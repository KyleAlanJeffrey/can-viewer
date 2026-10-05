import { useState, useSyncExternalStore } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { applyUpdate, subscribeToUpdate, updateReady } from '../offline/register';

/** Says when a new version of the app has downloaded, and reloads into it on request. */
export function UpdateBanner() {
  const ready = useSyncExternalStore(subscribeToUpdate, updateReady);
  const [dismissed, setDismissed] = useState(false);
  if (!ready || dismissed) return null;
  return (
    <div className="banner update-banner" role="status">
      <RefreshCw size={16} strokeWidth={1.5} />
      <p>A new version of FreeCAN Studio is ready.</p>
      <button className="button" onClick={applyUpdate}>
        Reload
      </button>
      <button className="icon-button small" onClick={() => setDismissed(true)} aria-label="Dismiss">
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}
