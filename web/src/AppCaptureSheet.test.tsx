import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { fakeCore } from './test/fixtures';

// One way of loading per file: a mocked module is loaded once per file, whatever resetModules does.
const sheet = vi.hoisted(() => {
  let arrive = () => {};
  const arrived = new Promise<void>((resolve) => (arrive = resolve));
  return { loaded: 0, arrived, arrive };
});
vi.mock('./capture/CaptureSheet', async (importOriginal) => {
  sheet.loaded++;
  await sheet.arrived;
  return importOriginal();
});

describe('App Capture sheet', () => {
  it('loads the sheet only once Connect live... is clicked, showing it as loading until then', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    render(<App core={fakeCore()} />);
    // A worker's first render, and loading the real sheet's code, can each take over a second under load.
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' }, { timeout: 3000 });
    expect(sheet.loaded).toBe(0);

    await userEvent.click(screen.getByRole('button', { name: 'Connect live\u2026' }));
    const loading = await screen.findByRole('dialog', { name: 'Live Capture' });
    expect(await within(loading).findByText('Loading\u2026')).toBeTruthy();
    expect(sheet.loaded).toBe(1);

    sheet.arrive();
    // This browser has no Web Serial, so the sheet explains that.
    expect(await screen.findByText(/needs Chrome or Edge/, {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText('Loading\u2026')).toBeNull();
    vi.unstubAllGlobals();
  });
});
