import { screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fakeCore, logInfo, makeRowBatch } from '../../test/fixtures';
import { renderInShell } from '../../test/shell';
import { TraceView } from './TraceView';

vi.mock('./FilterSheet', () => {
  throw new Error('Failed to fetch dynamically imported module');
});

class SizedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    this.callback([{ contentRect: { width: 810, height: 148 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', SizedResizeObserver);
  // React logs the error the boundary catches.
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('offers a reload when the filter sheet fails to load, and keeps the trace', async () => {
  const core = fakeCore({ rows: async (key, start) => makeRowBatch(key, start, []) });
  const { user } = renderInShell(TraceView, { core, log: logInfo() });
  await user.click(screen.getByRole('button', { name: 'Filters\u2026' }));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain("Couldn't load the filters.");
  expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
  expect(screen.getByRole('grid', { name: 'Frame trace' })).toBeTruthy();
});
