import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, logInfo } from './test/fixtures';

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
