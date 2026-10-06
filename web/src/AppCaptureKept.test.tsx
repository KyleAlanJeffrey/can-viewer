import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_SUPERSEDED, type CaptureFrame, type CoreApi, type LogInfo } from './core/api';
import type { KeptCapture } from './session';
import { FakeSerialPort } from './test/fakeSerial';
import { installLocks, removeLocks, type FakeLocks } from './test/fakeLocks';
import { fakeCore, logInfo, summary } from './test/fixtures';

/** Each load is a fresh copy of the app's modules, as after a reload. */
async function freshApp() {
  vi.resetModules();
  return (await import('./App')).App;
}

/** The session store as another tab sees it. */
async function storage() {
  vi.resetModules();
  return import('./session');
}

beforeAll(async () => {
  await import('./App');
});

let locks: FakeLocks;
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  locks = installLocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
  removeLocks();
  delete (navigator as { serial?: unknown }).serial;
  vi.restoreAllMocks();
});

/** The next chunk written is refused, as by a full disk. */
function fillStorage() {
  const put = IDBObjectStore.prototype.put;
  vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    if (Array.isArray(key) && key[0] === 'capture-chunk') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    return put.call(this, value, key);
  });
}

function withSerialPort(port: FakeSerialPort) {
  Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => port }, configurable: true });
}

/** A core that keeps captured frames, answering as the wasm core would. */
function captureCore() {
  const frames: CaptureFrame[] = [];
  let name = '';
  let bus = 'can0';
  const info = () => logInfo({ name, format: 'capture', frames: frames.length, durationS: 0.5, channels: [bus] });
  const core = fakeCore({
    startCapture: vi.fn((captureName: string, channel: string) => {
      name = captureName;
      bus = channel;
      frames.length = 0;
      return Promise.resolve(info());
    }),
    appendFrames: vi.fn((batch: CaptureFrame[]) => {
      frames.push(...batch);
      return Promise.resolve(info());
    }),
    trimCapture: vi.fn((beforeNs: number) => {
      frames.splice(0, frames.length, ...frames.filter((f) => f.timeNs >= beforeNs));
      return Promise.resolve(info());
    }),
    endCapture: vi.fn(() => Promise.resolve(info())),
    idSummary: () => Promise.resolve(frames.length > 0 ? [summary({ id: 0x123, count: frames.length })] : []),
    exportLog: vi.fn(() => Promise.resolve(new Blob(['(1.000000) can0 123#DEAD\n']))),
    openLog: vi.fn<CoreApi['openLog']>(async (file, logName) => logInfo({ name: logName, frames: file.size === 0 ? 0 : 1000 })),
  });
  return { core, frames };
}

async function startCapture() {
  await userEvent.click(await screen.findByRole('button', { name: 'Capture\u2026' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Choose Adapter\u2026' }));
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Live Capture' })).getByRole('button', { name: 'Start Capture' }));
  await screen.findByRole('button', { name: 'Stop Capture' });
}

/** Records two frames and stops, leaving an unsaved capture. Resolves with its name. */
async function unsavedCapture(port: FakeSerialPort, core: CoreApi): Promise<string> {
  await startCapture();
  port.send('t1232DEAD\rt1232BEEF\r');
  await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
  await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
  await screen.findByText(/Not saved \u00b7 2 frames/);
  return (core.startCapture as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0] as string;
}

/** The page goes away, letting go of its locks, and loads again with a fresh core. */
async function reload(unmount: () => void) {
  unmount();
  locks.dropAll();
  const Reloaded = await freshApp();
  const { core, frames } = captureCore();
  render(<Reloaded core={core} />);
  return { core, frames };
}

/** Stores an unsaved capture with frames at `times`, as a tab that has since gone away left it. */
async function storedCapture(fields: Partial<KeptCapture> = {}, times = [5]) {
  const session = await storage();
  const { packFrames } = await import('./core/captureFrames');
  const chunk = packFrames(times.map((timeNs) => ({ timeNs, id: 0x123, extended: false, flags: 0, data: Uint8Array.of(1) })));
  const capture: KeptCapture = { id: 'gone', name: 'capture-20261006-101500.log', bus: 'can0', startedAtMs: 1_700_000_000_000, bitrate: 500_000, layout: 1, frames: times.length, bytes: chunk.length, ...fields };
  await session.writeKeptCapture(capture, { seq: 0, bytes: chunk.buffer as ArrayBuffer });
  return { session, capture };
}

/** fake-indexeddb can't clone jsdom's Blobs, and a saved copy is only read by the fake core. */
const blobOf = (size: number) => ({ size }) as Blob;

const alertText = async () => (await screen.findByRole('alert')).textContent;

const stubSavePicker = () =>
  vi.stubGlobal('showSaveFilePicker', async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) }));

const emptyState = () => screen.findByRole('heading', { name: 'Open a CAN log to get started' });

describe('App unsaved capture across a reload', () => {
  it('brings an unsaved capture back after a reload, still to be saved', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core, frames } = captureCore();
    const { unmount } = render(<App core={core} />);
    const name = await unsavedCapture(port, core);
    const startedAtMs = (core.startCapture as ReturnType<typeof vi.fn>).mock.calls[0][2] as number;
    const recorded = frames.map((f) => [f.timeNs, f.id, [...f.data]]);

    const reloaded = await reload(unmount);
    await waitFor(() => expect(reloaded.core.endCapture).toHaveBeenCalled());
    expect(reloaded.core.startCapture).toHaveBeenCalledWith(name, 'can0', startedAtMs);
    expect(reloaded.frames.map((f) => [f.timeNs, f.id, [...f.data]])).toEqual(recorded);
    expect(await screen.findByText(/Not saved \u00b7 2 frames/)).toBeTruthy();
    expect(document.querySelector('.doc-title')?.textContent).toBe(name);
    expect(screen.getByRole('button', { name: 'Save Capture\u2026' })).toBeTruthy();

    // Still unsaved, so closing it asks first.
    await userEvent.click(screen.getByRole('button', { name: `Close ${name}` }));
    expect(screen.getByRole('dialog', { name: 'Discard the capture?' })).toBeTruthy();
  });

  it('brings back a capture that was recording when the page went away', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const { unmount } = render(<App core={core} />);
    await startCapture();
    port.send('t1232DEAD\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    const session = await storage();
    // Frames are written every second; asking to leave writes the ones since.
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    await waitFor(async () => expect((await session.keptCaptures())[0]?.frames).toBe(1));

    const reloaded = await reload(unmount);
    expect(await screen.findByText(/Not saved \u00b7 1 frame/)).toBeTruthy();
    expect(reloaded.frames).toHaveLength(1);
  });

  it('never brings back a capture once it is saved', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const { unmount } = render(<App core={core} />);
    const name = await unsavedCapture(port, core);
    stubSavePicker();
    await userEvent.click(screen.getByRole('button', { name: 'Save Capture\u2026' }));
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
    const session = await storage();
    await waitFor(async () => expect(await session.keptCaptures()).toEqual([]));

    const reloaded = await reload(unmount);
    // The candump file it was saved as comes back instead.
    await waitFor(() => expect(reloaded.core.openLog).toHaveBeenCalled());
    expect((reloaded.core.openLog as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(name);
    expect(reloaded.core.startCapture).not.toHaveBeenCalled();
  });

  it('never brings back a capture exported in another format', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    render(<App core={core} />);
    await unsavedCapture(port, core);
    stubSavePicker();
    await userEvent.click(screen.getByRole('button', { name: 'Export Log\u2026' }));
    const sheet = screen.getByRole('dialog', { name: 'Export Log' });
    await userEvent.click(within(sheet).getByRole('radio', { name: /CSV/ }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Export\u2026' }));
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
    const session = await storage();
    await waitFor(async () => expect(await session.keptCaptures()).toEqual([]));
  });

  it('never brings back a discarded capture', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const { unmount } = render(<App core={core} />);
    const name = await unsavedCapture(port, core);
    await userEvent.click(screen.getByRole('button', { name: `Close ${name}` }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Discard the capture?' })).getByRole('button', { name: 'Discard Capture' }));
    await emptyState();
    const session = await storage();
    await waitFor(async () => expect(await session.keptCaptures()).toEqual([]));

    const reloaded = await reload(unmount);
    expect(await emptyState()).toBeTruthy();
    expect(reloaded.core.startCapture).not.toHaveBeenCalled();
  });

  it('forgets the capture once another log replaces it', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const { container } = render(<App core={core} />);
    await unsavedCapture(port, core);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    await userEvent.upload(input, new File(['(1.0) can0 123#00\n'], 'other.log'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Discard the capture?' })).getByRole('button', { name: 'Discard Capture' }));
    await waitFor(() => expect(document.querySelector('.doc-title')?.textContent).toBe('other.log'));
    const session = await storage();
    await waitFor(async () => expect(await session.keptCaptures()).toEqual([]));
  });

  it('keeps only the newest capture once another starts, even one brought back by a reload', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const { unmount } = render(<App core={core} />);
    const first = await unsavedCapture(port, core);
    const session = await storage();
    expect((await session.keptCaptures()).map((c) => c.name)).toEqual([first]);

    const reloaded = await reload(unmount);
    await screen.findByText(/Not saved \u00b7 2 frames/);
    const nextPort = new FakeSerialPort();
    withSerialPort(nextPort);
    await userEvent.click(screen.getByRole('button', { name: 'Capture\u2026' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Discard the capture?' })).getByRole('button', { name: 'Discard Capture' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Adapter\u2026' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Live Capture' })).getByRole('button', { name: 'Start Capture' }));
    await screen.findByRole('button', { name: 'Stop Capture' });
    await waitFor(async () => expect(await session.keptCaptures()).toHaveLength(1));
    const kept = await session.keptCaptures();
    // Named by its start time, so the second may share the first's name; its ID differs.
    expect(kept[0].startedAtMs).toBe((reloaded.core.startCapture as ReturnType<typeof vi.fn>).mock.calls.at(-1)![2]);
  });

  it('leaves alone a capture another tab has open, and brings it back once that tab is gone', async () => {
    const otherTab = await storage();
    const capture = { id: 'other', name: 'capture-20261006-101500.log', bus: 'can0', startedAtMs: 1_700_000_000_000, bitrate: 500_000, layout: 1, frames: 1, bytes: 15 };
    const { packFrames } = await import('./core/captureFrames');
    const chunk = packFrames([{ timeNs: 5, id: 0x123, extended: false, flags: 0, data: Uint8Array.of(1) }]);
    expect(await otherTab.lockCapture('other')).not.toBeNull();
    await otherTab.writeKeptCapture(capture, { seq: 0, bytes: chunk.buffer as ArrayBuffer });

    const App = await freshApp();
    const { core } = captureCore();
    const { unmount, container } = render(<App core={core} />);
    await emptyState();
    // Opening and closing a log here touches only this tab's own session.
    const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    await userEvent.upload(input, new File(['(1.0) can0 123#00\n'], 'mine.log'));
    await waitFor(() => expect(document.querySelector('.doc-title')?.textContent).toBe('mine.log'));
    await userEvent.click(screen.getByRole('button', { name: 'Close mine.log' }));
    await emptyState();
    expect(core.startCapture).not.toHaveBeenCalled();
    expect((await otherTab.keptCaptures()).map((c) => c.id)).toEqual(['other']);

    // The other tab crashed: the next page load restores its capture.
    const reloaded = await reload(unmount);
    await waitFor(() => expect(reloaded.core.endCapture).toHaveBeenCalled());
    expect(reloaded.core.startCapture).toHaveBeenCalledWith(capture.name, 'can0', capture.startedAtMs);
    expect(await screen.findByText(/Not saved \u00b7 1 frame/)).toBeTruthy();
  });

  it('says once that the capture is not kept when storage is full, and goes on recording', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core, frames } = captureCore();
    const { unmount } = render(<App core={core} />);
    await startCapture();
    // Full once the keeper has begun, but before the frame comes: whichever write takes the frame
    // (when the keeper begins, every second, or when the page asks to leave) is then refused.
    const session = await storage();
    await waitFor(async () => expect(await session.keptCaptures()).toHaveLength(1));
    fillStorage();
    port.send('t1232DEAD\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    const banner = await screen.findByText(/couldn\u2019t keep a copy of capture-\d{8}-\d{6}\.log, so it won\u2019t reopen after a reload/);
    expect(banner.textContent).toMatch(/Its storage is full\. Save Capture\u2026 keeps it in a file\.$/);
    expect(document.querySelector('.toolbar [role=status]')?.textContent).toMatch(/couldn't keep a copy/);
    expect(await session.keptCaptures()).toEqual([]);

    // The page didn't go after all: the capture goes on, only not kept.
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await screen.findByText(/Not saved/);
    expect(frames).toHaveLength(1);
    expect(await session.keptCaptures()).toEqual([]);

    await reload(unmount);
    expect(await emptyState()).toBeTruthy();
  });

  it('says how to get the capture back when the engine restarts', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    let listener: (() => void) | null = null;
    core.onReset = (l) => {
      listener = l;
      return () => (listener = null);
    };
    const { unmount } = render(<App core={core} />);
    await unsavedCapture(port, core);
    act(() => listener?.());
    expect((await screen.findByRole('alert')).textContent).toBe('The CAN core stopped and was restarted. Reload the page to get the capture back.');

    const reloaded = await reload(unmount);
    await waitFor(() => expect(reloaded.core.endCapture).toHaveBeenCalled());
    expect(await screen.findByText(/Not saved \u00b7 2 frames/)).toBeTruthy();
  });

  it('asks before the demo link replaces a capture brought back', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const { unmount } = render(<App core={core} />);
    await unsavedCapture(port, core);
    window.history.replaceState(null, '', '/?demo=1');
    try {
      await reload(unmount);
      expect(await screen.findByRole('dialog', { name: 'Discard the capture?' })).toBeTruthy();
      await userEvent.click(within(screen.getByRole('dialog', { name: 'Discard the capture?' })).getByRole('button', { name: 'Cancel' }));
      expect(screen.getByText(/Not saved \u00b7 2 frames/)).toBeTruthy();
    } finally {
      window.history.replaceState(null, '', '/');
    }
  });

  /** Loads the app over a core whose `appendFrames` never finishes, as during a long restore. Resolves once it is restoring. */
  async function loadRestoring() {
    const App = await freshApp();
    const { core } = captureCore();
    core.appendFrames = vi.fn(() => new Promise<never>(() => {}));
    const page = render(<App core={core} />);
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    return page;
  }

  /** The page goes away mid-restore: reloaded or closed if `left`, or else crashed or killed. */
  function pageGone(page: { unmount: () => void }, left: boolean) {
    if (left) window.dispatchEvent(new Event('pagehide'));
    page.unmount();
    locks.dropAll();
  }

  it('still restores a capture whose restore two reloads cut short', async () => {
    const { session } = await storedCapture();
    pageGone(await loadRestoring(), true);
    pageGone(await loadRestoring(), true);
    const App = await freshApp();
    const { core } = captureCore();
    render(<App core={core} />);
    expect(await screen.findByText(/Not saved \u00b7 1 frame/)).toBeTruthy();
    await waitFor(async () => expect(await session.keptCaptures()).toMatchObject([{ failedRestores: 0 }]));
  });

  it('asks before restoring again a capture whose restore crashed the page twice, keeping it meanwhile', async () => {
    const { session, capture } = await storedCapture();
    await session.save('log', { name: 'p.log', blob: blobOf(10) });
    pageGone(await loadRestoring(), false);
    pageGone(await loadRestoring(), false);
    const App = await freshApp();
    const { core } = captureCore();
    render(<App core={core} />);
    expect(await screen.findByText(`${capture.name} couldn\u2019t be restored after 2 tries.`, { exact: false })).toBeTruthy();
    expect(screen.getByText(/The page stopped while restoring it\. It\u2019s still kept in this browser, unsaved\./)).toBeTruthy();
    // Meanwhile the saved log opens, as it would have without the capture.
    await waitFor(() => expect(document.querySelector('.doc-title')?.textContent).toBe('p.log'));
    expect(core.startCapture).not.toHaveBeenCalled();
    expect(await session.keptCaptures()).toHaveLength(1);
    expect(locks.holds(`freecan-studio-capture-${capture.id}`)).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByText(/Not saved \u00b7 1 frame/)).toBeTruthy();
    expect(document.querySelector('.doc-title')?.textContent).toBe(capture.name);
    expect(screen.queryByText(/couldn\u2019t be restored after/)).toBeNull();
    await waitFor(async () => expect(await session.keptCaptures()).toMatchObject([{ failedRestores: 0 }]));
  });

  it('hides the question for this session on Dismiss, still holding the capture', async () => {
    const { session, capture } = await storedCapture({ failedRestores: 2, lastRestoreError: 'There isn\u2019t enough memory' });
    const App = await freshApp();
    render(<App core={captureCore().core} />);
    expect(await screen.findByText(/There isn\u2019t enough memory\. It\u2019s still kept in this browser/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/couldn\u2019t be restored after/)).toBeNull();
    expect(locks.holds(`freecan-studio-capture-${capture.id}`)).toBe(true);
    expect(await session.keptCaptures()).toHaveLength(1);
  });

  it('keeps a capture that fails to restore for a reload to try again, then asks, and deletes it only when told', async () => {
    const { session, capture } = await storedCapture();
    const brokenCore = () => {
      const { core } = captureCore();
      core.appendFrames = vi.fn(() => Promise.reject(new Error('There isn\u2019t enough memory')));
      return core;
    };
    let App = await freshApp();
    const first = render(<App core={brokenCore()} />);
    expect(await alertText()).toBe(`The unsaved capture ${capture.name} couldn't be restored: There isn\u2019t enough memory. Reload the page to try again.`);
    expect(await emptyState()).toBeTruthy();
    await waitFor(() => expect([...locks.heldNames()]).toEqual([]));
    expect(await session.keptCaptures()).toMatchObject([{ id: 'gone', failedRestores: 1 }]);

    first.unmount();
    App = await freshApp();
    const second = render(<App core={brokenCore()} />);
    expect(await screen.findByText(/There isn\u2019t enough memory\. It\u2019s still kept in this browser/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();

    // Try Again that fails again asks again.
    await userEvent.click(screen.getByRole('button', { name: 'Try Again' }));
    await waitFor(async () => expect(await session.keptCaptures()).toMatchObject([{ failedRestores: 3 }]));
    expect(await screen.findByText(/couldn\u2019t be restored after 2 tries/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Delete\u2026' }));
    const confirm = screen.getByRole('dialog', { name: 'Delete the capture?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(await session.keptCaptures()).toHaveLength(1);
    await userEvent.click(screen.getByRole('button', { name: 'Delete\u2026' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Delete the capture?' })).getByRole('button', { name: 'Delete Capture' }));
    expect(screen.queryByText(/couldn\u2019t be restored after/)).toBeNull();
    await waitFor(async () => expect(await session.keptCaptures()).toEqual([]));

    const reloaded = await reload(second.unmount);
    expect(await emptyState()).toBeTruthy();
    expect(reloaded.core.startCapture).not.toHaveBeenCalled();
  });

  it('counts a restore as done once it is', async () => {
    const { session } = await storedCapture({ failedRestores: 1 });
    const App = await freshApp();
    render(<App core={captureCore().core} />);
    expect(await screen.findByText(/Not saved \u00b7 1 frame/)).toBeTruthy();
    await waitFor(async () => expect(await session.keptCaptures()).toMatchObject([{ failedRestores: 0 }]));
  });

  it('deletes at once a capture whose stored frames are damaged', async () => {
    const { session, capture } = await storedCapture();
    const { packFrames } = await import('./core/captureFrames');
    const cutShort = packFrames([{ timeNs: 5, id: 0x123, extended: false, flags: 0, data: Uint8Array.of(1, 2, 3) }]).slice(0, 15);
    await session.writeKeptCapture(capture, { seq: 0, bytes: cutShort.buffer as ArrayBuffer });
    const App = await freshApp();
    render(<App core={captureCore().core} />);
    expect(await alertText()).toBe(`The unsaved capture ${capture.name} couldn't be restored, so it was deleted: some of its frames are cut short`);
    await waitFor(async () => expect(await session.keptCaptures()).toEqual([]));
  });

  it('keeps a capture whose restore an engine restart cut short, for a reload to bring back', async () => {
    const { session, capture } = await storedCapture();
    const App = await freshApp();
    const { core } = captureCore();
    let reset: (() => void) | null = null;
    core.onReset = (listener) => {
      reset = listener;
      return () => (reset = null);
    };
    core.appendFrames = vi.fn(() => {
      act(() => reset?.());
      return Promise.reject(new Error('The CAN core stopped'));
    });
    const { unmount } = render(<App core={core} />);
    // In place of the restart's own message, which says to open the log again.
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(`The unsaved capture ${capture.name} couldn't be restored: The CAN core stopped. Reload the page to try again.`));
    expect(await session.keptCaptures()).toHaveLength(1);

    const reloaded = await reload(unmount);
    await waitFor(() => expect(reloaded.core.endCapture).toHaveBeenCalled());
    expect(await screen.findByText(/Not saved \u00b7 1 frame/)).toBeTruthy();
  });

  it('opens the saved log when a capture fails to restore', async () => {
    const { session, capture } = await storedCapture();
    await session.save('log', { name: 'p.log', blob: blobOf(10) });
    const App = await freshApp();
    const { core } = captureCore();
    core.appendFrames = vi.fn(() => Promise.reject(new Error('There isn\u2019t enough memory')));
    render(<App core={core} />);
    await waitFor(() => expect(document.querySelector('.doc-title')?.textContent).toBe('p.log'));
    expect(await alertText()).toMatch(new RegExp(`^The unsaved capture ${capture.name} couldn't be restored`));
  });

  it('restores a rolling capture without the frames it had dropped', async () => {
    await storedCapture({ trimmedBeforeNs: 7 }, [5, 10]);
    const App = await freshApp();
    const { core, frames } = captureCore();
    render(<App core={core} />);
    await waitFor(() => expect(core.endCapture).toHaveBeenCalled());
    expect(core.trimCapture).toHaveBeenCalledWith(7);
    expect(frames.map((f) => f.timeNs)).toEqual([10]);
  });

  it('reopens log B beside a capture brought back', async () => {
    const { session } = await storedCapture();
    await session.save('compare', { name: 'b.log', blob: blobOf(5) });
    await session.save('ui', { view: 'compare', selected: -1, pinnedTime: null, plots: [] });
    const App = await freshApp();
    const { core } = captureCore();
    let logB: LogInfo | null = null;
    Object.assign(core, {
      openCompareLog: vi.fn<CoreApi['openCompareLog']>(async (_file, name) => (logB = logInfo({ name }))),
      compareLogInfo: async () => logB,
      compareLogs: async () => [],
    });
    render(<App core={core} />);
    expect(await screen.findByText(/Not saved \u00b7 1 frame/)).toBeTruthy();
    await waitFor(() => expect(core.openCompareLog).toHaveBeenCalledWith(expect.anything(), 'b.log', expect.any(Function)));
    expect((await session.loadSaved<{ name: string }>('compare'))?.name).toBe('b.log');
    expect(await session.keptCaptures()).toHaveLength(1);
  });

  /** Restores a stored capture, then begins reading other.log over it. Resolves with how to end the read. */
  async function readOverRestored() {
    const { session } = await storedCapture();
    const App = await freshApp();
    const { core } = captureCore();
    let failRead: (e: unknown) => void = () => {};
    core.openLog = vi.fn<CoreApi['openLog']>(async (file, name) => {
      if (file.size === 0) {
        failRead(new DOMException(LOG_SUPERSEDED, 'AbortError'));
        return logInfo({ name, frames: 0, bytes: 0 });
      }
      return new Promise<LogInfo>((_, reject) => (failRead = reject));
    });
    const { container, unmount } = render(<App core={core} />);
    await screen.findByText(/Not saved \u00b7 1 frame/);
    const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    await userEvent.upload(input, new File(['(1.0) can0 123#00\n'], 'other.log'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Discard the capture?' })).getByRole('button', { name: 'Discard Capture' }));
    await screen.findByRole('button', { name: 'Cancel reading other.log' });
    return { session, unmount, fail: (message: string) => act(async () => failRead(new Error(message))) };
  }

  it('leaves no log, and no capture to bring back, when a read over a restored capture is cancelled', async () => {
    const { session, unmount } = await readOverRestored();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel reading other.log' }));
    expect(await emptyState()).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(async () => expect(await session.keptCaptures()).toEqual([]));

    const reloaded = await reload(unmount);
    expect(await emptyState()).toBeTruthy();
    expect(reloaded.core.startCapture).not.toHaveBeenCalled();
  });

  it('leaves no log, and no capture to bring back, when a read over a restored capture fails', async () => {
    const { session, fail } = await readOverRestored();
    await fail('other.log is not a CAN log.');
    expect(await alertText()).toContain('other.log is not a CAN log.');
    expect(await emptyState()).toBeTruthy();
    expect(await session.keptCaptures()).toEqual([]);
  });
});
