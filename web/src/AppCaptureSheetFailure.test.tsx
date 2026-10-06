import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it, vi } from 'vitest';
import { fakeCore } from './test/fixtures';

// A file of its own, as a mocked module is loaded once per file.
vi.mock('./capture/CaptureSheet', async () => {
  throw new TypeError('Failed to fetch dynamically imported module');
});

describe('App Capture sheet', () => {
  it('offers a reload in the sheet when the sheet fails to load, leaving the app usable', async () => {
    vi.stubGlobal('indexedDB', new IDBFactory());
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { App } = await import('./App');
    render(<App core={fakeCore()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Capture\u2026' }));
    await screen.findByText("Couldn't load capture.");
    const sheet = screen.getByRole('dialog', { name: 'Live Capture' });
    expect(within(sheet).getByRole('alert').textContent).toContain("Couldn't load capture.");
    expect(within(sheet).getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Open a CAN log to get started' })).toBeTruthy();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
});
