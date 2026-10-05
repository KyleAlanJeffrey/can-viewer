import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { fakeCore } from '../test/fixtures';
import { lazyView } from './lazyView';
import type { ViewContext } from './types';

const ctx = { core: fakeCore() } as ViewContext;

describe('lazyView', () => {
  it('shows the view once its chunk loads', async () => {
    const View = lazyView(async () => () => <p>Loaded view</p>);
    render(<View ctx={ctx} />);
    expect(await screen.findByText('Loaded view')).toBeTruthy();
  });

  it('offers a reload when the chunk fails to load', async () => {
    // React reports the caught error to the console; the boundary is what is under test.
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    const View = lazyView(() => Promise.reject(new Error('Failed to fetch dynamically imported module')));
    render(<View ctx={ctx} />);
    expect((await screen.findByRole('alert')).textContent).toBe('Couldn\u2019t load this view.Reload');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    quiet.mockRestore();
  });
});
