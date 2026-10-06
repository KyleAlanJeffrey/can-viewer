import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureFrame, CoreApi } from './core/api';
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
    await otherTab.writeCaptureChunk(capture, { seq: 0, bytes: chunk.buffer as ArrayBuffer });

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
    port.send('t1232DEAD\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    fillStorage();
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    const banner = await screen.findByText(/couldn\u2019t keep a copy of capture-\d{8}-\d{6}\.log, so it won\u2019t come back after a reload/);
    expect(banner.textContent).toMatch(/Its storage is full\. Save Capture\u2026 keeps it in a file\.$/);
    expect(document.querySelector('.toolbar [role=status]')?.textContent).toMatch(/couldn't keep a copy/);
    const session = await storage();
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

  it('forgets a kept capture that fails to restore, so it is not tried again', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const { unmount } = render(<App core={core} />);
    const name = await unsavedCapture(port, core);

    unmount();
    locks.dropAll();
    const Reloaded = await freshApp();
    const broken = captureCore().core;
    broken.appendFrames = vi.fn(() => Promise.reject(new Error('There isn\u2019t enough memory.')));
    const second = render(<Reloaded core={broken} />);
    expect((await screen.findByRole('alert')).textContent).toBe(`The unsaved capture ${name} couldn't be restored: There isn\u2019t enough memory.`);
    expect(await emptyState()).toBeTruthy();

    const reloaded = await reload(second.unmount);
    expect(await emptyState()).toBeTruthy();
    expect(reloaded.core.startCapture).not.toHaveBeenCalled();
  });
});
