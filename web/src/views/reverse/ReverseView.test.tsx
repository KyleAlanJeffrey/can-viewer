import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { FLAG_FD, FLAG_REASSEMBLED, type CoreApi, type IdSummary, type MessageDef } from '../../core/api';
import { fakeCore, lane, logInfo, makeRowBatch, message, seriesInfo, signal, summary } from '../../test/fixtures';
import { ViewStateContext, ViewStateStore } from '../shared/viewState';
import type { LoadedDbc, ViewContext } from '../types';
import { ReverseView } from './ReverseView';

const engine = summary({ id: 0x100, name: 'Engine' });
const unknown = summary({ id: 0x200 });
const brakes = summary({ id: 0x300, name: 'Brakes' });
const dm1 = summary({ id: 0x18feca00, extended: true, minLen: 100, maxLen: 100, flags: FLAG_REASSEMBLED });
const fd = summary({ id: 0x400, minLen: 64, maxLen: 64, flags: FLAG_FD });

const messages = new Map<number, MessageDef>([
  [engine.key, message(0x100, 'Engine', { signals: [signal('EngineSpeed', { unit: 'rpm' }), signal('Throttle', { startBit: 8, unit: '%' })] })],
  [brakes.key, message(0x300, 'Brakes', { signals: [signal('BrakePressure', { unit: 'bar' })] })],
]);
const dbc: LoadedDbc = { id: 'car', db: { name: 'car.dbc', messages: [...messages.values()] }, channel: null, edited: false };

/** Byte 0 of Engine and of the unknown message changes across the window; Brakes never changes. */
function testCore(overrides: Partial<CoreApi> = {}): CoreApi {
  return fakeCore({
    byteLanes: async (key, _first, count, t0, t1) =>
      Array.from({ length: count }, (_, byte) => lane(key !== brakes.key && byte === 0 ? [1, 2, 3] : [5, 5, 5], t0, t1)),
    rowAtTime: async () => 1,
    rows: async (key, start) => makeRowBatch(key, start, [{ t: 0, id: 0x100, index: 0, data: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88] }]),
    decodeRaw: async () => seriesInfo(1, 'raw'),
    decodeSignal: async (_key, name) => seriesInfo(2, name),
    seriesView: async () => [Float64Array.of(40, 70), Float64Array.of(0, 1)],
    ...overrides,
  });
}

/** The shell's part of ViewContext, with the selection and pinned time held in state. */
function Shell({ core, ids }: { core: CoreApi; ids: IdSummary[] }) {
  const [selected, select] = useState(-1);
  const [pinnedTime, setPinnedTime] = useState<number | null>(null);
  const [store] = useState(() => new ViewStateStore());
  const unused = () => Promise.reject(new Error('not used by this test'));
  const ctx: ViewContext = {
    core,
    log: logInfo({ durationS: 100, channels: ['can0'] }),
    logVersion: 1,
    ids,
    dbcs: [dbc],
    messageOf: (key) => messages.get(key) ?? null,
    dbcOf: (key) => (messages.has(key) ? dbc : null),
    addDbc: unused,
    updateDbc: unused,
    removeDbc: unused,
    moveDbc: unused,
    selected,
    select,
    query: '',
    plots: [],
    togglePlot: unused,
    removePlot: () => {},
    clearPlots: () => {},
    signalColor: () => 'black',
    pinnedTime,
    setPinnedTime,
    run: async (_label, task) => {
      await task();
      return true;
    },
    setError: () => {},
    setView: () => {},
    setInspectorHidden: () => {},
    openLogPicker: () => {},
    openDbcPicker: () => {},
  };
  return (
    <ViewStateContext.Provider value={store}>
      <ReverseView ctx={ctx} />
    </ViewStateContext.Provider>
  );
}

function renderView(ids = [brakes, unknown, engine], core = testCore()) {
  const user = userEvent.setup();
  render(<Shell core={core} ids={ids} />);
  return user;
}

/** Asserts the matrix rows, in order, by ID and message name. */
function expectMatrixRows(rows: [id: string, name: string][]) {
  const headers = within(screen.getByRole('table')).getAllByRole('rowheader');
  expect(headers).toHaveLength(rows.length);
  rows.forEach(([id, name], i) => {
    expect(within(headers[i]).getByText(id)).toBeTruthy();
    expect(within(headers[i]).getByText(name)).toBeTruthy();
  });
}

const allRows: [string, string][] = [
  ['100', 'Engine'],
  ['200', 'Unknown'],
  ['300', 'Brakes'],
];

describe('Byte Values', () => {
  it('shows one row per message, sorted by ID, with its name or Unknown', () => {
    renderView();
    expectMatrixRows(allRows);
    expect(screen.getAllByRole('button', { name: /^100 byte \d$/ })).toHaveLength(8);
  });

  it('hides a message whose bytes never change with Changing bytes only, known or not', async () => {
    const user = renderView();
    await user.click(screen.getByRole('checkbox', { name: 'Changing bytes only' }));
    await waitFor(() =>
      expectMatrixRows([
        ['100', 'Engine'],
        ['200', 'Unknown'],
      ]),
    );
    await user.click(screen.getByRole('checkbox', { name: 'Changing bytes only' }));
    expectMatrixRows(allRows);
  });

  it('labels a long payload by what carries it and expands it in groups of eight', async () => {
    const user = renderView([dm1, fd]);
    const [fdHead, dm1Head] = screen.getAllByRole('rowheader');
    expect(within(fdHead).getByText('CAN FD \u00b7 B0-7 of 64')).toBeTruthy();
    expect(within(dm1Head).getByText('J1939 TP \u00b7 B0-7 of 100')).toBeTruthy();
    expect(within(dm1Head).queryByText(/CAN FD/)).toBeNull();

    await user.click(within(dm1Head).getByRole('button', { name: 'View all' }));
    expect(screen.getByText('J1939 TP \u00b7 100 bytes')).toBeTruthy();
    expect(screen.getByText('B8-15')).toBeTruthy();
    expect(screen.getByText('B96-99')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /^18FECA00 byte \d+$/ })).toHaveLength(100);
  });

  it('selects a byte and pins it', async () => {
    const user = renderView();
    expect(screen.getByText(/^Select a byte to pin it/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Pin byte' }).hasAttribute('disabled')).toBe(true);

    await user.click(screen.getByRole('button', { name: /^100 byte 2/ }));
    const cell = screen.getByRole('button', { name: /^100 byte 2/ });
    expect(cell.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /^100 byte 3/ }).getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByText('100 \u00b7 Byte 2')).toBeTruthy();
    expect(within(screen.getAllByRole('rowheader')[0]).getByRole('button').getAttribute('aria-pressed')).toBe('true');
    // The cursor parks where the cell was clicked, so the cell shows that frame's byte.
    await waitFor(() => expect(screen.getByRole('button', { name: '100 byte 2, 33 hex' })).toBeTruthy());

    await user.click(screen.getByRole('button', { name: 'Pin byte' }));
    expect(screen.getByRole('button', { name: 'Unpin byte' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^100 byte 2, .*pinned$/ })).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Unpin 100 \u00b7 Byte 2' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Unpin byte' }));
    expect(screen.getByRole('button', { name: 'Pin byte' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Unpin 100 \u00b7 Byte 2' })).toBeNull();
  });
});

describe('Advanced', () => {
  it('rates bit changes against the steps between the frames of the window', async () => {
    // Five frames in the window, so four steps; bit 6 of byte 0 changes at every one of them.
    const flips = new Uint32Array(64);
    flips[6] = 4;
    const core = testCore({ rowCountBetween: async () => 5, bitFlipsBetween: async () => flips });
    const user = renderView([engine], core);
    await user.click(within(screen.getByRole('rowheader')).getByRole('button'));
    await user.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(await screen.findByText('5 frames in the window')).toBeTruthy();

    const grid = screen.getByRole('application', { name: /^Bit activity/ });
    grid.focus();
    await user.keyboard('{ArrowRight}');
    expect(await within(grid).findByText(/^Byte 0, bit 6\. Changed 4 times, 100% of frames\./)).toBeTruthy();
  });

  it('says a bit that changed one time changed once', async () => {
    const flips = new Uint32Array(64);
    flips[6] = 1;
    const core = testCore({ rowCountBetween: async () => 2, bitFlipsBetween: async () => flips });
    const user = renderView([engine], core);
    await user.click(within(screen.getByRole('rowheader')).getByRole('button'));
    await user.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(await screen.findByText('2 frames in the window')).toBeTruthy();

    const grid = screen.getByRole('application', { name: /^Bit activity/ });
    grid.focus();
    await user.keyboard('{ArrowRight}');
    expect(await within(grid).findByText(/^Byte 0, bit 6\. Changed once, 100% of frames\./)).toBeTruthy();
  });
});

describe('Pin signal sheet', () => {
  async function openSheet() {
    const user = renderView();
    await user.click(screen.getByRole('button', { name: 'Pin signal\u2026' }));
    const sheet = screen.getByRole('dialog', { name: 'Pin signal' });
    /** Asserts the sheet lists exactly these signals. Each button's name starts with its signal. */
    const expectSignals = (names: string[]) => {
      const list = within(sheet).queryByRole('list', { name: 'Signals' });
      expect(list ? within(list).getAllByRole('button') : []).toHaveLength(names.length);
      for (const name of names) expect(within(sheet).getByRole('button', { name: new RegExp(`^${name}`) })).toBeTruthy();
    };
    return { user, sheet, expectSignals };
  }

  it('lists every decoded signal and none of the unknown message', async () => {
    const { sheet, expectSignals } = await openSheet();
    expectSignals(['BrakePressure', 'EngineSpeed', 'Throttle']);
    expect(within(sheet).queryByText('200')).toBeNull();
  });

  it('filters by signal name, and by message name or ID to show all of its signals', async () => {
    const { user, sheet, expectSignals } = await openSheet();
    const search = within(sheet).getByRole('textbox', { name: 'Filter signals' });

    await user.type(search, 'speed');
    expectSignals(['EngineSpeed']);

    await user.clear(search);
    await user.type(search, 'ENGINE');
    expectSignals(['EngineSpeed', 'Throttle']);

    await user.clear(search);
    await user.type(search, '300');
    expectSignals(['BrakePressure']);

    await user.clear(search);
    await user.type(search, 'nothing like it');
    expectSignals([]);
    expect(within(sheet).getByText('No signals match.')).toBeTruthy();
  });

  it('pins a signal as a reference', async () => {
    const { user, sheet } = await openSheet();
    const throttle = within(sheet).getByRole('button', { name: /^Throttle/ });
    expect(throttle.getAttribute('aria-pressed')).toBe('false');
    await user.click(throttle);
    expect(within(sheet).getByRole('button', { name: /^Throttle/ }).getAttribute('aria-pressed')).toBe('true');
    await user.click(within(sheet).getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('button', { name: 'Unpin Throttle' })).toBeTruthy();
  });
});
