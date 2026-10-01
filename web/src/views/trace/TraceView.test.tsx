import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_IDS, type CoreApi } from '../../core/api';
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
// jsdom puts every element at the origin, so clientY is the offset into the canvas.
const clickRow = (row: number) =>
  fireEvent.click(trace().querySelector('canvas')!, { clientY: HEADER_H + row * ROW_H + ROW_H / 2 });

describe('Trace', () => {
  it('shows every frame, then only the ID picked in the sidebar', async () => {
    const { user, rows } = renderTrace();
    expect(trace().getAttribute('aria-rowcount')).toBe(String(FRAMES));
    await waitFor(() => expect(rows).toHaveBeenCalledWith(ALL_IDS, 0, VISIBLE + 1));
    expect(screen.getByText('Select an ID to see which bits change and the signals it carries.')).toBeTruthy();

    const sidebar = screen.getByRole('navigation', { name: 'Messages' });
    await user.click(within(sidebar).getByRole('button', { name: /^100/ }));
    expect(trace().getAttribute('aria-rowcount')).toBe(String(engine.count));
    await waitFor(() => expect(rows).toHaveBeenCalledWith(engine.key, 0, VISIBLE + 1));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect(within(inspector).getByRole('heading', { name: /^100\s*Engine$/ })).toBeTruthy();
    expect(within(inspector).getByRole('checkbox', { name: 'Plot EngineSpeed' })).toBeTruthy();

    await user.click(within(sidebar).getByRole('button', { name: /^All frames/ }));
    expect(trace().getAttribute('aria-rowcount')).toBe(String(FRAMES));
  });

  it('scrolls by row, to the end and back to the start from the keyboard', async () => {
    const { user, rows } = renderTrace();
    trace().focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, 1, VISIBLE + 1));
    await user.keyboard('{End}');
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, FRAMES - VISIBLE, VISIBLE + 1));
    await user.keyboard('{PageUp}');
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, FRAMES - 2 * VISIBLE, VISIBLE + 1));
    await user.keyboard('{Home}');
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(ALL_IDS, 0, VISIBLE + 1));
  });

  it('pins the time of a clicked row while something is plotted', async () => {
    const { rows, state } = renderTrace({ plots: [plot] });
    await rowsShown(rows);
    clickRow(2);
    expect(state.pinnedTime).toBeCloseTo(2 * STEP);
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
  });
});
