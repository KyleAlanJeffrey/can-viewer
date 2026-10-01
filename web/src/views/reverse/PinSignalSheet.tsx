import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Search } from 'lucide-react';
import { formatId, isErrorFrame, type IdSummary, type MessageDef } from '../../core/api';
import { Sheet } from '../../components/Sheet';
import type { ViewContext } from '../types';
import { pinId, type Pin } from './pins';

interface Props {
  open: boolean;
  onClose: () => void;
  ctx: ViewContext;
  pins: Pin[];
  onToggle: (pin: Pin) => void;
}

interface Group {
  summary: IdSummary;
  message: MessageDef;
  bus: string;
}

/** A searchable list of every decoded signal in the log, to pin as a reference. */
export function PinSignalSheet({ open, onClose, ctx, pins, onToggle }: Props) {
  const { ids, messageOf, log } = ctx;
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const pinned = useMemo(() => new Set(pins.map(pinId)), [pins]);

  useEffect(() => {
    if (open) {
      setQuery('');
      // The dialog opens in an effect of its own; focus once it is showing.
      const timer = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(timer);
    }
  }, [open]);

  const groups = useMemo<Group[]>(() => {
    const q = query.trim().toLowerCase();
    return ids
      .filter((s) => !isErrorFrame(s))
      .sort((a, b) => a.channel - b.channel || a.id - b.id)
      .flatMap((summary) => {
        const message = messageOf(summary.key);
        if (!message || message.signals.length === 0) return [];
        const bus = log?.channels[summary.channel] ?? '?';
        const head = `${formatId(summary.id, summary.extended)} ${message.name} ${bus}`.toLowerCase();
        const signals = q && !head.includes(q) ? message.signals.filter((sig) => sig.name.toLowerCase().includes(q)) : message.signals;
        return signals.length > 0 ? [{ summary, message: { ...message, signals }, bus }] : [];
      });
  }, [ids, messageOf, log, query]);

  const total = groups.reduce((n, g) => n + g.message.signals.length, 0);

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Pin signal"
      description="A pinned signal stays in view on the shared timeline while you change messages or modes."
      footer={
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="re-pin-sheet">
        <label className="search re-pin-search">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="sr-only">Filter signals</span>
          <input ref={searchRef} value={query} placeholder="Filter signals, messages and IDs" onChange={(e) => setQuery(e.target.value)} />
        </label>
        {ctx.dbcs.length === 0 ? (
          <p className="hint">Signals come from a DBC, so open one first.</p>
        ) : total === 0 ? (
          <p className="hint">{query ? 'No signals match.' : 'No loaded DBC decodes a message in this log.'}</p>
        ) : (
          <ul className="re-pin-list" aria-label="Signals">
            {groups.map(({ summary, message, bus }) => (
              <li key={summary.key} className="re-pin-group">
                <p className="re-pin-group-head">
                  <span className="mono">{formatId(summary.id, summary.extended)}</span>
                  <span>{message.name}</span>
                  <span className="re-pin-bus mono">{bus}</span>
                </p>
                <ul>
                  {message.signals.map((sig) => {
                    const pin: Pin = { kind: 'signal', key: summary.key, signal: sig.name };
                    const isPinned = pinned.has(pinId(pin));
                    return (
                      <li key={sig.name}>
                        <button type="button" className="re-pin-row" aria-pressed={isPinned} onClick={() => onToggle(pin)}>
                          <span className="re-pin-name">{sig.name}</span>
                          <span className="re-pin-unit">{sig.unit}</span>
                          <span className="re-pin-state">
                            {isPinned ? (
                              <span className="status">
                                <Check size={14} strokeWidth={2} aria-hidden="true" />
                                Pinned
                              </span>
                            ) : (
                              <span className="re-pin-action">Pin</span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
