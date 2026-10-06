/**
 * slcan (Lawicel) adapters over Web Serial: CANable and its clones with slcan firmware, USBtin,
 * Lawicel CANUSB and others. Commands and frames are ASCII lines ending in CR. Lawicel adapters
 * answer every command with CR (done) or BEL (refused). CANable's slcan firmware answers only
 * `V`, with a version line, and nothing else, so for it only a failed write counts as a failure,
 * as with slcand and python-can.
 */

import { FLAG_BRS, FLAG_FD, FLAG_RTR, type CaptureFrame } from '../core/api';
import {
  DeviceClock,
  errorText,
  ListenOnlyUnconfirmedError,
  settleWithin,
  START_CANCELLED,
  usbIds,
  type CaptureAdapter,
  type CaptureEvents,
  type CaptureSettings,
  type StartedCapture,
} from './adapter';
import type { SerialPortLike } from './webSerial';

const CR = 0x0d;
const LF = 0x0a;
const BEL = 0x07;
/** Longer than any frame line: `B`, 8 ID digits, a DLC, 128 data digits and a 4-digit time. */
const MAX_LINE = 160;
/** CAN FD payload length of each DLC code. */
const FD_LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
/** USB adapters ignore it; adapters behind a UART bridge mostly default to it. */
export const SERIAL_BAUD_RATE = 115_200;
/** Serial speeds offered for adapters behind a UART. */
export const SERIAL_BAUD_RATES = [9600, 19_200, 38_400, 57_600, 115_200, 230_400, 460_800, 921_600, 1_000_000, 2_000_000, 3_000_000];
/** The crystal of the Lawicel CANUSB and most SJA1000 adapters; the CAN clock is half of it. */
const SJA1000_CRYSTAL_HZ = 16_000_000;

/** The `Y<n>` code of each CAN FD data bitrate (CANable 2 firmware). */
const DATA_BITRATE_CODES = new Map([
  [1_000_000, 1],
  [2_000_000, 2],
  [4_000_000, 4],
  [5_000_000, 5],
  [8_000_000, 8],
]);

/** `Z1` timestamps count milliseconds from 0 to 59999. */
const TIMESTAMP_WRAP_NS = 60_000 * 1e6;

/** The `S<n>` code of each bitrate. */
const BITRATE_CODES = new Map([
  [10_000, 0],
  [20_000, 1],
  [50_000, 2],
  [100_000, 3],
  [125_000, 4],
  [250_000, 5],
  [500_000, 6],
  [800_000, 7],
  [1_000_000, 8],
]);

/** BTR0 and BTR1 from four hex digits, as the `s` command takes them, or null. */
export function parseBtr(text: string): [number, number] | null {
  if (!/^[0-9A-Fa-f]{4}$/.test(text)) return null;
  return [parseInt(text.slice(0, 2), 16), parseInt(text.slice(2), 16)];
}

/**
 * The bitrate SJA1000 registers BTR0 and BTR1 give with a 16 MHz crystal: a time quantum is
 * 2 * (BRP + 1) crystal periods, and a bit is 1 + (TSEG1 + 1) + (TSEG2 + 1) quanta.
 */
export function sja1000Bitrate(btr0: number, btr1: number): number {
  const brp = btr0 & 0x3f;
  const tseg1 = btr1 & 0x0f;
  const tseg2 = (btr1 >> 4) & 0x07;
  const quanta = 3 + tseg1 + tseg2;
  return SJA1000_CRYSTAL_HZ / (2 * (brp + 1) * quanta);
}

export type SlcanFrame = Omit<CaptureFrame, 'timeNs'> & {
  /** The adapter's own time (`Z1`) in milliseconds, wrapping every minute, if the line has one. */
  timestampMs?: number;
};

export type SlcanEvent =
  | { kind: 'frame'; frame: SlcanFrame }
  /** A bare CR: the last command was done. */
  | { kind: 'ok' }
  /** BEL: the last command was refused. */
  | { kind: 'error' }
  /** Any other line that isn't a frame, such as `V1013` in answer to `V`, or an echo. */
  | { kind: 'reply'; text: string }
  | { kind: 'bad'; reason: string };

interface FrameType {
  idDigits: number;
  remote: boolean;
  fd: boolean;
  brs: boolean;
}

const FRAME_TYPES: Record<string, FrameType> = {
  t: { idDigits: 3, remote: false, fd: false, brs: false },
  T: { idDigits: 8, remote: false, fd: false, brs: false },
  r: { idDigits: 3, remote: true, fd: false, brs: false },
  R: { idDigits: 8, remote: true, fd: false, brs: false },
  d: { idDigits: 3, remote: false, fd: true, brs: false },
  D: { idDigits: 8, remote: false, fd: true, brs: false },
  b: { idDigits: 3, remote: false, fd: true, brs: true },
  B: { idDigits: 8, remote: false, fd: true, brs: true },
};

const HEX = /^[0-9A-Fa-f]+$/;
/** The answer to `V`: hardware then software version, two hex digits each, such as `V1013`. */
const VERSION_REPLY = /^[Vv][0-9A-Fa-f]{4}/;
/** The answer to `F` while the channel is open: the status flags as two hex digits, such as `F00`. */
const STATUS_REPLY = /^F[0-9A-Fa-f]{2}$/;

function hex(text: string): number | null {
  return HEX.test(text) ? parseInt(text, 16) : null;
}

/**
 * One received frame line: `tIIIL<data>` (11-bit), `TIIIIIIIIL<data>` (29-bit), `rIIIL` and
 * `RIIIIIIIIL` (remote), and the CAN FD lines `d`/`D` and, with bit rate switching, `b`/`B`,
 * whose DLC codes 9 to F mean 12 to 64 bytes. Four hex digits after the data are the adapter's
 * own timestamp (`Z1`). Returns the frame, or why the line isn't one.
 */
export function parseSlcanFrame(line: string): SlcanFrame | string {
  const type = FRAME_TYPES[line[0]];
  if (!type) return 'not a frame';
  const idEnd = 1 + type.idDigits;
  const id = line.length > idEnd ? hex(line.slice(1, idEnd)) : null;
  if (id === null) return 'bad CAN ID';
  if (id > (type.idDigits === 3 ? 0x7ff : 0x1fff_ffff)) return 'CAN ID out of range';
  const dlc = hex(line[idEnd]);
  if (dlc === null) return 'bad length';
  if (!type.fd && dlc > 8) return 'classic CAN length over 8';
  const length = type.fd ? FD_LENGTHS[dlc] : dlc;
  const dataStart = idEnd + 1;
  const dataEnd = dataStart + (type.remote ? 0 : 2 * length);
  const extra = line.length - dataEnd;
  if (extra < 0) return 'data cut short';
  if (extra !== 0 && (extra !== 4 || hex(line.slice(dataEnd)) === null)) return 'unexpected characters after the data';
  const data = new Uint8Array(type.remote ? 0 : length);
  for (let i = 0; i < data.length; i++) {
    const byte = hex(line.slice(dataStart + 2 * i, dataStart + 2 * i + 2));
    if (byte === null) return 'bad hex data';
    data[i] = byte;
  }
  const flags = (type.fd ? FLAG_FD : 0) | (type.brs ? FLAG_BRS : 0) | (type.remote ? FLAG_RTR : 0);
  const frame: SlcanFrame = { id, extended: type.idDigits === 8, flags, data };
  if (type.remote) frame.dlc = dlc;
  if (extra === 4) frame.timestampMs = parseInt(line.slice(dataEnd), 16);
  return frame;
}

/** Splits what an adapter sends into events, whatever chunks it arrives in. */
export class SlcanParser {
  private line = '';
  private overlong = false;

  push(chunk: Uint8Array): SlcanEvent[] {
    const events: SlcanEvent[] = [];
    for (const byte of chunk) {
      if (byte === BEL) {
        events.push({ kind: 'error' });
      } else if (byte === CR) {
        events.push(this.overlong ? { kind: 'bad', reason: 'line too long' } : lineEvent(this.line));
        this.line = '';
        this.overlong = false;
      } else if (byte === LF || this.overlong) {
        // Some adapters end lines with CR LF.
      } else if (this.line.length === MAX_LINE) {
        this.overlong = true;
      } else {
        this.line += String.fromCharCode(byte);
      }
    }
    return events;
  }
}

function lineEvent(line: string): SlcanEvent {
  if (line === '') return { kind: 'ok' };
  if (!(line[0] in FRAME_TYPES)) return { kind: 'reply', text: line };
  const frame = parseSlcanFrame(line);
  return typeof frame === 'string' ? { kind: 'bad', reason: frame } : { kind: 'frame', frame };
}

type Answer = 'ok' | 'refused' | 'no answer' | 'write failed';

/** A reply line awaited in place of a bare CR, which may then answer an earlier command. */
type AwaitedReply = 'version' | 'status';

interface Waiter {
  answer: (a: Answer) => void;
}

export interface SlcanTiming {
  /** How long to wait for an answer to `S<n>`, and to later commands on an adapter that answers. */
  commandMs: number;
  /**
   * A pause after the first command, so a late answer to it can't be taken for the next one's;
   * also how long to wait between commands to an adapter that answers nothing, and after the
   * version line that comes before `L`.
   */
  settleMs: number;
}

const DEFAULT_TIMING: SlcanTiming = { commandMs: 1000, settleMs: 100 };
/** How long a stop waits for the port to close; a hung device may never let it. */
const CLOSE_WAIT_MS = 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens the CAN channel with `C` (in case it was left open), `S<n>` (or `s` with custom bit
 * timing), `Y<n>` for a CAN FD data bitrate, then `O`. For listen only it sends `V` and `L`, and
 * if `L` is refused (or, after an `L` it didn't confirm, `F`), or the adapter answers nothing,
 * `M1` (CANable's silent mode, which it takes only while off the bus) and `O`.
 * Whether the adapter answers commands at all is learnt from `S<n>` or `s`, which every Lawicel
 * adapter answers. Listen-only counts as confirmed only when an adapter answers `L` with CR, and
 * only once the version line it sends for `V` has shown that every earlier answer has come.
 * An `L` that isn't refused but isn't confirmed either is left in place, without `M1` or `O`,
 * unless the adapter then refuses `F`, which shows the channel is closed.
 * `Z1` asks for the adapter's own timestamps before the bus opens; frames that carry one are
 * timed by it (see `DeviceClock`), others by the host clock when their bytes arrive. Frames are
 * read only once `O` or `L` has been sent.
 */
export class SlcanAdapter implements CaptureAdapter {
  readonly label: string;
  private parser = new SlcanParser();
  private waiters: Waiter[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private reading: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  /** The writer of the command being written, so a stop can abort a write that hangs. */
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  /** The start under way, until it settles; another isn't begun before then. */
  private starting: Promise<StartedCapture> | null = null;
  /** Set by `stop`, so a start still under way stops at its next step. */
  private cancelled = false;
  /** Resolves on `stop`, so a write that hangs stops being waited for. */
  private stopped: Promise<void> = new Promise(() => {});
  private signalStop = () => {};
  private events: CaptureEvents | null = null;
  private clock: () => number = () => 0;
  /** Set as `O` or `L` is sent. Until then a line that looks like a frame is a reply or stale. */
  private busOpen = false;
  private deviceClock = new DeviceClock(TIMESTAMP_WRAP_NS);
  /** `Z1` was sent and not refused, so a stop sends `Z0`: Lawicel adapters keep the setting. */
  private timestampsAsked = false;
  /** Set while the answer to `V` or `F` is awaited: until it comes, a CR answers an earlier command. */
  private awaitedReply: AwaitedReply | null = null;

  constructor(
    private readonly port: SerialPortLike,
    private readonly timing: SlcanTiming = DEFAULT_TIMING,
  ) {
    const ids = usbIds(port.getInfo());
    this.label = ids ? `USB serial device ${ids}` : 'Serial port';
  }

  start(settings: CaptureSettings, events: CaptureEvents, clock: () => number): Promise<StartedCapture> {
    if (this.starting) return Promise.reject(new Error('The adapter is still busy with the last try. Unplug it, plug it back in, then choose it again.'));
    const starting = this.open(settings, events, clock);
    this.starting = starting;
    const settled = () => {
      if (this.starting === starting) this.starting = null;
    };
    starting.then(settled, settled);
    return starting;
  }

  private async open(settings: CaptureSettings, events: CaptureEvents, clock: () => number): Promise<StartedCapture> {
    const btr = settings.btr === undefined ? null : parseBtr(settings.btr);
    if (settings.btr !== undefined && !btr) throw new Error('The bit timing must be four hex digits: BTR0 then BTR1.');
    const code = BITRATE_CODES.get(settings.bitrate);
    if (!btr && code === undefined) throw new Error(`slcan adapters can't run at ${settings.bitrate} bit/s.`);
    const bitrateCommand = btr ? `s${settings.btr!.toUpperCase()}` : `S${code}`;
    const dataCode = settings.dataBitrate === undefined ? null : DATA_BITRATE_CODES.get(settings.dataBitrate);
    if (dataCode === undefined) throw new Error(`slcan adapters can't run a CAN FD data phase at ${settings.dataBitrate} bit/s.`);
    // The sheet keeps the chosen adapter, so it can be started again after a stop.
    this.parser = new SlcanParser();
    this.waiters = [];
    this.stopping = null;
    this.cancelled = false;
    this.stopped = new Promise((resolve) => (this.signalStop = resolve));
    this.reader = null;
    this.reading = null;
    this.writer = null;
    this.busOpen = false;
    this.deviceClock = new DeviceClock(TIMESTAMP_WRAP_NS);
    this.timestampsAsked = false;
    this.awaitedReply = null;
    this.events = events;
    this.clock = clock;
    try {
      await this.port.open({ baudRate: settings.serialBaudRate ?? SERIAL_BAUD_RATE });
    } catch (e) {
      if (this.cancelled) throw new Error(START_CANCELLED);
      // As when an earlier try's open never finished.
      if ((e as { name?: unknown } | null)?.name === 'InvalidStateError') {
        throw new Error(`The adapter is still busy with an earlier try (${errorText(e)}). Unplug it, plug it back in, then choose it again.`);
      }
      throw new Error(`The adapter couldn't be opened (${errorText(e)}). Close any other program or tab using it, then try again.`);
    }
    try {
      this.checkCancelled();
      this.reading = this.readLoop();
      await this.expect('C', this.timing.settleMs, null);
      await sleep(this.timing.settleMs);
      this.answerAll('no answer');
      const bitrate = await this.expect(
        bitrateCommand,
        this.timing.commandMs,
        btr
          ? 'The adapter refused the bit timing. Check the BTR values; only SJA1000-based adapters such as the Lawicel CANUSB take them.'
          : 'The adapter refused the bitrate. Check that it runs slcan firmware.',
      );
      const answers = bitrate !== 'no answer';
      const wait = answers ? this.timing.commandMs : this.timing.settleMs;
      if (dataCode !== null) {
        const dataBitrate = await this.expect(`Y${dataCode}`, wait, 'The adapter refused the CAN FD data bitrate. Only CAN FD adapters, such as a CANable 2, take it.');
        await this.settleUnanswered(dataBitrate, answers);
      }
      // Taken only while the channel is closed. An adapter that refuses it sends no timestamps.
      const timestamps = await this.expect('Z1', wait, null);
      this.timestampsAsked = timestamps !== 'refused';
      await this.settleUnanswered(timestamps, answers);
      // Frames can follow the answer to O or L in the same chunk, so read them once the command is out.
      const busOpened = () => {
        this.busOpen = true;
      };
      const open = () => this.expect('O', wait, 'The adapter refused to open the CAN channel.', busOpened);
      if (!settings.listenOnly) {
        await open();
        return { listenOnly: false };
      }
      // CANable ignores L, so a silent adapter gets only M1, which CANable takes as silent mode.
      if (answers) {
        const drained = await this.drainAnswers(wait);
        const listenOnly = await this.expect('L', wait, null, busOpened);
        // Without the version line, this answer may still be an earlier command's.
        if (drained && listenOnly === 'ok') return { listenOnly: true };
        if (listenOnly !== 'refused' && (await this.channelOpen(wait)) !== false) {
          // The channel is likely open in listen-only mode, where Lawicel adapters refuse M1 and
          // O, so it is left as it is: the safer of the two. A status line from F doesn't say
          // more, as only the answer to L confirms the mode.
          if (settings.allowUnconfirmedListenOnly) return { listenOnly: false };
          this.busOpen = false;
          throw new ListenOnlyUnconfirmedError(
            listenOnly === 'ok'
              ? "This adapter was sent listen-only mode (L), but its answer couldn't be told from an earlier command's, so it may still acknowledge frames on the bus."
              : "This adapter was sent listen-only mode (L) but didn't confirm it in time, so it may still acknowledge frames on the bus.",
          );
        }
        // Without the version line this BEL may be an earlier command's while L opened the
        // channel; M1 and O are then refused with a visible error, which is safe.
        this.busOpen = false;
      }
      // Only L confirms listen-only: on Lawicel adapters M sets the acceptance code, so a CR for
      // M1 proves nothing.
      const silent = await this.expect('M1', wait, null);
      if (!settings.allowUnconfirmedListenOnly) {
        throw new ListenOnlyUnconfirmedError(
          silent === 'refused'
            ? "This adapter can't listen only, so it would acknowledge frames on the bus."
            : "This adapter didn't confirm listen-only mode. Silent mode (M1) was sent, which CANable firmware follows, but another adapter may still acknowledge frames on the bus.",
        );
      }
      await open();
      return { listenOnly: false };
    } catch (e) {
      if (!this.cancelled) {
        await this.stop();
        throw e;
      }
      // After the stop's own teardown, which may have found the port not yet open.
      await this.stopping;
      if (this.port.readable) await this.teardown();
      throw new Error(START_CANCELLED);
    }
  }

  stop(): Promise<void> {
    this.cancelled = true;
    this.signalStop();
    this.stopping ??= this.teardown();
    return this.stopping;
  }

  /** Lets the port go. Never rejects, and doesn't wait long on a device that has hung. */
  private async teardown(): Promise<void> {
    try {
      const hung = this.writer;
      if (hung) {
        // A write that hasn't finished holds the stream, so no C can follow it.
        this.writer = null;
        void hung.abort().catch(() => undefined);
        hung.releaseLock();
      } else if (this.port.readable && this.port.writable && !this.port.writable.locked) {
        // So the adapter stops sending; closing the port could drop a C not yet written. A lost
        // device has no stream left, and nothing to tell.
        const writer = this.port.writable.getWriter();
        await settleWithin(writer.write(new TextEncoder().encode(this.closeCommands())), this.timing.commandMs);
        writer.releaseLock();
        await sleep(this.timing.settleMs);
      }
      await this.reader?.cancel().catch(() => undefined);
      await this.reading;
      await settleWithin(this.port.close(), CLOSE_WAIT_MS);
    } catch {
      // Stopping never fails; what is left of the port goes with the page.
    }
  }

  private checkCancelled() {
    if (this.cancelled) throw new Error(START_CANCELLED);
  }

  release() {
    const writer = this.port.writable?.getWriter();
    if (!writer) return;
    void writer.write(new TextEncoder().encode(this.closeCommands())).catch(() => undefined);
    writer.releaseLock();
  }

  private closeCommands(): string {
    return this.timestampsAsked ? 'C\rZ0\r' : 'C\r';
  }

  /**
   * Sends `command` and waits up to `waitMs` for an answer. A failed write always throws; a
   * BEL throws `refused` when given. No answer is fine: some adapters never answer.
   */
  private async expect(command: string, waitMs: number, refused: string | null, onWritten?: () => void): Promise<Answer> {
    this.checkCancelled();
    const answer = await this.command(command, waitMs, onWritten);
    this.checkCancelled();
    // A lost device has no stream left to read, and answers nothing more.
    if (answer === 'write failed' || (answer === 'no answer' && !this.port.readable)) {
      throw new Error('The adapter stopped taking commands. Unplug it, plug it back in and try again.');
    }
    if (answer === 'refused' && refused !== null) throw new Error(refused);
    return answer;
  }

  private async command(command: string, waitMs = this.timing.commandMs, onWritten?: () => void): Promise<Answer> {
    const writer = this.port.writable?.getWriter();
    if (!writer) return 'write failed';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = new Promise<Answer>((resolve) => {
      const waiter: Waiter = {
        answer: (a) => {
          clearTimeout(timer);
          resolve(a);
        },
      };
      this.waiters.push(waiter);
      timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter);
        resolve('no answer');
      }, waitMs);
    });
    this.writer = writer;
    const written = writer.write(new TextEncoder().encode(`${command}\r`)).then(
      () => true,
      () => false,
    );
    // Let go of the stream as soon as the write settles, so a stop then sees it free for C.
    void written.then((ok) => {
      if (ok) onWritten?.();
      if (this.writer === writer) this.writer = null;
      writer.releaseLock();
    });
    const stopped = this.stopped.then(() => false);
    if (!(await Promise.race([written, stopped]))) this.answerAll('write failed');
    return answered;
  }

  /**
   * Waits a little after an adapter that answers commands gave none, as one writing a setting to
   * its EEPROM may answer late: an answer that comes while no command waits is dropped, rather
   * than taken for the next command's.
   */
  private async settleUnanswered(answer: Answer, answers: boolean) {
    if (answers && answer === 'no answer') await sleep(this.timing.settleMs);
  }

  /**
   * Sends `V` and drops every CR and BEL until its version line comes. An adapter answers in
   * order, so those answer earlier commands, however late, and the next answer is the next
   * command's. Answers are dropped a little past the line too, in case firmware ends it with
   * another CR. False when no version line came, so the next answer may still be stale.
   */
  private async drainAnswers(waitMs: number): Promise<boolean> {
    this.awaitedReply = 'version';
    try {
      if ((await this.expect('V', waitMs, null)) !== 'ok') return false;
      await sleep(this.timing.settleMs);
      return true;
    } finally {
      this.awaitedReply = null;
    }
  }

  /**
   * Asks for the status flags with `F`, which a Lawicel adapter answers with a status line only
   * while the channel is open, and refuses with BEL while it is closed. A CR meanwhile may be a
   * late answer to `L`, so it is dropped. Null when the answer tells neither.
   */
  private async channelOpen(waitMs: number): Promise<boolean | null> {
    this.awaitedReply = 'status';
    try {
      const status = await this.expect('F', waitMs, null);
      if (status === 'ok') return true;
      return status === 'refused' ? false : null;
    } finally {
      this.awaitedReply = null;
    }
  }

  /** Hands `answer` to the oldest command waiting for one. False when none is waiting. */
  private answer(answer: Answer): boolean {
    const waiter = this.waiters.shift();
    waiter?.answer(answer);
    return waiter !== undefined;
  }

  private answerAll(answer: Answer) {
    while (this.answer(answer));
  }

  private async readLoop() {
    while (this.port.readable && !this.stopping) {
      const reader = this.port.readable.getReader();
      this.reader = reader;
      let closed = false;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) {
            closed = true;
            break;
          }
          if (value) this.receive(value);
        }
      } catch (e) {
        // A parity or overrun error leaves the port open with a new stream to read; a lost
        // device leaves `readable` null, and ends the capture below.
        if (!this.stopping && this.port.readable) this.events?.onProblem(`The serial port reported an error: ${errorText(e)}`);
      } finally {
        reader.releaseLock();
        this.reader = null;
      }
      if (closed || this.stopping) break;
    }
    this.answerAll('no answer');
    if (!this.stopping) this.events?.onEnd('The adapter was disconnected.');
  }

  private receive(chunk: Uint8Array) {
    const hostNs = this.clock();
    const frames: CaptureFrame[] = [];
    for (const event of this.parser.push(chunk)) {
      switch (event.kind) {
        case 'frame': {
          if (!this.busOpen) break;
          const { timestampMs, ...frame } = event.frame;
          const timeNs = timestampMs === undefined ? hostNs : this.deviceClock.time(timestampMs * 1e6, hostNs);
          frames.push({ ...frame, timeNs });
          break;
        }
        case 'ok':
          if (this.awaitedReply === null) this.answer('ok');
          break;
        case 'reply':
          if (this.awaitedReply === 'version' && VERSION_REPLY.test(event.text)) this.answer('ok');
          if (this.awaitedReply === 'status' && STATUS_REPLY.test(event.text)) this.answer('ok');
          break;
        case 'error':
          // Before the version line, a BEL answers an earlier command.
          if (this.awaitedReply === 'version') break;
          // A late BEL to a command no longer waited for, such as the opening C, is no problem.
          if (!this.answer('refused') && this.busOpen) this.events?.onProblem('The adapter reported an error.');
          break;
        case 'bad':
          if (this.busOpen) this.events?.onProblem(`A line from the adapter wasn't a CAN frame (${event.reason}).`);
          break;
      }
    }
    if (frames.length > 0) this.events?.onFrames(frames);
  }
}
