import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreApi, DiscoveryHints, MessageSuggestions, Suggestion, SuggestionKind } from '../../core/api';
import { fakeCore, lane, makeRowBatch, message, seriesInfo, signal, summary } from '../../test/fixtures';
import { renderInShell } from '../../test/shell';
import type { LoadedDbc } from '../types';
import { ReverseView } from './ReverseView';
import { isAcceptedSignal, parseMarker } from './Suggestions';

const engine = summary({ id: 0x100, name: 'Engine' });
const first = summary({ id: 0x200 });
const second = summary({ id: 0x201 });
const car: LoadedDbc = { id: 'car', db: { name: 'car.dbc', messages: [message(0x100, 'Engine', { signals: [signal('EngineSpeed')] })] }, channel: null, edited: false };

function suggestion(kind: SuggestionKind, startBit: number, size: number, fields: Partial<Suggestion> = {}): Suggestion {
  return {
    kind,
    spec: { startBit, size, byteOrder: 'intel', signed: false, factor: 1, offset: 0 },
    confidence: 0.9,
    level: 'high',
    reason: 'Increments by 1 each frame; wraps at 255',
    unconfirmed: false,
    sparkline: { t: [0, 1, 2], v: [0, 1, 2] },
    fit: null,
    ...fields,
  };
}

const found = (key: number, suggestions: Suggestion[]): MessageSuggestions => ({ key, frames: 100, sampledFrames: 100, suggestions });
const counter = suggestion('counter', 0, 8);
const speed = suggestion('continuous', 16, 16, { confidence: 0.7, level: 'medium', reason: 'Changes smoothly; 300 values from 0 to 11799' });

type Progress = (done: number, total: number, latest: MessageSuggestions | null) => void;

/** A core whose scan is driven by the test: `scan.progress` reports a message, `scan.finish` ends it. */
function discoveryCore(overrides: Partial<CoreApi> = {}) {
  const scan = {
    keys: [] as number[],
    signal: undefined as AbortSignal | undefined,
    progress: (() => {}) as Progress,
    skip: undefined as ((key: number) => boolean) | undefined,
    finish: () => {},
    fail: (_e: unknown) => {},
  };
  const core = fakeCore({
    byteLanes: async (_key, _first, count, t0, t1) => Array.from({ length: count }, () => lane([1, 2, 3], t0, t1)),
    bitFlips: async () => new Uint32Array(64),
    bitFlipsBetween: async () => new Uint32Array(64),
    rowCountBetween: async () => 5,
    rowAtTime: async () => 1,
    rows: async (key, start) => makeRowBatch(key, start, [{ t: 0, id: 0x200, index: 0, data: [1, 2, 3, 4, 5, 6, 7, 8] }]),
    rowBytes: async () => new Uint16Array(0),
    changeActivity: async () => new Uint32Array(0),
    decodeRaw: async () => seriesInfo(1, 'raw'),
    seriesView: async () => [Float64Array.of(40, 70), Float64Array.of(0, 1)],
    scanSignals: (keys, _hints, onProgress, signal, skip) =>
      new Promise((resolve, reject) => {
        Object.assign(scan, { keys, signal, skip, progress: onProgress, finish: () => resolve([]), fail: reject });
      }),
    suggestSignals: vi.fn(async (key: number) => found(key, [])),
    ...overrides,
  });
  return { core, scan };
}

async function openAdvanced(core: CoreApi, selected = first.key, capturing = false) {
  const shell = renderInShell(ReverseView, { core, ids: [engine, first, second], dbcs: [car], selected, capturing });
  await shell.user.click(screen.getByRole('tab', { name: 'Advanced' }));
  // The panel is loaded on first use.
  await screen.findByRole('region', { name: 'Suggested signals' });
  return shell;
}

const panel = () => screen.getByRole('region', { name: 'Suggested signals' });
const row = (n: number) => within(panel()).getByRole('button', { name: new RegExp(`^${n}\\. `) }).closest('li')!;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Suggested signals', () => {
  it('scans the unknown messages, the open one first, then lists what it found with the overview', async () => {
    const { core, scan } = discoveryCore();
    const { user, state } = await openAdvanced(core, second.key);

    expect(within(panel()).getByText('Suggestions are guesses. Check them against the log before accepting.')).toBeTruthy();
    expect(within(panel()).getByText(/^Scanning 2 messages/).textContent).toBe('Scanning 2 messages\u2026 0 of 2');
    expect(within(panel()).getByRole('progressbar', { name: 'Scan progress' }).getAttribute('aria-valuenow')).toBe('0');
    expect(scan.keys).toEqual([second.key, first.key]);

    act(() => scan.progress(1, 2, found(second.key, [counter])));
    expect(within(panel()).getByText(/^Scanning 2 messages/).textContent).toBe('Scanning 2 messages\u2026 1 of 2');
    expect(within(row(1)).getByText('Counter')).toBeTruthy();
    expect(within(row(1)).getByText('bits 0-7 \u00b7 Intel \u00b7 unsigned')).toBeTruthy();
    expect(within(row(1)).getByText('High \u00b7 90%')).toBeTruthy();
    expect(within(row(1)).getByText('Increments by 1 each frame; wraps at 255.')).toBeTruthy();

    act(() => {
      scan.progress(2, 2, found(first.key, [counter, speed]));
      scan.finish();
    });
    await waitFor(() => expect(within(panel()).queryByRole('progressbar')).toBeNull());
    expect(within(panel()).getByText('3 suggestions across 2 messages')).toBeTruthy();

    await user.click(within(panel()).getByRole('button', { name: 'Most promising: 200' }));
    expect(state.selected).toBe(first.key);
    expect(await within(panel()).findByText('Continuous value')).toBeTruthy();
  });

  it('waits for a live capture to stop before suggesting', async () => {
    const { core, scan } = discoveryCore();
    await openAdvanced(core, first.key, true);
    expect(within(panel()).getByText('Suggestions are made once the capture stops.')).toBeTruthy();
    expect(scan.keys).toEqual([]);
    expect(core.suggestSignals).not.toHaveBeenCalled();
  });

  it('suggests for a message opened during the scan at once, which the scan then passes over', async () => {
    const { core, scan } = discoveryCore({ suggestSignals: vi.fn(async (key: number) => found(key, [speed])) });
    const { user } = await openAdvanced(core);
    expect(scan.keys).toEqual([first.key, second.key]);

    await user.click(screen.getByRole('tab', { name: 'Byte Values' }));
    const head = screen.getAllByRole('rowheader').find((h) => h.textContent?.includes('201'))!;
    await user.click(within(head).getByRole('button'));
    await user.click(screen.getByRole('tab', { name: 'Advanced' }));
    expect(await within(panel()).findByText('Continuous value')).toBeTruthy();
    expect(core.suggestSignals).toHaveBeenCalledWith(second.key, { markers: [], reference: null });
    expect(scan.skip?.(second.key)).toBe(true);
    expect(within(panel()).getByRole('progressbar', { name: 'Scan progress' })).toBeTruthy();
  });

  it('counts in the overview only the suggestions it lists, not those over bits a DBC describes', async () => {
    const { core } = discoveryCore({ suggestSignals: vi.fn(async (key: number) => found(key, [counter, speed])) });
    await openAdvanced(core, engine.key);
    // EngineSpeed covers the counter's bits 0-7.
    expect(await within(panel()).findByText('Continuous value')).toBeTruthy();
    expect(within(panel()).queryByText('Counter')).toBeNull();
    expect(within(panel()).getByText('1 suggestion across 1 message')).toBeTruthy();
  });

  it('keeps the open message suggested for when the scan is cancelled as it finishes it', async () => {
    const suggestSignals = vi.fn(async (key: number) => found(key, [speed]));
    const { core, scan } = discoveryCore({ suggestSignals });
    const { user } = await openAdvanced(core);
    expect(scan.keys[0]).toBe(first.key);

    await user.click(within(panel()).getByRole('button', { name: 'Cancel' }));
    act(() => {
      scan.progress(1, 2, found(first.key, [counter]));
      scan.fail(new DOMException('The scan was cancelled.', 'AbortError'));
    });
    expect(await within(panel()).findByText('Counter')).toBeTruthy();
    expect(within(panel()).queryByText('Not scanned yet.')).toBeNull();
    expect(suggestSignals).not.toHaveBeenCalled();
  });

  it('suggests for the open message on its own when the scan is cancelled part way through it', async () => {
    const suggestSignals = vi.fn(async (key: number) => found(key, [counter]));
    const { core, scan } = discoveryCore({ suggestSignals });
    const { user } = await openAdvanced(core);
    expect(scan.keys[0]).toBe(first.key);

    await user.click(within(panel()).getByRole('button', { name: 'Cancel' }));
    act(() => scan.fail(new DOMException('The scan was cancelled.', 'AbortError')));
    expect(await within(panel()).findByText('Counter')).toBeTruthy();
    expect(within(panel()).queryByText('Not scanned yet.')).toBeNull();
    expect(suggestSignals).toHaveBeenCalledTimes(1);
    expect(suggestSignals).toHaveBeenCalledWith(first.key, { markers: [], reference: null });
  });

  it('does not ask again for the open message at the end of the scan when a hint already did', async () => {
    const suggestSignals = vi.fn(() => new Promise<MessageSuggestions>(() => {}));
    const { core, scan } = discoveryCore({ suggestSignals });
    const { user } = await openAdvanced(core);
    expect(scan.keys[0]).toBe(first.key);

    await user.click(within(panel()).getByRole('button', { name: 'Add a hint\u2026' }));
    await user.type(within(panel()).getByRole('textbox', { name: 'Something happened at' }), '12 s{Enter}');
    expect(suggestSignals).toHaveBeenCalledTimes(1);

    await user.click(within(panel()).getByRole('button', { name: 'Cancel' }));
    act(() => scan.fail(new DOMException('The scan was cancelled.', 'AbortError')));
    await waitFor(() => expect(within(panel()).queryByRole('progressbar')).toBeNull());
    expect(suggestSignals).toHaveBeenCalledTimes(1);
  });

  it('stops the scan on Cancel and offers to scan the rest', async () => {
    const { core, scan } = discoveryCore();
    const { user } = await openAdvanced(core);
    act(() => scan.progress(1, 2, found(first.key, [counter])));

    await user.click(within(panel()).getByRole('button', { name: 'Cancel' }));
    expect(scan.signal?.aborted).toBe(true);
    act(() => scan.fail(new DOMException('The scan was cancelled.', 'AbortError')));

    expect(await within(panel()).findByRole('button', { name: 'Scan the rest' })).toBeTruthy();
    expect(within(panel()).getByText(/1 unknown not scanned/)).toBeTruthy();
    expect(within(row(1)).getByText('Counter')).toBeTruthy();
  });

  it('says when it found nothing, and scans again or takes a hint', async () => {
    const { core, scan } = discoveryCore();
    const { user } = await openAdvanced(core);
    act(() => {
      scan.progress(1, 2, found(first.key, []));
      scan.progress(2, 2, found(second.key, []));
      scan.finish();
    });

    expect(await within(panel()).findByText('No suggestions for this message')).toBeTruthy();
    expect(within(panel()).getByText('Try a longer log, or add an event hint.')).toBeTruthy();

    await user.click(within(panel()).getByRole('button', { name: 'Scan again' }));
    expect(core.suggestSignals).toHaveBeenLastCalledWith(first.key, { markers: [], reference: null });

    await user.click(within(panel()).getByRole('button', { name: 'Add hint' }));
    const event = within(panel()).getByRole('textbox', { name: 'Something happened at' });
    await waitFor(() => expect(document.activeElement).toBe(event));
    await user.type(event, 'I pressed the brake at 12.5 s{Enter}');
    expect(core.suggestSignals).toHaveBeenLastCalledWith(first.key, { markers: [{ t: 12.5 }], reference: null } satisfies DiscoveryHints);
    expect(within(panel()).getByRole('button', { name: 'Remove the marker at 12.5 s' })).toBeTruthy();
  });

  it('fits a scale to a reference signal', async () => {
    const fitted = suggestion('continuous', 16, 16, {
      spec: { startBit: 16, size: 16, byteOrder: 'intel', signed: false, factor: 0.01, offset: 0 },
      fit: { reference: 'EngineSpeed', unit: 'rpm', r: 0.99, factor: 0.01, offset: 0 },
    });
    const { core, scan } = discoveryCore({ suggestSignals: vi.fn(async (key: number) => found(key, [fitted])) });
    const { user } = await openAdvanced(core);
    act(() => scan.progress(1, 2, found(first.key, [speed])));

    await user.click(within(panel()).getByRole('button', { name: 'Add a hint\u2026' }));
    await user.selectOptions(within(panel()).getByRole('combobox', { name: 'Compare with' }), 'Engine.EngineSpeed');
    await user.click(within(panel()).getByRole('button', { name: 'Fit scale' }));
    expect(core.suggestSignals).toHaveBeenLastCalledWith(first.key, { markers: [], reference: { key: engine.key, signal: 'EngineSpeed' } });
    expect(await within(panel()).findByText('Fitted to EngineSpeed: factor 0.01, offset 0 (rpm).')).toBeTruthy();
  });

  it('accepts a suggestion through the New Signal form, and undoes it', async () => {
    const { core, scan } = discoveryCore();
    const { user, state } = await openAdvanced(core);
    act(() => {
      scan.progress(1, 2, found(first.key, [counter, speed]));
      scan.progress(2, 2, found(second.key, []));
      scan.finish();
    });
    await waitFor(() => expect(within(panel()).queryByRole('progressbar')).toBeNull());

    await user.click(within(row(2)).getByRole('button', { name: 'Accept suggestion 2' }));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    const name = within(inspector).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(name.value).toBe('Value_16');
    expect((within(inspector).getByRole('spinbutton', { name: 'Start bit' }) as HTMLInputElement).value).toBe('16');
    expect((within(inspector).getByRole('spinbutton', { name: 'Length' }) as HTMLInputElement).value).toBe('16');
    expect(within(row(2)).getByRole('button', { name: /^2\. / }).getAttribute('aria-pressed')).toBe('true');

    await user.clear(name);
    await user.type(name, 'VehicleSpeed');
    await user.click(within(inspector).getByRole('button', { name: 'Add to Database' }));
    await waitFor(() => expect(within(row(2)).getByRole('status').textContent).toBe('Accepted \u00b7 VehicleSpeed'));
    expect(state.dbcs[0].db.messages.find((m) => m.id === 0x200)?.signals.map((s) => s.name)).toEqual(['VehicleSpeed']);
    // The message is no longer unknown, but its suggestions still count.
    expect(within(panel()).getByText('2 suggestions across 1 message')).toBeTruthy();

    await user.click(within(row(2)).getByRole('button', { name: 'Review in Database' }));
    expect(state.view).toBe('database');

    await user.click(within(row(2)).getByRole('button', { name: 'Undo VehicleSpeed' }));
    await waitFor(() => expect(document.activeElement).toBe(within(row(2)).getByRole('button', { name: 'Accept suggestion 2' })));
    expect(state.dbcs[0].db.messages.map((m) => m.id)).toEqual([0x100]);
  });

  it('accepts a multiplexor and then its page cells into the DBC multiplexing', async () => {
    const selector = { startBit: 0, size: 8, byteOrder: 'intel' as const };
    const mux = suggestion('multiplexor', 0, 8, { reason: 'Selects which of 2 pages bytes 1-2 carry' });
    const cell = (value: number) =>
      suggestion('continuous', 8, 16, { spec: { startBit: 8, size: 16, byteOrder: 'intel', signed: false, factor: 1, offset: 0, mux: { ...selector, value } } });
    const decodeRaw = vi.fn(async () => seriesInfo(1, 'raw'));
    const { core, scan } = discoveryCore({ decodeRaw });
    const { user, state } = await openAdvanced(core);
    act(() => {
      scan.progress(1, 2, found(first.key, [mux, cell(0), cell(1)]));
      scan.progress(2, 2, found(second.key, []));
      scan.finish();
    });
    await waitFor(() => expect(within(panel()).queryByRole('progressbar')).toBeNull());
    expect(within(row(3)).getByRole('button', { name: /^3\. Continuous value, bits 8-23 \u00b7 Intel \u00b7 unsigned \u00b7 page m1,/ })).toBeTruthy();

    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    const name = within(inspector).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    const add = () => user.click(within(inspector).getByRole('button', { name: 'Add to Database' }));

    // A cell needs its multiplexor in the message first.
    await user.click(within(row(2)).getByRole('button', { name: 'Accept suggestion 2' }));
    await waitFor(() => expect(name.value).toBe('Value_8_m0'));
    expect(within(inspector).getByText('Add the multiplexor at 0|8@1+ first; this signal is on its page m0.')).toBeTruthy();
    await waitFor(() => expect(decodeRaw).toHaveBeenLastCalledWith(first.key, expect.objectContaining({ startBit: 8, mux: { ...selector, value: 0 } })));
    await add();
    expect(state.dbcs[0].db.messages.some((m) => m.id === 0x200)).toBe(false);

    await user.click(within(row(1)).getByRole('button', { name: 'Accept suggestion 1' }));
    await waitFor(() => expect(name.value).toBe('Mux'));
    await add();
    await waitFor(() => expect(within(row(1)).getByRole('status').textContent).toBe('Accepted \u00b7 Mux'));

    for (const n of [2, 3]) {
      await user.click(within(row(n)).getByRole('button', { name: `Accept suggestion ${n}` }));
      await waitFor(() => expect(name.value).toBe(`Value_8_m${n - 2}`));
      await add();
      await waitFor(() => expect(within(row(n)).getByRole('status').textContent).toBe(`Accepted \u00b7 Value_8_m${n - 2}`));
    }
    const signals = () => state.dbcs[0].db.messages.find((m) => m.id === 0x200)?.signals ?? [];
    expect(signals().map((s) => [s.name, s.isMultiplexor, s.muxValue])).toEqual([
      ['Mux', true, null],
      ['Value_8_m0', false, 0],
      ['Value_8_m1', false, 1],
    ]);

    // Undoing the multiplexor would leave its pages switched by nothing.
    await user.click(within(row(1)).getByRole('button', { name: 'Undo Mux' }));
    expect((await screen.findByRole('alert')).textContent).toBe("Couldn't undo Mux: Value_8_m0 and Value_8_m1 are on its pages. Undo or remove them first.");
    expect(signals().map((s) => s.name)).toEqual(['Mux', 'Value_8_m0', 'Value_8_m1']);
    expect(within(row(1)).getByRole('status').textContent).toBe('Accepted \u00b7 Mux');

    for (const n of [3, 2]) {
      await user.click(within(row(n)).getByRole('button', { name: `Undo Value_8_m${n - 2}` }));
      await waitFor(() => expect(within(row(n)).getByRole('button', { name: `Accept suggestion ${n}` })).toBeTruthy());
    }
    await user.click(within(row(1)).getByRole('button', { name: 'Undo Mux' }));
    await waitFor(() => expect(state.dbcs[0].db.messages.map((m) => m.id)).toEqual([0x100]));
  });

  it('puts a page signal on its own multiplexor when the message nests them', async () => {
    const inner = { startBit: 8, size: 4, byteOrder: 'intel' as const };
    const nested: LoadedDbc = {
      ...car,
      db: {
        ...car.db,
        messages: [
          ...car.db.messages,
          message(0x200, 'Paged', {
            signals: [signal('Outer', { isMultiplexor: true }), signal('Inner', { ...inner, isMultiplexor: true, muxValue: 1, muxSwitch: { signal: 'Outer', ranges: [[1, 1]] } })],
          }),
        ],
      },
    };
    const cell = suggestion('continuous', 16, 16, { spec: { startBit: 16, size: 16, byteOrder: 'intel', signed: false, factor: 1, offset: 0, mux: { ...inner, value: 2 } } });
    const { core, scan } = discoveryCore({ suggestSignals: vi.fn(async (key: number) => found(key, [cell])) });
    const shell = renderInShell(ReverseView, { core, ids: [engine, first, second], dbcs: [nested], selected: first.key, capturing: false });
    await shell.user.click(screen.getByRole('tab', { name: 'Advanced' }));
    await screen.findByRole('region', { name: 'Suggested signals' });
    act(() => scan.finish());
    await shell.user.click(await within(panel()).findByRole('button', { name: 'Accept suggestion 1' }));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    await waitFor(() => expect((within(inspector).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Value_16_m2'));
    expect(within(inspector).getByText('On page m2 of the multiplexor at 8|4@1+.')).toBeTruthy();
    await shell.user.click(within(inspector).getByRole('button', { name: 'Add to Database' }));
    await waitFor(() => expect(within(row(1)).getByRole('status').textContent).toBe('Accepted \u00b7 Value_16_m2'));
    const added = shell.state.dbcs[0].db.messages.find((m) => m.id === 0x200)?.signals[2];
    expect([added?.muxValue, added?.muxSwitch]).toEqual([2, { signal: 'Inner', ranges: [[2, 2]] }]);
  });

  it('names the top-level multiplexor of a page signal when a nested one is listed first', async () => {
    const outer = { startBit: 0, size: 8, byteOrder: 'intel' as const };
    const nested: LoadedDbc = {
      ...car,
      db: {
        ...car.db,
        messages: [
          ...car.db.messages,
          message(0x200, 'Paged', {
            signals: [
              signal('Inner', { startBit: 8, size: 4, isMultiplexor: true, muxValue: 1, muxSwitch: { signal: 'Outer', ranges: [[1, 1]] } }),
              signal('Outer', { ...outer, isMultiplexor: true }),
            ],
          }),
        ],
      },
    };
    const cell = suggestion('continuous', 16, 16, { spec: { startBit: 16, size: 16, byteOrder: 'intel', signed: false, factor: 1, offset: 0, mux: { ...outer, value: 3 } } });
    const { core, scan } = discoveryCore({ suggestSignals: vi.fn(async (key: number) => found(key, [cell])) });
    const shell = renderInShell(ReverseView, { core, ids: [engine, first, second], dbcs: [nested], selected: first.key, capturing: false });
    await shell.user.click(screen.getByRole('tab', { name: 'Advanced' }));
    await screen.findByRole('region', { name: 'Suggested signals' });
    act(() => scan.finish());
    await shell.user.click(await within(panel()).findByRole('button', { name: 'Accept suggestion 1' }));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    await waitFor(() => expect((within(inspector).getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Value_16_m3'));
    await shell.user.click(within(inspector).getByRole('button', { name: 'Add to Database' }));
    await waitFor(() => expect(within(row(1)).getByRole('status').textContent).toBe('Accepted \u00b7 Value_16_m3'));
    const added = shell.state.dbcs[0].db.messages.find((m) => m.id === 0x200)?.signals[2];
    expect([added?.muxValue, added?.muxSwitch]).toEqual([3, { signal: 'Outer', ranges: [[3, 3]] }]);
  });

  it('dismisses a suggestion and brings it back', async () => {
    const { core, scan } = discoveryCore();
    const { user } = await openAdvanced(core);
    act(() => scan.progress(1, 2, found(first.key, [counter, speed])));

    await user.click(within(row(1)).getByRole('button', { name: 'Dismiss suggestion 1' }));
    expect(within(panel()).queryByRole('button', { name: /^1\. / })).toBeNull();
    expect(within(row(2)).getByText('Continuous value')).toBeTruthy();
    await user.click(within(panel()).getByRole('button', { name: 'Show 1 dismissed' }));
    expect(within(row(1)).getByText('Dismissed')).toBeTruthy();
    await user.click(within(row(1)).getByRole('button', { name: 'Restore suggestion 1' }));
    expect(within(row(1)).queryByText('Dismissed')).toBeNull();
    expect(within(panel()).queryByRole('button', { name: /Show .* dismissed/ })).toBeNull();
  });

  it('plots a suggestion as a pinned reference', async () => {
    const { core, scan } = discoveryCore();
    const { user } = await openAdvanced(core);
    act(() => scan.progress(1, 2, found(first.key, [counter])));

    const plot = within(row(1)).getByRole('button', { name: 'Plot it: suggestion 1' });
    await user.click(plot);
    expect(plot.getAttribute('aria-pressed')).toBe('true');
    expect(await screen.findByRole('button', { name: 'Unpin 200 \u00b7 Suggested counter' })).toBeTruthy();
    await user.click(plot);
    expect(screen.queryByRole('button', { name: 'Unpin 200 \u00b7 Suggested counter' })).toBeNull();
  });

  it('keeps the list and the bit grid in step, by pointer and by keyboard', async () => {
    // The grid draws only once it knows its width.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {}
        observe() {
          this.callback([{ contentRect: { width: 400 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
      },
    );
    const widths: number[] = [];
    const getContext = HTMLCanvasElement.prototype.getContext;
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, ...args: Parameters<typeof getContext>) {
      const g = getContext.apply(this, args) as CanvasRenderingContext2D;
      return new Proxy(g, {
        set(target, prop, value) {
          if (prop === 'lineWidth') widths.push(value);
          return Reflect.set(target, prop, value);
        },
      }) as never;
    });
    const { core, scan } = discoveryCore();
    const { user } = await openAdvanced(core);
    act(() => scan.progress(1, 2, found(first.key, [counter, speed])));
    const grid = await screen.findByRole('application', { name: /^Bit activity/ });

    // Hovering a suggestion draws its outline heavier.
    widths.length = 0;
    await user.hover(row(2));
    expect(row(2).hasAttribute('data-active')).toBe(true);
    await waitFor(() => expect(widths).toContain(3));
    await user.unhover(row(2));

    // Moving onto a suggestion's bits marks it in the list; Enter selects it.
    grid.focus();
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    await waitFor(() => expect(row(2).hasAttribute('data-active')).toBe(true));
    expect(row(1).hasAttribute('data-active')).toBe(false);
    expect(within(grid).getByText(/Suggestion 2, Continuous value; Enter selects it\./)).toBeTruthy();
    fireEvent.keyDown(grid, { key: 'Enter' });
    await waitFor(() => expect(within(row(2)).getByRole('button', { name: /^2\. / }).getAttribute('aria-pressed')).toBe('true'));

    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    fireEvent.keyDown(grid, { key: 'ArrowUp' });
    await waitFor(() => expect(row(1).hasAttribute('data-active')).toBe(true));
    fireEvent.blur(grid);
    await waitFor(() => expect(row(1).hasAttribute('data-active')).toBe(false));
  });

  it('reads the time of an event from what was typed', () => {
    expect(parseMarker('12')).toBe(12);
    expect(parseMarker('12.5 s')).toBe(12.5);
    expect(parseMarker('12,5 s')).toBe(12.5);
    expect(parseMarker('12,5s')).toBe(12.5);
    expect(parseMarker('at 12,25s')).toBe(12.25);
    expect(parseMarker('Bremse bei 3,25')).toBe(3.25);
    // A thousands group is too easily misread.
    expect(parseMarker('1,000 s')).toBeNull();
    expect(parseMarker('I pressed the brake at 7 s')).toBe(7);
    expect(parseMarker('brake 2 at 12 s')).toBe(12);
    expect(parseMarker('pedal 3: 45.5 sec')).toBe(45.5);
    expect(parseMarker('soon')).toBeNull();
  });
});

describe('Undo of an accepted suggestion', () => {
  it('takes out only the signal accepted, not another added in its place', () => {
    const id = '512:16:16:intel';
    expect(isAcceptedSignal(signal('VehicleSpeed', { startBit: 16, size: 16 }), id, 'VehicleSpeed')).toBe(true);
    // Deleted, then a new signal of the same name on other bits, or another name on the same bits.
    expect(isAcceptedSignal(signal('VehicleSpeed', { startBit: 0, size: 8 }), id, 'VehicleSpeed')).toBe(false);
    expect(isAcceptedSignal(signal('Speed2', { startBit: 16, size: 16 }), id, 'VehicleSpeed')).toBe(false);
    expect(isAcceptedSignal(signal('VehicleSpeed', { startBit: 16, size: 16, byteOrder: 'motorola' }), id, 'VehicleSpeed')).toBe(false);
  });
});
