import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { fakeCore, logInfo } from './test/fixtures';

// A file of its own, as a mocked module is loaded once per file.
vi.mock('./capture/CaptureSheet', async () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});

describe('App Capture sheet', () => {
  it('offers a reload in the sheet when the sheet fails to load, leaving the app usable', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(<App core={fakeCore({ openLog: async () => logInfo(), idSummary: async () => [] })} />);
    // A worker's first render can take over a second under load.
    await screen.findByRole('heading', { name: 'How would you like to start?' }, { timeout: 3000 });
    await userEvent.upload(container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!, new File(['(1.0) can0 123#00\n'], 'x.log'));
    // The lazy import failing can take over a second under load.
    await userEvent.click(await screen.findByRole('button', { name: 'Connect live\u2026' }));
    await screen.findByText("Couldn't load capture.", {}, { timeout: 3000 });
    // The fallback's sheet is opened by an effect, a moment after its text is on the page.
    const sheet = await screen.findByRole('dialog', { name: 'Live Capture' });
    expect(within(sheet).getByRole('alert').textContent).toContain("Couldn't load capture.");
    expect(within(sheet).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Open Log\u2026' }) as HTMLButtonElement).disabled).toBe(false);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
