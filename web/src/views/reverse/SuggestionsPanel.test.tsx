import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CoreApi, MessageSuggestions, Suggestion, SuggestionKind } from '../../core/api';
import { fakeCore, lane, makeRowBatch, message, seriesInfo, signal, summary } from '../../test/fixtures';
import { renderInShell } from '../../test/shell';
import type { LoadedDbc } from '../types';
import { ReverseView } from './ReverseView';

const engine = summary({ id: 0x100, name: 'Engine' });
const first = summary({ id: 0x200 });
const second = summary({ id: 0x201 });
const car: LoadedDbc = { id: 'car', db: { name: 'car.dbc', messages: [message(0x100, 'Engine', { signals: [signal('EngineSpeed')] })] }, channel: null, edited: false };

function suggestion(kind: SuggestionKind, startBit: number, size: number, fields: Partial<Suggestion> = {}): Suggestion {
  return {
    kind,
    spec: { startBit, size, byteOrder: 'intel', signed: false, factor: 1, offset: 0 },
    confidence: 0.67,
    level: 'medium',
    reason: 'Switches 5 times; set under 1% of the time',
    unconfirmed: false,
    sparkline: { t: [0, 1, 2], v: [1, 0, 0] },
    fit: null,
    ...fields,
  };
}

const found = (key: number, suggestions: Suggestion[]): MessageSuggestions => ({ key, frames: 692, sampledFrames: 692, suggestions });
const flag = suggestion('flag', 12, 1);
const speed = suggestion('continuous', 16, 16, { confidence: 0.9, level: 'high', reason: 'Changes smoothly' });
// Motorola from bit 3 runs 3-0 of byte 0, then 15-12 of byte 1.
const motorola = suggestion('enum', 3, 8, { spec: { startBit: 3, size: 8, byteOrder: 'motorola', signed: false, factor: 1, offset: 0 }, level: 'low', confidence: 0.57 });

type Progress = (done: number, total: number, latest: MessageSuggestions | null) => void;

function discoveryCore(overrides: Partial<CoreApi> = {}) {
  const scan = { keys: [] as number[], progress: (() => {}) as Progress, finish: () => {} };
  const core = fakeCore({
    byteLanes: async (_key, _first, count, t0, t1) => Array.from({ length: count }, () => lane([1, 2, 3], t0, t1)),
    bitFlips: async () => new Uint32Array(64),
    bitFlipsBetween: async () => new Uint32Array(64),
    rowCountBetween: async () => 5,
    rowAtTime: async () => 1,
    rows: async (key, start) => makeRowBatch(key, start, [{ t: 0, id: 0x200, index: 0, data: [4, 0x80, 0xbb, 0x14, 0xff, 0xff, 0xff, 0xff] }]),
    rowBytes: async () => new Uint16Array(0),
    changeActivity: async () => new Uint32Array(0),
    decodeRaw: vi.fn(async () => seriesInfo(1, 'raw')),
    seriesView: async () => [Float64Array.of(40, 70), Float64Array.of(0, 1)],
    scanSignals: (keys, _hints, onProgress) =>
      new Promise((resolve) => {
        Object.assign(scan, { keys, progress: onProgress, finish: () => resolve([]) });
      }),
    suggestSignals: vi.fn(async (key: number) => found(key, [])),
    ...overrides,
  });
  return { core, scan };
}

/** Byte Values with 200 selected, its scan run to the end with these suggestions. */
async function openByteValues(suggestions: Suggestion[], others: Suggestion[] = []) {
  const { core, scan } = discoveryCore();
  const shell = renderInShell(ReverseView, { core, ids: [engine, first, second], dbcs: [car], selected: first.key });
  await screen.findByRole('complementary', { name: 'Suggested signals' });
  expect(scan.keys).toEqual([first.key, second.key]);
  act(() => {
    scan.progress(1, 2, found(first.key, suggestions));
    scan.progress(2, 2, found(second.key, others));
    scan.finish();
  });
  await waitFor(() => expect(within(panel()).queryByRole('progressbar')).toBeNull());
  return { ...shell, core };
}

const panel = () => screen.getByRole('complementary', { name: 'Suggested signals' });
const card = (n: number) => within(panel()).getByRole('button', { name: new RegExp(`^${n}\\. `) });
const cell = (id: string, byte: number) => screen.getByRole('button', { name: new RegExp(`^${id} byte ${byte}\\b`) });
/** The bytes of `id` outlined for suggestion `n`. */
const outlined = (id: string, n: number) =>
  Array.from({ length: 8 }, (_, byte) => byte).filter((byte) => cell(id, byte).getAttribute('aria-label')!.endsWith(`, suggestion ${n}`));

describe('Suggested signals on Byte Values', () => {
  it('lists the selected message\'s suggestions beside the matrix, and the toggle hides and restores them', async () => {
    const { user, state } = await openByteValues([flag, speed]);
    expect(within(panel()).getByText('2 suggestions \u00b7 from 692 frames')).toBeTruthy();
    expect(within(panel()).getByText('Suggestions are guesses. Check them against the log before accepting.')).toBeTruthy();
    expect(within(panel()).getByText('Plot it adds the candidate to pinned references.')).toBeTruthy();
    expect(card(1).textContent).toContain('bit 12 \u00b7 Intel \u00b7 unsigned');
    expect(card(1).textContent).toContain('Medium \u00b7 67%');
    // The matrix stays in view beside it.
    expect(screen.getByRole('table')).toBeTruthy();

    const toggle = screen.getByRole('switch', { name: 'Suggested signals \u00b7 2' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    await user.click(toggle);
    expect(screen.queryByRole('complementary', { name: 'Suggested signals' })).toBeNull();
    expect(state.viewState.get('re.suggestionsOpen')?.value).toBe(false);

    // Kept through a visit to Advanced.
    await user.click(screen.getByRole('tab', { name: 'Advanced' }));
    await user.click(screen.getByRole('tab', { name: 'Byte Values' }));
    expect(screen.queryByRole('complementary', { name: 'Suggested signals' })).toBeNull();

    await user.click(screen.getByRole('switch', { name: /^Suggested signals/ }));
    expect(await screen.findByRole('complementary', { name: 'Suggested signals' })).toBeTruthy();

    await user.click(within(panel()).getByRole('button', { name: 'Hide Suggested signals' }));
    expect(screen.queryByRole('complementary', { name: 'Suggested signals' })).toBeNull();
  });

  it('switches to the suggestions of every message and picks the most promising', async () => {
    const { user, state } = await openByteValues([flag], [speed, motorola]);
    expect(within(panel()).getByText('3 suggestions across 2 messages')).toBeTruthy();
    expect(within(panel()).queryByText('Changes smoothly.')).toBeNull();

    await user.click(within(panel()).getByRole('radio', { name: 'All messages' }));
    const groups = within(panel()).getAllByRole('button', { name: /suggestions?$/ });
    expect(groups.map((g) => g.textContent)).toEqual(['201Unknowncan02 suggestions', '200Unknowncan01 suggestion']);
    expect(within(panel()).getByText('Changes smoothly.')).toBeTruthy();

    await user.click(within(panel()).getByRole('button', { name: 'Most promising: 201' }));
    expect(state.selected).toBe(second.key);
    await user.click(within(panel()).getByRole('radio', { name: 'Selected message' }));
    expect(within(panel()).getByText('2 suggestions \u00b7 from 692 frames')).toBeTruthy();
  });

  it('outlines the bytes of the selected suggestion in its message row', async () => {
    const { user } = await openByteValues([flag, speed, motorola]);
    expect(outlined('200', 1)).toEqual([]);

    await user.click(card(1));
    expect(card(1).getAttribute('aria-pressed')).toBe('true');
    expect(outlined('200', 1)).toEqual([1]);
    expect(within(card(1).closest('li')!).getByText('Highlights Byte 1 in the table.')).toBeTruthy();
    expect(screen.getByText('200 \u00b7 Byte 1 \u00b7 bit 12')).toBeTruthy();
    const head = screen.getAllByRole('rowheader').find((h) => h.textContent?.startsWith('200'))!;
    expect(within(head).getByRole('button').getAttribute('aria-pressed')).toBe('true');
    // Only the selected card's Accept is the amber primary.
    expect(within(card(1).closest('li')!).getByRole('button', { name: 'Accept suggestion 1' }).className).toBe('primary');
    expect(within(card(2).closest('li')!).getByRole('button', { name: 'Accept suggestion 2' }).className).toBe('button');

    await user.click(card(2));
    expect(outlined('200', 1)).toEqual([]);
    expect(outlined('200', 2)).toEqual([2, 3]);
    expect(screen.getByText('200 \u00b7 Bytes 2-3 \u00b7 bits 16-31')).toBeTruthy();

    await user.click(card(3));
    expect(outlined('200', 3)).toEqual([0, 1]);
    expect(screen.getByText('200 \u00b7 Bytes 0-1 \u00b7 3|8@0+')).toBeTruthy();
    // No other row is outlined.
    expect(Array.from({ length: 8 }, (_, b) => cell('201', b).getAttribute('aria-label')).some((l) => l!.includes('suggestion'))).toBe(false);
  });

  it('moves between the cards with the arrow keys and selects with Enter', async () => {
    const { user } = await openByteValues([flag, speed, motorola]);
    card(1).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(card(2));
    await user.keyboard('{ArrowDown}{ArrowUp}');
    expect(document.activeElement).toBe(card(2));
    await user.keyboard('{Enter}');
    expect(card(2).getAttribute('aria-pressed')).toBe('true');
    expect(outlined('200', 2)).toEqual([2, 3]);
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(document.activeElement).toBe(card(1));
  });

  it('plots a suggestion as a pinned reference, decoded from its bits, and unpins it', async () => {
    const { user, core } = await openByteValues([flag, speed]);
    await user.click(within(panel()).getByRole('button', { name: 'Plot it: suggestion 2' }));
    expect(await screen.findByRole('button', { name: 'Unpin 200 \u00b7 Suggested continuous value' })).toBeTruthy();
    expect(core.decodeRaw).toHaveBeenCalledWith(first.key, speed.spec);
    expect(within(panel()).getByRole('button', { name: 'Plot it: suggestion 2' }).getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'Unpin 200 \u00b7 Suggested continuous value' }));
    expect(screen.queryByRole('button', { name: 'Unpin 200 \u00b7 Suggested continuous value' })).toBeNull();
    expect(within(panel()).getByRole('button', { name: 'Plot it: suggestion 2' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('opens the selected suggestion\'s bits in Advanced', async () => {
    const { user } = await openByteValues([flag, speed]);
    await user.click(card(2));
    await user.click(screen.getByRole('button', { name: 'Open in Advanced' }));
    expect(screen.getByRole('tab', { name: 'Advanced' }).getAttribute('aria-selected')).toBe('true');
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect((within(inspector).getByRole('spinbutton', { name: 'Start bit' }) as HTMLInputElement).value).toBe('16');
    expect((within(inspector).getByRole('spinbutton', { name: 'Length' }) as HTMLInputElement).value).toBe('16');
    const list = await screen.findByRole('region', { name: 'Suggested signals' });
    expect(within(list).getByRole('button', { name: /^2\. / }).getAttribute('aria-pressed')).toBe('true');
  });

  it('carries a byte picked after the suggestion into Advanced instead', async () => {
    const { user } = await openByteValues([flag, speed]);
    await user.click(card(2));
    await user.click(cell('200', 5));
    expect(screen.getByText('200 \u00b7 Byte 5')).toBeTruthy();
    expect(outlined('200', 2)).toEqual([2, 3]);
    await user.click(screen.getByRole('button', { name: 'Open in Advanced' }));
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    expect((within(inspector).getByRole('spinbutton', { name: 'Start bit' }) as HTMLInputElement).value).toBe('40');
  });

  it('accepts through the New Signal form in Advanced, and dismisses', async () => {
    const { user } = await openByteValues([flag, speed]);
    await user.click(within(panel()).getByRole('button', { name: 'Dismiss suggestion 1' }));
    expect(within(panel()).queryByRole('button', { name: /^1\. / })).toBeNull();
    expect(screen.getByRole('switch', { name: 'Suggested signals \u00b7 1' })).toBeTruthy();

    await user.click(within(panel()).getByRole('button', { name: 'Accept suggestion 2' }));
    expect(screen.getByRole('tab', { name: 'Advanced' }).getAttribute('aria-selected')).toBe('true');
    const inspector = screen.getByRole('complementary', { name: 'Inspector' });
    const name = within(inspector).getByRole('textbox', { name: 'Name' }) as HTMLInputElement;
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(name.value).toBe('Value_16');
    expect((within(inspector).getByRole('spinbutton', { name: 'Start bit' }) as HTMLInputElement).value).toBe('16');
  });
});
