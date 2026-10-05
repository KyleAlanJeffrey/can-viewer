import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureFrame, CoreApi } from './core/api';
import { FakeSerialPort } from './test/fakeSerial';
import { fakeCore, logInfo, summary } from './test/fixtures';

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

describe('App live capture', () => {
  /** A browser with Web Serial whose device prompt picks `port`. */
  function withSerialPort(port: FakeSerialPort) {
    Object.defineProperty(navigator, 'serial', { value: { requestPort: async () => port }, configurable: true });
  }

  /** A core that keeps captured frames, answering as the wasm core would. */
  function captureCore() {
    const frames: CaptureFrame[] = [];
    let name = '';
    const info = () => logInfo({ name, format: 'capture', frames: frames.length, durationS: 0.5, channels: ['can0'] });
    const core = fakeCore({
      startCapture: vi.fn((captureName: string) => {
        name = captureName;
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
    // The sheet loads on its own the first time.
    const sheet = await screen.findByRole('dialog', { name: 'Live Capture' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Choose Adapter\u2026' }));
    await userEvent.click(within(sheet).getByRole('button', { name: 'Start Capture' }));
    await screen.findByRole('button', { name: 'Stop Capture' });
    expect(port.commands).toEqual(['C', 'S6', 'L']);
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
    // Filtered rows are found once, so filters wait for the capture to stop.
    expect((screen.getByRole('button', { name: 'Filters\u2026' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Filters apply once the capture stops.')).toBeTruthy();
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
    expect(port.commands.at(-1)).toBe('C');
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
    expect(leave()).toBe(true);
    port.send('t1230\r');
    await waitFor(() => expect(core.appendFrames).toHaveBeenCalled());
    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    await screen.findByText(/Not saved/);
    expect(leave()).toBe(true);

    stubSavePicker();
    await userEvent.click(screen.getByRole('button', { name: 'Save Capture\u2026' }));
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
    expect(leave()).toBe(false);
  });

  it('asks before recording from a CANable, which confirms nothing, and never claims listen-only for it', async () => {
    const App = await freshApp();
    const port = new FakeSerialPort();
    port.canable();
    withSerialPort(port);
    const { core, frames } = captureCore();
    render(<App core={core} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Capture\u2026' }));
    const sheet = await screen.findByRole('dialog', { name: 'Live Capture' });
    await userEvent.click(within(sheet).getByRole('button', { name: 'Choose Adapter\u2026' }));
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
    expect(within(await screen.findByRole('dialog', { name: 'Live Capture' })).getByText(/needs Chrome or Edge/)).toBeTruthy();
  });
});
