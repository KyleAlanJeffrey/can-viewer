import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CoreApi } from '../../core/api';
import type { PlotSpec } from '../../components/Plots';
import { fakeCore, logInfo, message, seriesInfo, signal, summary } from '../../test/fixtures';
import { renderInShell, type ShellOptions } from '../../test/shell';
import type { LoadedDbc } from '../types';
import { PlotView } from './PlotView';

const engine = summary({ id: 0x100, name: 'Engine' });
const unknown = summary({ id: 0x200 });
const brakes = summary({ id: 0x300, name: 'Brakes' });

const SIGNALS = [
  { key: engine.key, name: 'EngineSpeed', unit: 'rpm', handle: 1 },
  { key: engine.key, name: 'Throttle', unit: '%', handle: 2 },
  { key: brakes.key, name: 'BrakePressure', unit: 'bar', handle: 3 },
];

const dbc: LoadedDbc = {
  id: 'car',
  db: {
    name: 'car.dbc',
    messages: [
      message(0x100, 'Engine', { signals: [signal('EngineSpeed', { unit: 'rpm' }), signal('Throttle', { startBit: 8, unit: '%' })] }),
      message(0x300, 'Brakes', { signals: [signal('BrakePressure', { unit: 'bar' })] }),
    ],
  },
  channel: null,
  edited: false,
};

function infoOf(name: string) {
  const s = SIGNALS.find((x) => x.name === name)!;
  return { ...seriesInfo(s.handle, s.name), unit: s.unit };
}

function plotOf(name: string): PlotSpec {
  const s = SIGNALS.find((x) => x.name === name)!;
  return { id: `${s.key}:${s.name}`, label: s.name, info: infoOf(name), color: 'c1' };
}

/**
 * Signal `handle` has a sample every second, worth `100 * handle` plus the time. A zero-width
 * window, as the cursor readouts ask for, gets the samples either side of the time.
 */
function plotCore(): CoreApi {
  return fakeCore({
    decodeSignal: async (_key, name) => infoOf(name),
    seriesView: async (handle, t0, t1) => {
      const xs = t0 === t1 ? [Math.floor(t0), Math.floor(t0) + 1] : [t0, t1];
      return [Float64Array.from(xs), Float64Array.from(xs, (x) => 100 * handle + x)];
    },
  });
}

function renderPlot(options: Partial<ShellOptions> = {}) {
  return renderInShell(PlotView, {
    core: plotCore(),
    ids: [engine, unknown, brakes],
    dbcs: [dbc],
    log: logInfo({ durationS: 100 }),
    ...options,
  });
}

const tree = () => screen.getByRole('navigation', { name: 'Signals' });
/** Asserts the tree lists exactly these signals. Each checkbox's name starts with its signal. */
function expectSignals(names: string[]) {
  expect(within(tree()).queryAllByRole('checkbox')).toHaveLength(names.length);
  for (const name of names) expect(within(tree()).getByRole('checkbox', { name: new RegExp(`^${name}`) })).toBeTruthy();
}
const lanes = () => screen.queryAllByRole('group').map((g) => g.getAttribute('aria-label'));

/** The cells after the row header of the readout row headed `label`. */
function readoutRow(label: string): string[] {
  const table = screen.getByRole('table', { name: 'Signal values at the cursors' });
  const row = within(table)
    .getAllByRole('row')
    .find((r) => within(r).queryByRole('rowheader')?.textContent === label);
  if (!row) throw new Error(`No readout row ${label}`);
  return within(row)
    .getAllByRole('cell')
    .map((c) => c.textContent ?? '');
}

describe('Plot signal tree', () => {
  it('adds a lane for each ticked signal and removes it when unticked or removed', async () => {
    const { user, state } = renderPlot();
    expect(screen.getByRole('heading', { name: 'Choose signals to plot' })).toBeTruthy();
    // Until something is plotted, the view's next step is its own amber button.
    expect(state.viewPrimary).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Choose Signals' }));
    expect(state.sidebarShown).toBe(true);
    await waitFor(() => expect(document.activeElement).toBe(within(tree()).getAllByRole('button')[0]));
    // Only messages a DBC describes are listed, and they start closed.
    expect(within(tree()).getAllByRole('button').map((b) => b.getAttribute('aria-expanded'))).toEqual(['false', 'false']);
    expectSignals([]);

    await user.click(within(tree()).getByRole('button', { name: /^100/ }));
    expectSignals(['EngineSpeed', 'Throttle']);

    await user.click(within(tree()).getByRole('checkbox', { name: /^EngineSpeed/ }));
    await waitFor(() => expect(lanes()).toEqual(['EngineSpeed (rpm)']));
    expect(state.viewPrimary).toBe(false);
    await user.click(within(tree()).getByRole('checkbox', { name: /^Throttle/ }));
    await waitFor(() => expect(lanes()).toEqual(['EngineSpeed (rpm)', 'Throttle (%)']));
    expect(within(tree()).getByRole('checkbox', { name: /^EngineSpeed/ })).toHaveProperty('checked', true);
    expect(screen.getByText('2 signals', { exact: false })).toBeTruthy();

    await user.click(within(tree()).getByRole('checkbox', { name: /^EngineSpeed/ }));
    expect(lanes()).toEqual(['Throttle (%)']);
    expect(within(tree()).getByRole('checkbox', { name: /^EngineSpeed/ })).toHaveProperty('checked', false);

    await user.click(screen.getByRole('button', { name: 'Remove Throttle' }));
    expect(lanes()).toEqual([]);
    expect(state.plots).toEqual([]);
    expect(within(tree()).getByRole('checkbox', { name: /^Throttle/ })).toHaveProperty('checked', false);
  });

  it('filters by signal name, and by message name or ID to show all of its signals', async () => {
    const { user } = renderPlot();
    const search = screen.getByRole('searchbox', { name: 'Search' });

    await user.type(search, 'pressure');
    expectSignals(['BrakePressure']);

    await user.clear(search);
    await user.type(search, 'ENGINE');
    expectSignals(['EngineSpeed', 'Throttle']);

    await user.clear(search);
    await user.type(search, '300');
    expectSignals(['BrakePressure']);

    // A match collapsed during the search stays listed.
    await user.click(within(tree()).getByRole('button', { name: /^300/ }));
    expectSignals([]);
    expect(within(tree()).getByRole('button', { name: /^300/ }).getAttribute('aria-expanded')).toBe('false');

    await user.clear(search);
    await user.type(search, 'nothing like it');
    expect(within(tree()).getByText('No signals match.')).toBeTruthy();
  });

  it('asks for a DBC when none is loaded', () => {
    renderPlot({ dbcs: [] });
    expect(within(tree()).getByRole('button', { name: 'Open DBC\u2026' })).toBeTruthy();
    expect(screen.getByText('Signals come from a DBC, so open one first.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Choose Signals' })).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Open DBC\u2026' })).toHaveLength(2);
  });
});

describe('Plot cursors', () => {
  it('reads out each signal at cursor A, then at B and their difference, and pins A', async () => {
    const { user, state } = renderPlot({ plots: [plotOf('EngineSpeed'), plotOf('BrakePressure')] });
    // A starts a third of the way in; the nearest samples are at 33 s.
    await waitFor(() => expect(readoutRow('A')).toEqual(['33.333 s', '133', '333']));
    await waitFor(() => expect(state.pinnedTime).toBeCloseTo(100 / 3));
    expect(() => readoutRow('B')).toThrow();

    await user.click(screen.getByRole('radio', { name: '2 cursors' }));
    await waitFor(() => expect(readoutRow('B')).toEqual(['66.667 s', '167', '367']));
    expect(readoutRow('\u0394 B\u2212A')).toEqual(['33.333 s', '+34', '+34']);

    await user.click(screen.getByRole('radio', { name: '1 cursor' }));
    expect(() => readoutRow('B')).toThrow();
  });

  it('reads out NaN where a float signal is NaN, and a difference with it as NaN', async () => {
    const core = fakeCore({
      decodeSignal: async (_key, name) => infoOf(name),
      seriesView: async (_handle, t0, t1) => {
        const xs = t0 === t1 ? [Math.floor(t0), Math.floor(t0) + 1] : [t0, t1];
        return [Float64Array.from(xs), Float64Array.from(xs, (x) => (x < 50 ? NaN : x))];
      },
    });
    const { user } = renderPlot({ core, plots: [plotOf('EngineSpeed')] });
    await waitFor(() => expect(readoutRow('A')).toEqual(['33.333 s', 'NaN']));
    await user.click(screen.getByRole('radio', { name: '2 cursors' }));
    await waitFor(() => expect(readoutRow('B')).toEqual(['66.667 s', '67']));
    expect(readoutRow('\u0394 B\u2212A')).toEqual(['33.333 s', 'NaN']);
  });

  it('starts cursor A at a time pinned elsewhere, and drops a marker there', async () => {
    const { user } = renderPlot({ plots: [plotOf('Throttle')], pinnedTime: 12.5 });
    await waitFor(() => expect(readoutRow('A')).toEqual(['12.500 s', '212']));

    const markers = screen.getByRole('region', { name: 'Markers' });
    expect(within(markers).getByText('Add Marker drops one at cursor A.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Add Marker' }));
    const marker = within(markers).getByRole('listitem');
    expect(within(marker).getByText('M1')).toBeTruthy();
    expect(within(marker).getByText('12.500 s')).toBeTruthy();

    await user.click(within(markers).getByRole('button', { name: 'Remove marker M1' }));
    expect(within(markers).queryByRole('listitem')).toBeNull();
  });
});
