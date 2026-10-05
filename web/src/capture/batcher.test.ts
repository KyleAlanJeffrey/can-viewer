import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureFrame } from '../core/api';
import { FrameBatcher } from './batcher';

const frame = (timeNs: number): CaptureFrame => ({ timeNs, id: 0x123, extended: false, flags: 0, data: new Uint8Array(0) });
const times = (batches: CaptureFrame[][]) => batches.map((b) => b.map((f) => f.timeNs));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FrameBatcher', () => {
  it('holds frames until started, then sends them every interval in one batch', async () => {
    const sent: CaptureFrame[][] = [];
    const batcher = new FrameBatcher(async (b) => void sent.push(b), () => {}, { intervalMs: 100 });
    batcher.add([frame(1), frame(2)]);
    await vi.advanceTimersByTimeAsync(500);
    expect(sent).toEqual([]);

    batcher.start();
    batcher.add([frame(3)]);
    await vi.advanceTimersByTimeAsync(99);
    expect(sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(times(sent)).toEqual([[1, 2, 3]]);

    await vi.advanceTimersByTimeAsync(300);
    expect(sent).toHaveLength(1);
    batcher.add([frame(4)]);
    await vi.advanceTimersByTimeAsync(100);
    expect(times(sent)).toEqual([[1, 2, 3], [4]]);
    await batcher.stop();
  });

  it('sends at once when enough frames are waiting', async () => {
    const sent: CaptureFrame[][] = [];
    const batcher = new FrameBatcher(async (b) => void sent.push(b), () => {}, { intervalMs: 1000, maxFrames: 3 });
    batcher.start();
    batcher.add([frame(1), frame(2)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toEqual([]);
    batcher.add([frame(3)]);
    await vi.advanceTimersByTimeAsync(0);
    expect(times(sent)).toEqual([[1, 2, 3]]);
    await batcher.stop();
  });

  it('sends one batch at a time, in order, even when a send is slow', async () => {
    const sent: CaptureFrame[][] = [];
    const finish: (() => void)[] = [];
    const batcher = new FrameBatcher(
      (b) =>
        new Promise<void>((resolve) => {
          sent.push(b);
          finish.push(resolve);
        }),
      () => {},
      { intervalMs: 100 },
    );
    batcher.start();
    batcher.add([frame(1)]);
    await vi.advanceTimersByTimeAsync(100);
    batcher.add([frame(2)]);
    await vi.advanceTimersByTimeAsync(100);
    batcher.add([frame(3)]);
    await vi.advanceTimersByTimeAsync(100);
    expect(times(sent)).toEqual([[1]]);
    finish[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(times(sent)).toEqual([[1], [2]]);
    finish[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(times(sent)).toEqual([[1], [2], [3]]);
    finish[2]();
    await batcher.stop();
  });

  it('sends the last frames when stopped, and nothing after', async () => {
    const sent: CaptureFrame[][] = [];
    const batcher = new FrameBatcher(async (b) => void sent.push(b), () => {}, { intervalMs: 100 });
    batcher.start();
    batcher.add([frame(1)]);
    await batcher.stop();
    expect(times(sent)).toEqual([[1]]);
    batcher.add([frame(2)]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(times(sent)).toEqual([[1]]);
  });

  it('reports a failed send once and sends nothing more', async () => {
    const onError = vi.fn();
    const send = vi.fn(() => Promise.reject(new Error('core gone')));
    const batcher = new FrameBatcher(send, onError, { intervalMs: 100 });
    batcher.start();
    batcher.add([frame(1)]);
    await vi.advanceTimersByTimeAsync(100);
    batcher.add([frame(2)]);
    await vi.advanceTimersByTimeAsync(300);
    await batcher.stop();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(new Error('core gone'));
    expect(batcher.pending).toBe(0);
  });
});
