import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  coverage,
  describeOffset,
  formatClock,
  logTimeOf,
  nudgeOffset,
  offsetKey,
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

  const log = { name: 'demo.log', bytes: 55_000_000 };
  const dash = { name: 'dash.mp4', size: 1000, lastModified: 1 };

  it('keeps an offset per log and video', () => {
    rememberOffset(offsetKey(log, dash), 3.2);
    rememberOffset(offsetKey(log, { ...dash, name: 'other.mp4' }), -1);
    expect(rememberedOffset(offsetKey(log, dash))).toBe(3.2);
    expect(rememberedOffset(offsetKey(log, { ...dash, name: 'other.mp4' }))).toBe(-1);
    expect(rememberedOffset(offsetKey({ ...log, name: 'other.log' }, dash))).toBeNull();
    rememberOffset(offsetKey(log, dash), null);
    expect(rememberedOffset(offsetKey(log, dash))).toBeNull();
  });

  it('tells apart files that share a name', () => {
    rememberOffset(offsetKey(log, dash), 3.2);
    // A dashcam starts its numbering again on a new card; a log can be recorded again too.
    expect(rememberedOffset(offsetKey(log, { ...dash, size: 2000 }))).toBeNull();
    expect(rememberedOffset(offsetKey(log, { ...dash, lastModified: 2 }))).toBeNull();
    expect(rememberedOffset(offsetKey({ ...log, bytes: 1 }, dash))).toBeNull();
  });

  it('keeps only the most recent pairs', () => {
    for (let i = 0; i < 60; i++) rememberOffset(offsetKey({ name: `log${i}`, bytes: 1 }, dash), i);
    expect(rememberedOffset(offsetKey({ name: 'log0', bytes: 1 }, dash))).toBeNull();
    expect(rememberedOffset(offsetKey({ name: 'log59', bytes: 1 }, dash))).toBe(59);
  });

  it('carries on when storage is unusable', () => {
    localStorage.setItem('freecan-studio.video-offsets', '{not json');
    expect(rememberedOffset(offsetKey(log, dash))).toBeNull();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    expect(() => rememberOffset(offsetKey(log, dash), 1)).not.toThrow();
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
    session.open(new File(['a'], 'a.mp4', { type: 'video/mp4' }), { name: 'demo.log', bytes: 100 });
    expect(session.get()).toMatchObject({ name: 'a.mp4', url: 'blob:video-1', offset: null });
    session.open(new File(['b'], 'b.mp4', { type: 'video/mp4' }), { name: 'demo.log', bytes: 100 });
    expect(urls).toEqual(['blob:video-1']);
    session.close();
    expect(urls).toEqual(['blob:video-1', 'blob:video-2']);
    expect(session.get()).toBeNull();
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it('remembers the synced offset, and nudges keep the synced one to reset to', () => {
    const session = new VideoSession();
    const file = new File(['a'], 'dash.mp4', { type: 'video/mp4' });
    session.open(file, { name: 'demo.log', bytes: 100 });
    session.sync(52.34 - 49.14);
    session.setOffset(3.3);
    expect(session.get()).toMatchObject({ offset: 3.3, syncedOffset: 3.2 });
    session.close();
    session.open(file, { name: 'demo.log', bytes: 100 });
    expect(session.get()).toMatchObject({ offset: 3.3, syncedOffset: 3.3 });
  });

  it('counts a log as loading until its task settles, even when it fails', async () => {
    const session = new VideoSession();
    let fail = (_: Error) => {};
    const loading = session.whileLoadingLog(() => new Promise<void>((_, reject) => (fail = reject)));
    expect(session.isLoadingLog()).toBe(true);
    fail(new Error('bad log'));
    await expect(loading).rejects.toThrow('bad log');
    expect(session.isLoadingLog()).toBe(false);
  });

  it('knows a video file by its type or name', () => {
    expect(isVideoFile(new File([], 'clip.bin', { type: 'video/webm' }))).toBe(true);
    expect(isVideoFile(new File([], 'Dash.MOV'))).toBe(true);
    expect(isVideoFile(new File([], 'drive.log'))).toBe(false);
    expect(isVideoFile(new File([], 'car.dbc'))).toBe(false);
  });
});
