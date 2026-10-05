import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_IDS, EXT_FLAG, FLAG_ERROR, FLAG_FD, FLAG_RTR, type CoreApi } from '../../core/api';
import type { PlotSpec } from '../../components/Plots';
import { fakeCore, logInfo, makeRowBatch, message, seriesInfo, signal, summary } from '../../test/fixtures';
import { renderInShell, type ShellOptions } from '../../test/shell';
import type { LoadedDbc } from '../types';
import { TraceView } from './TraceView';

const HEADER_H = 28;
const ROW_H = 24;
/** Rows that fit in the trace the resize observer below reports. */
const VISIBLE = 5;
const FRAMES = 1000;
/** Seconds between the fake log's frames. */
const STEP = 0.1;

const engine = summary({ id: 0x100, name: 'Engine', count: 400 });
const brakes = summary({ id: 0x300, name: 'Brakes', count: 600 });
const dbc: LoadedDbc = {
  id: 'car',
  db: { name: 'car.dbc', messages: [message(0x100, 'Engine', { signals: [signal('EngineSpeed')] }), message(0x300, 'Brakes')] },
  channel: null,
  edited: false,
};
const plot: PlotSpec = { id: `${engine.key}:EngineSpeed`, label: 'EngineSpeed', info: seriesInfo(1, 'EngineSpeed'), color: 'c1' };

/** Gives every observed element room for the trace header and VISIBLE rows. */
class SizedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    const contentRect = { width: 810, height: HEADER_H + VISIBLE * ROW_H } as DOMRectReadOnly;
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

/** Row n of any key is at n * STEP seconds and is frame n of the log. */
function traceCore() {
  const rows = vi.fn<CoreApi['rows']>(async (key, start, count) => {
    const total = key === ALL_IDS ? FRAMES : key === engine.key ? engine.count : brakes.count;
    const n = Math.max(0, Math.min(count, total - start));
    return makeRowBatch(
      key,
      start,
      Array.from({ length: n }, (_, i) => ({ t: (start + i) * STEP, id: 0x100, index: start + i, data: [1, 2, 3, 4, 5, 6, 7, 8] })),
    );
  });
  const core = fakeCore({
    rows,
    bitFlips: async () => new Uint32Array(64),
    seriesView: async () => [Float64Array.of(0, 100), Float64Array.of(0, 1)],
  });
  return { core, rows };
}

/** Waits for the trace to have the rows it last asked for. */
async function rowsShown(rows: ReturnType<typeof traceCore>['rows']) {
  await waitFor(() => expect(rows).toHaveBeenCalled());
  await act(() => rows.mock.results.at(-1)!.value);
}

function renderTrace(options: Partial<ShellOptions> = {}) {
  const { core, rows } = traceCore();
  const shell = renderInShell(TraceView, { core, ids: [engine, brakes], dbcs: [dbc], log: logInfo({ frames: FRAMES }), ...options });
  return { ...shell, rows };
}

const trace = () => screen.getByRole('grid', { name: 'Frame trace' });
/** The header is row 1 of the grid. */
const rowIndex = (row: number) => row + 2;
const frameRows = () => within(trace()).getAllByRole('row').slice(1);
const rowIndexes = () => frameRows().map((r) => Number(r.getAttribute('aria-rowindex')));
const selectedRowIndexes = () =>
  frameRows()
    .filter((r) => r.getAttribute('aria-selected') === 'true')
    .map((r) => Number(r.getAttribute('aria-rowindex')));
const activeRowIndex = () => {
  const id = trace().getAttribute('aria-activedescendant');
  return id ? Number(document.getElementById(id)?.getAttribute('aria-rowindex')) : null;
};
const cellTexts = (row: HTMLElement) => within(row).getAllByRole('gridcell').map((c) => c.textContent);
// jsdom puts every element at the origin, so clientY is the offset into the canvas.
const clickRow = (row: number) =>
  fireEvent.click(trace().querySelector('canvas')!, { clientY: HEADER_H + row * ROW_H + ROW_H / 2 });

describe('Trace', () => {
  it('shows every frame, then only the ID picked in the sidebar', async () => {
    const { user, rows } = renderTrace();
    expect(trace().getAttribute('aria-rowcount')).toBe(String(FRAMES + 1));
    await waitFor(() => expect(rows).toHaveBeenCalledWith(ALL_IDS, 0, VISIBLE + 1));
    expect(screen.getByText('Select an ID to see which bits change and the signals it carries.')).toBeTruthy();

    const sidebar = screen.getByRole('navigation', { name: 'Messages' });
    await user.click(within(sidebar).getByRole('button', { name: /^100/ }));
    expect(trace().getAttribute('aria-rowcount')).toBe(String(engine.count + 1));
    await waitFor(() => expect(rows).toHaveBeenCalledWith(engine.key, 0, VISIBLE + 1));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByRole('heading', { name: /^100\s*Engine$/ })).toBeTruthy();
    expect(within(inspector).getByRole('checkbox', { name: 'Plot EngineSpeed' })).toBeTruthy();

    await user.click(within(sidebar).getByRole('button', { name: /^All frames/ }));
    expect(trace().getAttribute('aria-rowcount')).toBe(String(FRAMES + 1));
  });

  it('starts at the newest frames while capturing, for every ID picked', async () => {
    const { user, rows } = renderTrace({ capturing: true });
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, FRAMES - VISIBLE, VISIBLE + 1));
    await user.click(within(screen.getByRole('navigation', { name: 'Messages' })).getByRole('button', { name: /^100/ }));
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(engine.key, engine.count - VISIBLE, VISIBLE + 1));
  });

  it('puts the rows in view in the accessibility tree', async () => {
    const { rows } = renderTrace();
    await rowsShown(rows);
    const [header] = within(trace()).getAllByRole('row');
    expect(header.getAttribute('aria-rowindex')).toBe('1');
    expect(within(header).getAllByRole('columnheader').map((c) => c.textContent)).toEqual(['Time', 'Bus', 'ID', 'Name', 'Len', 'Data']);
    // The rows in view and the part-shown one below them.
    expect(rowIndexes()).toEqual(Array.from({ length: VISIBLE + 1 }, (_, i) => rowIndex(i)));
    expect(cellTexts(frameRows()[1])).toEqual(['0.100000', 'can0', '100', 'Engine', '8', '01 02 03 04 05 06 07 08']);
  });

  it('reads long payloads, error, remote and FD frames as the canvas draws them', async () => {
    const specs = [
      { t: 0, id: (0x18fe_ca00 | EXT_FLAG) >>> 0, index: 0, data: Array.from({ length: 64 }, (_, i) => i), fullLength: 100 },
      { t: 0.1, id: (0x2000_0080 | EXT_FLAG) >>> 0, index: 1, flags: FLAG_ERROR, data: [0, 0, 0, 0, 0, 0, 0, 0] },
      { t: 0.2, id: 0x300, index: 2, flags: FLAG_RTR, data: [] },
      { t: 0.3, id: 0x100, index: 3, flags: FLAG_FD, data: [0xa0, 0xb1, 0xc2, 0xd3, 0xe4, 0xf5, 0x06, 0x17, 0x28, 0x39, 0x4a, 0x5b] },
    ];
    const rows = vi.fn<CoreApi['rows']>(async (key, start, count) => makeRowBatch(key, start, specs.slice(start, start + count)));
    renderInShell(TraceView, { core: fakeCore({ rows }), ids: [engine, brakes], dbcs: [dbc], log: logInfo({ frames: specs.length }) });
    await rowsShown(rows);
    const [long, error, remote, fd] = frameRows().map(cellTexts);
    const bytes = specs[0].data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    expect(long).toEqual(['0.000000', 'can0', '18FECA00', '', '100', `${bytes} \u2026 (100 bytes)`]);
    expect(error).toEqual(['0.100000', 'can0', 'ERR', 'Error 080', '8', '00 00 00 00 00 00 00 00']);
    expect(remote).toEqual(['0.200000', 'can0', '300', 'Brakes', 'RTR', '']);
    expect(fd).toEqual(['0.300000', 'can0', '100', 'Engine', '12', 'FD A0 B1 C2 D3 E4 F5 06 17 28 39 4A 5B']);
  });

  it('moves the active row from the keyboard and scrolls to keep it in view', async () => {
    const { user, rows } = renderTrace();
    await rowsShown(rows);
    trace().focus();
    expect(activeRowIndex()).toBe(rowIndex(0));
    await user.keyboard('{ArrowDown}');
    expect(activeRowIndex()).toBe(rowIndex(1));
    expect(rows).toHaveBeenLastCalledWith(ALL_IDS, 0, VISIBLE + 1);
    // Past the last row in view, the trace scrolls by a row.
    await user.keyboard('{ArrowDown}'.repeat(VISIBLE - 1));
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, 1, VISIBLE + 1));
    await waitFor(() => expect(activeRowIndex()).toBe(rowIndex(VISIBLE)));
    await user.keyboard('{End}');
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, FRAMES - VISIBLE, VISIBLE + 1));
    await waitFor(() => expect(activeRowIndex()).toBe(rowIndex(FRAMES - 1)));
    expect(rowIndexes()).toEqual(Array.from({ length: VISIBLE }, (_, i) => rowIndex(FRAMES - VISIBLE + i)));
    await user.keyboard('{PageUp}');
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, FRAMES - 2 * VISIBLE, VISIBLE + 1));
    await waitFor(() => expect(activeRowIndex()).toBe(rowIndex(FRAMES - 1 - VISIBLE)));
    await user.keyboard('{Home}');
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, 0, VISIBLE + 1));
    await waitFor(() => expect(activeRowIndex()).toBe(rowIndex(0)));
  });

  it('pages down a screen at a time', async () => {
    const { user, rows } = renderTrace();
    await rowsShown(rows);
    trace().focus();
    await user.keyboard('{PageDown}');
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, VISIBLE, VISIBLE + 1));
    await waitFor(() => expect(activeRowIndex()).toBe(rowIndex(VISIBLE)));
  });

  it('keeps the active row while the rows it moves to load', async () => {
    const { user, rows } = renderTrace();
    await rowsShown(rows);
    trace().focus();
    const activeIds: (string | null)[] = [];
    const observer = new MutationObserver(() => activeIds.push(trace().getAttribute('aria-activedescendant')));
    observer.observe(trace(), { attributeFilter: ['aria-activedescendant'] });
    await user.keyboard('{End}');
    await waitFor(() => expect(activeRowIndex()).toBe(rowIndex(FRAMES - 1)));
    await user.keyboard('{Home}');
    await waitFor(() => expect(activeRowIndex()).toBe(rowIndex(0)));
    observer.disconnect();
    expect(activeIds.length).toBeGreaterThan(0);
    expect(activeIds).not.toContain(null);
  });

  it('keeps row indexes absolute and the active row in view when the wheel scrolls', async () => {
    const { rows } = renderTrace();
    await rowsShown(rows);
    fireEvent.wheel(trace(), { deltaY: 10 * ROW_H });
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, 10, VISIBLE + 1));
    await waitFor(() => expect(rowIndexes()).toEqual(Array.from({ length: VISIBLE + 1 }, (_, i) => rowIndex(10 + i))));
    expect(cellTexts(frameRows()[0])[0]).toBe('1.000000');
    expect(activeRowIndex()).toBe(rowIndex(10));
  });

  it('selects and pins the active row with Enter, and clears it with Space', async () => {
    const { user, rows, state } = renderTrace({ plots: [plot] });
    await rowsShown(rows);
    trace().focus();
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(selectedRowIndexes()).toEqual([rowIndex(2)]);
    expect(state.pinnedTime).toBeCloseTo(2 * STEP);
    await user.keyboard(' ');
    expect(selectedRowIndexes()).toEqual([]);
  });

  it('selects the active row with Space, and clears it with Enter', async () => {
    const { user, rows, state } = renderTrace({ plots: [plot] });
    await rowsShown(rows);
    trace().focus();
    await user.keyboard('{ArrowDown} ');
    expect(selectedRowIndexes()).toEqual([rowIndex(1)]);
    expect(state.pinnedTime).toBeCloseTo(STEP);
    await user.keyboard('{Enter}');
    expect(selectedRowIndexes()).toEqual([]);
  });

  it('toggles the row once while Enter is held', async () => {
    const { user, rows } = renderTrace({ plots: [plot] });
    await rowsShown(rows);
    trace().focus();
    await user.keyboard('{Enter>2/}');
    expect(selectedRowIndexes()).toEqual([rowIndex(0)]);
  });

  it('scrolls the part-shown row into view when it is clicked', async () => {
    const { user, rows, state } = renderTrace({ plots: [plot] });
    await rowsShown(rows);
    trace().focus();
    clickRow(VISIBLE);
    expect(selectedRowIndexes()).toEqual([rowIndex(VISIBLE)]);
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, 1, VISIBLE + 1));
    expect(activeRowIndex()).toBe(rowIndex(VISIBLE));
    // Enter acts on the clicked row, not the one above it.
    await user.keyboard('{Enter}');
    expect(selectedRowIndexes()).toEqual([]);
    expect(state.pinnedTime).toBeCloseTo(VISIBLE * STEP);
  });

  it('pins the time of a clicked row while something is plotted', async () => {
    const { rows, state } = renderTrace({ plots: [plot] });
    await rowsShown(rows);
    clickRow(2);
    expect(state.pinnedTime).toBeCloseTo(2 * STEP);
    expect(selectedRowIndexes()).toEqual([rowIndex(2)]);
    expect(frameRows().filter((r) => r.getAttribute('aria-selected') === 'false')).toHaveLength(VISIBLE);
    expect(activeRowIndex()).toBe(rowIndex(2));
    // Below the last fetched row is not a row.
    clickRow(VISIBLE + 3);
    expect(state.pinnedTime).toBeCloseTo(2 * STEP);
  });

  it('pins nothing without plots', async () => {
    const { rows, state } = renderTrace();
    await rowsShown(rows);
    clickRow(2);
    expect(state.pinnedTime).toBeNull();
  });

  it('scrolls to the row nearest a time pinned elsewhere', async () => {
    const { rows } = renderTrace({ plots: [plot], pinnedTime: 50.04 });
    // Row 500 is nearest; it is centred in the five visible rows.
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, 500 - Math.floor(VISIBLE / 2), VISIBLE + 1));
    await waitFor(() => expect(selectedRowIndexes()).toEqual([rowIndex(500)]));
    expect(activeRowIndex()).toBe(rowIndex(500));
  });
});
