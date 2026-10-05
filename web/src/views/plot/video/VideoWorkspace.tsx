import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { useViewState } from '../../shared/viewState';
import { useVideo } from './videoSession';
import './video.css';

// Most sessions never add a video, so the panel loads when one is opened.
const VideoPanel = lazy(() => import('./VideoPanel'));

export type VideoLayout = 'docked' | 'corner';

const DEFAULT_PANEL_W = 420;
const MIN_PANEL_W = 280;
/** The plots keep at least this much width beside a docked video. */
const MIN_MAIN_W = 360;
const RESIZE_STEP = 16;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface WorkspaceProps {
  logDuration: number;
  /** Cursor A, or null while nothing is plotted. */
  cursor: number | null;
  onCursor: (t: number) => void;
  children: ReactNode;
}

/** The view's content with the video, if one is open, docked beside it or floating in the corner. */
export function VideoWorkspace({ logDuration, cursor, onCursor, children }: WorkspaceProps) {
  const video = useVideo();
  const [layout, setLayout] = useViewState<VideoLayout>('plot.videoLayout', 'docked');
  const [savedWidth, setWidth] = useViewState('plot.videoWidth', DEFAULT_PANEL_W);
  const splitRef = useRef<HTMLDivElement>(null);
  const [splitW, setSplitW] = useState(0);

  useEffect(() => {
    const el = splitRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSplitW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const maxW = Math.max(MIN_PANEL_W, splitW - MIN_MAIN_W);
  const width = clamp(savedWidth, MIN_PANEL_W, maxW);
  const docked = layout === 'docked';

  return (
    <div className="pv-split" ref={splitRef}>
      <div className="pv-main">{children}</div>
      {video && docked && <Splitter splitRef={splitRef} width={width} min={MIN_PANEL_W} max={maxW} onWidth={setWidth} />}
      {video && (
        <Suspense fallback={null}>
          <VideoPanel
            key={video.url}
            video={video}
            layout={layout}
            onLayout={setLayout}
            style={docked ? { width } : undefined}
            logDuration={logDuration}
            cursor={cursor}
            onCursor={onCursor}
          />
        </Suspense>
      )}
    </div>
  );
}

interface SplitterProps {
  splitRef: RefObject<HTMLDivElement | null>;
  width: number;
  min: number;
  max: number;
  onWidth: (width: number) => void;
}

function Splitter({ splitRef, width, min, max, onWidth }: SplitterProps) {
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    e.currentTarget.focus();
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const split = splitRef.current;
    if (!split || !e.currentTarget.hasPointerCapture(e.pointerId)) return;
    onWidth(Math.round(clamp(split.getBoundingClientRect().right - e.clientX, min, max)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = RESIZE_STEP * (e.shiftKey ? 4 : 1);
    // The panel is on the right, so moving the divider left widens it.
    const targets: Record<string, number> = { ArrowLeft: width + step, ArrowRight: width - step, Home: max, End: min };
    if (!(e.key in targets)) return;
    e.preventDefault();
    onWidth(clamp(targets[e.key], min, max));
  };
  return (
    <div
      role="separator"
      tabIndex={0}
      className="pv-splitter"
      aria-orientation="vertical"
      aria-label="Resize video panel"
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={width}
      title="Drag, or use the arrow keys, to resize the video"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKeyDown}
    />
  );
}
