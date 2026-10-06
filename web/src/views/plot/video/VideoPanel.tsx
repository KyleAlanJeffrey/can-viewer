import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Check, Circle, Link2, Lock, PanelRight, Pause, PictureInPicture2, Play, StepBack, StepForward, X } from 'lucide-react';
import { formatSeconds } from '../model';
import { coverage, describeOffset, formatClock, logTimeOf, nudgeOffset, parseTime, videoTimeOf } from './sync';
import { AddVideoButton } from './AddVideoButton';
import { videoSession, type LoadedVideo } from './videoSession';
import { PANEL_ID, type ShownLayout, type VideoLayout } from './VideoWorkspace';

const STEP_S = 0.1;
const BIG_STEP_S = 1;
const PAGE_STEP_S = 10;
const NUDGE_S = 0.1;

// MediaError codes and a readyState; jsdom has no MediaError global.
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;
const HAVE_METADATA = 1;

/** Elements where Space already means something, so it must not also play or pause. */
const SPACE_TAKEN =
  'input:not([type="range"]), textarea, select, button, a[href], summary, [contenteditable]:not([contenteditable="false"]), [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="option"], [role="menuitem"], dialog[open]';

export function spaceIsTaken(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(SPACE_TAKEN) !== null;
}

function playbackError(code: number | undefined, name: string): string {
  if (code === MEDIA_ERR_SRC_NOT_SUPPORTED)
    return `This browser can\u2019t play ${name}: its format or codec isn\u2019t supported here. MP4 with H.264 video plays in every supported browser, so convert it to that and add it again.`;
  if (code === MEDIA_ERR_DECODE) return `${name} could not be decoded. The file may be damaged, or use a codec this browser can\u2019t play.`;
  return `${name} could not be read. Add it again.`;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * How far the video can be seeked: its duration, or for a file that doesn't state one (a WebM
 * from a screen recorder reports Infinity) the end of what can be seeked so far. Null if unknown.
 */
function knownEnd(media: HTMLMediaElement): number | null {
  if (Number.isFinite(media.duration)) return media.duration;
  const seekable = media.seekable;
  if (seekable && seekable.length > 0) {
    const end = seekable.end(seekable.length - 1);
    if (Number.isFinite(end) && end > 0) return end;
  }
  return null;
}

interface PanelProps {
  video: LoadedVideo;
  layout: ShownLayout;
  onLayout: (layout: VideoLayout) => void;
  style: CSSProperties | undefined;
  logDuration: number;
  cursor: number | null;
  onCursor: (t: number) => void;
}

export default function VideoPanel({ video, layout, onLayout, style, logDuration, cursor, onCursor }: PanelProps) {
  const mediaRef = useRef<HTMLVideoElement>(null);
  /** Whether the video's metadata has loaded. */
  const [loaded, setLoaded] = useState(false);
  /** Where the video can be seeked up to (see knownEnd); null while that isn't known. */
  const [end, setEnd] = useState<number | null>(null);
  const [current, setCurrent] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const { offset } = video;
  const linked = offset !== null && !syncing;
  const corner = layout === 'corner';
  const ready = loaded && !error;
  /** The video's span, for working out what the log covers; open-ended while unknown. */
  const span = end ?? Infinity;
  const syncButton = useRef<HTMLButtonElement>(null);
  /** Whether the current primary-button press started on the video, for telling a click on it from a stray one. */
  const pressedOnVideo = useRef(false);
  /** Set when the sync step closes, so focus goes back to the button that opened it. */
  const refocusSync = useRef(false);

  /** The cursor time the video last set, and under which offset, to tell its echo from a move in the plot. */
  const pushed = useRef<{ cursor: number; offset: number } | null>(null);
  // The animation loop and window listeners outlive renders; they read the current values here.
  const latest = useRef({ linked, offset, cursor, onCursor, logDuration });
  useLayoutEffect(() => {
    latest.current = { linked, offset, cursor, onCursor, logDuration };
  });

  /** Moves the plot cursor to where the video is, when the two are linked and the log covers that moment. */
  const follow = useCallback((videoTime: number) => {
    const { linked, offset, cursor, onCursor, logDuration } = latest.current;
    if (!linked || offset === null || cursor === null) return;
    const t = logTimeOf(videoTime, offset);
    if (coverage(t, logDuration) !== 'inside' || t === cursor) return;
    pushed.current = { cursor: t, offset };
    onCursor(t);
  }, []);

  const seek = (t: number, followCursor: boolean) => {
    const media = mediaRef.current;
    if (!media || !loaded) return;
    const to = clamp(t, 0, end ?? Infinity);
    media.currentTime = to;
    setCurrent(to);
    if (followCursor) follow(to);
  };

  const togglePlay = useCallback(() => {
    const media = mediaRef.current;
    if (!media || !ready) return;
    if (media.paused) {
      // play() rejects when a pause interrupts it, which needs no handling.
      void media.play()?.catch(() => {});
    } else {
      media.pause();
    }
  }, [ready]);

  // Plot cursor to video.
  useEffect(() => {
    const media = mediaRef.current;
    if (!media || !loaded || !linked || offset === null || cursor === null) return;
    const echo = pushed.current;
    if (echo && echo.cursor === cursor && echo.offset === offset) return;
    // Past the echo: a later offset change (a nudge, then Reset) must seek even back to this cursor.
    pushed.current = null;
    const t = videoTimeOf(cursor, offset);
    if (coverage(t, span) !== 'inside') {
      if (!media.paused) media.pause();
      return;
    }
    if (Math.abs(media.currentTime - t) < 5e-4) return;
    media.currentTime = t;
    setCurrent(t);
  }, [cursor, offset, linked, loaded, span]);

  // Video to plot cursor, once per animation frame while playing.
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const media = mediaRef.current;
      if (!media) return;
      setCurrent(media.currentTime);
      follow(media.currentTime);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, follow]);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== ' ' || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented || spaceIsTaken(e.target)) return;
      e.preventDefault();
      togglePlay();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay]);

  // Switching views unmounts the panel; the session keeps the position for when it comes back.
  useEffect(() => {
    const media = mediaRef.current;
    return () => {
      if (media && videoSession.get()?.url === video.url) videoSession.position = media.currentTime;
    };
  }, [video.url]);

  const onLoadedMetadata = () => {
    const media = mediaRef.current;
    if (!media) return;
    setError(null);
    const { linked, offset, cursor } = latest.current;
    // A linked cursor inside the video decides the frame; the effect above seeks there.
    const mediaEnd = knownEnd(media);
    const cursorDecides = linked && offset !== null && cursor !== null && coverage(videoTimeOf(cursor, offset), mediaEnd ?? Infinity) === 'inside';
    if (!cursorDecides && videoSession.position > 0) media.currentTime = Math.min(videoSession.position, mediaEnd ?? videoSession.position);
    setCurrent(media.currentTime);
    setEnd(mediaEnd);
    setLoaded(true);
  };

  /** Duration and seekable range can grow after the metadata, as an open-ended WebM loads. */
  const onRangeChange = () => {
    const media = mediaRef.current;
    if (media && loaded) setEnd(knownEnd(media));
  };

  // Back to the button that opened the sync step once it closes.
  useEffect(() => {
    if (syncing || !refocusSync.current) return;
    refocusSync.current = false;
    syncButton.current?.focus();
  }, [syncing]);

  const endSync = () => {
    refocusSync.current = true;
    setSyncing(false);
  };

  // A local file can load before React has mounted the element, and React drops events that come
  // that early, so catch up with what already happened.
  useEffect(() => {
    const media = mediaRef.current;
    if (!media) return;
    if (media.error) setError(playbackError(media.error.code, video.name));
    else if (media.readyState >= HAVE_METADATA) onLoadedMetadata();
    // Once, on mount; later loads arrive as events.
  }, []);

  const onPlaybackStopped = () => {
    setPlaying(false);
    const media = mediaRef.current;
    if (media) {
      setCurrent(media.currentTime);
      follow(media.currentTime);
    }
  };

  const onScrubKey = (e: KeyboardEvent<HTMLInputElement>) => {
    const step = e.shiftKey ? BIG_STEP_S : STEP_S;
    const targets: Record<string, number> = {
      ArrowLeft: current - step,
      ArrowDown: current - step,
      ArrowRight: current + step,
      ArrowUp: current + step,
      PageDown: current - PAGE_STEP_S,
      PageUp: current + PAGE_STEP_S,
      Home: 0,
      End: end ?? current,
    };
    if (!(e.key in targets)) return;
    e.preventDefault();
    seek(targets[e.key], true);
  };

  // Firefox's "Pop out this video" button swallows the press on it, but the first time it shows
  // (with its text label) it lets the click through, which would also start the video.
  const onVideoClick = () => {
    if (pressedOnVideo.current) togglePlay();
    pressedOnVideo.current = false;
  };

  const startSync = () => {
    mediaRef.current?.pause();
    setSyncing(true);
  };

  // The cursor outside the video: the frame on screen would be the wrong one, so it is covered.
  let gap: string | null = null;
  // The video outside the log: it plays on, but the cursor can't follow.
  let beyond: string | null = null;
  if (linked && offset !== null && ready) {
    if (cursor !== null) {
      const where = coverage(videoTimeOf(cursor, offset), span);
      if (where === 'before') gap = `The cursor is before the video, which starts at ${formatSeconds(offset)} in the log.`;
      if (where === 'after') gap = `The cursor is past the end of the video, which ends at ${formatSeconds(logTimeOf(span, offset))} in the log.`;
    }
    const where = coverage(logTimeOf(current, offset), logDuration);
    if (where === 'before') beyond = `Before the log: it starts at ${formatClock(videoTimeOf(0, offset))} in the video.`;
    if (where === 'after') beyond = `Past the end of the log: it ends at ${formatClock(videoTimeOf(logDuration, offset))} in the video.`;
  }

  const endText = end !== null ? formatClock(end) : '--:--.---';
  const synced = offset !== null && !syncing;

  return (
    <section id={PANEL_ID} className={`pv-video ${layout}`} style={style} aria-label="Video">
      <header className="pv-video-head">
        <h2 className="pv-video-name" title={video.name}>
          {video.name}
        </h2>
        {/* One element for both states, so focus stays on it when it flips. */}
        <button
          className={corner ? 'icon-button' : 'button'}
          onClick={() => onLayout(corner ? 'docked' : 'corner')}
          disabled={syncing}
          aria-label={corner ? 'Dock video beside the plots' : undefined}
          title={corner ? 'Dock beside the plots' : undefined}
        >
          {corner ? <PanelRight size={16} strokeWidth={1.5} aria-hidden="true" /> : <PictureInPicture2 size={16} strokeWidth={1.5} aria-hidden="true" />}
          {!corner && 'Corner view'}
        </button>
        <button className={corner ? 'icon-button' : 'button'} onClick={() => videoSession.close()} aria-label="Close video" title="Close video">
          <X size={16} strokeWidth={1.5} aria-hidden="true" />
          {!corner && 'Close video'}
        </button>
      </header>

      <div className="pv-video-frame">
        <video
          ref={mediaRef}
          src={video.url}
          preload="auto"
          playsInline
          aria-label={`Video ${video.name}`}
          onPointerDown={(e) => {
            pressedOnVideo.current = e.button === 0;
          }}
          onPointerCancel={() => {
            pressedOnVideo.current = false;
          }}
          // A mouse dragged off the video won't click it. Touch and pen leave before their click, so they keep the press.
          onPointerLeave={(e) => {
            if (e.pointerType === 'mouse') pressedOnVideo.current = false;
          }}
          onClick={onVideoClick}
          onLoadedMetadata={onLoadedMetadata}
          onDurationChange={onRangeChange}
          onProgress={onRangeChange}
          onPlay={() => setPlaying(true)}
          onPause={onPlaybackStopped}
          onEnded={onPlaybackStopped}
          onError={(e) => setError(playbackError(e.currentTarget.error?.code, video.name))}
        />
        {error ? (
          <div className="pv-video-cover" role="alert">
            <p>{error}</p>
            <AddVideoButton log={video.log}>Choose another video&hellip;</AddVideoButton>
          </div>
        ) : (
          gap && (
            <div className="pv-video-cover" role="status">
              <p className="pv-video-cover-title">No video here</p>
              <p>{gap}</p>
            </div>
          )
        )}
        {!error && (
          <span className="pv-video-badge">
            {synced ? <Check size={14} strokeWidth={2} aria-hidden="true" /> : <Circle className="pv-video-ring" size={14} strokeWidth={1.75} aria-hidden="true" />}
            {synced ? 'Synced' : 'Not synced'}
          </span>
        )}
      </div>

      <div className="pv-video-scrub">
        {/* Without a known end there is no scale to scrub along; the step buttons still work. */}
        {end !== null && (
          <input
            type="range"
            min={0}
            max={end}
            step="any"
            value={Math.min(current, end)}
            disabled={!ready}
            aria-label="Video position"
            aria-valuetext={formatClock(current)}
            onChange={(e) => seek(Number(e.target.value), true)}
            onKeyDown={onScrubKey}
          />
        )}
        <span className="pv-video-clock">
          {formatClock(current)} / {endText}
        </span>
      </div>

      <div className="pv-video-controls">
        <button className="icon-button" onClick={(e) => seek(current - (e.shiftKey ? BIG_STEP_S : STEP_S), true)} disabled={!ready} aria-label="Back 0.1 s" title="Back 0.1 s (Shift: 1 s)">
          <StepBack size={16} strokeWidth={1.5} />
        </button>
        <button className="icon-button pv-video-play" onClick={togglePlay} disabled={!ready} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={18} strokeWidth={1.5} /> : <Play size={18} strokeWidth={1.5} />}
        </button>
        <button className="icon-button" onClick={(e) => seek(current + (e.shiftKey ? BIG_STEP_S : STEP_S), true)} disabled={!ready} aria-label="Forward 0.1 s" title="Forward 0.1 s (Shift: 1 s)">
          <StepForward size={16} strokeWidth={1.5} />
        </button>
        <span className="pv-video-hint">Space plays and pauses</span>
      </div>

      {beyond && (
        <p className="pv-video-beyond" role="status">
          {beyond}
        </p>
      )}

      {!corner &&
        !error &&
        (syncing ? (
          <SyncForm
            videoTime={current}
            end={end}
            playing={playing}
            cursor={cursor}
            logDuration={logDuration}
            onSeekVideo={(t) => seek(t, false)}
            onCursor={onCursor}
            onCancel={endSync}
            onConfirm={(next) => {
              videoSession.sync(next);
              pushed.current = null;
              endSync();
            }}
          />
        ) : offset !== null ? (
          <div className="pv-video-sync">
            <p className="pv-video-offset">{describeOffset(offset)}</p>
            <div className="pv-video-actions">
              <button className="button" onClick={() => videoSession.setOffset(nudgeOffset(offset, -NUDGE_S))} aria-label="-0.1 s, video earlier" title="Start the video 0.1 s earlier against the log">
                -0.1 s
              </button>
              <button className="button" onClick={() => videoSession.setOffset(nudgeOffset(offset, NUDGE_S))} aria-label="+0.1 s, video later" title="Start the video 0.1 s later against the log">
                +0.1 s
              </button>
              <button
                className="button"
                onClick={() => video.syncedOffset !== null && videoSession.setOffset(video.syncedOffset)}
                disabled={video.syncedOffset === null || video.syncedOffset === offset}
                title="Undo the nudges, back to the synced offset"
              >
                Reset
              </button>
              <button ref={syncButton} className="button" onClick={startSync} disabled={!ready}>
                Re-sync&hellip;
              </button>
            </div>
            <p className="pv-video-note">
              <Link2 size={14} strokeWidth={1.75} aria-hidden="true" />
              {cursor === null ? 'Plot a signal to follow the video on the log.' : 'The plot cursor seeks the video, and playback moves the cursor.'}
            </p>
          </div>
        ) : (
          <div className="pv-video-sync">
            <p className="pv-video-offset">Not synced yet</p>
            <p className="pv-video-note">Line the video up with the log, and the plot cursor and the video move together.</p>
            <div className="pv-video-actions">
              <button ref={syncButton} className="button" onClick={startSync} disabled={!ready}>
                Sync with log&hellip;
              </button>
            </div>
          </div>
        ))}

      {!corner && (
        <p className="pv-video-privacy">
          <Lock size={13} strokeWidth={1.75} aria-hidden="true" />
          Video stays on this computer. Never uploaded.
        </p>
      )}
    </section>
  );
}

interface SyncFormProps {
  videoTime: number;
  /** The end of the video, or null while unknown. */
  end: number | null;
  /** While the video plays, the offset preview changes every frame and is not announced. */
  playing: boolean;
  cursor: number | null;
  logDuration: number;
  onSeekVideo: (t: number) => void;
  onCursor: (t: number) => void;
  onCancel: () => void;
  onConfirm: (offset: number) => void;
}

/** Pairs a moment in the video with the same moment in the log. Each field follows its source until typed in. */
function SyncForm({ videoTime, end, playing, cursor, logDuration, onSeekVideo, onCursor, onCancel, onConfirm }: SyncFormProps) {
  const [videoText, setVideoText] = useState<string | null>(null);
  const [logText, setLogText] = useState<string | null>(null);
  const [logPoint, setLogPoint] = useState<number | null>(cursor);
  const [videoError, setVideoError] = useState<string | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const videoField = useRef<HTMLInputElement>(null);
  const videoEnd = end ?? Infinity;

  useEffect(() => videoField.current?.focus(), []);

  // Clicking in the plot picks the log point, over anything typed.
  useEffect(() => {
    if (cursor === null) return;
    setLogPoint(cursor);
    setLogText(null);
    setLogError(null);
  }, [cursor]);

  /** Applies what was typed in the video field: the video's time, or null if it is invalid. */
  const commitVideo = (): number | null => {
    if (videoText === null) return videoTime;
    const t = parseTime(videoText);
    if (t === null || t > videoEnd) {
      setVideoError(end === null ? 'Enter a video time such as 00:49.140.' : `Enter a video time from 00:00.000 to ${formatClock(end)}.`);
      return null;
    }
    setVideoError(null);
    setVideoText(null);
    onSeekVideo(t);
    return t;
  };

  /** Applies what was typed in the log field: the log point, or null if there is none or it is invalid. */
  const commitLog = (): number | null => {
    if (logText === null) return logPoint;
    const t = parseTime(logText);
    if (t === null || t > logDuration) {
      setLogError(`Enter a log time from 0 to ${logDuration.toFixed(3)} s.`);
      return null;
    }
    setLogError(null);
    setLogText(null);
    setLogPoint(t);
    if (cursor !== null) onCursor(t);
    return t;
  };

  const confirm = () => {
    const v = commitVideo();
    const l = commitLog();
    if (v !== null && l !== null) onConfirm(l - v);
  };

  const fieldKeys = (commit: () => unknown, revert: () => void) => (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') {
      // Escape here only undoes the typing; it shouldn't also unpin the cursor.
      e.stopPropagation();
      revert();
    }
  };

  const offset = logPoint !== null ? logPoint - videoTime : null;
  const canConfirm = logPoint !== null || logText !== null;

  return (
    <section className="pv-video-syncform" aria-labelledby="pv-sync-title">
      <h3 id="pv-sync-title" className="pv-video-sync-title">
        Sync video with your log
      </h3>
      <p id="pv-sync-help" className="pv-video-note">
        Find a moment you can see in both (e.g. the brake light coming on), pause the video there, click the matching point in the log.
      </p>
      <ol className="pv-video-steps">
        <li>
          <label htmlFor="pv-sync-video">Pause video at</label>
          <div className="pv-video-field">
            <input
              ref={videoField}
              id="pv-sync-video"
              className="input mono"
              inputMode="decimal"
              autoComplete="off"
              value={videoText ?? formatClock(videoTime)}
              aria-invalid={videoError ? true : undefined}
              aria-describedby={videoError ? 'pv-sync-video-error' : 'pv-sync-help'}
              onChange={(e) => setVideoText(e.target.value)}
              onBlur={commitVideo}
              onKeyDown={fieldKeys(commitVideo, () => {
                setVideoText(null);
                setVideoError(null);
              })}
            />
            {videoError && (
              <p id="pv-sync-video-error" className="field-error">
                {videoError}
              </p>
            )}
          </div>
        </li>
        <li>
          <label htmlFor="pv-sync-log">Choose log point</label>
          <div className="pv-video-field">
            <span className="pv-video-unit">
              <input
                id="pv-sync-log"
                className="input mono"
                inputMode="decimal"
                autoComplete="off"
                placeholder={cursor === null ? 'Seconds' : undefined}
                value={logText ?? (logPoint !== null ? logPoint.toFixed(3) : '')}
                aria-invalid={logError ? true : undefined}
                aria-describedby={logError ? 'pv-sync-log-error' : 'pv-sync-help'}
                onChange={(e) => setLogText(e.target.value)}
                onBlur={commitLog}
                onKeyDown={fieldKeys(commitLog, () => {
                  setLogText(null);
                  setLogError(null);
                })}
              />
              <span aria-hidden="true">s</span>
            </span>
            {logError && (
              <p id="pv-sync-log-error" className="field-error">
                {logError}
              </p>
            )}
          </div>
        </li>
      </ol>
      <p className="pv-video-offset" aria-live={playing ? 'off' : 'polite'}>
        {offset !== null ? describeOffset(offset) : 'Choose the log point to see the offset.'}
      </p>
      <div className="pv-video-actions end">
        <button className="button" onClick={onCancel}>
          Cancel
        </button>
        <button className="button" onClick={confirm} disabled={!canConfirm}>
          Confirm sync
        </button>
      </div>
    </section>
  );
}
