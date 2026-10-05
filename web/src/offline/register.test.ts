import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Register = typeof import('./register');

class FakeWorker extends EventTarget {
  state = 'installing';
  postMessage = vi.fn();
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null;
  waiting: FakeWorker | null = null;
  update = vi.fn(() => Promise.resolve());
}

class FakeContainer extends EventTarget {
  controller: object | null = null;
  registration = new FakeRegistration();
  register = vi.fn(async () => this.registration);
}

let container: FakeContainer;

/** A fresh copy of the module, as on a page load. */
async function load(): Promise<Register> {
  vi.resetModules();
  return import('./register');
}

beforeEach(() => {
  container = new FakeContainer();
  Object.defineProperty(navigator, 'serviceWorker', { value: container, configurable: true });
  vi.useFakeTimers();
});

afterEach(() => {
  Reflect.deleteProperty(navigator, 'serviceWorker');
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
    const { registerServiceWorker, updateReady } = await load();
    await registerServiceWorker(true);
    expect(container.register).toHaveBeenCalledWith('/sw.js');
    expect(updateReady()).toBe(false);
  });

  it('stays quiet when registration is refused', async () => {
    container.register.mockRejectedValueOnce(new Error('SecurityError'));
    const { registerServiceWorker, updateReady } = await load();
    await expect(registerServiceWorker(true)).resolves.toBeUndefined();
    expect(updateReady()).toBe(false);
  });

  it('does not offer the first install as an update', async () => {
    const { registerServiceWorker, updateReady } = await load();
    await registerServiceWorker(true);
    const installing = new FakeWorker();
    container.registration.installing = installing;
    container.registration.dispatchEvent(new Event('updatefound'));
    installing.state = 'installed';
    installing.dispatchEvent(new Event('statechange'));
    expect(updateReady()).toBe(false);
  });

  it('offers a new version once it has installed behind the current one', async () => {
    container.controller = {};
    const { registerServiceWorker, subscribeToUpdate, updateReady } = await load();
    const listener = vi.fn();
    subscribeToUpdate(listener);
    await registerServiceWorker(true);
    const installing = new FakeWorker();
    container.registration.installing = installing;
    container.registration.dispatchEvent(new Event('updatefound'));
    expect(updateReady()).toBe(false);
    installing.state = 'installed';
    installing.dispatchEvent(new Event('statechange'));
    expect(updateReady()).toBe(true);
    expect(listener).toHaveBeenCalled();
  });

  it('offers a version that was already waiting when the page loaded', async () => {
    container.controller = {};
    container.registration.waiting = new FakeWorker();
    const { registerServiceWorker, updateReady } = await load();
    await registerServiceWorker(true);
    expect(updateReady()).toBe(true);
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
    const waiting = new FakeWorker();
    container.registration.waiting = waiting;
    const reload = vi.fn();
    vi.spyOn(window, 'location', 'get').mockReturnValue({ ...window.location, reload });
    const { applyUpdate, registerServiceWorker } = await load();
    await registerServiceWorker(true);
    applyUpdate();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: 'SKIP_WAITING' });
    expect(reload).not.toHaveBeenCalled();
    container.dispatchEvent(new Event('controllerchange'));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
