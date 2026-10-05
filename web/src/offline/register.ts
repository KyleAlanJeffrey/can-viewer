// Registers the service worker (production builds only) and tracks whether this tab should reload:
// `ready` when a new version is waiting to take over, `outdated` when another tab already let it.

export type UpdateStatus = 'current' | 'ready' | 'outdated';

const UPDATE_CHECK_MS = 60 * 60 * 1000;

let status: UpdateStatus = 'current';
let waitingWorker: ServiceWorker | null = null;
/** This tab asked for the new version, so its taking over is expected. */
let updateRequested = false;
const listeners = new Set<() => void>();

function setStatus(next: UpdateStatus) {
  status = next;
  for (const listener of listeners) listener();
}

/** For `useSyncExternalStore`. */
export function subscribeToUpdate(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function updateStatus(): UpdateStatus {
  return status;
}

/** Lets the waiting version take over, then reloads this tab into it. */
export function applyUpdate() {
  const worker = waitingWorker;
  // Another tab may have let it take over already; then there is nothing to wait for.
  if (!worker || worker.state === 'activating' || worker.state === 'activated' || worker.state === 'redundant') {
    location.reload();
    return;
  }
  updateRequested = true;
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
  worker.postMessage({ type: 'SKIP_WAITING' });
}

export async function registerServiceWorker(enabled = import.meta.env.PROD): Promise<void> {
  if (!enabled || !('serviceWorker' in navigator)) return;
  const container = navigator.serviceWorker;
  let registration: ServiceWorkerRegistration;
  try {
    registration = await container.register(`${import.meta.env.BASE_URL}sw.js`);
  } catch {
    // Some private windows refuse service workers; the app still works online.
    return;
  }
  // With no controller this is the first install, which takes over by itself; only an update waits.
  if (container.controller) {
    // A new version took over without this tab asking, so this tab runs a version that is going away.
    container.addEventListener('controllerchange', () => {
      if (!updateRequested) setStatus('outdated');
    });
  }
  const offer = (worker: ServiceWorker) => {
    if (!container.controller || status === 'outdated') return;
    waitingWorker = worker;
    setStatus('ready');
  };
  const watch = (worker: ServiceWorker) => {
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') offer(worker);
    });
  };
  if (registration.waiting) offer(registration.waiting);
  // The update may have started before `register` resolved, too late for `updatefound`.
  if (registration.installing) watch(registration.installing);
  registration.addEventListener('updatefound', () => {
    if (registration.installing) watch(registration.installing);
  });
  // A tab can stay open for days; look for a new version now and then. Offline, the check just fails.
  setInterval(() => registration.update().catch(() => {}), UPDATE_CHECK_MS);
}
