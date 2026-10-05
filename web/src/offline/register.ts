// Registers the service worker (production builds only) and tracks a new version waiting to take over.

const UPDATE_CHECK_MS = 60 * 60 * 1000;

let waitingWorker: ServiceWorker | null = null;
const listeners = new Set<() => void>();

function setWaiting(worker: ServiceWorker) {
  waitingWorker = worker;
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`. */
export function subscribeToUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateReady(): boolean {
  return waitingWorker !== null;
}

/** Lets the waiting version take over, then reloads this tab into it. */
export function applyUpdate() {
  if (!waitingWorker) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

export async function registerServiceWorker(enabled = import.meta.env.PROD): Promise<void> {
  if (!enabled || !('serviceWorker' in navigator)) return;
  let registration: ServiceWorkerRegistration;
  try {
    registration = await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`);
  } catch {
    // Some private windows refuse service workers; the app still works online.
    return;
  }
  // With no controller this is the first install, which takes over by itself; only an update waits.
  const isUpdate = () => navigator.serviceWorker.controller !== null;
  if (registration.waiting && isUpdate()) setWaiting(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const installing = registration.installing;
    installing?.addEventListener('statechange', () => {
      if (installing.state === 'installed' && isUpdate()) setWaiting(installing);
    });
  });
  // A tab can stay open for days; look for a new version now and then. Offline, the check just fails.
  setInterval(() => registration.update().catch(() => {}), UPDATE_CHECK_MS);
}
