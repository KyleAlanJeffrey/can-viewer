import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Register = typeof import('./register');

class FakeWorker extends EventTarget {
  constructor(public state: ServiceWorkerState = 'installing') {
    super();
  }
  postMessage = vi.fn();
  /** Moves to `state` and says so, as a browser does. */
  become(state: ServiceWorkerState) {
    this.state = state;
    this.dispatchEvent(new Event('statechange'));
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn(() => Promise.resolve());
  /** A new version starts installing, as after a deploy. */
  startUpdate(): FakeWorker {
    const worker = new FakeWorker();
    this.installing = worker;
    this.dispatchEvent(new Event('updatefound'));
    return worker;
  }
}

class FakeContainer extends EventTarget {
  controller: object | null = null;
  registration = new FakeRegistration();
  register = vi.fn(async () => this.registration);
}

let container: FakeContainer;
let reload: ReturnType<typeof vi.fn<() => void>>;

/** A fresh copy of the module, as on a page load. */
async function load(): Promise<Register> {
  vi.resetModules();
  return import('./register');
}

beforeEach(() => {
  container = new FakeContainer();
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
  reload = vi.fn<() => void>();
  vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
  vi.useFakeTimers();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('registerServiceWorker', () => {
  it('does nothing outside a production build', async () => {
    expect(import.meta.env.PROD).toBe(false);
    const { registerServiceWorker } = await load();
    await registerServiceWorker();
    expect(container.register).not.toHaveBeenCalled();
  });

  it('registers /sw.js in production', async () => {
    const { registerServiceWorker, updateStatus } = await load();
    await registerServiceWorker(true);
    expect(container.register).toHaveBeenCalledWith('/sw.js');
    expect(updateStatus()).toBe('current');
  });

  it('stays quiet when registration is refused', async () => {
    container.register.mockRejectedValueOnce(new Error('SecurityError'));
    const { registerServiceWorker, updateStatus } = await load();
    await expect(registerServiceWorker(true)).resolves.toBeUndefined();
    expect(updateStatus()).toBe('current');
  });

  it('does not offer the first install as an update, nor call its taking over out of date', async () => {
    const { registerServiceWorker, updateStatus } = await load();
    await registerServiceWorker(true);
    container.registration.startUpdate().become('installed');
    container.dispatchEvent(new Event('controllerchange'));
    expect(updateStatus()).toBe('current');
  });

  it('offers a new version once it has installed behind the current one', async () => {
    container.controller = {};
    const { registerServiceWorker, subscribeToUpdate, updateStatus } = await load();
    const listener = vi.fn();
    subscribeToUpdate(listener);
    await registerServiceWorker(true);
    const worker = container.registration.startUpdate();
    expect(updateStatus()).toBe('current');
    worker.become('installed');
    expect(updateStatus()).toBe('ready');
    expect(listener).toHaveBeenCalled();
  });

  it('offers a version that was already waiting when the page loaded', async () => {
    container.controller = {};
    container.registration.waiting = new FakeWorker('installed');
    const { registerServiceWorker, updateStatus } = await load();
    await registerServiceWorker(true);
    expect(updateStatus()).toBe('ready');
  });

  it('offers a version that started installing before registration resolved', async () => {
    container.controller = {};
    const installing = new FakeWorker();
    container.registration.installing = installing;
    const { registerServiceWorker, updateStatus } = await load();
    await registerServiceWorker(true);
    installing.become('installed');
    expect(updateStatus()).toBe('ready');
  });

  it('says this tab is out of date when another tab lets the new version take over', async () => {
    container.controller = {};
    const { registerServiceWorker, updateStatus } = await load();
    await registerServiceWorker(true);
    container.registration.startUpdate().become('installed');
    container.dispatchEvent(new Event('controllerchange'));
    expect(updateStatus()).toBe('outdated');
  });

  it('checks for a new version every hour', async () => {
    const { registerServiceWorker } = await load();
    await registerServiceWorker(true);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(container.registration.update).toHaveBeenCalledTimes(1);
  });
});

describe('applyUpdate', () => {
  it('tells the waiting version to take over, then reloads into it', async () => {
    container.controller = {};
    const waiting = new FakeWorker('installed');
    container.registration.waiting = waiting;
    const { applyUpdate, registerServiceWorker, updateStatus } = await load();
    await registerServiceWorker(true);
    applyUpdate();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(updateStatus()).toBe('ready');
  });

  it('reloads at once when another tab already let the new version take over', async () => {
    container.controller = {};
    const waiting = new FakeWorker('installed');
    container.registration.waiting = waiting;
    const { applyUpdate, registerServiceWorker } = await load();
    await registerServiceWorker(true);
    waiting.become('activated');
    container.dispatchEvent(new Event('controllerchange'));
    applyUpdate();
    expect(waiting.postMessage).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
