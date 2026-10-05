import type { CompareOptions } from '../../core/api';
import { Sheet } from '../../components/Sheet';

interface Props {
  options: CompareOptions;
  onChange: (options: CompareOptions) => void;
  /** Explain each rule under its checkbox, as the sheet does. */
  detailed?: boolean;
}

export function IgnoreRules({ options, onChange, detailed = false }: Props) {
  return (
    <fieldset className={`cmp-rules${detailed ? ' detailed' : ''}`}>
      <legend className="sr-only">Ignore rules</legend>
      <label className="cmp-rule">
        <input type="checkbox" checked={options.ignoreCounters} onChange={(e) => onChange({ ...options, ignoreCounters: e.target.checked })} />
        <span>
          Ignore counters and checksums
          {detailed && (
            <span className="cmp-rule-detail">
              Bits that count up or look like a checksum or CRC in both logs. They change on every frame whatever the car does.
            </span>
          )}
        </span>
      </label>
      <label className="cmp-rule">
        <input
          type="checkbox"
          checked={options.ignoreChangesWithinA}
          onChange={(e) => onChange({ ...options, ignoreChangesWithinA: e.target.checked })}
        />
        <span>
          Ignore IDs that also change within A alone
          {detailed && (
            <span className="cmp-rule-detail">
              Compares the first half of log A with its second half, and discounts what differs there, such as temperatures drifting.
            </span>
          )}
        </span>
      </label>
    </fieldset>
  );
}

interface SheetProps {
  open: boolean;
  onClose: () => void;
  options: CompareOptions;
  onChange: (options: CompareOptions) => void;
}

/** The ignore rules with what each one does, changed in place. */
export function IgnoreRulesSheet({ open, onClose, options, onChange }: SheetProps) {
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Ignore Rules"
      description="Leave out changes that would show in any two logs. The comparison updates as you change them."
      footer={
        <button type="button" className="primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <IgnoreRules options={options} onChange={onChange} detailed />
    </Sheet>
  );
}
