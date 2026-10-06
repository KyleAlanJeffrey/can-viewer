import { useState, type DragEvent, type ReactNode } from 'react';
import { ArrowLeftRight, FileText } from 'lucide-react';
import type { LogInfo } from '../../core/api';
import { formatDuration } from '../../format';

/** Log B while it is read: its name and how far along, 0 to 1. */
export interface Reading {
  name: string;
  fraction: number;
}

interface Props {
  logA: LogInfo;
  /** Undefined while the view checks whether the core still holds one. */
  logB: LogInfo | null | undefined;
  reading: Reading | null;
  /** Another task is under way: no log can be opened until it ends. */
  busy: boolean;
  /** This browser couldn't keep a copy of log B, so it won't come back after a reload. */
  notKept: boolean;
  onReplaceA: () => void;
  onPickB: () => void;
  onDropB: (file: File) => void;
  onSwap: () => void;
}

/** Logs A and B side by side, with Replace... for each and Swap between them. */
export function LogCards({ logA, logB, reading, busy, notKept, onReplaceA, onPickB, onDropB, onSwap }: Props) {
  const [dragging, setDragging] = useState(false);
  const capture = logA.format === 'capture';
  const blocked = !!reading || busy;

  // The shell opens anything dropped elsewhere as log A; a drop here is log B.
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(true);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) onDropB(file);
  };
  const dropProps = { onDragOver, onDragLeave: () => setDragging(false), onDrop };

  return (
    <header className="content-header cmp-files">
      <LogCard letter="A" log={logA} action={<button type="button" className="button" onClick={onReplaceA} disabled={blocked} aria-label={'Replace log A\u2026'}>Replace&hellip;</button>} />
      <button
        type="button"
        className="cmp-swap"
        onClick={onSwap}
        disabled={!logB || blocked || capture}
        aria-label="Swap logs A and B"
        title={capture ? "A capture can't be swapped. Save it, then open the saved file to swap it." : undefined}
      >
        <ArrowLeftRight size={18} strokeWidth={1.5} aria-hidden="true" />
        <span aria-hidden="true">Swap</span>
      </button>
      {reading ? (
        <div className="cmp-log" {...dropProps}>
          <FileText className="cmp-log-icon" size={22} strokeWidth={1.5} aria-hidden="true" />
          <div className="cmp-log-text">
            <p className="cmp-log-name">
              <span className="cmp-letter">B</span>
              {reading.name}
            </p>
            <p className="cmp-log-sub" role="status">
              Reading&hellip; {Math.round(reading.fraction * 100)}%
            </p>
            <div className="cmp-progress" aria-hidden="true">
              <span style={{ transform: `scaleX(${reading.fraction})` }} />
            </div>
          </div>
        </div>
      ) : logB ? (
        <LogCard
          letter="B"
          log={logB}
          note={notKept ? 'Not kept for a reload' : undefined}
          dropProps={dropProps}
          dragging={dragging}
          action={
            <button type="button" className="button" onClick={onPickB} disabled={blocked} aria-label={'Replace log B\u2026'}>
              Replace&hellip;
            </button>
          }
        />
      ) : logB === null ? (
        <div className={`cmp-drop${dragging ? ' active' : ''}`} {...dropProps}>
          <FileText className="cmp-log-icon" size={22} strokeWidth={1.5} aria-hidden="true" />
          <div className="cmp-log-text">
            <p className="cmp-log-name">Choose a second log</p>
            <p className="cmp-log-sub">Drop a CAN log here, or open one in any format the app reads.</p>
          </div>
          <button type="button" className="primary" onClick={onPickB} disabled={blocked}>
            Open log B&hellip;
          </button>
        </div>
      ) : (
        <div className="cmp-log" aria-busy="true" />
      )}
    </header>
  );
}

interface CardProps {
  letter: 'A' | 'B';
  log: LogInfo;
  action: ReactNode;
  note?: string;
  dropProps?: Record<string, (e: DragEvent) => void>;
  dragging?: boolean;
}

function LogCard({ letter, log, action, note, dropProps, dragging }: CardProps) {
  return (
    <section className={`cmp-log${dragging ? ' active' : ''}`} aria-label={`Log ${letter}`} {...dropProps}>
      <FileText className="cmp-log-icon" size={22} strokeWidth={1.5} aria-hidden="true" />
      <div className="cmp-log-text">
        <p className="cmp-log-name" title={log.name}>
          <span className="cmp-letter">{letter}</span>
          {log.name}
        </p>
        <p className="cmp-log-sub">
          {formatDuration(log.durationS)}
          {note && ` \u00b7 ${note}`}
        </p>
      </div>
      {action}
    </section>
  );
}
