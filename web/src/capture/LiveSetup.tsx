import { useId } from 'react';
import type { CaptureAdapter, CaptureSettings } from './adapter';
import { useCaptureForm } from './CaptureSheet';
import type { AdapterKind } from './support';

interface Props {
  /** Starts capturing from `adapter`. Rejects with a message for the user if it can't. */
  onStart: (adapter: CaptureAdapter, settings: CaptureSettings) => Promise<void>;
  /** The adapter kinds the browser can reach; at least one. */
  kinds: AdapterKind[];
  /** Shows the browser's device prompt; tests pass a stand-in. */
  request?: (kind: AdapterKind) => Promise<CaptureAdapter | null>;
  /** The buses the loaded DBCs are set to, offered as bus names. */
  buses: string[];
  /** The app is busy with another task, which a capture would cut short. */
  busy: boolean;
}

/** The welcome's live setup: the Capture sheet's settings in the page, then an explicit start. */
export function LiveSetup({ onStart, kinds, request, buses, busy }: Props) {
  const ids = useId();
  const form = useCaptureForm({ onStart, kinds, request, buses, layout: 'inline' });

  return (
    <>
      <section className="wel-panel" aria-labelledby={`${ids}connection`}>
        <h3 id={`${ids}connection`} className="wel-panel-title">
          Connection settings
        </h3>
        {form.fields}
      </section>
      <section className="wel-panel wel-start" aria-labelledby={`${ids}start`}>
        <div className="wel-start-text">
          <h3 id={`${ids}start`} className="wel-panel-title">
            Next: start the capture
          </h3>
          <p className="wel-hint">
            {form.adapter ? 'Nothing is recorded until you start.' : 'Choose an adapter to continue. Choosing one doesn\u2019t start recording.'}
          </p>
        </div>
        <button type="button" className="primary" onClick={form.start} disabled={!form.canStart || busy}>
          {form.startLabel}
        </button>
      </section>
    </>
  );
}
