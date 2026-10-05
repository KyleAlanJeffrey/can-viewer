import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coverage,
  describeOffset,
  formatClock,
  logTimeOf,
  nudgeOffset,
  parseTime,
  rememberOffset,
  rememberedOffset,
  videoTimeOf,
} from './sync';
import { VideoSession, isVideoFile } from './videoSession';

describe('video offset maths', () => {
  it('maps video time to log time and back', () => {
    // The mockup's pair: video 49.140 s is log 52.340 s.
    expect(logTimeOf(49.14, 3.2)).toBeCloseTo(52.34);
    expect(videoTimeOf(52.34, 3.2)).toBeCloseTo(49.14);
    expect(videoTimeOf(logTimeOf(10, -2.5), -2.5)).toBeCloseTo(10);
  });

  it('says which way the video is offset', () => {
    expect(describeOffset(3.2)).toBe('Video starts 3.2 s after the log');
    expect(describeOffset(-0.25)).toBe('Video starts 0.25 s before the log');
    expect(describeOffset(0.0001)).toBe('Video and log start together');
    expect(describeOffset(52.34 - 49.14)).toBe('Video starts 3.2 s after the log');
  });

  it('nudges in tenths without gathering float noise', () => {
    let offset = 3.2;
    for (let i = 0; i < 7; i++) offset = nudgeOffset(offset, 0.1);
    expect(offset).toBe(3.9);
    for (let i = 0; i < 39; i++) offset = nudgeOffset(offset, -0.1);
    expect(offset).toBe(0);
    expect(Object.is(offset, -0)).toBe(false);
  });

  it('tells times inside a span from times before or after it', () => {
    expect(coverage(-0.001, 10)).toBe('before');
    expect(coverage(0, 10)).toBe('inside');
    expect(coverage(10, 10)).toBe('inside');
    expect(coverage(10.001, 10)).toBe('after');
    expect(coverage(1e9, Infinity)).toBe('inside');
  });
});

describe('video times as text', () => {
  it('formats a clock', () => {
    expect(formatClock(49.14)).toBe('00:49.140');
    expect(formatClock(138.36)).toBe('02:18.360');
    expect(formatClock(3723.5)).toBe('1:02:03.500');
    expect(formatClock(59.9996)).toBe('01:00.000');
    expect(formatClock(NaN)).toBe('--:--.---');
  });

  it('reads seconds and clocks', () => {
    expect(parseTime('49.14')).toBe(49.14);
    expect(parseTime(' 52.340 s ')).toBe(52.34);
    expect(parseTime('00:49.140')).toBeCloseTo(49.14);
    expect(parseTime('1:02:03.5')).toBeCloseTo(3723.5);
    expect(parseTime('.5')).toBe(0.5);
    expect(parseTime(formatClock(138.36))).toBeCloseTo(138.36);
  });

  it('rejects what is not a time', () => {
    for (const text of ['', 's', '-1', 'abc', '1:60', '1.5:20', '1:2:3:4', '1e3', '12..5']) expect(parseTime(text), text).toBeNull();
  });
});

describe('remembered offsets', () => {
  beforeEach(() => localStorage.clear());

  it('keeps an offset per log and video name', () => {
    rememberOffset('demo.log', 'dash.mp4', 3.2);
    rememberOffset('demo.log', 'other.mp4', -1);
    expect(rememberedOffset('demo.log', 'dash.mp4')).toBe(3.2);
    expect(rememberedOffset('demo.log', 'other.mp4')).toBe(-1);
    expect(rememberedOffset('other.log', 'dash.mp4')).toBeNull();
    rememberOffset('demo.log', 'dash.mp4', null);
    expect(rememberedOffset('demo.log', 'dash.mp4')).toBeNull();
  });

  it('keeps only the most recent pairs', () => {
    for (let i = 0; i < 60; i++) rememberOffset(`log${i}`, 'v.mp4', i);
    expect(rememberedOffset('log0', 'v.mp4')).toBeNull();
    expect(rememberedOffset('log59', 'v.mp4')).toBe(59);
  });

  it('carries on when storage is unusable', () => {
    localStorage.setItem('freecan-studio.video-offsets', '{not json');
    expect(rememberedOffset('demo.log', 'dash.mp4')).toBeNull();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => rememberOffset('demo.log', 'dash.mp4', 1)).not.toThrow();
    setItem.mockRestore();
  });
});

describe('video session', () => {
  let urls: string[];
  beforeEach(() => {
    localStorage.clear();
    urls = [];
    let n = 0;
    vi.stubGlobal('URL', Object.assign(class extends URL {}, {
      createObjectURL: () => `blob:video-${++n}`,
      revokeObjectURL: (url: string) => urls.push(url),
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('revokes the object URL when the video is replaced or closed', () => {
    const session = new VideoSession();
    const changes = vi.fn();
    session.subscribe(changes);
    session.open(new File(['a'], 'a.mp4', { type: 'video/mp4' }), 'demo.log');
    expect(session.get()).toMatchObject({ name: 'a.mp4', url: 'blob:video-1', offset: null });
    session.open(new File(['b'], 'b.mp4', { type: 'video/mp4' }), 'demo.log');
    expect(urls).toEqual(['blob:video-1']);
    session.close();
    expect(urls).toEqual(['blob:video-1', 'blob:video-2']);
    expect(session.get()).toBeNull();
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it('remembers the synced offset, and nudges keep the synced one to reset to', () => {
    const session = new VideoSession();
    const file = new File(['a'], 'dash.mp4', { type: 'video/mp4' });
    session.open(file, 'demo.log');
    session.sync(52.34 - 49.14);
    session.setOffset(3.3);
    expect(session.get()).toMatchObject({ offset: 3.3, syncedOffset: 3.2 });
    session.close();
    session.open(file, 'demo.log');
    expect(session.get()).toMatchObject({ offset: 3.3, syncedOffset: 3.3 });
  });

  it('knows a video file by its type or name', () => {
    expect(isVideoFile(new File([], 'clip.bin', { type: 'video/webm' }))).toBe(true);
    expect(isVideoFile(new File([], 'Dash.MOV'))).toBe(true);
    expect(isVideoFile(new File([], 'drive.log'))).toBe(false);
    expect(isVideoFile(new File([], 'car.dbc'))).toBe(false);
  });
});
