import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Sheet } from './Sheet';

/** Escape on a modal dialog, as the browser does it: cancel, then close unless prevented. */
function pressEscape(dialog: HTMLDialogElement) {
  act(() => {
    if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
  });
}

describe('Sheet', () => {
  it('closes on Escape when dismissible', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Example">
        <p>Body</p>
      </Sheet>,
    );
    pressEscape(screen.getByRole('dialog') as HTMLDialogElement);
    expect(onClose).toHaveBeenCalled();
  });

  it('ignores Escape while not dismissible', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose} title="Example" dismissible={false}>
        <p>Body</p>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    pressEscape(dialog);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.open).toBe(true);
  });

  it('shows itself again when the browser closes it but its owner keeps it open', () => {
    render(
      <Sheet open onClose={() => {}} title="Example">
        <p>Body</p>
      </Sheet>,
    );
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    act(() => dialog.close());
    expect(dialog.open).toBe(true);
  });
});
