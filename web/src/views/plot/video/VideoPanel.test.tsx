import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreApi } from '../../../core/api';
import { fakeCore, logInfo, seriesInfo } from '../../../test/fixtures';
import { renderInShell } from '../../../test/shell';
import { ViewStateContext, ViewStateStore } from '../../shared/viewState';
import { PlotView } from '../PlotView';
import { rememberOffset } from './sync';
import { spaceIsTaken } from './VideoPanel';
import { VideoWorkspace } from './VideoWorkspace';
import { videoSession } from './videoSession';

// jsdom has <video> but no playback, so the media element is faked: times are plain fields, play()
// and pause() flip `paused` and fire their events, and frames run when a test says so.

interface MediaState {
  currentTime: number;
  paused: boolean;
  duration: number;
  error: { code: number } | null;
  seeks: number[];
}

const media = new WeakMap<HTMLMediaElement, MediaState>();
/** A duration here makes new elements start with their metadata already loaded. */
let preloadedDuration = NaN;
function stateOf(el: HTMLMediaElement): MediaState {
  let s = media.get(el);
  if (!s) {
    s = { currentTime: 0, paused: true, duration: preloadedDuration, error: null, seeks: [] };
    media.set(el, s);
  }
  return s;
}

const proto = HTMLMediaElement.prototype;
const faked = ['currentTime', 'paused', 'duration', 'readyState', 'error', 'play', 'pause'] as const;
const originals = new Map(faked.map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)]));

beforeAll(() => {
  Object.defineProperties(proto, {
    currentTime: {
      configurable: true,
      get(this: HTMLMediaElement) {
        return stateOf(this).currentTime;
      },
      set(this: HTMLMediaElement, t: number) {
        stateOf(this).currentTime = t;
        stateOf(this).seeks.push(t);
      },
    },
    paused: { configurable: true, get: function (this: HTMLMediaElement) { return stateOf(this).paused; } },
    duration: { configurable: true, get: function (this: HTMLMediaElement) { return stateOf(this).duration; } },
    readyState: { configurable: true, get: function (this: HTMLMediaElement) { return Number.isNaN(stateOf(this).duration) ? 0 : 4; } },
    error: { configurable: true, get: function (this: HTMLMediaElement) { return stateOf(this).error; } },
    play: {
      configurable: true,
      value(this: HTMLMediaElement) {
        stateOf(this).paused = false;
        this.dispatchEvent(new Event('play'));
        return Promise.resolve();
      },
    },
    pause: {
      configurable: true,
      value(this: HTMLMediaElement) {
        if (stateOf(this).paused) return;
        stateOf(this).paused = true;
        this.dispatchEvent(new Event('pause'));
      },
    },
  });
});

afterAll(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(proto, key, descriptor);
    else delete (proto as unknown as Record<string, unknown>)[key];
  }
});

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const revoked: string[] = [];

beforeEach(() => {
  localStorage.clear();
  frames = new Map();
  revoked.length = 0;
  let n = 0;
  URL.createObjectURL = () => `blob:video-${++n}`;
  URL.revokeObjectURL = (url: string) => void revoked.push(url);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    frames.set(++nextFrame, cb);
    return nextFrame;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => void frames.delete(id));
});

afterEach(() => {
  preloadedDuration = NaN;
  act(() => videoSession.close());
  vi.restoreAllMocks();
});

/** Runs the frames requested so far, as one animation frame. */
function runFrame() {
  const pending = [...frames.values()];
  frames = new Map();
  act(() => pending.forEach((cb) => cb(performance.now())));
}

const videoEl = () => document.querySelector('video')!;
const mediaState = () => stateOf(videoEl());

function loadMetadata(duration: number) {
  stateOf(videoEl()).duration = duration;
  act(() => {
    videoEl().dispatchEvent(new Event('loadedmetadata'));
  });
}

interface Harness {
  cursor: number | null;
  moveCursor: (t: number | null) => void;
}

/** The workspace with a stand-in for the plot cursor, which a test can read and move. */
async function renderWorkspace({ cursor = 20 as number | null, logDuration = 100, offset = null as number | null } = {}) {
  if (offset !== null) rememberOffset('demo.log', 'dash.mp4', offset);
  const harness = { cursor } as Harness;
  function Shell() {
    const [store] = useState(() => new ViewStateStore());
    const [t, setT] = useState<number | null>(cursor);
    harness.cursor = t;
    harness.moveCursor = (next) => act(() => setT(next));
    return (
      <ViewStateContext.Provider value={store}>
        <VideoWorkspace logDuration={logDuration} cursor={t} onCursor={setT}>
          <p>Plots</p>
        </VideoWorkspace>
      </ViewStateContext.Provider>
    );
  }
  const user = userEvent.setup();
  render(<Shell />);
  act(() => videoSession.open(new File(['x'], 'dash.mp4', { type: 'video/mp4' }), 'demo.log'));
  // The panel is loaded lazily.
  await screen.findByRole('region', { name: 'Video' });
  return { user, harness };
}

const panel = () => screen.getByRole('region', { name: 'Video' });

describe('Video sync', () => {
  it('pairs a paused video frame with a point in the log', async () => {
    const { user, harness } = await renderWorkspace({ cursor: 20 });
    loadMetadata(138.36);
    expect(within(panel()).getByText('Not synced')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Sync with log\u2026' }));
    const videoField = screen.getByRole('textbox', { name: 'Pause video at' });
    const logField = screen.getByRole('textbox', { name: 'Choose log point' });
    expect(logField).toHaveProperty('value', '20.000');

    await user.clear(videoField);
    await user.type(videoField, '0:49.14{Enter}');
    expect(mediaState().currentTime).toBeCloseTo(49.14);
    expect(videoField).toHaveProperty('value', '00:49.140');

    // Clicking in the plot moves the cursor, which picks the log point. The video stays put.
    harness.moveCursor(52.34);
    expect(logField).toHaveProperty('value', '52.340');
    expect(mediaState().currentTime).toBeCloseTo(49.14);
    expect(screen.getByText('Video starts 3.2 s after the log')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Confirm sync' }));
    expect(within(panel()).getByText('Synced')).toBeTruthy();
    expect(screen.getByText('Video starts 3.2 s after the log')).toBeTruthy();
    expect(videoSession.get()?.offset).toBe(3.2);
    expect(harness.cursor).toBe(52.34);
  });

  it('takes typed times, and says when one is out of range', async () => {
    const { user, harness } = await renderWorkspace({ cursor: 20 });
    loadMetadata(60);
    await user.click(screen.getByRole('button', { name: 'Sync with log\u2026' }));
    const videoField = screen.getByRole('textbox', { name: 'Pause video at' });
    const logField = screen.getByRole('textbox', { name: 'Choose log point' });

    await user.clear(videoField);
    await user.type(videoField, '75{Enter}');
    expect(videoField.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('Enter a video time from 00:00.000 to 01:00.000.')).toBeTruthy();
    await user.clear(videoField);
    await user.type(videoField, '10{Enter}');
    expect(videoField.getAttribute('aria-invalid')).toBeNull();

    // Typing the log point moves the plot cursor too.
    await user.clear(logField);
    await user.type(logField, '8.5 s{Enter}');
    expect(harness.cursor).toBe(8.5);
    expect(screen.getByText('Video starts 1.5 s before the log')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(within(panel()).getByText('Not synced')).toBeTruthy();
    expect(videoSession.get()?.offset).toBeNull();
  });

  it('seeks the video from the plot cursor, and playback moves the cursor', async () => {
    const { user, harness } = await renderWorkspace({ cursor: 52.34, offset: 3.2 });
    loadMetadata(138.36);
    expect(within(panel()).getByText('Synced')).toBeTruthy();
    expect(mediaState().currentTime).toBeCloseTo(49.14);

    harness.moveCursor(60);
    expect(mediaState().currentTime).toBeCloseTo(56.8);

    await user.click(screen.getByRole('button', { name: 'Play' }));
    expect(mediaState().paused).toBe(false);
    const seeks = mediaState().seeks.length;
    mediaState().currentTime = 70;
    runFrame();
    expect(harness.cursor).toBeCloseTo(73.2);
    mediaState().currentTime = 70.5;
    runFrame();
    expect(harness.cursor).toBeCloseTo(73.7);
    // The cursor following the video doesn't seek the video back.
    expect(mediaState().seeks.length).toBe(seeks);
    expect(screen.getByText('01:10.500', { exact: false })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Pause' }));
    expect(mediaState().paused).toBe(true);
    expect(frames.size).toBe(0);
  });

  it('covers the frame when the cursor is outside the video, rather than seeking there', async () => {
    const { harness } = await renderWorkspace({ cursor: 1, offset: 3.2 });
    loadMetadata(60);
    expect(screen.getByText('No video here')).toBeTruthy();
    expect(screen.getByText('The cursor is before the video, which starts at 3.200 s in the log.')).toBeTruthy();
    expect(mediaState().seeks).toEqual([]);

    harness.moveCursor(70);
    expect(screen.getByText('The cursor is past the end of the video, which ends at 63.200 s in the log.')).toBeTruthy();
    expect(mediaState().seeks).toEqual([]);

    harness.moveCursor(30);
    expect(screen.queryByText('No video here')).toBeNull();
    expect(mediaState().currentTime).toBeCloseTo(26.8);
  });

  it('keeps playing past the end of the log, but leaves the cursor at the log', async () => {
    const { user, harness } = await renderWorkspace({ cursor: 90, logDuration: 100, offset: 3.2 });
    loadMetadata(138.36);
    await user.click(screen.getByRole('button', { name: 'Play' }));
    mediaState().currentTime = 96;
    runFrame();
    expect(harness.cursor).toBeCloseTo(99.2);
    mediaState().currentTime = 98;
    runFrame();
    expect(harness.cursor).toBeCloseTo(99.2);
    expect(mediaState().paused).toBe(false);
    expect(screen.getByText('Past the end of the log: it ends at 01:36.800 in the video.')).toBeTruthy();
  });

  it('nudges the offset in tenths and resets to the synced one', async () => {
    const { user } = await renderWorkspace({ cursor: 52.34, offset: 3.2 });
    loadMetadata(138.36);
    const reset = screen.getByRole('button', { name: 'Reset' });
    expect(reset).toHaveProperty('disabled', true);

    await user.click(screen.getByRole('button', { name: 'Video 0.1 s later' }));
    expect(screen.getByText('Video starts 3.3 s after the log')).toBeTruthy();
    // The cursor holds still and the video shows the frame now matched to it.
    expect(mediaState().currentTime).toBeCloseTo(49.04);

    await user.click(screen.getByRole('button', { name: 'Video 0.1 s earlier' }));
    await user.click(screen.getByRole('button', { name: 'Video 0.1 s earlier' }));
    expect(screen.getByText('Video starts 3.1 s after the log')).toBeTruthy();
    await user.click(reset);
    expect(screen.getByText('Video starts 3.2 s after the log')).toBeTruthy();
    expect(reset).toHaveProperty('disabled', true);
  });

  it('plays and pauses on Space, unless a control has focus', async () => {
    const { user } = await renderWorkspace({ cursor: 20 });
    loadMetadata(60);
    await user.keyboard(' ');
    expect(mediaState().paused).toBe(false);
    await user.keyboard(' ');
    expect(mediaState().paused).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Sync with log\u2026' }));
    await user.click(screen.getByRole('textbox', { name: 'Choose log point' }));
    await user.keyboard(' ');
    expect(mediaState().paused).toBe(true);

    expect(spaceIsTaken(screen.getByRole('slider', { name: 'Video position' }))).toBe(false);
    expect(spaceIsTaken(screen.getByRole('button', { name: 'Cancel' }))).toBe(true);
    expect(spaceIsTaken(document.body)).toBe(false);
  });

  it('steps and scrubs with the keyboard', async () => {
    const { user } = await renderWorkspace({ cursor: 20 });
    loadMetadata(60);
    await user.click(screen.getByRole('button', { name: 'Forward 0.1 s' }));
    expect(mediaState().currentTime).toBeCloseTo(0.1);
    const scrubber = screen.getByRole('slider', { name: 'Video position' });
    scrubber.focus();
    await user.keyboard('{Shift>}{ArrowRight}{/Shift}{ArrowRight}');
    expect(mediaState().currentTime).toBeCloseTo(1.2);
    await user.keyboard('{End}');
    expect(mediaState().currentTime).toBe(60);
    await user.click(screen.getByRole('button', { name: 'Back 0.1 s' }));
    expect(mediaState().currentTime).toBeCloseTo(59.9);
    expect(scrubber.getAttribute('aria-valuetext')).toBe('00:59.900');
  });

  it('catches up with a video that loaded before the panel mounted', async () => {
    preloadedDuration = 60;
    await renderWorkspace();
    expect(screen.getByText('00:00.000 / 01:00.000')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' })).toHaveProperty('disabled', false);
  });

  it('explains a video this browser cannot play', async () => {
    await renderWorkspace();
    stateOf(videoEl()).error = { code: 4 };
    act(() => {
      videoEl().dispatchEvent(new Event('error'));
    });
    expect(screen.getByRole('alert').textContent).toContain('This browser can\u2019t play dash.mp4');
    expect(screen.getByRole('button', { name: 'Choose another video\u2026' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Play' })).toHaveProperty('disabled', true);
    expect(screen.queryByRole('button', { name: 'Sync with log\u2026' })).toBeNull();
  });

  it('pops to the corner and back, and closes', async () => {
    const { user } = await renderWorkspace();
    loadMetadata(60);
    expect(screen.getByRole('separator', { name: 'Resize video panel' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Corner view' }));
    expect(panel().classList.contains('corner')).toBe(true);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sync with log\u2026' })).toBeNull();
    // Docking again keeps the same video element, so playback isn't lost.
    const el = videoEl();
    await user.click(screen.getByRole('button', { name: 'Dock video beside the plots' }));
    expect(videoEl()).toBe(el);
    expect(screen.getByText('Video stays on this computer. Never uploaded.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Close video' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Video' })).toBeNull());
    expect(revoked).toEqual(['blob:video-1']);
    expect(screen.getByText('Plots')).toBeTruthy();
  });
});

describe('Video in the Plot view', () => {
  /** One plotted signal with a sample every second, worth the time plus 100. */
  function plotCore(): CoreApi {
    return fakeCore({
      seriesView: async (_handle, t0, t1) => {
        const xs = t0 === t1 ? [Math.floor(t0), Math.floor(t0) + 1] : [t0, t1];
        return [Float64Array.from(xs), Float64Array.from(xs, (x) => 100 + x)];
      },
    });
  }

  const readoutA = () => {
    const table = screen.getByRole('table', { name: 'Signal values at the cursors' });
    const row = within(table)
      .getAllByRole('row')
      .find((r) => within(r).queryByRole('rowheader')?.textContent === 'A');
    return within(row!).getAllByRole('cell')[0].textContent;
  };

  it('adds a video from the header, and playback moves cursor A', async () => {
    rememberOffset('demo.log', 'dash.mp4', 3.2);
    const { user } = renderInShell(PlotView, {
      core: plotCore(),
      log: logInfo({ name: 'demo.log', durationS: 100 }),
      plots: [{ id: '1:Speed', label: 'Speed', info: { ...seriesInfo(1, 'Speed'), unit: 'km/h' }, color: 'c1' }],
    });
    await waitFor(() => expect(readoutA()).toBe('33.333 s'));
    expect(screen.queryByRole('region', { name: 'Video' })).toBeNull();

    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept="video/*"]')!;
    expect(screen.getByRole('button', { name: 'Add video\u2026' })).toBeTruthy();
    await user.upload(input, new File(['x'], 'dash.mp4', { type: 'video/mp4' }));
    await screen.findByRole('region', { name: 'Video' });
    expect(screen.queryByRole('button', { name: 'Add video\u2026' })).toBeNull();

    loadMetadata(138.36);
    expect(mediaState().currentTime).toBeCloseTo(33.333 - 3.2);
    await user.click(screen.getByRole('button', { name: 'Play' }));
    mediaState().currentTime = 40;
    runFrame();
    await waitFor(() => expect(readoutA()).toBe('43.200 s'));
  });
});
