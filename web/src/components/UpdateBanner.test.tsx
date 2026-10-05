import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const update = vi.hoisted(() => ({ ready: false, listeners: new Set<() => void>(), apply: vi.fn() }));

vi.mock('../offline/register', () => ({
  updateReady: () => update.ready,
  subscribeToUpdate: (listener: () => void) => {
    update.listeners.add(listener);
    return () => update.listeners.delete(listener);
  },
  applyUpdate: update.apply,
}));

import { UpdateBanner } from './UpdateBanner';

function announceUpdate() {
  act(() => {
    update.ready = true;
    for (const listener of update.listeners) listener();
  });
}

beforeEach(() => {
  update.ready = false;
  update.apply.mockClear();
});

describe('UpdateBanner', () => {
  it('appears when a new version is waiting and reloads into it', async () => {
    render(<UpdateBanner />);
    expect(screen.queryByText(/new version/)).toBeNull();
    announceUpdate();
    expect(screen.getByRole('status').textContent).toContain('A new version of FreeCAN Studio is ready.');
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(update.apply).toHaveBeenCalledTimes(1);
  });

  it('can be dismissed', async () => {
    render(<UpdateBanner />);
    announceUpdate();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).toBeNull();
    expect(update.apply).not.toHaveBeenCalled();
  });
});
