import { useState, useSyncExternalStore } from 'react';
import { RefreshCw, X } from 'lucide-react';
import { applyUpdate, subscribeToUpdate, updateStatus } from '../offline/register';

/** Says when a new version of the app has downloaded, or another tab has moved to it, and reloads on request. */
export function UpdateBanner() {
  const status = useSyncExternalStore(subscribeToUpdate, updateStatus);
  const [dismissed, setDismissed] = useState<string | null>(null);
  if (status === 'current' || dismissed === status) return null;
  return (
    <div className="banner update-banner" role="status">
      <RefreshCw size={16} strokeWidth={1.5} />
      <p>{status === 'ready' ? 'A new version of FreeCAN Studio is ready.' : 'This tab is out of date. Reload to keep working.'}</p>
      <button className="button" onClick={applyUpdate}>
        Reload
      </button>
      <button className="icon-button small" onClick={() => setDismissed(status)} aria-label="Dismiss">
        <X size={14} strokeWidth={1.75} />
      </button>
    </div>
  );
}
