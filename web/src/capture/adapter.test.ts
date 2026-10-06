import { describe, expect, it } from 'vitest';
import { DeviceClock, MAX_AHEAD_OF_HOST_NS, MAX_BEHIND_HOST_NS, REANCHOR_AFTER_NS } from './adapter';

/** Whether each time is later than the one before. */
function rising(times: number[]): boolean {
  return times.every((t, i) => i === 0 || t > times[i - 1]);
}

/**
 * An slcan capture of a frame every 10 ms, each arriving 1 ms after it was sent, where the
 * computer sleeps at 100 s while the adapter counts on for `sleptS`.
 */
function captureAcrossSleep(sleptS: number) {
  const messages: string[] = [];
  const clock = new DeviceClock(60e9, (message) => messages.push(message));
  clock.sync(0, 0);
  const frames: { hostNs: number; timeNs: number }[] = [];
  for (let ms = 10; ms <= 110_000; ms += 10) {
    const deviceNs = (ms * 1e6 + (ms > 100_000 ? sleptS * 1e9 : 0)) % 60e9;
    const hostNs = ms * 1e6 + 1e6;
    frames.push({ hostNs, timeNs: clock.time(deviceNs, hostNs) });
  }
  return { frames, messages };
}

/** The furthest any frame arriving from `fromNs` on is timed from its arrival. */
function furthestFromArrival(frames: { hostNs: number; timeNs: number }[], fromNs: number): number {
  return Math.max(...frames.filter((f) => f.hostNs >= fromNs).map((f) => Math.abs(f.timeNs - f.hostNs)));
}

describe('DeviceClock', () => {
  it('leaves times before the frames arrived as the adapter stamped them', () => {
    const clock = new DeviceClock(60e9);
    clock.sync(10e9, 0);
    expect(clock.time(10.5e9, 0.7e9)).toBe(0.5e9);
    expect(clock.time(11.2e9, 1.5e9)).toBe(1.2e9);
  });

  it('follows an adapter clock that runs 500 ppm fast for 3 hours, short of the cap and rising, without re-anchoring', () => {
    const messages: string[] = [];
    const clock = new DeviceClock(60e9, (message) => messages.push(message));
    clock.sync(0, 0);
    const times: number[] = [];
    let maxAheadNs = -Infinity;
    for (let s = 1; s <= 3 * 3600; s++) {
      // Each frame arrives a millisecond after it was sent.
      const hostNs = s * 1e9 + 1e6;
      const timeNs = clock.time((s * 1.0005e9) % 60e9, hostNs);
      times.push(timeNs);
      maxAheadNs = Math.max(maxAheadNs, timeNs - hostNs);
    }
    // Unslewed, the last frame would be 5.4 s ahead.
    expect(maxAheadNs).toBeLessThanOrEqual(0);
    expect(rising(times)).toBe(true);
    expect(messages).toEqual([]);
  });

  it('re-anchors an adapter clock that runs 500 ppm slow each time it falls too far behind', () => {
    const messages: string[] = [];
    const clock = new DeviceClock(60e9, (message) => messages.push(message));
    clock.sync(0, 0);
    const times: number[] = [];
    let maxBehindNs = 0;
    for (let s = 1; s <= 3 * 3600; s++) {
      const hostNs = s * 1e9 + 1e6;
      const timeNs = clock.time((s * 0.9995e9) % 60e9, hostNs);
      times.push(timeNs);
      maxBehindNs = Math.max(maxBehindNs, hostNs - timeNs);
    }
    // Not re-anchored, the last frame would be 5.4 s behind.
    expect(messages).toHaveLength(2);
    expect(maxBehindNs).toBeLessThan(MAX_BEHIND_HOST_NS + 0.01e9);
    expect(rising(times)).toBe(true);
  });

  it('pulls back an anchor taken late, as slcan takes it from the first chunk to arrive', () => {
    const clock = new DeviceClock(60e9);
    // The first frame arrives 50 ms after it was sent, the rest 1 ms after.
    expect(clock.time(0, 50e6)).toBe(50e6);
    // 1000 ppm of 10 ms.
    expect(clock.time(10e6, 11e6)).toBe(60e6 - 10e3);
    const times: number[] = [];
    let hostNs = 0;
    for (let ms = 20; ms <= 60_000; ms += 10) {
      hostNs = ms * 1e6 + 1e6;
      times.push(clock.time((ms * 1e6) % 60e9, hostNs));
    }
    expect(times.at(-1)! - hostNs).toBeCloseTo(0, 0);
    expect(rising(times)).toBe(true);
  });

  it('slews by the adapter time past the latest seen, so a frame stamped in the past keeps the next in order', () => {
    const clock = new DeviceClock(60e9);
    clock.sync(0, 0.5e9);
    const before = clock.time(10e9, 10e9);
    clock.time(5e9, 10.1e9);
    expect(clock.time(10.001e9, 10.2e9)).toBeGreaterThan(before);
  });

  it('holds a time more than a second ahead to a second past the host clock, leaving the anchor and slew alone', () => {
    const messages: string[] = [];
    const glitched = new DeviceClock(60e9, (message) => messages.push(message));
    const clean = new DeviceClock(60e9);
    glitched.sync(0, 0);
    clean.sync(0, 0);
    expect(glitched.time(1e9, 1e9 - 0.5e6)).toBe(clean.time(1e9, 1e9 - 0.5e6));
    // Nearly half a wrap ahead, as far as unwrapping can put it.
    expect(glitched.time(31e9, 1.5e9)).toBe(1.5e9 + MAX_AHEAD_OF_HOST_NS);
    expect(glitched.time(2e9, 2e9 - 1e6)).toBe(clean.time(2e9, 2e9 - 1e6));
    expect(glitched.time(3e9, 3e9 - 2e6)).toBe(clean.time(3e9, 3e9 - 2e6));
    expect(glitched.time(10e9, 10e9 - 1e6)).toBe(clean.time(10e9, 10e9 - 1e6));
    expect(messages).toEqual([]);
  });

  it('re-anchors once frames have been held for a while, as after a sleep of 10 s, keeping times rising', () => {
    const { frames, messages } = captureAcrossSleep(10);
    expect(messages).toEqual(["The adapter's clock was 10.0 s ahead of the computer's, so frames are timed from the computer's clock again."]);
    const held = frames.filter((f) => f.hostNs > 100.001e9 && f.hostNs < 100.001e9 + REANCHOR_AFTER_NS);
    expect(held.every((f) => f.timeNs === f.hostNs + MAX_AHEAD_OF_HOST_NS)).toBe(true);
    // Once past the last held frame's time, frames follow the adapter's clock from their arrival.
    expect(furthestFromArrival(frames, 100.001e9 + REANCHOR_AFTER_NS + MAX_AHEAD_OF_HOST_NS + 0.1e9)).toBeLessThanOrEqual(1e6);
    expect(rising(frames.map((f) => f.timeNs))).toBe(true);
  });

  it('re-anchors frames that fell behind for good, as when a sleep of 40 s folds into the 60 s wrap', () => {
    const { frames, messages } = captureAcrossSleep(40);
    expect(messages).toEqual(["The adapter's clock was 20.0 s behind the computer's, so frames are timed from the computer's clock again."]);
    const reanchoredAt = frames.findIndex((f) => f.hostNs >= 100.011e9 + REANCHOR_AFTER_NS);
    const before = frames.slice(0, reanchoredAt);
    const after = frames.slice(reanchoredAt);
    expect(before.at(-1)!.hostNs - before.at(-1)!.timeNs).toBeCloseTo(20e9, -7);
    expect(after[0].timeNs).toBeGreaterThan(Math.max(...before.map((f) => f.timeNs)));
    expect(rising(after.map((f) => f.timeNs))).toBe(true);
    expect(furthestFromArrival(after, 0)).toBeLessThanOrEqual(1e6);
  });

  it('keeps the adapter times of frames read late after the page stalled for 3 s', () => {
    const messages: string[] = [];
    const clock = new DeviceClock(60e9, (message) => messages.push(message));
    clock.sync(0, 0);
    const times: number[] = [];
    for (let ms = 10; ms <= 60_000; ms += 10) {
      // Frames sent from 30 s to 33 s are read together as the stall ends.
      const hostNs = ms >= 30_000 && ms < 33_000 ? 33.001e9 : ms * 1e6 + 1e6;
      times.push(clock.time(ms * 1e6, hostNs));
    }
    expect(messages).toEqual([]);
    expect(times).toEqual(times.map((_, i) => (i + 1) * 10e6));
  });
});
