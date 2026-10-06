import { describe, expect, it, vi } from 'vitest';
import { FLAG_BRS, FLAG_FD, FLAG_RTR, type CaptureFrame } from '../core/api';
import { FakeSerialPort } from '../test/fakeSerial';
import { isListenOnlyUnconfirmed, type CaptureEvents } from './adapter';
import { SlcanAdapter, SlcanParser, parseBtr, parseSlcanFrame, sja1000Bitrate, type SlcanEvent } from './slcan';

const bytes = (text: string) => new TextEncoder().encode(text);

function frame(line: string) {
  const parsed = parseSlcanFrame(line);
  if (typeof parsed === 'string') throw new Error(`${line}: ${parsed}`);
  return { ...parsed, data: [...parsed.data] };
}

describe('parseSlcanFrame', () => {
  it('reads 11-bit and 29-bit data frames', () => {
    expect(frame('t1232DEAD')).toEqual({ id: 0x123, extended: false, flags: 0, data: [0xde, 0xad] });
    expect(frame('t7FF0')).toEqual({ id: 0x7ff, extended: false, flags: 0, data: [] });
    expect(frame('t00080102030405060708')).toEqual({ id: 0, extended: false, flags: 0, data: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(frame('T1234ABCD3aabbcc')).toEqual({ id: 0x1234_abcd, extended: true, flags: 0, data: [0xaa, 0xbb, 0xcc] });
    expect(frame('T1FFFFFFF0')).toEqual({ id: 0x1fff_ffff, extended: true, flags: 0, data: [] });
  });

  it('reads remote frames, which carry a length but no data', () => {
    expect(frame('r1238')).toEqual({ id: 0x123, extended: false, flags: FLAG_RTR, data: [], dlc: 8 });
    expect(frame('R12345678' + '2')).toEqual({ id: 0x1234_5678, extended: true, flags: FLAG_RTR, data: [], dlc: 2 });
  });

  it('reads CAN FD frames, with and without bit rate switching', () => {
    expect(frame('d1239' + '00'.repeat(12)).data).toHaveLength(12);
    expect(frame('d1239' + '00'.repeat(12)).flags).toBe(FLAG_FD);
    expect(frame('D12345678F' + 'AB'.repeat(64))).toEqual({ id: 0x1234_5678, extended: true, flags: FLAG_FD, data: Array(64).fill(0xab) });
    expect(frame('b123A' + '11'.repeat(16)).flags).toBe(FLAG_FD | FLAG_BRS);
    expect(frame('B000000FFD' + '22'.repeat(32))).toEqual({ id: 0xff, extended: true, flags: FLAG_FD | FLAG_BRS, data: Array(32).fill(0x22) });
    expect(frame('b1238' + '33'.repeat(8)).data).toHaveLength(8);
    const lengths = ['9', 'A', 'B', 'C', 'D', 'E', 'F'].map((dlc, i) => frame(`d123${dlc}` + '00'.repeat([12, 16, 20, 24, 32, 48, 64][i])).data.length);
    expect(lengths).toEqual([12, 16, 20, 24, 32, 48, 64]);
  });

  it("reads the adapter's own four-digit timestamp", () => {
    expect(frame('t1232DEADEA5F')).toEqual({ id: 0x123, extended: false, flags: 0, data: [0xde, 0xad], timestampMs: 59_999 });
    expect(frame('r12380001').flags).toBe(FLAG_RTR);
  });

  it('says why a line is not a frame', () => {
    expect(parseSlcanFrame('V1013')).toBe('not a frame');
    expect(parseSlcanFrame('t12')).toBe('bad CAN ID');
    expect(parseSlcanFrame('t123')).toBe('bad CAN ID');
    expect(parseSlcanFrame('tG230')).toBe('bad CAN ID');
    expect(parseSlcanFrame('t8000')).toBe('CAN ID out of range');
    expect(parseSlcanFrame('T200000000')).toBe('CAN ID out of range');
    expect(parseSlcanFrame('t123X')).toBe('bad length');
    expect(parseSlcanFrame('t1239' + '00'.repeat(9))).toBe('classic CAN length over 8');
    expect(parseSlcanFrame('r123F')).toBe('classic CAN length over 8');
    expect(parseSlcanFrame('t1234AABB')).toBe('data cut short');
    expect(parseSlcanFrame('t1231AABB')).toBe('unexpected characters after the data');
    expect(parseSlcanFrame('t1231AA12')).toBe('unexpected characters after the data');
    expect(parseSlcanFrame('t1231AAZZZZ')).toBe('unexpected characters after the data');
    expect(parseSlcanFrame('t1231ZZ')).toBe('bad hex data');
    expect(parseSlcanFrame('d1239' + '00'.repeat(8))).toBe('data cut short');
  });
});

describe('SJA1000 bit timing', () => {
  it('reads BTR0 and BTR1 from four hex digits', () => {
    expect(parseBtr('031c')).toEqual([0x03, 0x1c]);
    expect(parseBtr('031')).toBeNull();
    expect(parseBtr('03 1C')).toBeNull();
  });

  it('gives the bitrate of the registers with a 16 MHz crystal', () => {
    expect(sja1000Bitrate(0x03, 0x1c)).toBe(125_000);
    expect(sja1000Bitrate(0x00, 0x14)).toBe(1_000_000);
    expect(sja1000Bitrate(0x00, 0x1c)).toBe(500_000);
    expect(Math.round(sja1000Bitrate(0x4b, 0x14))).toBe(83_333);
  });
});

describe('SlcanParser', () => {
  const kinds = (events: SlcanEvent[]) => events.map((e) => (e.kind === 'frame' ? `frame ${e.frame.id.toString(16)}` : e.kind === 'reply' ? `reply ${e.text}` : e.kind));

  it('tells answers, errors, replies and frames apart', () => {
    const events = new SlcanParser().push(bytes('\r\x07V1013\rt1230\rz\r'));
    expect(kinds(events)).toEqual(['ok', 'error', 'reply V1013', 'frame 123', 'reply z']);
  });

  it('joins lines split across chunks, at any byte', () => {
    const stream = 't1232DEAD\rT1234ABCD0\r\x07r1230\r';
    const whole = new SlcanParser().push(bytes(stream));
    for (let size = 1; size <= stream.length; size++) {
      const parser = new SlcanParser();
      const events: SlcanEvent[] = [];
      for (let at = 0; at < stream.length; at += size) events.push(...parser.push(bytes(stream.slice(at, at + size))));
      expect(events, `chunks of ${size}`).toEqual(whole);
    }
    expect(kinds(whole)).toEqual(['frame 123', 'frame 1234abcd', 'error', 'frame 123']);
  });

  it('holds a partial line until its CR arrives', () => {
    const parser = new SlcanParser();
    expect(parser.push(bytes('t1232DE'))).toEqual([]);
    expect(kinds(parser.push(bytes('AD\r')))).toEqual(['frame 123']);
  });

  it('reports a BEL in the middle of a line without losing the line', () => {
    const parser = new SlcanParser();
    expect(kinds(parser.push(bytes('t123\x072DEAD\r')))).toEqual(['error', 'frame 123']);
  });

  it('ignores line feeds, so CR LF endings read like CR', () => {
    expect(kinds(new SlcanParser().push(bytes('t1230\r\nt4560\r\n')))).toEqual(['frame 123', 'frame 456']);
  });

  it('reports bad lines and keeps going', () => {
    const events = new SlcanParser().push(bytes('t12\rt1230\r'));
    expect(events[0]).toEqual({ kind: 'bad', reason: 'bad CAN ID' });
    expect(kinds(events)).toEqual(['bad', 'frame 123']);
  });

  it('drops an overlong line without holding it, then reads on', () => {
    const parser = new SlcanParser();
    expect(parser.push(bytes('x'.repeat(10_000)))).toEqual([]);
    const events = parser.push(bytes('yyy\rt1230\r'));
    expect(events[0]).toEqual({ kind: 'bad', reason: 'line too long' });
    expect(kinds(events)).toEqual(['bad', 'frame 123']);
  });
});

function recordingEvents() {
  const frames: CaptureFrame[] = [];
  const problems: string[] = [];
  const ends: string[] = [];
  const events: CaptureEvents = {
    onFrames: (f) => frames.push(...f),
    onProblem: (m) => problems.push(m),
    onEnd: (m) => ends.push(m),
  };
  return { frames, problems, ends, events };
}

const timing = { commandMs: 50, settleMs: 5 };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * Makes the adapter answer in order, as firmware does: each command after the ones before it,
 * taking `workMs` (such as a write to EEPROM) before its answer, from `replies` or the default.
 */
function answerInOrder(port: FakeSerialPort, replies: Record<string, string>, workMs: Record<string, number> = {}) {
  const answer = port.answer;
  let done = Promise.resolve();
  port.answer = (command) => {
    const reply = replies[command] ?? answer(command);
    done = done
      .then(() => new Promise((resolve) => setTimeout(resolve, workMs[command] ?? 0)))
      .then(() => {
        if (reply !== null) port.send(reply);
      });
    return null;
  };
}

describe('SlcanAdapter', () => {
  it('names the device by its USB IDs', () => {
    expect(new SlcanAdapter(new FakeSerialPort()).label).toBe('USB serial device 16D0:117E');
    expect(new SlcanAdapter(new FakeSerialPort({} as never)).label).toBe('Serial port');
  });

  it('closes, sets the bitrate and opens listen-only, then stamps frames with the host clock', async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    const { frames, problems, events } = recordingEvents();
    let now = 0;
    expect(await adapter.start({ bitrate: 500_000, listenOnly: true }, events, () => now)).toEqual({ listenOnly: true });
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'V', 'L']);

    now = 1_500_000;
    port.send('t1232DEAD\rT1234ABCD1');
    await tick();
    now = 2_000_000;
    port.send('FF\rjunk\r');
    await tick();
    expect(frames).toEqual([
      { id: 0x123, extended: false, flags: 0, data: Uint8Array.of(0xde, 0xad), timeNs: 1_500_000 },
      { id: 0x1234_abcd, extended: true, flags: 0, data: Uint8Array.of(0xff), timeNs: 2_000_000 },
    ]);
    expect(problems).toEqual([]);

    port.send('t12\r');
    await tick();
    expect(problems).toEqual(["A line from the adapter wasn't a CAN frame (bad CAN ID)."]);

    await adapter.stop();
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'V', 'L', 'C', 'Z0']);
    expect(port.closed).toBe(true);
  });

  it.each([
    [10_000, 'S0'],
    [125_000, 'S4'],
    [250_000, 'S5'],
    [1_000_000, 'S8'],
  ])('sets %i bit/s with %s', async (bitrate, command) => {
    const port = new FakeSerialPort();
    await new SlcanAdapter(port, timing).start({ bitrate, listenOnly: false }, recordingEvents().events, () => 0);
    expect(port.commands).toEqual(['C', command, 'Z1', 'O']);
  });

  it('sends M1 when the adapter refuses L, but asks first, as a CR for M1 proves nothing', async () => {
    const port = new FakeSerialPort();
    const answer = port.answer;
    port.answer = (command) => (command === 'L' ? '\x07' : answer(command));
    const adapter = new SlcanAdapter(port, timing);
    const refusal = await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0).catch((e: unknown) => e);
    expect(isListenOnlyUnconfirmed(refusal)).toBe(true);
    expect((refusal as Error).message).toMatch(/^This adapter didn't confirm listen-only mode/);
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'V', 'L', 'M1', 'C', 'Z0']);
  });

  it('opens an adapter that refuses listen-only only when the user agrees', async () => {
    const port = new FakeSerialPort();
    const answer = port.answer;
    port.answer = (command) => (command === 'L' || command === 'M1' ? '\x07' : answer(command));
    const adapter = new SlcanAdapter(port, timing);
    const refusal = await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0).catch((e: unknown) => e);
    expect(isListenOnlyUnconfirmed(refusal)).toBe(true);
    expect((refusal as Error).message).toBe("This adapter can't listen only, so it would acknowledge frames on the bus.");
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'V', 'L', 'M1', 'C', 'Z0']);
    expect(port.closed).toBe(true);

    port.commands.length = 0;
    const settings = { bitrate: 500_000, listenOnly: true, allowUnconfirmedListenOnly: true };
    expect(await adapter.start(settings, recordingEvents().events, () => 0)).toEqual({ listenOnly: false });
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'V', 'L', 'M1', 'O']);
    await adapter.stop();
  });

  it.each([
    ['refused', '\x07', false],
    ['confirmed', '\r', true],
  ])("does not take an answer to Z1 that comes 1.5 s late for L's, when L is %s", async (_, lReply, confirmed) => {
    vi.useFakeTimers();
    try {
      const port = new FakeSerialPort();
      answerInOrder(port, { L: lReply }, { Z1: 1500 });
      const adapter = new SlcanAdapter(port);
      const starting = adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await starting;
      expect(port.commands.slice(0, 5)).toEqual(['C', 'S6', 'Z1', 'V', 'L']);
      if (confirmed) {
        expect(result).toEqual({ listenOnly: true });
        const stopping = adapter.stop();
        await vi.advanceTimersByTimeAsync(10_000);
        await stopping;
      } else {
        expect(isListenOnlyUnconfirmed(result)).toBe(true);
        expect(port.commands[5]).toBe('M1');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a BEL to Z1 that comes late rather than taking it as L's refusal", async () => {
    vi.useFakeTimers();
    try {
      const port = new FakeSerialPort();
      answerInOrder(port, { Z1: '\x07' }, { Z1: 1500 });
      const adapter = new SlcanAdapter(port);
      const starting = adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await starting).toEqual({ listenOnly: true });
      const stopping = adapter.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not take a CR that follows the version line for L', async () => {
    const port = new FakeSerialPort();
    answerInOrder(port, { V: 'V1013\r\r', L: '\x07' });
    const adapter = new SlcanAdapter(port, timing);
    const refusal = await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0).catch((e: unknown) => e);
    expect(isListenOnlyUnconfirmed(refusal)).toBe(true);
    expect(port.commands.slice(0, 6)).toEqual(['C', 'S6', 'Z1', 'V', 'L', 'M1']);
  });

  it.each([
    ['a bare CR', '\r'],
    ['nothing', null],
  ])("doesn't confirm listen-only when the adapter answers V with %s, as L's answer may be stale", async (_, vReply) => {
    const port = new FakeSerialPort();
    const answer = port.answer;
    port.answer = (command) => (command === 'V' ? vReply : answer(command));
    const adapter = new SlcanAdapter(port, timing);
    const refusal = await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0).catch((e: unknown) => e);
    expect(isListenOnlyUnconfirmed(refusal)).toBe(true);
    expect((refusal as Error).message).toMatch(/^This adapter didn't confirm listen-only mode/);
    expect(port.commands.slice(0, 6)).toEqual(['C', 'S6', 'Z1', 'V', 'L', 'M1']);
  });

  it("carries on when the channel wasn't open to close", async () => {
    const port = new FakeSerialPort();
    port.answer = (command) => (command === 'C' ? '\x07' : '\r');
    const adapter = new SlcanAdapter(port, timing);
    expect(await adapter.start({ bitrate: 500_000, listenOnly: false }, recordingEvents().events, () => 0)).toEqual({ listenOnly: false });
  });

  it('fails with a message when the adapter refuses the bitrate, and lets the port go', async () => {
    const port = new FakeSerialPort();
    port.answer = (command) => (command.startsWith('S') ? '\x07' : '\r');
    const adapter = new SlcanAdapter(port, timing);
    await expect(adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0)).rejects.toThrow(
      'The adapter refused the bitrate. Check that it runs slcan firmware.',
    );
    expect(port.closed).toBe(true);
  });

  it('captures from CANable firmware, which answers only V', async () => {
    const port = new FakeSerialPort();
    port.canable();
    const adapter = new SlcanAdapter(port, timing);
    const { frames, problems, events } = recordingEvents();
    expect(await adapter.start({ bitrate: 250_000, listenOnly: false }, events, () => 7)).toEqual({ listenOnly: false });
    expect(port.commands).toEqual(['C', 'S5', 'Z1', 'O']);
    expect(port.silentMode).toBe(false);
    port.send('t1231AA\r');
    await tick();
    expect(frames).toEqual([{ id: 0x123, extended: false, flags: 0, data: Uint8Array.of(0xaa), timeNs: 7 }]);
    expect(problems).toEqual([]);
    await adapter.stop();
    expect(port.closed).toBe(true);
  });

  it("puts CANable in silent mode before the bus opens, and asks since it can't confirm it", async () => {
    const port = new FakeSerialPort();
    port.canable();
    const adapter = new SlcanAdapter(port, { commandMs: 300, settleMs: 5 });
    const started = performance.now();
    const refusal = await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0).catch((e: unknown) => e);
    expect(isListenOnlyUnconfirmed(refusal)).toBe(true);
    expect((refusal as Error).message).toBe(
      "This adapter didn't confirm listen-only mode. Silent mode (M1) was sent, which CANable firmware follows, but another adapter may still acknowledge frames on the bus.",
    );
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'M1', 'C', 'Z0']);

    port.commands.length = 0;
    const settings = { bitrate: 500_000, listenOnly: true, allowUnconfirmedListenOnly: true };
    expect(await adapter.start(settings, recordingEvents().events, () => 0)).toEqual({ listenOnly: false });
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'M1', 'O']);
    expect(port.silentMode).toBe(true);
    // Only S6 waits the full time for an answer; once the adapter is known to be silent, the rest don't.
    expect(performance.now() - started).toBeLessThan(2 * 300 + 200);
    await adapter.stop();
  });

  it('asks the same of an adapter that answers nothing at all', async () => {
    const port = new FakeSerialPort();
    port.silence();
    const adapter = new SlcanAdapter(port, timing);
    const refusal = await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0).catch((e: unknown) => e);
    expect(isListenOnlyUnconfirmed(refusal)).toBe(true);
    expect((refusal as Error).message).toMatch(/^This adapter didn't confirm listen-only mode/);
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'M1', 'C', 'Z0']);
  });

  it('starts an adapter that answers nothing, sending it no V', async () => {
    const port = new FakeSerialPort();
    port.silence();
    const adapter = new SlcanAdapter(port, timing);
    expect(await adapter.start({ bitrate: 500_000, listenOnly: false }, recordingEvents().events, () => 0)).toEqual({ listenOnly: false });
    await adapter.stop();
    port.commands.length = 0;
    const settings = { bitrate: 500_000, listenOnly: true, allowUnconfirmedListenOnly: true };
    expect(await adapter.start(settings, recordingEvents().events, () => 0)).toEqual({ listenOnly: false });
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'M1', 'O']);
    await adapter.stop();
  });

  it('takes only a bare CR as confirming listen-only, not an echo of the command', async () => {
    const port = new FakeSerialPort();
    const answer = port.answer;
    port.answer = (command) => (command === 'L' || command === 'M1' ? `${command}\r` : answer(command));
    const adapter = new SlcanAdapter(port, timing);
    const refusal = await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0).catch((e: unknown) => e);
    expect(isListenOnlyUnconfirmed(refusal)).toBe(true);
    expect((refusal as Error).message).toMatch(/^This adapter didn't confirm listen-only mode/);
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'V', 'L', 'M1', 'C', 'Z0']);
  });

  it('reads no frames before the bus is opened, such as a version line that looks like one', async () => {
    const port = new FakeSerialPort();
    port.answer = (command) => (command.startsWith('S') ? 'b2c4e1f\rt1230\r\r' : '\r');
    const adapter = new SlcanAdapter(port, timing);
    const { frames, problems, events } = recordingEvents();
    expect(await adapter.start({ bitrate: 500_000, listenOnly: false }, events, () => 0)).toEqual({ listenOnly: false });
    port.send('t4560\r');
    await tick();
    expect(frames.map((f) => f.id)).toEqual([0x456]);
    expect(problems).toEqual([]);
    await adapter.stop();
  });

  it('reads no frames that arrive while the open command is still being written', async () => {
    const port = new FakeSerialPort();
    const answer = port.answer;
    port.answer = (command) => {
      if (command.startsWith('S')) {
        port.writeDelayMs = 20;
        setTimeout(() => port.send('t1230\r'), 5);
      }
      return answer(command);
    };
    const adapter = new SlcanAdapter(port, timing);
    const { frames, events } = recordingEvents();
    await adapter.start({ bitrate: 500_000, listenOnly: false }, events, () => 0);
    port.send('t4560\r');
    await tick();
    expect(frames.map((f) => f.id)).toEqual([0x456]);
    await adapter.stop();
  });

  it('still fails on a BEL from an adapter that otherwise answers nothing', async () => {
    const port = new FakeSerialPort();
    port.answer = (command) => (command === 'O' ? '\x07' : null);
    const adapter = new SlcanAdapter(port, timing);
    await expect(adapter.start({ bitrate: 500_000, listenOnly: false }, recordingEvents().events, () => 0)).rejects.toThrow(
      'The adapter refused to open the CAN channel.',
    );
    expect(port.closed).toBe(true);
  });

  it('fails with a message when the adapter takes no more commands', async () => {
    const port = new FakeSerialPort();
    port.writeError = new DOMException('The device has been lost.', 'NetworkError');
    const adapter = new SlcanAdapter(port, timing);
    await expect(adapter.start({ bitrate: 500_000, listenOnly: false }, recordingEvents().events, () => 0)).rejects.toThrow(
      'The adapter stopped taking commands. Unplug it, plug it back in and try again.',
    );
    expect(port.closed).toBe(true);
  });

  it('asks the adapter to close as the page goes away, without waiting', async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0);
    adapter.release();
    await tick();
    expect(port.commands.slice(-2)).toEqual(['C', 'Z0']);
    await adapter.stop();
  });

  it('fails with a message when the port is busy', async () => {
    const port = new FakeSerialPort();
    port.openError = new DOMException('Failed to open serial port.', 'NetworkError');
    const adapter = new SlcanAdapter(port, timing);
    await expect(adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0)).rejects.toThrow(
      "The adapter couldn't be opened (Failed to open serial port.). Close any other program or tab using it, then try again.",
    );
  });

  it('opens the port at 115200 baud unless told another serial speed', async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    await adapter.start({ bitrate: 500_000, listenOnly: false }, recordingEvents().events, () => 0);
    expect(port.baudRate).toBe(115_200);
    await adapter.stop();
    await adapter.start({ bitrate: 500_000, listenOnly: false, serialBaudRate: 57_600 }, recordingEvents().events, () => 0);
    expect(port.baudRate).toBe(57_600);
    await adapter.stop();
  });

  it("times frames by the adapter's Z1 timestamps, unwrapped every minute and anchored to the host clock", async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    const { frames, events } = recordingEvents();
    let now = 5_000_000;
    await adapter.start({ bitrate: 500_000, listenOnly: false }, events, () => now);
    // Two frames 7 ms apart on the adapter's clock, arriving together.
    port.send('t1230EA56\rt1230EA5D\r');
    await tick();
    // 24 ms after the first by the adapter, past its wrap at 60000 ms, but read 40 ms later.
    now += 40_000_000;
    port.send('t1230000E\rt1230\r');
    await tick();
    // The second frame is timed after the chunk arrived, so the anchor moves back 7 us (1000 ppm of 7 ms).
    expect(frames.map((f) => f.timeNs)).toEqual([5_000_000, 11_993_000, 28_993_000, 45_000_000]);
    expect(frames.every((f) => !('timestampMs' in f))).toBe(true);

    // A minute and more later, the counter has wrapped again.
    now += 61_000_000_000;
    port.send('t1230001E\r');
    await tick();
    expect(frames.at(-1)!.timeNs).toBe(5_000_000 - 7_000 + 60_000_000_000 + 40_000_000);
    await adapter.stop();
  });

  it('times frames by the host clock when the adapter refuses Z1, and leaves Z alone on a stop', async () => {
    const port = new FakeSerialPort();
    port.answer = (command) => (command === 'Z1' ? '\x07' : '\r');
    const adapter = new SlcanAdapter(port, timing);
    const { frames, problems, events } = recordingEvents();
    await adapter.start({ bitrate: 500_000, listenOnly: false }, events, () => 7);
    port.send('t1230\r');
    await tick();
    expect(frames.map((f) => f.timeNs)).toEqual([7]);
    expect(problems).toEqual([]);
    await adapter.stop();
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'O', 'C']);
  });

  it('sets a CAN FD data bitrate with Y before the bus opens, and reads FD frames', async () => {
    const port = new FakeSerialPort();
    port.canable();
    const adapter = new SlcanAdapter(port, timing);
    const { frames, events } = recordingEvents();
    await adapter.start({ bitrate: 500_000, dataBitrate: 2_000_000, listenOnly: false }, events, () => 0);
    expect(port.commands).toEqual(['C', 'S6', 'Y2', 'Z1', 'O']);
    port.send(`b1239${'11'.repeat(12)}\r`);
    await tick();
    expect(frames[0]).toMatchObject({ id: 0x123, flags: FLAG_FD | FLAG_BRS });
    expect(frames[0].data).toHaveLength(12);
    await adapter.stop();
  });

  it('fails with a message when the adapter refuses the data bitrate, or for one it has no code for', async () => {
    const port = new FakeSerialPort();
    port.answer = (command) => (command.startsWith('Y') ? '\x07' : '\r');
    const adapter = new SlcanAdapter(port, timing);
    await expect(adapter.start({ bitrate: 500_000, dataBitrate: 5_000_000, listenOnly: false }, recordingEvents().events, () => 0)).rejects.toThrow(
      'The adapter refused the CAN FD data bitrate. Only CAN FD adapters, such as a CANable 2, take it.',
    );
    expect(port.commands).toEqual(['C', 'S6', 'Y5', 'C']);
    await expect(adapter.start({ bitrate: 500_000, dataBitrate: 3_000_000, listenOnly: false }, recordingEvents().events, () => 0)).rejects.toThrow(
      "can't run a CAN FD data phase at 3000000 bit/s",
    );
  });

  it('sets custom bit timing with s in place of S<n>', async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    await adapter.start({ bitrate: 83_333, btr: '4b14', listenOnly: false }, recordingEvents().events, () => 0);
    expect(port.commands).toEqual(['C', 's4B14', 'Z1', 'O']);
    await adapter.stop();
  });

  it('fails with a message when the adapter refuses the bit timing', async () => {
    const port = new FakeSerialPort();
    port.answer = (command) => (command.startsWith('s') ? '\x07' : '\r');
    const adapter = new SlcanAdapter(port, timing);
    await expect(adapter.start({ bitrate: 125_000, btr: '031C', listenOnly: false }, recordingEvents().events, () => 0)).rejects.toThrow(
      /^The adapter refused the bit timing\./,
    );
    expect(port.closed).toBe(true);
    await expect(adapter.start({ bitrate: 125_000, btr: '31C', listenOnly: false }, recordingEvents().events, () => 0)).rejects.toThrow(
      'The bit timing must be four hex digits: BTR0 then BTR1.',
    );
  });

  it('rejects a bitrate slcan has no command for', async () => {
    const adapter = new SlcanAdapter(new FakeSerialPort(), timing);
    await expect(adapter.start({ bitrate: 83_333, listenOnly: true }, recordingEvents().events, () => 0)).rejects.toThrow("can't run at 83333 bit/s");
  });

  it('reports a BEL nobody asked for as a problem', async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    const { problems, events } = recordingEvents();
    await adapter.start({ bitrate: 500_000, listenOnly: true }, events, () => 0);
    port.send('\x07');
    await tick();
    expect(problems).toEqual(['The adapter reported an error.']);
    await adapter.stop();
  });

  it('ends the capture when the adapter is unplugged, and stops cleanly afterwards', async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    const { ends, frames, problems, events } = recordingEvents();
    await adapter.start({ bitrate: 500_000, listenOnly: true }, events, () => 0);
    port.send('t1230\r');
    await tick();
    port.unplug();
    await tick();
    expect(frames).toHaveLength(1);
    expect(ends).toEqual(['The adapter was disconnected.']);
    expect(problems).toEqual([]);
    const commandsBefore = port.commands.length;
    await adapter.stop();
    expect(port.commands).toHaveLength(commandsBefore);
    expect(port.closed).toBe(true);
  });

  it('starts again after a stop, as the sheet keeps the chosen adapter', async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0);
    port.send('t1230');
    await adapter.stop();

    const { frames, problems, events } = recordingEvents();
    await adapter.start({ bitrate: 250_000, listenOnly: true }, events, () => 0);
    expect(port.commands.slice(7)).toEqual(['C', 'S5', 'Z1', 'V', 'L']);
    port.send('t4561AA\r');
    await tick();
    expect(frames.map((f) => f.id)).toEqual([0x456]);
    expect(problems).toEqual([]);
    await adapter.stop();
    expect(port.closed).toBe(true);
  });

  it('lets the port go when a write hangs, and can start again', async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    port.hangWrites = true;
    const starting = adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0);
    await tick();
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(port.closed).toBe(true);
    await expect(starting).rejects.toThrow('The capture was stopped while the adapter started.');

    port.hangWrites = false;
    port.commands.length = 0;
    expect(await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0)).toEqual({ listenOnly: true });
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'V', 'L']);
    await adapter.stop();
  });

  it('closes a port that opens only after the start was stopped, without opening the bus', async () => {
    const port = new FakeSerialPort();
    const opened = port.delayOpen();
    const adapter = new SlcanAdapter(port, timing);
    const starting = adapter.start({ bitrate: 500_000, listenOnly: false }, recordingEvents().events, () => 0);
    await adapter.stop();
    await expect(adapter.start({ bitrate: 500_000, listenOnly: false }, recordingEvents().events, () => 0)).rejects.toThrow(
      'The adapter is still busy with the last try.',
    );

    opened();
    await expect(starting).rejects.toThrow('The capture was stopped while the adapter started.');
    expect(port.commands).not.toContain('O');
    expect(port.commands).not.toContain('S6');
    expect(port.closed).toBe(true);
  });

  it('reports no problem for a late BEL before the bus opens', async () => {
    const port = new FakeSerialPort();
    port.answer = (command) => (command === 'C' ? null : '\r');
    const adapter = new SlcanAdapter(port, { commandMs: 50, settleMs: 50 });
    const { problems, events } = recordingEvents();
    const starting = adapter.start({ bitrate: 500_000, listenOnly: false }, events, () => 0);
    // Past the 50 ms wait for an answer to C, within the pause after it.
    await new Promise((resolve) => setTimeout(resolve, 75));
    port.send('\x07');
    await starting;
    expect(problems).toEqual([]);
    await adapter.stop();
  });

  it('writes C and Z0 before closing the port on a stop, even over a slow link', async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    await adapter.start({ bitrate: 500_000, listenOnly: false }, recordingEvents().events, () => 0);
    port.writeDelayMs = 20;
    const close = port.close.bind(port);
    let commandsAtClose: string[] = [];
    port.close = async () => {
      commandsAtClose = [...port.commands];
      await close();
    };
    await adapter.stop();
    expect(commandsAtClose).toEqual(['C', 'S6', 'Z1', 'O', 'C', 'Z0']);
    expect(port.closed).toBe(true);
  });

  it('says an adapter whose earlier open never finished is still busy', async () => {
    const port = new FakeSerialPort();
    port.openError = new DOMException('A call to open() is already in progress.', 'InvalidStateError');
    const adapter = new SlcanAdapter(port, timing);
    await expect(adapter.start({ bitrate: 500_000, listenOnly: false }, recordingEvents().events, () => 0)).rejects.toThrow(
      'The adapter is still busy with an earlier try (A call to open() is already in progress.). Unplug it, plug it back in, then choose it again.',
    );
  });

  it('stops only once, however often it is asked', async () => {
    const port = new FakeSerialPort();
    const adapter = new SlcanAdapter(port, timing);
    await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0);
    const close = vi.spyOn(port, 'close');
    await Promise.all([adapter.stop(), adapter.stop()]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(port.commands.filter((c) => c === 'C')).toHaveLength(2);
  });
});
