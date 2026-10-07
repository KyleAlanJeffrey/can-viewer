import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, logInfo } from './test/fixtures';

async function freshApp() {
  vi.resetModules();
  return (await import('./App')).App;
}

beforeAll(async () => {
  await import('./App');
});

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  // A 390px wide window: every max-width query from 390px up matches.
  const matchMedia = (media: string) =>
    ({
      matches: Number(/max-width: (\d+)/.exec(media)?.[1] ?? 0) >= 390,
      media,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
  vi.stubGlobal('matchMedia', matchMedia);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function openLog() {
  const App = await freshApp();
  const core = fakeCore({
    openLog: () => Promise.resolve(logInfo({ name: 'x.log' })),
    idSummary: () => Promise.resolve([]),
  });
  const { container } = render(<App core={core} />);
  await screen.findByRole('heading', { name: 'How would you like to start?' }, { timeout: 3000 });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
  await userEvent.upload(input, new File(['(1.0) can0 123#00\n'], 'x.log'));
  return screen.findByRole('button', { name: 'View: Overview' });
}

describe('App on a phone', () => {
  it('switches views from the Views sheet in place of the tabs, and gives focus back to the picker', async () => {
    const picker = await openLog();
    expect(screen.queryByRole('radiogroup', { name: 'View' })).toBeNull();
    expect(picker.getAttribute('aria-expanded')).toBe('false');

    await userEvent.click(picker);
    const sheet = screen.getByRole('dialog', { name: 'Views' });
    expect(picker.getAttribute('aria-expanded')).toBe('true');
    const views = within(within(sheet).getByRole('navigation', { name: 'Views' })).getAllByRole('button');
    expect(views.map((v) => v.textContent)).toEqual(['Overview', 'Trace', 'Plot', 'Reverse Engineer', 'Compare', 'Database']);
    expect(views.filter((v) => v.getAttribute('aria-current') === 'page').map((v) => v.textContent)).toEqual(['Overview']);

    await userEvent.click(within(sheet).getByRole('button', { name: 'Trace' }));
    const tracePicker = await screen.findByRole('button', { name: 'View: Trace' });
    expect(screen.queryByRole('dialog', { name: 'Views' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(tracePicker));

    await userEvent.click(tracePicker);
    const current = within(screen.getByRole('dialog', { name: 'Views' })).getByRole('button', { name: 'Trace' });
    expect(current.getAttribute('aria-current')).toBe('page');
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Views' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(tracePicker));
  });

  it('keeps the session actions in the Views sheet', async () => {
    await userEvent.click(await openLog());
    const actions = within(screen.getByRole('list', { name: 'Session' })).getAllByRole('button');
    expect(actions.map((a) => a.getAttribute('data-action'))).toEqual(['new-session', 'open-dbc', 'open-log', 'export-log', 'capture']);
    expect(within(screen.getByRole('list', { name: 'Session' })).getByRole('button', { name: /Connect live/ }).textContent).toContain('Not available in this browser');

    await userEvent.click(screen.getByRole('button', { name: /New session/ }));
    expect(await screen.findByRole('heading', { name: 'How would you like to start?' })).toBeTruthy();
  });

  it('puts the Signals button beside the picker on Plot, opening the signal list', async () => {
    await userEvent.click(await openLog());
    await userEvent.click(within(screen.getByRole('dialog', { name: 'Views' })).getByRole('button', { name: 'Plot' }));
    const signals = await screen.findByRole('button', { name: 'Signals (0)' });
    expect(screen.queryByRole('button', { name: 'Messages' })).toBeNull();
    await userEvent.click(signals);
    expect(signals.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('heading', { name: 'Signals' })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close signals' })));
  });

  it('opens the sidebar over the view from its button, and closes it again', async () => {
    await openLog();
    const button = screen.getByRole('button', { name: 'Messages' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const close = within(document.getElementById('sidebar')!).getByRole('button', { name: /Close/ });
    await waitFor(() => expect(document.activeElement).toBe(close));
    // Everything behind the sidebar is out of reach while it covers the window.
    expect(button.closest('[inert]')).toBeTruthy();
    expect(close.closest('[inert]')).toBeNull();
    await userEvent.click(close);
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.closest('[inert]')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(button));

    await userEvent.click(button);
    await userEvent.keyboard('{Escape}');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await waitFor(() => expect(document.activeElement).toBe(button));
  });
});
