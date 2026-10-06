import { screen, waitFor, within } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';
import { useState, type ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FILTERED_ROWS, type CoreApi, type FrameFilter } from '../../core/api';
import { fakeCore, logInfo, makeRowBatch, summary } from '../../test/fixtures';
import { renderInShell } from '../../test/shell';
import type { ViewProps } from '../types';
import { TraceView } from './TraceView';

const HEADER_H = 28;
const ROW_H = 24;
const VISIBLE = 5;
const FRAMES = 1000;
const MATCHES = 42;

const engine = summary({ id: 0x100, name: 'Engine', count: 400 });
const brakes = summary({ id: 0x300, name: 'Brakes', count: 600 });
const radar = summary({ id: 0x300, channel: 1, name: 'Radar', count: 0 });

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

/** A core whose filters match MATCHES frames, or none when `matches` says so; filtered rows have 1F in byte 2. */
function filterCore(matches: (filter: FrameFilter) => number = () => MATCHES) {
  const rows = vi.fn<CoreApi['rows']>(async (key, start, count) => {
    const n = Math.max(0, Math.min(count, (key === FILTERED_ROWS ? MATCHES : FRAMES) - start));
    return makeRowBatch(
      key,
      start,
      Array.from({ length: n }, (_, i) => ({ t: (start + i) * 0.1, id: 0x300, index: start + i, data: [0, 0, 0x1f, 8], changed: [3] })),
    );
  });
  const setTraceFilter = vi.fn<CoreApi['setTraceFilter']>(async (filter) => (filter ? matches(filter) : 0));
  const countFilterMatches = vi.fn<CoreApi['countFilterMatches']>(async (filter) => matches(filter));
  const core = fakeCore({ rows, setTraceFilter, countFilterMatches, bitFlips: async () => new Uint32Array(64) });
  return { core, rows, setTraceFilter, countFilterMatches };
}

function renderFilters(matches?: (filter: FrameFilter) => number, { view = TraceView, durationS = 100 }: { view?: ComponentType<ViewProps>; durationS?: number } = {}) {
  const fake = filterCore(matches);
  const shell = renderInShell(view, {
    core: fake.core,
    ids: [engine, brakes, radar],
    log: logInfo({ frames: FRAMES, channels: ['can0', 'can1'], durationS }),
  });
  return { ...shell, ...fake };
}

/** The Trace view, with a button that leaves it for another view and comes back. */
function Switcher(props: ViewProps) {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setShown((s) => !s)}>
        Switch view
      </button>
      {shown && <TraceView {...props} />}
    </>
  );
}

const sheet = () => screen.getByRole('dialog', { name: 'Trace filters' });
const preview = () => within(sheet()).getByRole('status').textContent;
const chips = () =>
  within(screen.getByRole('list', { name: 'Applied filters' }))
    .getAllByRole('listitem')
    .map((li) => li.textContent);
const countLine = () => document.querySelector('.tv-count')?.textContent;
const applied = (setTraceFilter: ReturnType<typeof filterCore>['setTraceFilter']) =>
  setTraceFilter.mock.calls.map(([f]) => f).filter((f): f is FrameFilter => f !== null);

const NONE: FrameFilter = { channels: null, keys: null, kinds: null, rules: [], combine: 'all', t0: null, t1: null };

/** The sheet loads on first use. */
async function openSheet(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: /^(Edit filters|Filters)/ }));
  await screen.findByRole('dialog', { name: 'Trace filters' });
}

/** Opens the sheet and adds a "byte 2 equals `value`" rule. */
async function addByteRule(user: UserEvent, value: string) {
  await openSheet(user);
  await user.click(within(sheet()).getByRole('button', { name: 'Add rule' }));
  const rules = within(sheet()).getAllByRole('group', { name: /^Rule \d+$/ });
  const rule = rules[rules.length - 1];
  const byte = within(rule).getByRole('textbox', { name: /byte$/ });
  await user.clear(byte);
  await user.type(byte, '2');
  await user.type(within(rule).getByRole('textbox', { name: /value, hex$/ }), value);
}

describe('Trace filters', () => {
  it('previews the count, applies the filters in the core and shows them as chips', async () => {
    const { user, rows, setTraceFilter, countFilterMatches } = renderFilters();
    await openSheet(user);
    expect(preview()).toBe('Preview: 1,000 of 1,000 frames match');
    expect(countFilterMatches).not.toHaveBeenCalled();

    await user.click(within(sheet()).getByRole('checkbox', { name: 'can1' }));
    await waitFor(() => expect(countFilterMatches).toHaveBeenLastCalledWith({ ...NONE, channels: [0] }));
    await waitFor(() => expect(preview()).toBe(`Preview: ${MATCHES} of 1,000 frames match`));

    const search = within(sheet()).getByRole('combobox', { name: 'Search IDs or names' });
    await user.type(search, 'brak');
    const options = within(sheet()).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['300Brakescan0']);
    await user.keyboard('{Enter}');
    expect(within(sheet()).getByRole('button', { name: 'Remove 300 Brakes on can0' })).toBeTruthy();

    await user.click(within(sheet()).getByRole('button', { name: 'Add rule' }));
    await user.clear(within(sheet()).getByRole('textbox', { name: 'Rule 1 byte' }));
    await user.type(within(sheet()).getByRole('textbox', { name: 'Rule 1 byte' }), '2');
    await user.type(within(sheet()).getByRole('textbox', { name: 'Rule 1 value, hex' }), '1f');
    await user.click(within(sheet()).getByRole('checkbox', { name: 'Remote' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));

    const expected: FrameFilter = {
      channels: [0],
      keys: [brakes.key],
      kinds: ['data', 'error', 'reassembled'],
      rules: [{ type: 'byteEquals', byte: 2, value: 0x1f }],
      combine: 'all',
      t0: null,
      t1: null,
    };
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith(expected));
    expect(screen.queryByRole('dialog')).toBeNull();
    // 300 is on both buses, so its chip names the bus.
    expect(chips()).toEqual(['can0', '300 on can0', 'Data, Error, J1939 reassembled', 'Byte 2 = 1F']);
    await waitFor(() => expect(countLine()).toBe(`${MATCHES} of 1,000 frames match`));
    await waitFor(() => expect(rows).toHaveBeenLastCalledWith(FILTERED_ROWS, 0, VISIBLE + 1));

    // Each row says which byte matched; the canvas outlines it.
    const grid = screen.getByRole('grid', { name: 'Frame trace' });
    await waitFor(() => expect(within(grid).getAllByRole('row')).toHaveLength(VISIBLE + 2));
    const dataCell = within(within(grid).getAllByRole('row')[1]).getAllByRole('gridcell').at(-1);
    expect(dataCell?.textContent).toBe('00 00 1F 08, filter matched byte 2');
  });

  it('removes one filter from its chip, and every filter with Clear all', async () => {
    const { user, setTraceFilter } = renderFilters();
    await addByteRule(user, '1F');
    await user.click(within(sheet()).getByRole('checkbox', { name: 'can1' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(chips()).toEqual(['can0', 'Byte 2 = 1F']));

    await user.click(screen.getByRole('button', { name: 'Remove filter can0' }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith({ ...NONE, rules: [{ type: 'byteEquals', byte: 2, value: 0x1f }] }));
    expect(chips()).toEqual(['Byte 2 = 1F']);
    // The removed chip's button is gone, so focus moves to the button that opens the sheet.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit filters\u2026' }));

    await user.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith(null));
    expect(screen.queryByRole('list', { name: 'Applied filters' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Filters\u2026' })).toBeTruthy();
    expect(countLine()).toBe('');
  });

  it('shows an empty state when nothing matches, with ways to loosen the filters', async () => {
    const { user, setTraceFilter } = renderFilters((f) => (f.rules.some((r) => r.type === 'byteEquals' && r.value === 0xff) ? 0 : MATCHES));
    await addByteRule(user, '1F');
    await user.click(within(sheet()).getByRole('button', { name: 'Add rule' }));
    await user.clear(within(sheet()).getByRole('textbox', { name: 'Rule 2 byte' }));
    await user.type(within(sheet()).getByRole('textbox', { name: 'Rule 2 byte' }), '3');
    await user.type(within(sheet()).getByRole('textbox', { name: 'Rule 2 value, hex' }), 'ff');
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));

    expect(await screen.findByRole('heading', { name: 'No frames match these filters' })).toBeTruthy();
    expect(screen.queryByRole('grid', { name: 'Frame trace' })).toBeNull();
    expect(countLine()).toBe('0 of 1,000 frames match');

    await user.click(screen.getByRole('button', { name: 'Remove last filter, Byte 3 = FF' }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith({ ...NONE, rules: [{ type: 'byteEquals', byte: 2, value: 0x1f }] }));
    expect(await screen.findByRole('grid', { name: 'Frame trace' })).toBeTruthy();

    // Back to nothing matching, then clear everything from the empty state.
    await addByteRule(user, 'FF');
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    await screen.findByRole('heading', { name: 'No frames match these filters' });
    await user.click(screen.getByRole('button', { name: 'Clear all filters' }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith(null));
    expect(await screen.findByRole('grid', { name: 'Frame trace' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Applied filters' })).toBeNull();
  });

  it('removes the filter edited last, whatever its place among the chips', async () => {
    const { user, setTraceFilter } = renderFilters((f) => (f.channels === null ? MATCHES : 0));
    await addByteRule(user, '1F');
    await user.click(within(sheet()).getByRole('checkbox', { name: 'can1' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByRole('heading', { name: 'No frames match these filters' })).toBeTruthy();
    expect(chips()).toEqual(['can0', 'Byte 2 = 1F']);

    await user.click(screen.getByRole('button', { name: 'Remove last filter, can0' }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith({ ...NONE, rules: [{ type: 'byteEquals', byte: 2, value: 0x1f }] }));

    // Editing the rule again, after the bus, makes the rule the last edited.
    await openSheet(user);
    await user.click(within(sheet()).getByRole('checkbox', { name: 'can1' }));
    const value = within(sheet()).getByRole('textbox', { name: 'Rule 1 value, hex' });
    await user.clear(value);
    await user.type(value, '20');
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    await user.click(await screen.findByRole('button', { name: 'Remove last filter, Byte 2 = 20' }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith({ ...NONE, channels: [0] }));
  });

  it('narrows the filters to the ID picked in the sidebar', async () => {
    const { user, setTraceFilter } = renderFilters((f) => (f.keys?.length === 0 ? 0 : MATCHES));
    await openSheet(user);
    await user.type(within(sheet()).getByRole('combobox', { name: 'Search IDs or names' }), 'engine{Enter}');
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith({ ...NONE, keys: [engine.key] }));

    const sidebar = screen.getByRole('navigation', { name: 'Messages' });
    await user.click(within(sidebar).getByRole('button', { name: /^300\s*Brakes/ }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith({ ...NONE, keys: [] }));
    expect(await screen.findByText(/Only frames of 300, picked in the sidebar, are shown/)).toBeTruthy();

    await user.click(within(sidebar).getByRole('button', { name: /^100\s*Engine/ }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith({ ...NONE, keys: [engine.key] }));
    await waitFor(() => expect(countLine()).toBe(`${MATCHES} of ${engine.count} frames match`));
    await user.click(within(sidebar).getByRole('button', { name: /^All frames/ }));
    // The same filter as with Engine picked, so the core is not asked again; only the total changes.
    await waitFor(() => expect(countLine()).toBe(`${MATCHES} of 1,000 frames match`));
    expect(applied(setTraceFilter)).toHaveLength(3);
    expect(chips()).toEqual(['100']);
  });

  it('marks fields it cannot read and applies nothing until they are fixed', async () => {
    const { user, setTraceFilter } = renderFilters();
    await addByteRule(user, 'zz');
    expect(within(sheet()).getByText('Enter the value as a hex byte, 00 to FF.')).toBeTruthy();
    await waitFor(() => expect(preview()).toBe('Fix the marked fields to see how many frames match.'));

    await user.type(within(sheet()).getByRole('textbox', { name: 'To' }), '-3');
    expect(within(sheet()).getByText('Enter seconds from the start of the log, such as 18.5.')).toBeTruthy();
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    expect(sheet()).toBeTruthy();
    expect(applied(setTraceFilter)).toEqual([]);
    expect(document.activeElement).toBe(within(sheet()).getByRole('textbox', { name: 'Rule 1 value, hex' }));

    // A new rule's empty value is only marked once Apply was tried.
    await user.click(within(sheet()).getByRole('button', { name: 'Remove rule 1' }));
    await user.click(within(sheet()).getByRole('button', { name: 'Add rule' }));
    expect(within(sheet()).getByText('Enter the value as a hex byte, 00 to FF.')).toBeTruthy();
    await user.click(within(sheet()).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(applied(setTraceFilter)).toEqual([]);
  });

  it('counts only the draft that settles, and offers Any rule for two rules', async () => {
    const { user, countFilterMatches } = renderFilters();
    await addByteRule(user, '1F');
    await waitFor(() => expect(countFilterMatches).toHaveBeenCalledTimes(1));
    expect(countFilterMatches).toHaveBeenLastCalledWith({ ...NONE, rules: [{ type: 'byteEquals', byte: 2, value: 0x1f }] });

    await user.click(within(sheet()).getByRole('button', { name: 'Add rule' }));
    const second = within(sheet()).getByRole('group', { name: 'Rule 2' });
    await user.selectOptions(within(second).getByRole('combobox', { name: 'Rule 2 type' }), 'Bit is clear');
    await user.selectOptions(within(second).getByRole('combobox', { name: 'Rule 2 bit' }), '3');
    await user.click(within(sheet()).getByRole('radio', { name: 'Any rule' }));
    await waitFor(() =>
      expect(countFilterMatches).toHaveBeenLastCalledWith({
        ...NONE,
        rules: [
          { type: 'byteEquals', byte: 2, value: 0x1f },
          { type: 'bit', byte: 0, bit: 3, set: false },
        ],
        combine: 'any',
      }),
    );
    // Every edit above came within the delay of the one before, so each settled draft was counted once.
    expect(countFilterMatches.mock.calls.length).toBeLessThanOrEqual(3);

    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(chips()).toEqual(['Any ofByte 2 = 1F', 'Byte 0 bit 3 clear']));
  });

  it('sets the time range by typing, or from the strip with the keyboard', async () => {
    const { user, countFilterMatches, setTraceFilter } = renderFilters();
    await openSheet(user);
    await user.type(within(sheet()).getByRole('textbox', { name: 'From' }), '12');
    await user.type(within(sheet()).getByRole('textbox', { name: 'To' }), '18.5');
    await waitFor(() => expect(countFilterMatches).toHaveBeenLastCalledWith({ ...NONE, t0: 12, t1: 18.5 }));

    const from = within(sheet()).getByRole('slider', { name: 'From' });
    expect(from.getAttribute('aria-valuetext')).toBe('12.000 seconds');
    from.focus();
    await user.keyboard('{ArrowRight}');
    const moved = Number((within(sheet()).getByRole('textbox', { name: 'From' }) as HTMLInputElement).value);
    expect(moved).toBeGreaterThan(12);
    expect(moved).toBeLessThan(18.5);
    await user.keyboard('{Home}');
    expect((within(sheet()).getByRole('textbox', { name: 'From' }) as HTMLInputElement).value).toBe('');

    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith({ ...NONE, t1: 18.5 }));
    expect(chips()).toEqual(['Until 18.500 s']);
  });

  it('shows the filtered rows again at once on returning to the view', async () => {
    const { user, rows, setTraceFilter } = renderFilters(undefined, { view: Switcher });
    await addByteRule(user, '1F');
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(countLine()).toBe(`${MATCHES} of 1,000 frames match`));

    await user.click(screen.getByRole('button', { name: 'Switch view' }));
    expect(screen.queryByRole('grid')).toBeNull();
    rows.mockClear();
    await user.click(screen.getByRole('button', { name: 'Switch view' }));
    // The core still holds the rows, so nothing is filtered again, and every frame is never shown.
    expect(screen.getByRole('grid', { name: 'Frame trace' })).toBeTruthy();
    expect(countLine()).toBe(`${MATCHES} of 1,000 frames match`);
    await waitFor(() => expect(rows).toHaveBeenCalled());
    expect(rows.mock.calls.every(([key]) => key === FILTERED_ROWS)).toBe(true);
    expect(applied(setTraceFilter)).toHaveLength(1);
  });

  it('shows no frames while the filters are applied, rather than every frame', async () => {
    const { user, rows, setTraceFilter } = renderFilters();
    let finish: (count: number) => void = () => {};
    setTraceFilter.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await addByteRule(user, '1F');
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    expect(await screen.findByText('Filtering\u2026', { selector: '.tv-empty-lede' })).toBeTruthy();
    expect(screen.queryByRole('grid')).toBeNull();
    rows.mockClear();

    finish(MATCHES);
    expect(await screen.findByRole('grid', { name: 'Frame trace' })).toBeTruthy();
    await waitFor(() => expect(rows).toHaveBeenCalled());
    expect(rows.mock.calls.every(([key]) => key === FILTERED_ROWS)).toBe(true);
  });

  it('drops the filters and says why when the core rejects them', async () => {
    const { user, state, setTraceFilter } = renderFilters();
    setTraceFilter.mockRejectedValueOnce(new Error('not enough memory to filter this log'));
    await addByteRule(user, '1F');
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(state.error).toBe("The filters couldn't be applied: not enough memory to filter this log"));
    expect(screen.queryByRole('list', { name: 'Applied filters' })).toBeNull();
    expect(countLine()).toBe('');
    expect(await screen.findByRole('grid', { name: 'Frame trace' })).toBeTruthy();
  });

  it("keeps the range open to the log's end when End takes the strip there", async () => {
    // The end is between two milliseconds, so rounding it would leave out the last frames.
    const { user, setTraceFilter } = renderFilters(undefined, { durationS: 12.3454 });
    await openSheet(user);
    await user.type(within(sheet()).getByRole('textbox', { name: 'To' }), '5');
    within(sheet()).getByRole('slider', { name: 'To' }).focus();
    await user.keyboard('{End}');
    expect((within(sheet()).getByRole('textbox', { name: 'To' }) as HTMLInputElement).value).toBe('');
    await user.type(within(sheet()).getByRole('textbox', { name: 'From' }), '1.23456');
    await user.click(within(sheet()).getByRole('button', { name: 'Apply filters' }));
    await waitFor(() => expect(setTraceFilter).toHaveBeenLastCalledWith({ ...NONE, t0: 1.23456 }));

    // Reopened, the field shows the time as it was typed, not rounded.
    await openSheet(user);
    expect((within(sheet()).getByRole('textbox', { name: 'From' }) as HTMLInputElement).value).toBe('1.23456');
  });

  it('finds IDs typed with 0x, moves with Home and End, and never submits on Enter', async () => {
    const { user, setTraceFilter } = renderFilters();
    await openSheet(user);
    const search = within(sheet()).getByRole('combobox', { name: 'Search IDs or names' });
    search.focus();
    await user.keyboard('{Enter}');
    expect(sheet()).toBeTruthy();
    expect(setTraceFilter).not.toHaveBeenCalled();

    await user.type(search, '0x3');
    const options = within(sheet()).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['300Brakescan0', '300Radarcan1']);
    await user.keyboard('{End}');
    expect(options[1].getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{Home}');
    expect(options[0].getAttribute('aria-selected')).toBe('true');
    await user.keyboard('{End}{Enter}');
    expect(within(sheet()).getByRole('button', { name: 'Remove 300 Radar on can1' })).toBeTruthy();
    expect(setTraceFilter).not.toHaveBeenCalled();
  });
});
