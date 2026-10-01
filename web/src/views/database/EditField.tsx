import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';

interface Props {
  label: string;
  /** The committed value, as text. */
  value: string;
  /** Why `text` can't be committed, or null when it can. */
  validate?: (text: string) => string | null;
  onCommit: (text: string) => void;
  /** `row` puts the label beside the input (inspector), `stack` above it (cards), `cell` hides it (tables). */
  layout: 'row' | 'stack' | 'cell';
  mono?: boolean;
  numeric?: boolean;
  multiline?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** A datalist id offering suggestions. */
  list?: string;
  /** On the outermost element: the field in `stack` layout, else the control. */
  className?: string;
}

/**
 * A text field that commits on blur or Enter (Ctrl/Cmd+Enter when multiline) and reverts on
 * Escape. Invalid text stays in the field, flagged, and is never committed.
 */
export function EditField({ label, value, validate, onCommit, layout, mono, numeric, multiline, placeholder, autoFocus, list, className }: Props) {
  const id = useId();
  const errorId = `${id}-error`;
  const [text, setText] = useState(value);
  const [shownValue, setShownValue] = useState(value);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  if (value !== shownValue) {
    setShownValue(value);
    setText(value);
    setError(null);
  }

  useEffect(() => {
    if (autoFocus) (input.current ?? area.current)?.select();
  }, [autoFocus]);

  const attempt = () => {
    const problem = validate?.(text) ?? null;
    setError(problem);
    if (problem !== null) return;
    if (text !== value) onCommit(text);
    // Shows the canonical form when the commit changed nothing, e.g. "0.250" for 0.25.
    setText(value);
  };

  const change = (next: string) => {
    setText(next);
    if (error !== null) setError(validate?.(next) ?? null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      setText(value);
      setError(null);
    } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      attempt();
    }
  };

  const shared = {
    id,
    value: text,
    placeholder,
    autoFocus,
    'aria-invalid': error !== null,
    'aria-describedby': error !== null ? errorId : undefined,
    'aria-label': layout === 'cell' ? label : undefined,
    className: `input${mono ? ' mono' : ''}`,
    onBlur: attempt,
    onKeyDown,
    spellCheck: false,
  };

  const control = (
    <div className={`db-control${className && layout !== 'stack' ? ` ${className}` : ''}`}>
      {multiline ? (
        <textarea ref={area} rows={2} {...shared} onChange={(e) => change(e.target.value)} />
      ) : (
        <input
          ref={input}
          type="text"
          inputMode={numeric ? 'decimal' : undefined}
          autoComplete="off"
          list={list}
          {...shared}
          onChange={(e) => change(e.target.value)}
        />
      )}
      {error !== null && (
        <p id={errorId} className="field-error">
          {error}
        </p>
      )}
    </div>
  );

  if (layout === 'cell') return control;
  const labelEl = (
    <label htmlFor={id} className="field-label">
      {label}
    </label>
  );
  if (layout === 'row') {
    return (
      <>
        {labelEl}
        {control}
      </>
    );
  }
  return (
    <div className={`field${className ? ` ${className}` : ''}`}>
      {labelEl}
      {control}
    </div>
  );
}
