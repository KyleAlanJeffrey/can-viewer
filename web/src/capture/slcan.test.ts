import { describe, expect, it, vi } from 'vitest';
import { FLAG_BRS, FLAG_FD, FLAG_RTR, type CaptureFrame } from '../core/api';
import { FakeSerialPort } from '../test/fakeSerial';
import type { CaptureEvents } from './adapter';
import { SlcanAdapter, SlcanParser, parseSlcanFrame, type SlcanEvent } from './slcan';

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
    expect(frame('r1238')).toEqual({ id: 0x123, extended: false, flags: FLAG_RTR, data: [] });
    expect(frame('R12345678' + '2')).toEqual({ id: 0x1234_5678, extended: true, flags: FLAG_RTR, data: [] });
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

  it("skips the adapter's own four-digit timestamp", () => {
    expect(frame('t1232DEADEA5F')).toEqual({ id: 0x123, extended: false, flags: 0, data: [0xde, 0xad] });
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
    expect(port.commands).toEqual(['C', 'S6', 'L']);

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
    expect(port.commands).toEqual(['C', 'S6', 'L', 'C']);
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
    expect(port.commands).toEqual(['C', command, 'O']);
  });

  it('opens normally when the adapter refuses listen-only', async () => {
    const port = new FakeSerialPort();
    port.answer = (command) => (command === 'L' ? '\x07' : '\r');
    const adapter = new SlcanAdapter(port, timing);
    expect(await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0)).toEqual({ listenOnly: false });
    expect(port.commands).toEqual(['C', 'S6', 'L', 'O']);
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

  it("fails with a message when nothing answers, as with a device that isn't slcan", async () => {
    const port = new FakeSerialPort();
    port.answer = () => null;
    const adapter = new SlcanAdapter(port, timing);
    await expect(adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0)).rejects.toThrow("The adapter didn't answer.");
    expect(port.closed).toBe(true);
  });

  it('fails with a message when the port is busy', async () => {
    const port = new FakeSerialPort();
    port.openError = new DOMException('Failed to open serial port.', 'NetworkError');
    const adapter = new SlcanAdapter(port, timing);
    await expect(adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0)).rejects.toThrow(
      "The adapter couldn't be opened (Failed to open serial port.). Close any other program or tab using it, then try again.",
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
    expect(port.commands.slice(4)).toEqual(['C', 'S5', 'L']);
    port.send('t4561AA\r');
    await tick();
    expect(frames.map((f) => f.id)).toEqual([0x456]);
    expect(problems).toEqual([]);
    await adapter.stop();
    expect(port.closed).toBe(true);
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
