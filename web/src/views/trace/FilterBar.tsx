import type { Ref } from 'react';
import { SearchX, SlidersHorizontal, X } from 'lucide-react';
import { formatCount } from '../../format';
import type { FilterChip } from './filters';

interface BarProps {
  chips: FilterChip[];
  /** Whether "Any rule" joins the rule chips. */
  anyRule: boolean;
  /** Matching frames, or null while the filters are applied. Absent without filters. */
  matches?: number | null;
  total: number;
  editRef: Ref<HTMLButtonElement>;
  onEdit: () => void;
  onRemove: (chip: FilterChip) => void;
  onClear: () => void;
}

/** The Filters button over the trace, then the applied filters as removable chips and their count. */
export function FilterBar({ chips, anyRule, matches, total, editRef, onEdit, onRemove, onClear }: BarProps) {
  const filtered = chips.length > 0;
  return (
    <div className="tv-bar">
      <button ref={editRef} type="button" className="button" onClick={onEdit}>
        <SlidersHorizontal size={16} strokeWidth={1.5} aria-hidden="true" />
        {filtered ? 'Edit filters\u2026' : 'Filters\u2026'}
      </button>
      {filtered && (
        <>
          <ul className="tv-chips" aria-label="Applied filters">
            {chips.map((chip) => (
              <li key={chip.id} className="tv-chip">
                {anyRule && chip.id === firstRule(chips) && <span className="tv-chip-lead">Any of</span>}
                <span>{chip.label}</span>
                <button type="button" className="icon-button small" aria-label={`Remove filter ${chip.label}`} onClick={() => onRemove(chip)}>
                  <X size={14} strokeWidth={1.75} />
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="text-button" onClick={onClear}>
            Clear all
          </button>
        </>
      )}
      <p className="tv-count" role="status">
        {filtered &&
          (matches == null ? (
            'Filtering\u2026'
          ) : (
            <>
              <span className="num">{formatCount(matches)}</span> of <span className="num">{formatCount(total)}</span> frames match
            </>
          ))}
      </p>
    </div>
  );
}

function firstRule(chips: FilterChip[]): string | undefined {
  return chips.find((c) => c.id.startsWith('rule-'))?.id;
}

interface EmptyProps {
  last: FilterChip;
  /** The trace shows one ID, picked in the sidebar. */
  oneId: string | null;
  onRemoveLast: () => void;
  onClear: () => void;
}

/** In place of the trace when no frame matches. */
export function NoMatches({ last, oneId, onRemoveLast, onClear }: EmptyProps) {
  return (
    <div className="tv-empty">
      <div className="tv-empty-inner">
        <SearchX size={32} strokeWidth={1.5} aria-hidden="true" />
        <h2 className="tv-empty-title">No frames match these filters</h2>
        <p className="tv-empty-lede">
          Try removing a rule or widening the time range.
          {oneId && ` Only frames of ${oneId}, picked in the sidebar, are shown; pick All frames to filter every ID.`}
        </p>
        <div className="tv-empty-actions">
          <button type="button" className="button" aria-label={`Remove last filter, ${last.label}`} onClick={onRemoveLast}>
            Remove last filter
          </button>
          <button type="button" className="button" onClick={onClear}>
            Clear all filters
          </button>
        </div>
      </div>
    </div>
  );
}
