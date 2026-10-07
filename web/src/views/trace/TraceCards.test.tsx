import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_IDS, FLAG_FD, type CoreApi, type FrameValue } from '../../core/api';
import { fakeCore, makeRowBatch, message, signal } from '../../test/fixtures';
import { CARD_H, TraceCards, type FrameLookup } from './TraceCards';

const FRAMES = 1_000_000;
/** A collapsed card and the gap under it, and the room above the first. */
const PITCH = CARD_H + 8;
const PAD = 12;
const engine = message(0x0c9, 'ENGINE_1', { signals: [signal('EngineSpeed', { size: 16, factor: 0.25, unit: 'rpm' })] });

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
  vi.restoreAllMocks();
});

const VALUES: FrameValue[] = [
  { name: 'EngineSpeed', unit: 'rpm', value: 811.75, label: null, missing: null },
  { name: 'Gear', unit: '', value: 3, label: 'Drive', missing: null },
  { name: 'Page2', unit: 'V', value: null, label: null, missing: 'absent' },
  { name: 'Torque', unit: 'Nm', value: null, label: null, missing: 'error' },
];

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
  const decodeFrame = vi.fn<CoreApi['decodeFrame']>(async (_key, row) => (row % 2 === 0 ? VALUES : []));
  const lookup = (_channel: number, id: number): FrameLookup => (id === 0x0c9 ? { name: 'ENGINE_1', message: engine, key: 0x0c9 } : { message: null, key: null });
  const onPlotMessage = vi.fn();
  render(
    <TraceCards
      core={fakeCore({ rows, decodeFrame })}
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
  return { rows, decodeFrame, onPlotMessage };
}

async function cardsShown(rows: ReturnType<typeof renderCards>['rows']) {
  await waitFor(() => expect(rows).toHaveBeenCalled());
  await act(() => rows.mock.results.at(-1)!.value);
}

const list = () => screen.getByRole('list', { name: 'Frames' });
const head = (row: number) => list().querySelector<HTMLElement>(`[data-row="${row}"]`)!;
const card = (row: number) => head(row).closest<HTMLElement>('[role=listitem]')!;
const topOf = (row: number) => parseFloat(card(row).style.top);

describe('TraceCards', () => {
  it('renders only the cards in view of a million frames, each named for screen readers', async () => {
    const { rows } = renderCards();
    await cardsShown(rows);
    expect(rows.mock.calls.every(([, , count]) => count < 100)).toBe(true);
    const items = within(list()).getAllByRole('listitem');
    expect(items.length).toBeLessThan(20);
    expect(items[0].getAttribute('aria-setsize')).toBe(String(FRAMES));
    expect(screen.getByRole('button', { name: '0.000000 s, 0C9 on can0, ENGINE_1, 8 bytes', expanded: false })).toBe(head(0));
    expect(head(1).getAttribute('aria-label')).toBe('0.001000 s, 300 on can0, Unknown, FD, 32 bytes');
  });

  it('opens a tapped card in place with the core decoded values, and closes it on a second tap', async () => {
    const { rows, decodeFrame, onPlotMessage } = renderCards();
    await cardsShown(rows);

    await userEvent.click(head(0));
    expect(head(0).getAttribute('aria-expanded')).toBe('true');
    expect(decodeFrame).toHaveBeenCalledWith(ALL_IDS, 0);
    const values = await within(card(0)).findByRole('region', { name: 'Decoded values' });
    const shown = within(values)
      .getAllByRole('term')
      .map((dt) => `${dt.textContent}=${dt.nextElementSibling?.textContent}`);
    // Signals multiplexed out of the frame are left out.
    expect(shown).toEqual(['EngineSpeed=811.75 rpm', 'Gear=Drive', 'Torque=Error']);
    await userEvent.click(within(card(0)).getByRole('button', { name: /Plot this message/ }));
    expect(onPlotMessage).toHaveBeenCalledWith(0x0c9, 0);

    await userEvent.click(head(0));
    expect(head(0).getAttribute('aria-expanded')).toBe('false');
    expect(within(card(0)).queryByRole('region', { name: 'Decoded values' })).toBeNull();
  });

  it('shows the first 8 bytes of an FD frame, and all of them from View all', async () => {
    const { rows } = renderCards();
    await cardsShown(rows);
    const fd = card(1);
    expect(fd.querySelectorAll('.tc-byte')).toHaveLength(8);
    expect(head(1).textContent).toContain('Unknown \u00b7 FD \u00b7 32 bytes');

    await userEvent.click(within(fd).getByRole('button', { name: 'View all 32 bytes' }));
    expect(head(1).getAttribute('aria-expanded')).toBe('true');
    expect(fd.querySelectorAll('.tc-byte')).toHaveLength(32);
    expect(within(fd).queryByRole('button', { name: 'View all 32 bytes' })).toBeNull();
    expect(within(fd).getByText('No loaded DBC describes this ID.')).toBeTruthy();
  });

  it('moves the cards after an open card down by its extra height', async () => {
    // jsdom lays nothing out, so the open card reports a height of its own.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('open') ? CARD_H + 100 : CARD_H;
    });
    const { rows } = renderCards();
    await cardsShown(rows);
    expect(topOf(2)).toBe(PAD + 2 * PITCH);

    await userEvent.click(head(1));
    await waitFor(() => expect(topOf(2)).toBe(PAD + 2 * PITCH + 100));
    expect(topOf(1)).toBe(PAD + PITCH);
    await userEvent.click(head(1));
    expect(topOf(2)).toBe(PAD + 2 * PITCH);
  });

  it('scrolls with the wheel, rendering the cards that come into view', async () => {
    const { rows } = renderCards();
    await cardsShown(rows);
    fireEvent.wheel(list().parentElement!, { deltaY: 100 * PITCH });
    await cardsShown(rows);
    expect(topOf(100)).toBe(PAD);
    expect(list().querySelector('[data-row="0"]')).toBeNull();
  });

  it('moves focus between cards with the keys, without letting the browser scroll the list', async () => {
    const { rows } = renderCards();
    await cardsShown(rows);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    head(0).focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(head(1));
    expect(focus).toHaveBeenLastCalledWith({ preventScroll: true });

    await userEvent.keyboard('{End}');
    await cardsShown(rows);
    await waitFor(() => expect(document.activeElement).toBe(head(FRAMES - 1)));
    expect(head(FRAMES - 1).getAttribute('aria-label')).toMatch(/^999\.999000 s/);

    await userEvent.keyboard('{Home}');
    await cardsShown(rows);
    await waitFor(() => expect(document.activeElement).toBe(head(0)));
    expect(topOf(0)).toBe(PAD);
  });
});
