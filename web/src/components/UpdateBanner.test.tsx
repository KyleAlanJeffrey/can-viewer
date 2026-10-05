import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const update = vi.hoisted(() => ({ status: 'current', listeners: new Set<() => void>(), apply: vi.fn() }));

vi.mock('../offline/register', () => ({
  updateStatus: () => update.status,
  subscribeToUpdate: (listener: () => void) => {
    update.listeners.add(listener);
    return () => update.listeners.delete(listener);
  },
  applyUpdate: update.apply,
}));

import { UpdateBanner } from './UpdateBanner';

function announce(status: string) {
  act(() => {
    update.status = status;
    for (const listener of update.listeners) listener();
  });
}

beforeEach(() => {
  update.status = 'current';
  update.apply.mockClear();
});

describe('UpdateBanner', () => {
  it('asks a tab left on the old version to reload', async () => {
    render(<UpdateBanner />);
    announce('outdated');
    expect(screen.getByRole('status').textContent).toContain('This tab is out of date. Reload to keep working.');
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(update.apply).toHaveBeenCalledTimes(1);
  });

  it('comes back after a dismissed update when the tab falls out of date', async () => {
    render(<UpdateBanner />);
    announce('ready');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    announce('outdated');
    expect(screen.getByRole('status').textContent).toContain('out of date');
  });

  it('appears when a new version is waiting and reloads into it', async () => {
    render(<UpdateBanner />);
    expect(screen.queryByText(/new version/)).toBeNull();
    announce('ready');
    expect(screen.getByRole('status').textContent).toContain('A new version of FreeCAN Studio is ready.');
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(update.apply).toHaveBeenCalledTimes(1);
  });

  it('can be dismissed', async () => {
    render(<UpdateBanner />);
    announce('ready');
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(update.apply).not.toHaveBeenCalled();
  });
});
