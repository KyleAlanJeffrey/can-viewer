import { describe, expect, it } from 'vitest';
import { DeviceClock, MAX_AHEAD_OF_HOST_NS } from './adapter';

describe('DeviceClock', () => {
  it('leaves times at or a little past the host clock as the adapter stamped them', () => {
    const clock = new DeviceClock(60e9);
    clock.sync(10e9, 0);
    expect(clock.time(10.5e9, 0.7e9)).toBe(0.5e9);
    expect(clock.time(11.7e9, 0.8e9)).toBe(1.7e9);
    expect(clock.time(11.8e9, 0.8e9)).toBe(0.8e9 + MAX_AHEAD_OF_HOST_NS);
  });

  it('holds a time stamped far ahead to a second past the host clock, and times the next frames as before', () => {
    const clock = new DeviceClock(60e9);
    clock.sync(0, 0);
    expect(clock.time(2e9, 2e9)).toBe(2e9);
    // Half a wrap ahead is as far as unwrapping can put it.
    expect(clock.time(31.9e9, 2.1e9)).toBe(2.1e9 + MAX_AHEAD_OF_HOST_NS);
    expect(clock.time(2.2e9, 2.2e9)).toBe(2.2e9);
  });
});
