import { describe, expect, it } from 'vitest';
import { DeviceClock, MAX_AHEAD_OF_HOST_NS, REANCHOR_AFTER_NS } from './adapter';

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

  it.each([
    [500, 6, 12e6],
    [100, 12, 5e6],
  ])('follows an adapter clock that runs %i ppm slow for %i hours by slewing forward, without re-anchoring', (ppm, hours, maxBehindNs) => {
    const messages: string[] = [];
    const clock = new DeviceClock(60e9, (message) => messages.push(message));
    clock.sync(0, 0);
    const times: number[] = [];
    let behindNs = 0;
    for (let s = 1; s <= hours * 3600; s++) {
      // Each frame arrives a millisecond after it was sent.
      const hostNs = s * 1e9 + 1e6;
      const timeNs = clock.time((s * (1e9 - ppm * 1e3)) % 60e9, hostNs);
      times.push(timeNs);
      behindNs = Math.max(behindNs, hostNs - timeNs);
    }
    // Unslewed, the last frame would be 10.8 s and 4.3 s behind.
    expect(behindNs).toBeLessThan(maxBehindNs);
    expect(messages).toEqual([]);
    expect(rising(times)).toBe(true);
  });

  it.each([
    [20, 500e6],
    [99, 300e6],
  ])('keeps following an adapter clock that runs slow when %i%% of frames arrive up to %d ns late', (percentLate, maxLateNs) => {
    const messages: string[] = [];
    const clock = new DeviceClock(60e9, (message) => messages.push(message));
    clock.sync(0, 0);
    let seed = 1;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    let behindNs = 0;
    for (let ms = 10; ms <= 3600_000; ms += 10) {
      const sentNs = ms * 1e6;
      const latencyNs = random() * 100 < percentLate ? 1e6 + random() * maxLateNs : 1e6;
      const timeNs = clock.time((sentNs * (1 - 100e-6)) % 60e9, sentNs + latencyNs);
      behindNs = Math.max(behindNs, sentNs - timeNs);
    }
    expect(messages).toEqual([]);
    expect(behindNs).toBeLessThan(5e6);
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

  it('leaves the anchor alone for two glitches in a row on a quiet bus', () => {
    const messages: string[] = [];
    const clock = new DeviceClock(60e9, (message) => messages.push(message));
    clock.sync(0, 0);
    expect(clock.time(1e9, 1e9)).toBe(1e9);
    expect(clock.time(25e9, 5e9)).toBe(5e9 + MAX_AHEAD_OF_HOST_NS);
    expect(clock.time(28e9, 8e9)).toBe(8e9 + MAX_AHEAD_OF_HOST_NS);
    expect(clock.time(11e9, 11e9)).toBe(11e9);
    expect(messages).toEqual([]);
  });

  it('re-anchors once frames have been held for a while, as after a sleep of 10 s, keeping times rising', () => {
    const { frames, messages } = captureAcrossSleep(10);
    expect(messages).toEqual(["The adapter's clock was 10.0 s ahead of the computer's, so it was anchored to the computer's clock again."]);
    const held = frames.filter((f) => f.hostNs > 100.001e9 && f.hostNs < 100.001e9 + REANCHOR_AFTER_NS);
    expect(held.every((f) => f.timeNs === f.hostNs + MAX_AHEAD_OF_HOST_NS)).toBe(true);
    // Once past the last held frame's time, frames follow the adapter's clock from their arrival.
    expect(furthestFromArrival(frames, 100.001e9 + REANCHOR_AFTER_NS + MAX_AHEAD_OF_HOST_NS + 0.1e9)).toBeLessThanOrEqual(1e6);
    expect(rising(frames.map((f) => f.timeNs))).toBe(true);
  });

  it('re-anchors frames that fell behind for good, as when a sleep of 40 s folds into the 60 s wrap', () => {
    const { frames, messages } = captureAcrossSleep(40);
    expect(messages).toEqual(["The adapter's clock was 20.0 s behind the computer's, so it was anchored to the computer's clock again."]);
    const reanchoredAt = frames.findIndex((f) => f.hostNs >= 100.011e9 + REANCHOR_AFTER_NS);
    const before = frames.slice(0, reanchoredAt);
    const after = frames.slice(reanchoredAt);
    expect(before.at(-1)!.hostNs - before.at(-1)!.timeNs).toBeCloseTo(20e9, -7);
    expect(after[0].timeNs).toBeGreaterThan(Math.max(...before.map((f) => f.timeNs)));
    expect(rising(after.map((f) => f.timeNs))).toBe(true);
    expect(furthestFromArrival(after, 0)).toBeLessThanOrEqual(1e6);
  });

  it.each([
    ['all at once', (sentS: number) => (sentS < 33 ? 33.001 : null)],
    // Each 0.6 s of the backlog 0.25 s after the last, then what was sent meanwhile.
    ['over a second', (sentS: number) => (sentS < 33 ? 33.001 + 0.25 * Math.floor((sentS - 30) / 0.6) : sentS < 34 ? 34.002 : null)],
  ])('keeps the adapter times of frames read late after the page stalled for 3 s, read %s', (_, stalledArrivalS) => {
    const messages: string[] = [];
    const clock = new DeviceClock(60e9, (message) => messages.push(message));
    clock.sync(0, 0);
    const times: number[] = [];
    for (let ms = 10; ms <= 60_000; ms += 10) {
      const arrivalS = ms >= 30_000 ? stalledArrivalS(ms / 1000) : null;
      const hostNs = arrivalS === null ? ms * 1e6 + 1e6 : arrivalS * 1e9;
      times.push(clock.time(ms * 1e6, hostNs));
    }
    expect(messages).toEqual([]);
    expect(times).toEqual(times.map((_, i) => (i + 1) * 10e6));
  });
});
