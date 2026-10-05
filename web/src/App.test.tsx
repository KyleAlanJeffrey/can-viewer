import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureFrame } from './core/api';
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
      exportCandump: vi.fn(() => Promise.resolve(new TextEncoder().encode('(1.000000) can0 123#DEAD\n'))),
    });
    return { core, frames };
  }

  async function startCapture(port: FakeSerialPort) {
    await userEvent.click(await screen.findByRole('button', { name: 'Capture\u2026' }));
    const sheet = screen.getByRole('dialog', { name: 'Live Capture' });
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

    expect(screen.getByText('Recording')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Open Log\u2026' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('radio', { name: 'Trace' }).getAttribute('aria-checked')).toBe('true');

    port.send('t1232DEAD\rt1232BEEF\r');
    await waitFor(() => expect(frames).toHaveLength(2));
    expect(frames[0]).toMatchObject({ id: 0x123, extended: false, data: Uint8Array.of(0xde, 0xad) });
    expect(frames[1].timeNs).toBeGreaterThanOrEqual(frames[0].timeNs);
    expect(await screen.findByText(/2 frames/)).toBeTruthy();
    // The new ID reaches the sidebar while recording.
    expect(await screen.findByText('123')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Stop Capture' }));
    expect(await screen.findByText(/Capture \u00b7 2 frames .* \u00b7 Not saved/)).toBeTruthy();
    expect(core.endCapture).toHaveBeenCalledTimes(1);
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
    expect(await (written[0] as Blob).text()).toBe('(1.000000) can0 123#DEAD\n');
    await waitFor(() => expect(screen.queryByText(/Not saved/)).toBeNull());
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
    expect(within(screen.getByRole('dialog', { name: 'Live Capture' })).getByText(/needs Chrome or Edge/)).toBeTruthy();
  });
});
