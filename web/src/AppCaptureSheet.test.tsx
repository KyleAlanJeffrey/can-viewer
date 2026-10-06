import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore } from './test/fixtures';

/** A fresh copy of the app's modules, with the Capture sheet's module replaced by `sheetModule`. */
async function appWithSheet(sheetModule: () => Promise<unknown>) {
  vi.resetModules();
  vi.doMock('./capture/CaptureSheet', sheetModule);
  return (await import('./App')).App;
}

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.doUnmock('./capture/CaptureSheet');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('App Capture sheet', () => {
  it('loads the sheet only once Capture... is clicked', async () => {
    const loaded = vi.fn();
    const App = await appWithSheet(async () => {
      loaded();
      return vi.importActual('./capture/CaptureSheet');
    });
    render(<App core={fakeCore()} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    expect(loaded).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Capture\u2026' }));
    expect(await screen.findByRole('dialog', { name: 'Live Capture' })).toBeTruthy();
    expect(loaded).toHaveBeenCalledTimes(1);
  });

  it('offers a reload in the sheet when the sheet fails to load, leaving the app usable', async () => {
    const App = await appWithSheet(async () => {
      throw new TypeError('Failed to fetch dynamically imported module');
    });
    render(<App core={fakeCore()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Capture\u2026' }));
    const sheet = await screen.findByRole('dialog', { name: 'Live Capture' });
    expect(within(sheet).getByRole('alert').textContent).toContain("Couldn't load capture.");
    expect(within(sheet).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Open a CAN log to get started' })).toBeTruthy();
  });
});
