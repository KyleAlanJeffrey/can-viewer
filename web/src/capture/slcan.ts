/**
 * slcan (Lawicel) adapters over Web Serial: CANable and its clones with slcan firmware, USBtin,
 * Lawicel CANUSB and others. Commands and frames are ASCII lines ending in CR; the adapter
 * answers a command with CR (done) or BEL (refused).
 */

import { FLAG_BRS, FLAG_FD, FLAG_RTR, type CaptureFrame } from '../core/api';
import { errorText, usbIds, type CaptureAdapter, type CaptureEvents, type CaptureSettings, type StartedCapture } from './adapter';
import type { SerialPortLike } from './webSerial';

const CR = 0x0d;
const LF = 0x0a;
const BEL = 0x07;
/** Longer than any frame line: `B`, 8 ID digits, a DLC, 128 data digits and a 4-digit time. */
const MAX_LINE = 160;
/** CAN FD payload length of each DLC code. */
const FD_LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
/** USB adapters ignore it; adapters behind a UART bridge mostly default to it. */
const SERIAL_BAUD_RATE = 115_200;

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

export type SlcanFrame = Omit<CaptureFrame, 'timeNs'>;

export type SlcanEvent =
  | { kind: 'frame'; frame: SlcanFrame }
  /** A bare CR: the last command was done. */
  | { kind: 'ok' }
  /** BEL: the last command was refused. */
  | { kind: 'error' }
  /** Any other line, such as `V1013` in answer to `V`. */
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

function hex(text: string): number | null {
  return HEX.test(text) ? parseInt(text, 16) : null;
}

/**
 * One received frame line: `tIIIL<data>` (11-bit), `TIIIIIIIIL<data>` (29-bit), `rIIIL` and
 * `RIIIIIIIIL` (remote), and the CAN FD lines `d`/`D` and, with bit rate switching, `b`/`B`,
 * whose DLC codes 9 to F mean 12 to 64 bytes. Four hex digits after the data are the adapter's
 * own timestamp (`Z1`), which is not used. Returns the frame, or why the line isn't one.
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
  return { id, extended: type.idDigits === 8, flags, data };
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

type Answer = 'ok' | 'refused' | 'no answer';

interface Waiter {
  answer: (a: Answer) => void;
}

export interface SlcanTiming {
  /** How long a command may go unanswered. */
  commandMs: number;
  /** A pause after the first command, so a late answer to it can't be taken for the next one's. */
  settleMs: number;
}

const DEFAULT_TIMING: SlcanTiming = { commandMs: 1000, settleMs: 100 };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Opens the CAN channel with `C` (in case it was left open), `S<n>` and `L` (listen only) or
 * `O`, falling back to `O` when `L` is refused. Frames are stamped with the host clock when
 * their bytes arrive, not with the adapter's `Z1` timestamps.
 */
export class SlcanAdapter implements CaptureAdapter {
  readonly label: string;
  private parser = new SlcanParser();
  private waiters: Waiter[] = [];
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private reading: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private events: CaptureEvents | null = null;
  private clock: () => number = () => 0;

  constructor(
    private readonly port: SerialPortLike,
    private readonly timing: SlcanTiming = DEFAULT_TIMING,
  ) {
    const ids = usbIds(port.getInfo());
    this.label = ids ? `USB serial device ${ids}` : 'Serial port';
  }

  async start(settings: CaptureSettings, events: CaptureEvents, clock: () => number): Promise<StartedCapture> {
    const code = BITRATE_CODES.get(settings.bitrate);
    if (code === undefined) throw new Error(`slcan adapters can't run at ${settings.bitrate} bit/s.`);
    // The sheet keeps the chosen adapter, so it can be started again after a stop.
    this.parser = new SlcanParser();
    this.waiters = [];
    this.stopping = null;
    this.events = events;
    this.clock = clock;
    try {
      await this.port.open({ baudRate: SERIAL_BAUD_RATE });
    } catch (e) {
      throw new Error(`The adapter couldn't be opened (${errorText(e)}). Close any other program or tab using it, then try again.`);
    }
    this.reading = this.readLoop();
    try {
      await this.command('C');
      await sleep(this.timing.settleMs);
      this.answerAll('no answer');
      await this.expect(`S${code}`, 'The adapter refused the bitrate. Check that it runs slcan firmware.');
      const listenOnly = settings.listenOnly && (await this.command('L')) === 'ok';
      if (!listenOnly) await this.expect('O', 'The adapter refused to open the CAN channel.');
      return { listenOnly };
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      // So the adapter stops sending. A lost device has no stream left, and nothing to tell.
      if (this.port.readable) await this.command('C');
      await this.reader?.cancel().catch(() => undefined);
      await this.reading;
      await this.port.close().catch(() => undefined);
    })();
    return this.stopping;
  }

  private async expect(command: string, refused: string) {
    const answer = await this.command(command);
    if (answer === 'refused') throw new Error(refused);
    if (answer === 'no answer') throw new Error("The adapter didn't answer. Check that it's a CANable, USBtin or other slcan adapter running slcan firmware.");
  }

  private async command(command: string): Promise<Answer> {
    const writer = this.port.writable?.getWriter();
    if (!writer) return 'no answer';
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
      }, this.timing.commandMs);
    });
    try {
      await writer.write(new TextEncoder().encode(`${command}\r`));
    } catch {
      this.answerAll('no answer');
    } finally {
      writer.releaseLock();
    }
    return answered;
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
    const timeNs = this.clock();
    const frames: CaptureFrame[] = [];
    for (const event of this.parser.push(chunk)) {
      switch (event.kind) {
        case 'frame':
          frames.push({ ...event.frame, timeNs });
          break;
        case 'ok':
        case 'reply':
          this.answer('ok');
          break;
        case 'error':
          if (!this.answer('refused')) this.events?.onProblem('The adapter reported an error.');
          break;
        case 'bad':
          this.events?.onProblem(`A line from the adapter wasn't a CAN frame (${event.reason}).`);
          break;
      }
    }
    if (frames.length > 0) this.events?.onFrames(frames);
  }
}
