import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { fakeCore } from './test/fixtures';

// A file of its own, as a mocked module is loaded once per file.
vi.mock('./capture/CaptureSheet', async () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});

describe('App Capture sheet', () => {
  it('offers a reload in the sheet when the sheet fails to load, leaving the app usable', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<App core={fakeCore()} />);
    // A worker's first render, and the lazy import failing, can each take over a second under load.
    await userEvent.click(await screen.findByRole('button', { name: 'Connect live\u2026' }, { timeout: 3000 }));
    await screen.findByText("Couldn't load capture.", {}, { timeout: 3000 });
    // The fallback's sheet is opened by an effect, a moment after its text is on the page.
    const sheet = await screen.findByRole('dialog', { name: 'Live Capture' });
    expect(within(sheet).getByRole('alert').textContent).toContain("Couldn't load capture.");
    expect(within(sheet).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Open a CAN log to get started' })).toBeTruthy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
