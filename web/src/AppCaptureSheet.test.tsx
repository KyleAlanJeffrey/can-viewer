import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { fakeCore, logInfo } from './test/fixtures';

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
    const { container } = render(<App core={fakeCore({ openLog: async () => logInfo(), idSummary: async () => [] })} />);
    // A worker's first render, and loading the real sheet's code, can each take over a second under load.
    await screen.findByRole('heading', { name: 'How would you like to start?' }, { timeout: 3000 });
    // The welcome's first step doesn't load the capture code either.
    await userEvent.click(screen.getByRole('radio', { name: 'Connect live' }));
    await userEvent.upload(container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!, new File(['(1.0) can0 123#00\n'], 'x.log'));
    await screen.findByText('candump \u00b7 1,000 frames \u00b7 1 min 40 s');
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
