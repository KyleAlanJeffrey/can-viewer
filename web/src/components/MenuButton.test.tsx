import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MenuButton } from './MenuButton';

function renderMenu() {
  const open = vi.fn();
  const close = vi.fn();
  render(
    <>
      <MenuButton
        label="More actions"
        items={[
          { id: 'open', label: 'Open DBC\u2026', onSelect: open },
          { id: 'busy', label: 'Export Log\u2026', onSelect: () => {}, disabled: true },
          { id: 'close', label: 'Close demo.log', onSelect: close, separated: true },
        ]}
      />
      <button>After</button>
    </>,
  );
  return { user: userEvent.setup(), open, close, button: screen.getByRole('button', { name: 'More actions' }) };
}

describe('MenuButton', () => {
  it('opens on a click with the first item focused, and runs the item picked', async () => {
    const { user, open, button } = renderMenu();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await user.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Open DBC\u2026' }));
    await user.click(screen.getByRole('menuitem', { name: 'Open DBC\u2026' }));
    expect(open).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('moves through the enabled items with the arrow keys, Home and End, and closes on Escape', async () => {
    const { user, close, button } = renderMenu();
    button.focus();
    await user.keyboard('{ArrowUp}');
    const last = screen.getByRole('menuitem', { name: 'Close demo.log' });
    const first = screen.getByRole('menuitem', { name: 'Open DBC\u2026' });
    expect(document.activeElement).toBe(last);
    // The disabled item is skipped.
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(first);
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(last);
    await user.keyboard('{Home}');
    expect(document.activeElement).toBe(first);
    await user.keyboard('{End}');
    expect(document.activeElement).toBe(last);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(button);

    await user.keyboard('{ArrowDown}');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes on a click elsewhere', async () => {
    const { user, button } = renderMenu();
    await user.click(button);
    await user.click(screen.getByRole('button', { name: 'After' }));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
