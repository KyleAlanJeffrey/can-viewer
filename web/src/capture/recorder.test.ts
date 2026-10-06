import { describe, expect, it, vi } from 'vitest';
import type { CaptureFrame, LogInfo } from '../core/api';
import { fakeCore, logInfo } from '../test/fixtures';
import type { CaptureAdapter, CaptureEvents, StartedCapture } from './adapter';
import { CAPTURE_LIMITS, CaptureRecorder, captureFrameBytes, captureName } from './recorder';

const frame = (timeNs: number): CaptureFrame => ({ timeNs, id: 0x123, extended: false, flags: 0, data: new Uint8Array(0) });

/** An adapter the test drives through the events it was started with. */
function fakeAdapter(listenOnly = true) {
  const state: { events: CaptureEvents | null; clock: (() => number) | null } = { events: null, clock: null };
  const adapter: CaptureAdapter & { stop: ReturnType<typeof vi.fn> } = {
    label: 'Test adapter',
    start: vi.fn(async (_settings, events, clock) => {
      state.events = events;
      state.clock = clock;
      return { listenOnly };
    }),
    stop: vi.fn(async () => {}),
  };
  return { adapter, state };
}

function clock() {
  const c = { ms: 1000, now: () => c.ms, wallNow: () => 1_700_000_000_000 + c.ms };
  return c;
}

const settings = { bitrate: 500_000, listenOnly: true };

describe('CaptureRecorder', () => {
  it('starts the adapter, then the capture, and feeds batches of timed frames to the core', async () => {
    const { adapter, state } = fakeAdapter();
    const appended: CaptureFrame[][] = [];
    const core = fakeCore({
      startCapture: vi.fn((name: string) => Promise.resolve(logInfo({ name, format: 'capture', frames: 0 }))),
      appendFrames: vi.fn((frames: CaptureFrame[]) => {
        appended.push(frames);
        return Promise.resolve(logInfo({ format: 'capture', frames: appended.flat().length }));
      }),
      endCapture: vi.fn(() => Promise.resolve(logInfo({ format: 'capture', frames: 3 }))),
    });
    const time = clock();
    const recorder = new CaptureRecorder(core, adapter, 'capture.log', time, { intervalMs: 10 });

    const started = await recorder.start(settings);
    expect(started.listenOnly).toBe(true);
    expect(core.startCapture).toHaveBeenCalledWith('capture.log', 'can0', 1_700_000_001_000);

    time.ms = 1001.5;
    expect(state.clock!()).toBe(1_500_000);
    state.events!.onFrames([frame(1), frame(2)]);
    await new Promise((resolve) => setTimeout(resolve, 30));
    state.events!.onFrames([frame(3)]);
    expect(recorder.status().frames).toBe(3);

    const info: LogInfo = await recorder.stop();
    expect(info.frames).toBe(3);
    expect(appended.flat().map((f) => f.timeNs)).toEqual([1, 2, 3]);
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(core.endCapture).toHaveBeenCalledTimes(1);
  });

  it('leaves the core alone when the adapter fails to start', async () => {
    const adapter: CaptureAdapter = { label: 'x', start: () => Promise.reject(new Error('busy')), stop: async () => {} };
    const core = fakeCore({ startCapture: vi.fn() });
    await expect(new CaptureRecorder(core, adapter, 'c.log', clock()).start(settings)).rejects.toThrow('busy');
    expect(core.startCapture).not.toHaveBeenCalled();
  });

  it('stops the adapter when the core refuses the capture', async () => {
    const { adapter } = fakeAdapter();
    const core = fakeCore({ startCapture: () => Promise.reject(new Error('core gone')) });
    await expect(new CaptureRecorder(core, adapter, 'c.log', clock()).start(settings)).rejects.toThrow('core gone');
    expect(adapter.stop).toHaveBeenCalledTimes(1);
  });

  it('counts problems and reports the last one', async () => {
    const { adapter, state } = fakeAdapter();
    const core = fakeCore({ startCapture: () => Promise.resolve(logInfo()) });
    const recorder = new CaptureRecorder(core, adapter, 'c.log', clock());
    await recorder.start(settings);
    state.events!.onProblem('one');
    state.events!.onProblem('two');
    expect(recorder.status()).toMatchObject({ problems: 2, lastProblem: 'two' });
  });

  it('measures the frame rate over the last two seconds', async () => {
    const { adapter, state } = fakeAdapter();
    const core = fakeCore({ startCapture: () => Promise.resolve(logInfo()) });
    const time = clock();
    const recorder = new CaptureRecorder(core, adapter, 'c.log', time);
    await recorder.start(settings);
    expect(recorder.status().rate).toBeNull();
    for (let i = 0; i < 10; i++) {
      time.ms += 500;
      state.events!.onFrames(Array.from({ length: i < 5 ? 100 : 400 }, (_, n) => frame(n)));
      recorder.status();
    }
    const status = recorder.status();
    expect(status.elapsedS).toBe(5);
    expect(status.rate).toBe(800);
  });

  it('tells the app once when the adapter ends by itself', async () => {
    const { adapter, state } = fakeAdapter();
    const core = fakeCore({ startCapture: () => Promise.resolve(logInfo()) });
    const recorder = new CaptureRecorder(core, adapter, 'c.log', clock());
    const onEnd = vi.fn();
    recorder.onEnd = onEnd;
    await recorder.start(settings);
    state.events!.onEnd('The adapter was disconnected.');
    state.events!.onEnd('again');
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('The adapter was disconnected.');
  });

  it('tells the app when the core fails to take frames', async () => {
    const { adapter, state } = fakeAdapter();
    const core = fakeCore({ startCapture: () => Promise.resolve(logInfo()), appendFrames: () => Promise.reject(new Error('out of memory')) });
    const recorder = new CaptureRecorder(core, adapter, 'c.log', clock(), { intervalMs: 5 });
    const onEnd = vi.fn();
    recorder.onEnd = onEnd;
    await recorder.start(settings);
    state.events!.onFrames([frame(1)]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onEnd).toHaveBeenCalledWith('The capture stopped because the CAN core failed: out of memory');
  });
});

describe('CaptureRecorder status text', () => {
  it('leads with errors and listen-only, and keeps the whole status for the tooltip', async () => {
    const { adapter, state } = fakeAdapter(true);
    const time = clock();
    const recorder = new CaptureRecorder(fakeCore({ startCapture: () => Promise.resolve(logInfo()) }), adapter, 'c.log', time);
    await recorder.start(settings);
    state.events!.onFrames(Array.from({ length: 1500 }, (_, n) => frame(n)));
    state.events!.onProblem('bad line');
    recorder.status();
    time.ms += 83_000;
    const status = recorder.status();
    expect(recorder.text.summary(status)).toBe('1 error \u00b7 Listen only \u00b7 1,500 frames \u00b7 1:23 \u00b7 0/s');
    expect(recorder.text.title(status)).toBe(
      'Recording can0 from Test adapter at 500 kbit/s, listen only.\n1,500 frames at 0 frames/s in 1 min 23 s.\n1 error. The last: bad line',
    );
  });

  it('never says listen only for an adapter that did not confirm it', async () => {
    const { adapter, state } = fakeAdapter(false);
    const recorder = new CaptureRecorder(fakeCore({ startCapture: () => Promise.resolve(logInfo()) }), adapter, 'c.log', clock());
    await recorder.start(settings);
    state.events!.onFrames([frame(1)]);
    const status = recorder.status();
    expect(recorder.text.summary(status)).toBe('1 frame \u00b7 0:00');
    expect(recorder.text.title(status)).toMatch(/, not listen only\./);
  });

  it('stores the frames under the bus name chosen', async () => {
    const { adapter } = fakeAdapter();
    const core = fakeCore({ startCapture: vi.fn(() => Promise.resolve(logInfo())) });
    const recorder = new CaptureRecorder(core, adapter, 'c.log', clock());
    await recorder.start({ ...settings, bus: 'vehicle' });
    expect(core.startCapture).toHaveBeenCalledWith('c.log', 'vehicle', expect.any(Number));
    expect(recorder.text.title(recorder.status())).toMatch(/^Recording vehicle from Test adapter/);
  });
});

describe('CaptureRecorder start', () => {
  it('gives up on an adapter that never finishes starting, and stops it', async () => {
    const { adapter } = fakeAdapter();
    let finishStart: (started: StartedCapture) => void = () => {};
    adapter.start = vi.fn<CaptureAdapter['start']>(() => new Promise((resolve) => (finishStart = resolve)));
    const core = fakeCore({ startCapture: vi.fn(() => Promise.resolve(logInfo())) });
    const recorder = new CaptureRecorder(core, adapter, 'c.log', clock());
    recorder.startTimeoutMs = 20;
    await expect(recorder.start(settings)).rejects.toThrow("The adapter didn't start within 0.02 seconds. Unplug it, plug it back in and try again.");
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(core.startCapture).not.toHaveBeenCalled();

    // A start that settles after the timeout is ignored; the adapter itself closes the device.
    finishStart({ listenOnly: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(adapter.stop).toHaveBeenCalledTimes(1);
    expect(core.startCapture).not.toHaveBeenCalled();
  });
});

describe('CaptureRecorder limits', () => {
  it('warns as the capture grows, then stops it by itself, keeping the frames up to the limit', async () => {
    const { adapter, state } = fakeAdapter();
    const appended: CaptureFrame[] = [];
    const core = fakeCore({
      startCapture: () => Promise.resolve(logInfo()),
      appendFrames: vi.fn((frames: CaptureFrame[]) => {
        appended.push(...frames);
        return Promise.resolve(logInfo({ frames: appended.length }));
      }),
      endCapture: () => Promise.resolve(logInfo({ frames: appended.length })),
    });
    const each = captureFrameBytes(frame(0));
    const recorder = new CaptureRecorder(core, adapter, 'c.log', clock(), { intervalMs: 5 }, { warnBytes: 4 * each, maxBytes: 6 * each });
    const onEnd = vi.fn();
    recorder.onEnd = onEnd;
    await recorder.start(settings);

    state.events!.onFrames([frame(1), frame(2), frame(3)]);
    expect(recorder.status().nearLimit).toBe(false);
    state.events!.onFrames([frame(4)]);
    expect(recorder.status().nearLimit).toBe(true);
    expect(onEnd).not.toHaveBeenCalled();

    state.events!.onFrames([frame(5), frame(6), frame(7)]);
    state.events!.onFrames([frame(8)]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith('The capture stopped at 6 frames, before the app ran out of memory.');
    expect((await recorder.stop()).frames).toBe(6);
    expect(appended.map((f) => f.timeNs)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('counts each frame by its payload, so CAN FD frames reach the limit sooner', () => {
    const classic = { ...frame(0), data: new Uint8Array(8) };
    const fd = { ...frame(0), data: new Uint8Array(64) };
    expect(captureFrameBytes(fd)).toBeGreaterThan(2 * captureFrameBytes(classic));
    const maxFrames = (f: CaptureFrame) => Math.floor(CAPTURE_LIMITS.maxBytes / captureFrameBytes(f));
    expect(maxFrames(classic)).toBeGreaterThan(24_000_000);
    expect(maxFrames(fd)).toBeLessThan(10_000_000);
  });
});

describe('captureName', () => {
  it('names a capture by its local start time', () => {
    expect(captureName(new Date(2026, 9, 5, 14, 3, 9))).toBe('capture-20261005-140309.log');
  });
});
