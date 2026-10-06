import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOG_SUPERSEDED, type CaptureFrame, type CoreApi, type LogInfo, type Progress, type SeriesInfo } from './core/api';
import { FakeSerialPort } from './test/fakeSerial';
import { fakeCore, logInfo, message, seriesInfo, signal as signalDef, summary } from './test/fixtures';

/** session.ts caches its open database, so each test loads a fresh copy of the app's modules. */
async function freshApp() {
  vi.resetModules();
  return (await import('./App')).App;
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete (navigator as { serial?: unknown }).serial;
});

describe('App', () => {
  it('shows the empty state when there is no saved session', async () => {
    const App = await freshApp();
    const core = fakeCore({ setDatabases: vi.fn(() => Promise.resolve()) });
    render(<App core={core} />);
    expect(await screen.findByRole('heading', { name: 'Open a CAN log to get started' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Try the Demo' })).toBeTruthy();
    expect(screen.getByText('Message IDs appear here once a log is open.')).toBeTruthy();
    expect(core.setDatabases).not.toHaveBeenCalled();
  });

  it('says why a log gave no frames, naming its format', async () => {
    const App = await freshApp();
    const core = fakeCore({
      openLog: () => Promise.resolve(logInfo({ name: 'x.mf4', format: 'mf4', frames: 0, rejected: 1, firstRejection: [1, 'data larger than 1 GiB'] })),
    });
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    await userEvent.upload(input, new File(['MDF'], 'x.mf4'));
    expect((await screen.findByRole('alert')).textContent).toContain('No CAN frames in x.mf4 (MF4): data larger than 1 GiB.');
  });

  it('offers Export Log once a log is open, and shows why an export failed', async () => {
    const App = await freshApp();
    const exportLog = vi.fn<CoreApi['exportLog']>(() => Promise.reject(new Error("There isn't enough memory to build the exported file.")));
    const core = fakeCore({
      openLog: () => Promise.resolve(logInfo({ name: 'x.blf', format: 'blf' })),
      idSummary: () => Promise.resolve([]),
      exportLog,
    });
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    const exportButton = screen.getByRole('button', { name: 'Export Log\u2026' }) as HTMLButtonElement;
    expect(exportButton.disabled).toBe(true);

    const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    await userEvent.upload(input, new File(['LOGG'], 'x.blf'));
    await screen.findByText(/^BLF/);
    expect(exportButton.disabled).toBe(false);
    await userEvent.click(exportButton);
    expect(screen.getByRole('dialog', { name: 'Export Log' })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(exportLog).toHaveBeenCalledWith('candump');
    expect((await screen.findByRole('alert')).textContent).toContain("There isn't enough memory to build the exported file.");
    // Disabled while the export ran, the button gets focus back once enabled.
    await waitFor(() => expect(document.activeElement).toBe(exportButton));
    expect(exportButton.disabled).toBe(false);
  });

  it('picks the default export format for each log opened', async () => {
    const App = await freshApp();
    const core = fakeCore({
      openLog: (_file, logName) => Promise.resolve(logInfo({ name: logName, format: logName.endsWith('.asc') ? 'asc' : 'candump' })),
      idSummary: () => Promise.resolve([]),
    });
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    const exportButton = screen.getByRole('button', { name: 'Export Log\u2026' });
    const checkedFormat = async () => {
      await userEvent.click(exportButton);
      const sheet = screen.getByRole('dialog', { name: 'Export Log' });
      const checked = within(sheet).getByRole('radio', { checked: true }).getAttribute('aria-label');
      await userEvent.click(within(sheet).getByRole('button', { name: 'Cancel' }));
      return checked;
    };

    await userEvent.upload(input, new File(['(1.0) can0 123#00\n'], 'x.log'));
    await screen.findByText('candump \u00b7 1,000 frames \u00b7 1 min 40 s');
    expect(await checkedFormat()).toBe('Vector ASC (.asc)');

    await userEvent.upload(input, new File(['base hex'], 'y.asc'));
    await screen.findByText('ASC \u00b7 1,000 frames \u00b7 1 min 40 s');
    expect(await checkedFormat()).toBe('candump (.log)');
  });

  it('shows the format of an open log next to its frame count', async () => {
    const App = await freshApp();
    const core = fakeCore({
      openLog: () => Promise.resolve(logInfo({ name: 'x.blf', format: 'blf' })),
      idSummary: () => Promise.resolve([]),
    });
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    await userEvent.upload(input, new File(['LOGG'], 'x.blf'));
    expect(await screen.findByText('BLF \u00b7 1,000 frames \u00b7 1 min 40 s')).toBeTruthy();
  });
});

/** The toolbar's status line, which screen readers hear; views have status lines of their own. */
const toolbarStatus = () => document.querySelector('.toolbar [role=status]')?.textContent;

describe('App while a log is read', () => {
  interface FakeRead {
    name: string;
    settled: boolean;
    superseded: boolean;
    progress: (p: Progress) => void;
    /** Resolves the read without `act`, for a test that needs to act between steps itself. */
    settle: () => void;
    resolve: () => Promise<void>;
    fail: (message: string) => Promise<void>;
    abort: () => void;
  }

  /**
   * A core whose reads the test finishes. As the worker does, an `openLog` supersedes the read
   * under way, which rejects with an AbortError once the test calls `abortSuperseded`, and a
   * superseded read that resolves anyway, past its last chunk, leaves no log.
   */
  function readingCore(overrides: Partial<CoreApi> = {}) {
    const reads: FakeRead[] = [];
    const events: string[] = [];
    let current: FakeRead | null = null;
    let held: string | null = null;
    const core = fakeCore({
      openLog: vi.fn<CoreApi['openLog']>((file, name, onProgress) => {
        events.push(`openLog ${name}`);
        if (current) current.superseded = true;
        current = null;
        held = null;
        if (file.size === 0) return Promise.resolve(logInfo({ name, frames: 0, bytes: 0 }));
        return new Promise<LogInfo>((resolve, reject) => {
          const read: FakeRead = {
            name,
            settled: false,
            superseded: false,
            progress: (p) => act(() => onProgress(p)),
            settle: () => {
              read.settled = true;
              if (!read.superseded) held = name;
              if (current === read) current = null;
              resolve(logInfo({ name, bytes: file.size }));
            },
            resolve: () => act(async () => read.settle()),
            fail: (message) =>
              act(async () => {
                read.settled = true;
                if (current === read) current = null;
                reject(new Error(message));
              }),
            abort: () => {
              read.settled = true;
              reject(new DOMException(LOG_SUPERSEDED, 'AbortError'));
            },
          };
          current = read;
          reads.push(read);
        });
      }),
      idSummary: () => Promise.resolve([]),
      parseDbc: (_file, name) => {
        events.push(`parseDbc ${name}`);
        return Promise.resolve({ name, messages: [] });
      },
      setDatabases: () => {
        events.push('setDatabases');
        return Promise.resolve();
      },
      ...overrides,
    });
    /** The latest unsettled read of `name`. */
    const read = async (name: string) => {
      const find = () => reads.filter((r) => r.name === name && !r.settled).pop();
      await waitFor(() => expect(find()).toBeTruthy());
      return find()!;
    };
    const abortSuperseded = () => act(async () => reads.filter((r) => r.superseded && !r.settled).forEach((r) => r.abort()));
    const openedNames = () => events.filter((e) => e.startsWith('openLog ')).map((e) => e.slice('openLog '.length));
    return { core, read, abortSuperseded, events, openedNames, held: () => held };
  }

  const pick = (container: HTMLElement, name: string) =>
    userEvent.upload(container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!, new File(['(1.0) can0 123#00\n'], name));

  function drop(files: File[]) {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files } });
    act(() => {
      window.dispatchEvent(event);
    });
  }

  const title = () => document.querySelector('.doc-title')?.textContent;
  const openLogButton = () => screen.getByRole('button', { name: 'Open Log\u2026' }) as HTMLButtonElement;
  const savedLog = async () => (await (await import('./session')).loadSaved<{ name: string }>('log'))?.name;

  async function openFirst(container: HTMLElement, name: string, read: (name: string) => Promise<FakeRead>) {
    await pick(container, name);
    await (await read(name)).resolve();
    await waitFor(() => expect(title()).toBe(name));
    await waitFor(async () => expect(await savedLog()).toBe(name));
    // fake-indexeddb can't clone jsdom's Files, and a reopen reads only the copy's size.
    const file = new File(['(1.0) can0 123#00\n'], name);
    await (await import('./session')).save('log', { name, blob: { size: file.size } as Blob });
  }

  it('reads a log picked while another is read in its place, showing no error', async () => {
    const App = await freshApp();
    const { core, read, abortSuperseded, openedNames } = readingCore();
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });

    await pick(container, 'a.log');
    const a = await read('a.log');
    a.progress({ bytes: 30, total: 100 });
    expect(toolbarStatus()).toBe('Parsing a.log\u2026 30%');
    expect(openLogButton().disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Cancel reading a.log' })).toBeTruthy();

    await pick(container, 'b.log');
    // An empty log stops the read at once; b.log waits until the core has let a.log go.
    expect(openedNames()).toEqual(['a.log', '']);
    expect(toolbarStatus()).toBe('Reading b.log\u2026');
    // Progress from the stopped read, and its AbortError arriving late, change nothing.
    a.progress({ bytes: 90, total: 100 });
    expect(toolbarStatus()).toBe('Reading b.log\u2026');
    expect(document.querySelector('.progress')).toBeNull();
    await abortSuperseded();

    const b = await read('b.log');
    b.progress({ bytes: 50, total: 100 });
    expect(toolbarStatus()).toBe('Parsing b.log\u2026 50%');
    await b.resolve();
    await waitFor(() => expect(title()).toBe('b.log'));
    expect(toolbarStatus()).toBe('candump \u00b7 1,000 frames \u00b7 1 min 40 s');
    expect(openedNames()).toEqual(['a.log', '', 'b.log']);
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(async () => expect(await savedLog()).toBe('b.log'));
  });

  it('keeps the log that took over when the stopped read finishes after all, and never saves it', async () => {
    const App = await freshApp();
    const { core, read, openedNames, held } = readingCore();
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });

    await pick(container, 'a.log');
    const a = await read('a.log');
    await pick(container, 'b.log');
    // Past the last chunk the core takes no newer call, so a stopped read can still resolve.
    await a.resolve();
    expect(title()).toBe('No log open');
    expect(toolbarStatus()).toBe('Reading b.log\u2026');
    expect(await savedLog()).toBeUndefined();
    const b = await read('b.log');
    await b.resolve();
    await waitFor(() => expect(title()).toBe('b.log'));
    expect(held()).toBe('b.log');
    expect(openedNames()).toEqual(['a.log', '', 'b.log']);
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(async () => expect(await savedLog()).toBe('b.log'));
  });

  it('shows why the log that took over failed, and leaves no log', async () => {
    const App = await freshApp();
    const { core, read, abortSuperseded } = readingCore();
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    await openFirst(container, 'p.log', read);

    await pick(container, 'a.log');
    await read('a.log');
    await pick(container, 'b.log');
    await abortSuperseded();
    await (await read('b.log')).fail('b.log is not a CAN log.');
    expect((await screen.findByRole('alert')).textContent).toContain('b.log is not a CAN log.');
    expect(title()).toBe('No log open');
    await waitFor(async () => expect(await savedLog()).toBeUndefined());
  });

  it('reopens the log shown before, as it was, when the read is cancelled', async () => {
    const App = await freshApp();
    const { core, read, abortSuperseded, openedNames, held } = readingCore({ compareLogInfo: async () => null });
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    await openFirst(container, 'p.log', read);
    await userEvent.click(screen.getByRole('radio', { name: 'Compare' }));

    await pick(container, 'a.log');
    (await read('a.log')).progress({ bytes: 40, total: 100 });
    // The log shown until the read ends is the one Cancel goes back to.
    expect(title()).toBe('p.log');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel reading a.log' }));
    await abortSuperseded();
    const p = await read('p.log');
    expect(toolbarStatus()).toBe('Reading p.log\u2026');
    expect(title()).toBe('p.log');
    await p.resolve();
    await waitFor(() => expect(toolbarStatus()).toBe('candump \u00b7 1,000 frames \u00b7 1 min 40 s'));
    expect(title()).toBe('p.log');
    expect(held()).toBe('p.log');
    expect(screen.getByRole('radio', { name: 'Compare' }).getAttribute('aria-checked')).toBe('true');
    expect(openedNames()).toEqual(['p.log', 'a.log', '', '', 'p.log']);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await savedLog()).toBe('p.log');
    expect(document.activeElement).toBe(openLogButton());
  });

  it('leaves no log when the log shown before has no saved copy to reopen', async () => {
    const App = await freshApp();
    const session = await import('./session');
    const { core, read, abortSuperseded, held } = readingCore();
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    await openFirst(container, 'p.log', read);
    // As when the browser couldn't keep a copy.
    await session.forget('log');

    await pick(container, 'a.log');
    await read('a.log');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel reading a.log' }));
    await abortSuperseded();
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    expect(title()).toBe('No log open');
    await waitFor(() => expect(toolbarStatus()).toBe('Open a CAN log to begin'));
    expect(held()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await savedLog()).toBeUndefined();
    await waitFor(() => expect(document.activeElement).toBe(openLogButton()));
    expect(openLogButton().disabled).toBe(false);
  });

  it('does nothing when Cancel is pressed as the read ends, before the next render', async () => {
    const App = await freshApp();
    const { core, read, openedNames, held } = readingCore();
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    await pick(container, 'a.log');
    const a = await read('a.log');
    const cancel = screen.getByRole('button', { name: 'Cancel reading a.log' });
    await act(async () => {
      a.settle();
      await new Promise((resolve) => setTimeout(resolve, 0));
      cancel.click();
    });
    await waitFor(() => expect(title()).toBe('a.log'));
    expect(held()).toBe('a.log');
    expect(openedNames()).toEqual(['a.log']);
    await waitFor(async () => expect(await savedLog()).toBe('a.log'));
  });

  it('cancels a saved log being reopened after a reload, leaving none', async () => {
    const App = await freshApp();
    const session = await import('./session');
    await session.save('log', { name: 'p.log', blob: { size: 10 } as Blob });
    await session.save('compare', { name: 'q.log', blob: { size: 10 } as Blob });
    const { core, read, abortSuperseded } = readingCore();
    render(<App core={core} />);
    await read('p.log');
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel reading p.log' }));
    await abortSuperseded();
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(await session.loadSaved('log')).toBeUndefined();
    expect(await session.loadSaved('compare')).toBeUndefined();
  });

  it('shows only the log that took over from a reopened one still restoring its plots', async () => {
    const App = await freshApp();
    const session = await import('./session');
    const speed = summary({ id: 0x123, dbc: 0, messageId: 0x123 });
    await session.saveDbcs([
      { id: 'd', db: { name: 'car.dbc', messages: [message(0x123, 'M', { signals: [signalDef('Speed')], j1939: false })] }, channel: null, edited: false },
    ]);
    await session.save('log', { name: 'p.log', blob: { size: 10 } as Blob });
    await session.save('ui', { view: 'overview', selected: speed.key, pinnedTime: null, plots: [{ key: speed.key, signal: 'Speed', color: '#a56612' }] });
    let decoded: (info: SeriesInfo) => void = () => {};
    const decodeSignal = vi.fn<CoreApi['decodeSignal']>(() => new Promise<SeriesInfo>((resolve) => (decoded = resolve)));
    const { core, read, abortSuperseded, openedNames } = readingCore({ idSummary: async () => [speed], decodeSignal });
    const { container } = render(<App core={core} />);
    await (await read('p.log')).resolve();
    await waitFor(() => expect(decodeSignal).toHaveBeenCalled());

    await pick(container, 'b.log');
    await act(async () => decoded(seriesInfo(1, 'Speed')));
    await abortSuperseded();
    await (await read('b.log')).resolve();
    await waitFor(() => expect(title()).toBe('b.log'));
    expect(openedNames()).toEqual(['p.log', '', 'b.log']);
    expect(screen.queryByRole('alert')).toBeNull();
    await waitFor(async () => expect(await savedLog()).toBe('b.log'));
    // p.log's plots don't come back with b.log.
    await waitFor(async () => expect((await session.loadSaved<{ plots: unknown[]; selected: number }>('ui'))?.plots).toEqual([]));
    expect(decodeSignal).toHaveBeenCalledTimes(1);
  });

  it('reads a log dropped while another is read in its place, and turns away a DBC alone', async () => {
    const App = await freshApp();
    const { core, read, abortSuperseded, openedNames } = readingCore();
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    await pick(container, 'a.log');
    await read('a.log');

    drop([new File(['VERSION ""'], 'x.dbc')]);
    expect((await screen.findByRole('alert')).textContent).toContain('Wait for "Reading a.log\u2026" to finish, then drop the files again.');
    expect(openedNames()).toEqual(['a.log']);

    drop([new File(['(1.0) can0 123#00\n'], 'b.log')]);
    await abortSuperseded();
    const b = await read('b.log');
    await b.resolve();
    await waitFor(() => expect(title()).toBe('b.log'));
    expect(openedNames()).toEqual(['a.log', '', 'b.log']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stops the read before the DBCs dropped with a log are loaded', async () => {
    const App = await freshApp();
    const { core, read, abortSuperseded, events } = readingCore();
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    await pick(container, 'a.log');
    await read('a.log');

    drop([new File(['VERSION ""'], 'x.dbc'), new File(['(1.0) can0 123#00\n'], 'b.log')]);
    await abortSuperseded();
    await (await read('b.log')).resolve();
    await waitFor(() => expect(title()).toBe('b.log'));
    expect(events).toEqual(['openLog a.log', 'openLog ', 'parseDbc x.dbc', 'setDatabases', 'openLog b.log']);
  });

  it('opens the demo in place of a log being read', async () => {
    const App = await freshApp();
    vi.stubGlobal('fetch', async (path: string) => new Response(path.endsWith('.dbc') ? 'VERSION ""' : '(1.0) can0 123#00\n'));
    const { core, read, abortSuperseded, openedNames } = readingCore();
    const { container } = render(<App core={core} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    await pick(container, 'a.log');
    await read('a.log');

    await userEvent.click(screen.getByRole('button', { name: 'Try the Demo' }));
    await abortSuperseded();
    const demo = await read('demo.log');
    await demo.resolve();
    await waitFor(() => expect(title()).toBe('demo.log'));
    expect(openedNames()).toEqual(['a.log', '', 'demo.log']);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('App live capture', () => {
  /** A browser with Web Serial whose device prompt picks `port`. */
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
        return Promise.resolve(info());
      }),
      appendFrames: vi.fn((batch: CaptureFrame[]) => {
        frames.push(...batch);
        return Promise.resolve(info());
      }),
      endCapture: vi.fn(() => Promise.resolve(info())),
      idSummary: () => Promise.resolve(frames.length > 0 ? [summary({ id: 0x123, count: frames.length })] : []),
      exportLog: vi.fn(() => Promise.resolve(new Blob(['(1.000000) can0 123#DEAD\n']))),
    });
    return { core, frames };
  }

  async function startCapture(port: FakeSerialPort) {
    await userEvent.click(await screen.findByRole('button', { name: 'Capture\u2026' }));
    // The sheet shows as loading until its code arrives.
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Adapter\u2026' }));
    const sheet = screen.getByRole('dialog', { name: 'Live Capture' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Start Capture' }));
    await screen.findByRole('button', { name: 'Stop Capture' });
    expect(port.commands).toEqual(['C', 'S6', 'Z1', 'V', 'L']);
  }

  it('records from an slcan adapter, shows the frames as they come, and saves them as a candump log', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core, frames } = captureCore();
    render(<App core={core} />);
    await startCapture(port);

    expect(screen.getByText('Recording').parentElement!.textContent).toMatch(/^Recording \u00b7 Listen only \u00b7 0 frames/);
    expect(toolbarStatus()).toBe('Recording from USB serial device 16D0:117E, listen only.');
    // The core adds the frames that match to the filtered rows as they come.
    expect((screen.getByRole('button', { name: 'Filters\u2026' }) as HTMLButtonElement).disabled).toBe(false);
    // Buttons that can't be used while recording give the status line their room.
    expect(screen.queryByRole('button', { name: 'Open Log\u2026' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export Log\u2026' })).toBeNull();
    expect(screen.getByRole('radio', { name: 'Trace' }).getAttribute('aria-checked')).toBe('true');

    port.send('t1232DEAD\rt1232BEEF\r');
    await waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[0]).toMatchObject({ id: 0x123, extended: false, data: Uint8Array.of(0xde, 0xad) });
    expect(frames[1].timeNs).toBeGreaterThanOrEqual(frames[0].timeNs);
    expect(await screen.findByText(/2 frames/)).toBeTruthy();
    // The new ID reaches the sidebar while recording.
    expect(await screen.findByText('123')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    expect(await screen.findByText(/Not saved \u00b7 2 frames/)).toBeTruthy();
    expect(core.endCapture).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Filters\u2026' }) as HTMLButtonElement).disabled).toBe(false);
    expect(port.commands.at(-1)).toBe('Z0');
    expect(port.closed).toBe(true);

    const written: unknown[] = [];
    const picker = vi.fn(async () => ({
      createWritable: async () => ({ write: async (data: unknown) => void written.push(data), close: async () => {} }),
    }));
    vi.stubGlobal('showSaveFilePicker', picker);
    await userEvent.click(screen.getByRole('button', { name: 'Save Capture\u2026' }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(picker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: expect.stringMatching(/^capture-\d{8}-\d{6}\.log$/) }));
    expect(core.exportLog).toHaveBeenCalledWith('candump');
    expect(await (written[0] as Blob).text()).toBe('(1.000000) can0 123#DEAD\n');
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
    // Once stopped, the capture exports like any log.
    expect((screen.getByRole('button', { name: 'Export Log\u2026' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("estimates the capture's bus load at its bitrate, under the bus name chosen", async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const busLoad = vi.fn(async () => [Float64Array.of(0.25), Float64Array.of(0.1)] as [Float64Array, Float64Array]);
    core.busLoad = busLoad;
    render(<App core={core} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Capture\u2026' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Adapter\u2026' }));
    await userEvent.selectOptions(screen.getByLabelText('Bitrate'), '250 kbit/s');
    await userEvent.clear(screen.getByLabelText('Bus name'));
    await userEvent.type(screen.getByLabelText('Bus name'), 'body');
    await userEvent.click(screen.getByRole('button', { name: 'Start Capture' }));
    await screen.findByRole('button', { name: 'Stop Capture' });
    expect(core.startCapture).toHaveBeenCalledWith(expect.any(String), 'body', expect.any(Number));
    port.send('t1232DEAD\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await screen.findByText(/Not saved/);

    await userEvent.click(screen.getByRole('radio', { name: 'Overview' }));
    await waitFor(() => expect(busLoad).toHaveBeenCalledWith(0, 0, 0.5, expect.any(Number), 250_000));
    expect(busLoad).not.toHaveBeenCalledWith(0, 0, 0.5, expect.any(Number), 500_000);
    expect((screen.getByRole('combobox', { name: 'Bitrate of body' }) as HTMLSelectElement).value).toBe('250000');
  });

  it('reopens a saved capture after a reload, as the candump file it was saved as', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const { unmount } = render(<App core={core} />);
    await startCapture(port);
    port.send('t1232DEAD\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await screen.findByText(/Not saved/);
    vi.stubGlobal('showSaveFilePicker', async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) }));
    await userEvent.click(screen.getByRole('button', { name: 'Save Capture\u2026' }));
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
    const name = (core.startCapture as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    unmount();

    const Reloaded = await freshApp();
    const openLog = vi.fn<CoreApi['openLog']>(async (_file, logName) => logInfo({ name: logName, format: 'candump' }));
    render(<Reloaded core={fakeCore({ openLog, idSummary: () => Promise.resolve([]) })} />);
    await waitFor(() => expect(openLog).toHaveBeenCalled());
    // fake-indexeddb can't clone jsdom's Blobs, so only the name is checked.
    expect(openLog.mock.calls[0][1]).toBe(name);
    expect(await screen.findByText(name)).toBeTruthy();
  });

  it('forgets an unsaved capture after a reload', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const { unmount } = render(<App core={core} />);
    await startCapture(port);
    port.send('t1232DEAD\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await screen.findByText(/Not saved/);
    unmount();

    const Reloaded = await freshApp();
    const openLog = vi.fn<CoreApi['openLog']>();
    render(<Reloaded core={fakeCore({ openLog })} />);
    expect(await screen.findByRole('heading', { name: 'Open a CAN log to get started' })).toBeTruthy();
    expect(openLog).not.toHaveBeenCalled();
  });

  it('asks before an unsaved capture is replaced', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    render(<App core={core} />);
    await startCapture(port);
    port.send('t1230\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await screen.findByText(/Not saved/);

    await userEvent.click(screen.getByRole('button', { name: 'Capture\u2026' }));
    const confirm = screen.getByRole('dialog', { name: 'Discard the capture?' });
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Live Capture' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Capture\u2026' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Discard the capture?' })).getByRole('button', { name: 'Discard Capture' }));
    expect(screen.getByRole('dialog', { name: 'Live Capture' })).toBeTruthy();
  });

  /** Records one frame, then stops, leaving an unsaved capture. */
  async function unsavedCapture(port: FakeSerialPort, core: CoreApi) {
    await startCapture(port);
    port.send('t1230\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await screen.findByText(/Not saved/);
  }

  const stubSavePicker = () =>
    vi.stubGlobal('showSaveFilePicker', async () => ({ createWritable: async () => ({ write: async () => {}, close: async () => {} }) }));

  it('asks about an unsaved capture once, not again for a log opened while the first is read', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    let stopRead: () => void = () => {};
    const openLog = vi.fn<CoreApi['openLog']>((file, name) => {
      stopRead();
      if (file.size === 0 || name === 'b.log') return Promise.resolve(logInfo({ name, frames: file.size === 0 ? 0 : 1000 }));
      return new Promise<LogInfo>((_resolve, reject) => (stopRead = () => reject(new DOMException(LOG_SUPERSEDED, 'AbortError'))));
    });
    core.openLog = openLog;
    core.idSummary = async () => [];
    const { container } = render(<App core={core} />);
    await startCapture(port);
    port.send('t1230\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await screen.findByText(/Not saved/);

    const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    await userEvent.upload(input, new File(['(1.0) can0 123#00\n'], 'a.log'));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Discard the capture?' })).getByRole('button', { name: 'Discard Capture' }));
    await waitFor(() => expect(openLog).toHaveBeenCalledTimes(1));

    await userEvent.upload(input, new File(['(1.0) can0 123#00\n'], 'b.log'));
    expect(screen.queryByRole('dialog', { name: 'Discard the capture?' })).toBeNull();
    await waitFor(() => expect(document.querySelector('.doc-title')?.textContent).toBe('b.log'));
    expect(openLog.mock.calls.map(([, name]) => name)).toEqual(['a.log', '', 'b.log']);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('offers to save an unsaved capture before it is replaced, then goes on', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    render(<App core={core} />);
    await unsavedCapture(port, core);
    stubSavePicker();

    await userEvent.click(screen.getByRole('button', { name: 'Capture\u2026' }));
    const confirm = screen.getByRole('dialog', { name: 'Discard the capture?' });
    expect(within(confirm).getByRole('button', { name: 'Discard Capture' }).className).toBe('button');
    await userEvent.click(within(confirm).getByRole('button', { name: 'Save Capture\u2026' }));
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
    expect(core.exportLog).toHaveBeenCalledWith('candump');
    expect(await screen.findByRole('dialog', { name: 'Live Capture' })).toBeTruthy();
  });

  it('counts a capture exported from Export Log as saved', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    render(<App core={core} />);
    await unsavedCapture(port, core);
    stubSavePicker();

    await userEvent.click(screen.getByRole('button', { name: 'Export Log\u2026' }));
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Export Log' })).getByRole('button', { name: 'Export\u2026' }));
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
  });

  it('asks the browser to confirm leaving while recording or with an unsaved capture', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    render(<App core={core} />);
    const leave = () => {
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    await screen.findByRole('button', { name: 'Capture\u2026' });
    expect(leave()).toBe(false);

    await startCapture(port);
    // The listener is added by an effect, which can run a little after the button shows.
    await waitFor(() => expect(leave()).toBe(true));
    port.send('t1230\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await screen.findByText(/Not saved/);
    await waitFor(() => expect(leave()).toBe(true));

    stubSavePicker();
    await userEvent.click(screen.getByRole('button', { name: 'Save Capture\u2026' }));
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
    await waitFor(() => expect(leave()).toBe(false));
  });

  it('asks before recording from a CANable, which confirms nothing, and never claims listen-only for it', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    port.canable();
    withSerialPort(port);
    const { core, frames } = captureCore();
    render(<App core={core} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Capture\u2026' }));
    // The sheet shows as loading until its code arrives.
    await userEvent.click(await screen.findByRole('button', { name: 'Choose Adapter\u2026' }));
    const sheet = screen.getByRole('dialog', { name: 'Live Capture' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Start Capture' }));
    // A silent adapter takes its full wait for S6.
    expect((await within(sheet).findByRole('alert', {}, { timeout: 3000 })).textContent).toMatch(/didn't confirm listen-only mode\. Silent mode \(M1\) was sent.*Start anyway\?$/);
    expect(core.startCapture).not.toHaveBeenCalled();
    expect(port.commands).not.toContain('O');

    await userEvent.click(within(sheet).getByRole('button', { name: 'Start Anyway' }));
    await screen.findByRole('button', { name: 'Stop Capture' }, { timeout: 3000 });
    expect(port.commands.slice(-2)).toEqual(['M1', 'O']);
    expect(port.silentMode).toBe(true);
    expect(screen.getByText(/Listen-only mode isn't confirmed for this adapter/)).toBeTruthy();
    expect(toolbarStatus()).toBe('Recording from USB serial device 16D0:117E.');
    port.send('t1230\r');
    await waitFor(() => expect(frames).toHaveLength(1));
    await screen.findByText(/1 frame \u00b7/);
    expect(screen.getByText('Recording').parentElement!.textContent).not.toMatch(/listen only/i);
  });

  /** Drops `files` on the window, as the browser does when files are dragged in. */
  function drop(files: File[]) {
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', { value: { files } });
    act(() => {
      window.dispatchEvent(event);
    });
  }

  it('keeps Open log B disabled until the capture has stopped', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const stop = { finish: () => {} };
    const finished = new Promise<void>((resolve) => (stop.finish = resolve));
    const idSummary = core.idSummary;
    render(<App core={core} />);
    await startCapture(port);
    port.send('t1230\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('radio', { name: 'Compare' }));

    // The capture has ended but its IDs are still being read.
    core.idSummary = vi.fn<CoreApi['idSummary']>(async () => {
      await finished;
      return idSummary();
    });
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await waitFor(() => expect(core.idSummary).toHaveBeenCalled());
    const openB = await screen.findByRole('button', { name: 'Open log B\u2026' });
    expect((openB as HTMLButtonElement).disabled).toBe(true);

    stop.finish();
    await waitFor(() => expect((screen.getByRole('button', { name: 'Open log B\u2026' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('refuses a dropped log while the capture is stopping, then asks about the stopped capture', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    const stop = { finish: () => {} };
    const finished = new Promise<void>((resolve) => (stop.finish = resolve));
    const endCapture = core.endCapture;
    core.endCapture = vi.fn<CoreApi['endCapture']>(async () => {
      await finished;
      return endCapture();
    });
    render(<App core={core} />);
    await startCapture(port);
    port.send('t1230\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await waitFor(() => expect(core.endCapture).toHaveBeenCalled());
    drop([new File(['(1.0) can0 123#00\n'], 'other.log')]);
    expect((await screen.findByRole('alert')).textContent).toBe('Wait for the capture to stop, then drop the files again.');
    expect(screen.queryByRole('dialog', { name: 'Discard the capture?' })).toBeNull();

    stop.finish();
    await screen.findByText(/Not saved/);
    drop([new File(['(1.0) can0 123#00\n'], 'other.log')]);
    const confirm = await screen.findByRole('dialog', { name: 'Discard the capture?' });
    expect(confirm.textContent).toMatch(/capture-\d{8}-\d{6}\.log hasn\u2019t been saved/);
  });

  /** A capture core whose engine restart the test triggers with `reset()`. */
  function resettingCore() {
    const { core } = captureCore();
    let listener: (() => void) | null = null;
    core.onReset = (l) => {
      listener = l;
      return () => (listener = null);
    };
    return { core, reset: () => act(() => listener?.()) };
  }

  it('says a stopped, unsaved capture was lost when the engine restarts, closing the discard prompt', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core, reset } = resettingCore();
    render(<App core={core} />);
    await unsavedCapture(port, core);
    await userEvent.click(screen.getByRole('button', { name: 'Capture\u2026' }));
    expect(screen.getByRole('dialog', { name: 'Discard the capture?' })).toBeTruthy();

    reset();
    expect((await screen.findByRole('alert')).textContent).toBe('The CAN core stopped and was restarted, so the capture was lost.');
    expect(screen.queryByRole('dialog', { name: 'Discard the capture?' })).toBeNull();
  });

  it('asks for a saved capture to be opened again when the engine restarts', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core, reset } = resettingCore();
    render(<App core={core} />);
    await unsavedCapture(port, core);
    stubSavePicker();
    await userEvent.click(screen.getByRole('button', { name: 'Save Capture\u2026' }));
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());

    reset();
    expect((await screen.findByRole('alert')).textContent).toBe('The CAN core stopped and was restarted. Open the log again.');
  });

  it('keeps no log when no frames came, and says what to check', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core } = captureCore();
    render(<App core={core} />);
    await startCapture(port);
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    expect((await screen.findByRole('alert')).textContent).toContain('No frames came from the adapter. Check the bitrate');
    expect(screen.getByRole('heading', { name: 'Open a CAN log to get started' })).toBeTruthy();
  });

  it('keeps the frames when the adapter is unplugged, and says so', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    withSerialPort(port);
    const { core, frames } = captureCore();
    render(<App core={core} />);
    await startCapture(port);
    port.send('t1230\r');
    await waitFor(() => expect(frames).toHaveLength(1));
    port.unplug();
    expect((await screen.findByRole('alert')).textContent).toBe('The adapter was disconnected. The frames captured until then are kept.');
    expect(screen.queryByRole('button', { name: 'Stop Capture' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save Capture\u2026' })).toBeTruthy();
  });

  it('explains in the sheet when the browser has no Web Serial or WebUSB', async () => {
    const App = await freshApp();
    render(<App core={fakeCore()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Capture\u2026' }));
    expect(await screen.findByText(/needs Chrome or Edge/)).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Live Capture' })).toBeTruthy();
  });
});

describe('Compare in the app', () => {
  /** A core that reads logs by name and holds a log B beside the open log, as the real one does. */
  function compareApp(openCompareLog?: CoreApi['openCompareLog']) {
    const held = { a: null as LogInfo | null, b: null as LogInfo | null };
    const core = fakeCore({
      openLog: async (file, name) => {
        held.a = logInfo({ name, bytes: file.size });
        held.b = null;
        return held.a;
      },
      idSummary: async () => [],
      openCompareLog:
        openCompareLog ??
        (async (file, name) => {
          held.b = logInfo({ name, bytes: file.size });
          return held.b;
        }),
      compareLogInfo: async () => held.b,
      compareLogs: async () => [],
      swapCompareLog: async () => {
        [held.a, held.b] = [held.b, held.a];
        return held.a!;
      },
    });
    return core;
  }

  /** fake-indexeddb can't clone jsdom's Blobs, and Swap reads only a saved copy's size. */
  const blobOf = (size: number) => ({ size }) as Blob;

  async function savedSession(log: string, compare: string) {
    const session = await import('./session');
    await session.save('log', { name: log, blob: blobOf(log.length) });
    await session.save('compare', { name: compare, blob: blobOf(compare.length) });
    await session.save('ui', { view: 'compare', selected: -1, pinnedTime: null, plots: [] });
    return session;
  }

  it('trades the saved copies on Swap', async () => {
    const App = await freshApp();
    const session = await savedSession('a.log', 'b.log');
    render(<App core={compareApp()} />);
    const swap = await screen.findByRole('button', { name: 'Swap logs A and B' });
    await waitFor(() => expect((swap as HTMLButtonElement).disabled).toBe(false));
    await userEvent.click(swap);
    await waitFor(async () => expect((await session.loadSaved<{ name: string }>('log'))?.name).toBe('b.log'));
    expect((await session.loadSaved<{ name: string }>('compare'))?.name).toBe('a.log');
  });

  it('forgets a saved copy that is not of the log being swapped', async () => {
    const App = await freshApp();
    const session = await savedSession('a.log', 'b.log');
    render(<App core={compareApp()} />);
    const swap = await screen.findByRole('button', { name: 'Swap logs A and B' });
    await waitFor(() => expect((swap as HTMLButtonElement).disabled).toBe(false));
    // As if the copies of the open logs never landed, leaving older logs under both keys.
    await session.save('log', { name: 'older.log', blob: new Blob(['o']) });
    await session.save('compare', { name: 'older-b.log', blob: new Blob(['p']) });
    await userEvent.click(swap);
    await waitFor(async () => expect(await session.loadSaved('log')).toBeUndefined());
    expect(await session.loadSaved('compare')).toBeUndefined();
    expect(await screen.findByText(/couldn.t keep a copy of b\.log/)).toBeTruthy();
  });

  it('forgets an older saved copy of the same name on Swap', async () => {
    const App = await freshApp();
    const session = await savedSession('a.log', 'b.log');
    render(<App core={compareApp()} />);
    const swap = await screen.findByRole('button', { name: 'Swap logs A and B' });
    await waitFor(() => expect((swap as HTMLButtonElement).disabled).toBe(false));
    // As if saving log B failed, leaving an earlier log B a logger gave the same name.
    await session.save('compare', { name: 'b.log', blob: blobOf(100) });
    await userEvent.click(swap);
    await waitFor(async () => expect(await session.loadSaved('log')).toBeUndefined());
    expect((await session.loadSaved<{ name: string }>('compare'))?.name).toBe('a.log');
  });

  it('stays busy while log B is read after the open log is', async () => {
    const App = await freshApp();
    await savedSession('a.log', 'b.log');
    let finish: (info: LogInfo) => void = () => {};
    const core = compareApp(() => new Promise<LogInfo>((resolve) => (finish = resolve)));
    render(<App core={core} />);
    expect(await screen.findByText(/^Reading\u2026/)).toBeTruthy();
    expect(screen.getAllByRole('status').map((s) => s.textContent)).toContain('Reading b.log\u2026');
    expect((screen.getByRole('button', { name: 'Open Log\u2026' }) as HTMLButtonElement).disabled).toBe(true);
    finish(logInfo({ name: 'b.log' }));
    await waitFor(() => expect((screen.getByRole('button', { name: 'Open Log\u2026' }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('turns away a log picked while log B is read, as a picker opened before the read began would give', async () => {
    const App = await freshApp();
    await savedSession('a.log', 'b.log');
    let finish: (info: LogInfo) => void = () => {};
    const core = compareApp(() => new Promise<LogInfo>((resolve) => (finish = resolve)));
    const openLog = vi.spyOn(core, 'openLog');
    const { container } = render(<App core={core} />);
    expect(await screen.findByText(/^Reading\u2026/)).toBeTruthy();
    await waitFor(() => expect(openLog).toHaveBeenCalledTimes(1));
    const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    // Disabled buttons don't stop a file from reaching the input itself.
    await userEvent.upload(input, new File(['(1.0) can0 123#00\n'], 'c.log'), { applyAccept: false });
    expect((await screen.findByRole('alert')).textContent).toContain('Wait for "Reading b.log\u2026" to finish, then open the log again.');
    expect(openLog).toHaveBeenCalledTimes(1);
    finish(logInfo({ name: 'b.log' }));
  });
});
