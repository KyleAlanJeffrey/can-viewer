import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_IDS, FLAG_FD, type CoreApi } from '../../core/api';
import { fakeCore, makeRowBatch, message, signal } from '../../test/fixtures';
import { TraceCards, type FrameLookup } from './TraceCards';

const FRAMES = 1_000_000;
const engine = message(0x0c9, 'ENGINE_1', {
  signals: [signal('EngineSpeed', { size: 16, factor: 0.25, unit: 'rpm' }), signal('Counter', { startBit: 51, size: 4 })],
});

/** Gives the list room for a few cards. */
class SizedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    const contentRect = { width: 390, height: 400 } as DOMRectReadOnly;
    this.callback([{ contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', SizedResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Even rows are ENGINE_1 on can0; odd rows are a 32-byte FD frame of an ID no DBC describes. */
function renderCards() {
  const rows = vi.fn<CoreApi['rows']>(async (key, start, count) => {
    const n = Math.max(0, Math.min(count, FRAMES - start));
    return makeRowBatch(
      key,
      start,
      Array.from({ length: n }, (_, i) => {
        const row = start + i;
        return row % 2 === 0
          ? { t: row * 0.001, id: 0x0c9, index: row, data: [0xaf, 0x0c, 0, 0x3c, 0, 0, 0, 0xf7] }
          : { t: row * 0.001, id: 0x300, index: row, flags: FLAG_FD, data: Array.from({ length: 32 }, (_, k) => k) };
      }),
    );
  });
  const lookup = (_channel: number, id: number): FrameLookup => (id === 0x0c9 ? { name: 'ENGINE_1', message: engine, key: 0x0c9 } : { message: null, key: null });
  const onPlotMessage = vi.fn();
  render(
    <TraceCards
      core={fakeCore({ rows })}
      filterKey={ALL_IDS}
      rowCount={FRAMES}
      logVersion={1}
      channels={['can0']}
      hasDbc
      lookup={lookup}
      pinnedTime={null}
      onPlotMessage={onPlotMessage}
    />,
  );
  return { rows, onPlotMessage };
}

async function cardsShown(rows: ReturnType<typeof renderCards>['rows']) {
  await waitFor(() => expect(rows).toHaveBeenCalled());
  await act(() => rows.mock.results.at(-1)!.value);
}

const card = (row: number) => screen.getByRole('list', { name: 'Frames' }).querySelector<HTMLElement>(`[data-row="${row}"]`)!.closest<HTMLElement>('[role=listitem]')!;

describe('TraceCards', () => {
  it('renders only the cards in view of a million frames', async () => {
    const { rows } = renderCards();
    await cardsShown(rows);
    expect(rows.mock.calls.every(([, , count]) => count < 100)).toBe(true);
    const items = within(screen.getByRole('list', { name: 'Frames' })).getAllByRole('listitem');
    expect(items.length).toBeLessThan(20);
    expect(items[0].getAttribute('aria-setsize')).toBe(String(FRAMES));
    expect(within(card(0)).getByRole('button', { expanded: false }).textContent).toContain('ENGINE_1 \u00b7 8 bytes');
  });

  it('opens a tapped card in place with its decoded values, and closes it on a second tap', async () => {
    const { rows, onPlotMessage } = renderCards();
    await cardsShown(rows);
    const head = within(card(0)).getByRole('button', { expanded: false });

    await userEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const values = within(card(0)).getByRole('region', { name: 'Decoded values' });
    expect(within(values).getByText('EngineSpeed').nextElementSibling?.textContent).toBe('811.75 rpm');
    expect(within(values).getByText('Counter').nextElementSibling?.textContent).toBe('0');
    await userEvent.click(within(card(0)).getByRole('button', { name: /Plot this message/ }));
    expect(onPlotMessage).toHaveBeenCalledWith(0x0c9, 0);

    await userEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(within(card(0)).queryByRole('region', { name: 'Decoded values' })).toBeNull();
  });

  it('shows the first 8 bytes of an FD frame, and all of them from View all', async () => {
    const { rows } = renderCards();
    await cardsShown(rows);
    const fd = card(1);
    expect(fd.querySelectorAll('.tc-byte')).toHaveLength(8);
    expect(within(fd).getByRole('button', { expanded: false }).textContent).toContain('Unknown \u00b7 FD \u00b7 32 bytes');

    await userEvent.click(within(fd).getByRole('button', { name: 'View all 32 bytes' }));
    expect(within(fd).getByRole('button', { expanded: true })).toBeTruthy();
    expect(fd.querySelectorAll('.tc-byte')).toHaveLength(32);
    expect(within(fd).queryByRole('button', { name: 'View all 32 bytes' })).toBeNull();
    expect(within(fd).getByText('No loaded DBC describes this ID.')).toBeTruthy();
  });
});
