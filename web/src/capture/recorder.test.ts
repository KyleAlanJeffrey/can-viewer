import { describe, expect, it, vi } from 'vitest';
import type { CaptureFrame, LogInfo } from '../core/api';
import { fakeCore, logInfo } from '../test/fixtures';
import type { CaptureAdapter, CaptureEvents } from './adapter';
import { CaptureRecorder, captureName } from './recorder';

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

describe('captureName', () => {
  it('names a capture by its local start time', () => {
    expect(captureName(new Date(2026, 9, 5, 14, 3, 9))).toBe('capture-20261005-140309.log');
  });
});
