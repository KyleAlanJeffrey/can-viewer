import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Cable, Check, ChevronLeft, File as FileIcon, FileText, Lock } from 'lucide-react';
import type { AdapterKind } from '../capture/support';
import type { ExportFormat } from '../core/api';
import { formatBytes, logFormatName } from '../format';
import './welcome.css';

export type WelcomeStep = 'source' | 'setup';
export type WelcomeSource = 'file' | 'live';

/** The log formats the core reads, as the status line names them. */
const LOG_FORMATS: ExportFormat[] = ['candump', 'asc', 'blf', 'trc', 'mf4', 'csv'];

interface Props {
  step: WelcomeStep;
  source: WelcomeSource;
  onChange: (step: WelcomeStep, source: WelcomeSource) => void;
  /** Another task is under way, so nothing else can start until it ends. */
  busy: boolean;
  /** The DBCs loaded, which decode the log once it is open. */
  dbcNames: string[];
  onExplore: (file: File) => void;
  onAddDbcs: (files: File[]) => void;
  /** Opens DBCs on their own, to edit in Database. */
  onOpenDbcs: (files: File[]) => void;
  /** Goes to Database with the DBCs already loaded; null when there are none. */
  onEditDbcs: (() => void) | null;
  onDemo: () => void;
  /** The adapter kinds this browser can reach; none means no live capture here. */
  liveKinds: AdapterKind[];
  /** The live settings and Start Capture, loaded with the capture code. */
  liveSetup: ReactNode;
}

const STEPS = ['Source', 'Setup', 'Explore'];

function Stepper({ current }: { current: number }) {
  return (
    <>
      <ol className="wel-steps" aria-label="Steps">
        {STEPS.map((label, i) => {
          const state = i < current ? 'done' : i === current ? 'current' : 'todo';
          return (
            <li key={label} className={`wel-step ${state}`} aria-current={state === 'current' ? 'step' : undefined}>
              <span className="wel-step-mark" aria-hidden="true">
                {state === 'done' ? <Check size={12} strokeWidth={2.5} /> : i + 1}
              </span>
              {label}
              {state === 'done' && <span className="sr-only"> (done)</span>}
            </li>
          );
        })}
      </ol>
      <p className="wel-steps-compact" aria-hidden="true">
        Step {current + 1} of {STEPS.length} &middot; {STEPS[current]}
      </p>
    </>
  );
}

/**
 * What the app shows while nothing is open: choose a source, then set it up. Opening the log or
 * starting the capture is the third step, Explore, which is the workspace itself.
 */
export function Welcome({ step, source, onChange, busy, dbcNames, onExplore, onAddDbcs, onOpenDbcs, onEditDbcs, onDemo, liveKinds, liveSetup }: Props) {
  const ids = useId();
  const [file, setFile] = useState<File | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const logInput = useRef<HTMLInputElement>(null);
  const addDbcInput = useRef<HTMLInputElement>(null);
  const openDbcInput = useRef<HTMLInputElement>(null);

  // A new step replaces the content under focus, so focus moves to its heading. Not when the
  // welcome first shows: it is what the app opens with.
  // The source radios change `source` too, and keep focus.
  const shown = step === 'source' ? step : `${step} ${source}`;
  const lastShown = useRef(shown);
  useEffect(() => {
    if (shown === lastShown.current) return;
    lastShown.current = shown;
    heading.current?.focus();
  }, [shown]);

  const filesOf = (input: HTMLInputElement) => {
    const files = [...(input.files ?? [])];
    input.value = '';
    return files;
  };

  const back = (
    <button type="button" className="wel-back" onClick={() => onChange('source', source)}>
      <ChevronLeft size={16} strokeWidth={1.5} aria-hidden="true" />
      Back
    </button>
  );

  let body: ReactNode;
  if (step === 'source') {
    const choice = (value: WelcomeSource, title: string, text: string, icon: ReactNode, note?: string) => (
      <label className="wel-choice" data-source={value}>
        <span className="wel-choice-head">
          <input
            type="radio"
            name={`${ids}source`}
            value={value}
            checked={source === value}
            onChange={() => onChange('source', value)}
            aria-labelledby={`${ids}${value}-title`}
            aria-describedby={`${ids}${value}-text${note ? ` ${ids}${value}-note` : ''}`}
          />
          <span id={`${ids}${value}-title`} className="wel-choice-title">
            {title}
          </span>
        </span>
        <span className="wel-choice-body">
          {icon}
          <span id={`${ids}${value}-text`} className="wel-choice-text">
            {text}
          </span>
        </span>
        {note && (
          <span id={`${ids}${value}-note`} className="wel-choice-note">
            {note}
          </span>
        )}
      </label>
    );
    const live = source === 'live';
    body = (
      <>
        <h2 ref={heading} id={`${ids}title`} className="wel-title" tabIndex={-1}>
          How would you like to start?
        </h2>
        <p className="wel-lede">Open a recording or watch a CAN bus live.</p>
        <div className="wel-choices" role="radiogroup" aria-labelledby={`${ids}title`}>
          {choice('file', 'Open a log', 'Explore a recording from your device.', <FileIcon size={32} strokeWidth={1.25} aria-hidden="true" />)}
          {choice(
            'live',
            'Connect live',
            'Read a CAN bus through an adapter.',
            <Cable size={32} strokeWidth={1.25} aria-hidden="true" />,
            'Experimental \u00b7 requires a compatible adapter and browser',
          )}
        </div>
        <p className="wel-next">
          <b>Next:</b> {live ? 'choose an adapter and a bitrate, then start the capture.' : 'choose a log. Add a DBC if you have one.'}
        </p>
        <div className="wel-actions">
          <button type="button" className="primary" onClick={() => onChange('setup', source)}>
            {live ? 'Continue with live capture' : 'Continue with a log'}
          </button>
          <button type="button" className="button" onClick={onDemo} disabled={busy}>
            Try the Demo
          </button>
        </div>
        <input
          ref={openDbcInput}
          type="file"
          accept=".dbc"
          multiple
          hidden
          onChange={(e) => {
            const files = filesOf(e.target);
            if (files.length > 0) onOpenDbcs(files);
          }}
        />
        <p className="wel-dbc">
          Just editing a database?{' '}
          {onEditDbcs ? (
            <button type="button" className="wel-link" onClick={onEditDbcs} disabled={busy}>
              Edit your DBCs
            </button>
          ) : (
            <button type="button" className="wel-link" onClick={() => openDbcInput.current?.click()} disabled={busy}>
              Open a DBC&hellip;
            </button>
          )}
        </p>
      </>
    );
  } else if (source === 'file') {
    body = (
      <>
        <h2 ref={heading} className="wel-title" tabIndex={-1}>
          Choose your log
        </h2>
        <p className="wel-lede">Select a CAN log file from this device.</p>
        <p className="wel-formats">{LOG_FORMATS.map(logFormatName).join(' \u00b7 ')}</p>
        <input
          ref={logInput}
          type="file"
          hidden
          onChange={(e) => {
            const [picked] = filesOf(e.target);
            if (picked) setFile(picked);
          }}
        />
        <div className="wel-file">
          <FileIcon size={24} strokeWidth={1.25} aria-hidden="true" />
          {file ? (
            <p className="wel-file-name">
              <span className="wel-file-label">{file.name}</span>
              <span className="wel-hint">{formatBytes(file.size)}</span>
            </p>
          ) : (
            <p className="wel-file-name wel-hint">No file chosen</p>
          )}
          <button type="button" className="button" onClick={() => logInput.current?.click()}>
            {file ? 'Choose another\u2026' : 'Choose a file\u2026'}
          </button>
        </div>
        <section className="wel-section" aria-labelledby={`${ids}decode`}>
          <h3 id={`${ids}decode`} className="wel-section-title">
            Decode signals <span className="wel-quiet">(optional)</span>
          </h3>
          <p className="wel-hint">Add a DBC for signal names and values.</p>
          <input ref={addDbcInput} type="file" accept=".dbc" multiple hidden onChange={(e) => onAddDbcs(filesOf(e.target))} />
          {dbcNames.length > 0 && (
            <ul className="wel-dbcs" aria-label="DBCs loaded">
              {dbcNames.map((name) => (
                <li key={name}>
                  <FileText size={16} strokeWidth={1.5} aria-hidden="true" />
                  <span className="wel-file-label">{name}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="wel-row">
            <button type="button" className="button" onClick={() => addDbcInput.current?.click()} disabled={busy}>
              <FileText size={16} strokeWidth={1.5} aria-hidden="true" />
              Add DBC&hellip;
            </button>
            <p className="wel-hint">You can add one later.</p>
          </div>
        </section>
        <div className="wel-actions">
          <button type="button" className="primary" onClick={() => file && onExplore(file)} disabled={!file || busy}>
            Explore log
          </button>
        </div>
        <p className="wel-hint wel-after">{file ? 'Next: see your log overview.' : 'Choose a file to continue.'}</p>
      </>
    );
  } else if (liveKinds.length > 0) {
    body = (
      <>
        <h2 ref={heading} className="wel-title" tabIndex={-1}>
          Connect to a CAN bus
        </h2>
        <p className="wel-lede">
          Experimental live capture. <span className="wel-quiet">Record frames from a CAN adapter on this computer.</span>
        </p>
        {liveSetup}
      </>
    );
  } else {
    body = (
      <div className="wel-unsupported">
        <Cable size={32} strokeWidth={1.25} aria-hidden="true" />
        <h2 ref={heading} className="wel-title" tabIndex={-1}>
          Live capture needs a compatible computer
        </h2>
        <p className="wel-lede">This browser can&rsquo;t reach serial or USB devices, so it can&rsquo;t connect to a CAN adapter.</p>
        <p className="wel-hint">
          Live capture works in Chrome or Edge on a desktop computer.
          {!window.isSecureContext && ' The app also has to be opened over HTTPS.'} You can still open a log recorded with another tool.
        </p>
        <div className="wel-actions">
          <button type="button" className="primary" onClick={() => onChange('setup', 'file')}>
            Open a log instead
          </button>
          <button type="button" className="button" onClick={onDemo} disabled={busy}>
            Try the Demo
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="wel">
      <div className={`wel-inner${step === 'setup' && (source === 'file' || liveKinds.length > 0) ? ' setup' : ''}`}>
        <div className="wel-nav">
          {step === 'setup' && back}
          <Stepper current={step === 'source' ? 0 : 1} />
        </div>
        {body}
        <p className="privacy wel-center">
          <Lock size={14} strokeWidth={1.75} aria-hidden="true" />
          Files and recordings stay on your device.
        </p>
      </div>
    </div>
  );
}
