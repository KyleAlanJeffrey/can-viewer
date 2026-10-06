import { describe, expect, it } from 'vitest';
import { DeviceClock, MAX_AHEAD_OF_HOST_NS } from './adapter';

/** Whether each time is later than the one before. */
function rising(times: number[]): boolean {
  return times.every((t, i) => i === 0 || t > times[i - 1]);
}

describe('DeviceClock', () => {
  it('leaves times before the frames arrived as the adapter stamped them', () => {
    const clock = new DeviceClock(60e9);
    clock.sync(10e9, 0);
    expect(clock.time(10.5e9, 0.7e9)).toBe(0.5e9);
    expect(clock.time(11.2e9, 1.5e9)).toBe(1.2e9);
  });

  it('follows an adapter clock that runs 500 ppm fast for 3 hours, short of the cap and rising', () => {
    const clock = new DeviceClock(60e9);
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
    const glitched = new DeviceClock(60e9);
    const clean = new DeviceClock(60e9);
    glitched.sync(0, 0);
    clean.sync(0, 0);
    expect(glitched.time(1e9, 1e9 - 0.5e6)).toBe(clean.time(1e9, 1e9 - 0.5e6));
    // Nearly half a wrap ahead, as far as unwrapping can put it.
    expect(glitched.time(31e9, 1.5e9)).toBe(1.5e9 + MAX_AHEAD_OF_HOST_NS);
    expect(glitched.time(2e9, 2e9 - 1e6)).toBe(clean.time(2e9, 2e9 - 1e6));
    expect(glitched.time(3e9, 3e9 - 2e6)).toBe(clean.time(3e9, 3e9 - 2e6));
  });
});
