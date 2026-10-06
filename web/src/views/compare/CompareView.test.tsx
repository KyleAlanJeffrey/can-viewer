import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ByteComparison, CompareOptions, CoreApi, IdComparison } from '../../core/api';
import { fakeCore, lane, logInfo, makeRowBatch } from '../../test/fixtures';
import { renderInShell } from '../../test/shell';
import { CompareView } from './CompareView';

const session = vi.hoisted(() => ({
  loadSaved: vi.fn(async (): Promise<unknown> => undefined),
  save: vi.fn(async () => true),
  forget: vi.fn(async () => {}),
}));
vi.mock('../../session', () => session);

beforeEach(() => {
  session.loadSaved.mockClear();
  session.save.mockReset().mockResolvedValue(true);
  session.forget.mockClear();
});

const logB = logInfo({ name: 'door-lock.log', durationS: 50 });

function comparison(id: number, fields: Partial<IdComparison> = {}): IdComparison {
  return {
    bus: 'can0',
    id,
    extended: false,
    keyA: id,
    keyB: id,
    presence: 'both',
    name: null,
    framesA: 1000,
    framesB: 500,
    rateA: 10,
    rateB: 10,
    busB: 'can0',
    score: 0,
    reason: 'No significant changes',
    bytes: [],
    tooFewFrames: false,
    changesWithinA: false,
    ...fields,
  };
}

const body = comparison(0x450, { name: 'BODY', score: 100, reason: 'Byte 3 takes new values', bytes: [3] });
const onlyB = comparison(0x7df, { presence: 'onlyB', keyA: null, framesA: 0, rateA: 0, rateB: 1, score: 100, reason: 'Appears only in B' });
const onlyA = comparison(0x456, { presence: 'onlyA', keyB: null, busB: null, framesB: 0, rateB: 0, score: 100, reason: 'Appears only in A' });
const steady = comparison(0x0c1, { score: 3 });
// In the core's order, by score; the table groups them.
const RESULTS = [onlyA, onlyB, body, steady];

function bytes(fields: Partial<ByteComparison> = {}): ByteComparison {
  const byteScores = [0, 0, 0, 100, 0, 0, 0, 0];
  const bitScores = Array.from({ length: 64 }, (_, bit) => (bit === 24 ? 1 : 0));
  return {
    len: 8,
    framesA: 1000,
    framesB: 500,
    flipsA: Array(64).fill(0),
    flipsB: Array(64).fill(0),
    bitScores,
    byteScores,
    byteReasons: byteScores.map((s, k) => (s > 0 ? `Byte ${k} takes new values` : 'No significant changes')),
    newValues: byteScores.map((s) => (s > 0 ? [1] : [])),
    ignored: [],
    ...fields,
  };
}

/** A core that already holds log B and finds `results` between the logs. */
function compareCore(results: IdComparison[] = RESULTS, overrides: Partial<CoreApi> = {}): CoreApi {
  return fakeCore({
    compareLogInfo: async () => logB,
    compareLogs: async () => results,
    compareBytes: async () => bytes(),
    byteLanes: async (_key, _first, count, t0, t1) => Array.from({ length: count }, () => lane([0, 0], t0, t1)),
    compareByteLanes: async (_key, _first, count, t0, t1) => Array.from({ length: count }, () => lane([0, 1], t0, t1)),
    rowAtTime: async () => 1,
    rows: async (key, start) => makeRowBatch(key, start, [{ t: 0, id: 0x450, index: 0, data: [0, 0, 0, 0, 0, 0, 0, 0] }]),
    compareFrameAt: async () => Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 0),
    ...overrides,
  });
}

const fileInputs = () => [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
const groupButton = (name: RegExp) => screen.getByRole('button', { name });

describe('choosing log B', () => {
  it('asks for a second log, with Open log B... as the only primary action', async () => {
    renderInShell(CompareView, { core: fakeCore() });
    expect(await screen.findByText('Choose a second log')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open log B\u2026' }).className).toBe('primary');
    expect(document.querySelectorAll('.cmp .primary')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Swap logs A and B' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('radio', { name: /All messages/ }).closest('fieldset')?.disabled).toBe(true);
  });

  it('reads a picked file as log B and compares the logs', async () => {
    const openCompareLog = vi.fn(async () => logB);
    const compareLogs = vi.fn(async () => RESULTS);
    const core = compareCore(RESULTS, { compareLogInfo: async () => null, openCompareLog, compareLogs });
    const { user } = renderInShell(CompareView, { core });
    await screen.findByText('Choose a second log');

    const file = new File(['(1.0) can0 450#00'], 'door-lock.log');
    await user.upload(fileInputs()[0], file);
    expect(openCompareLog).toHaveBeenCalledWith(file, 'door-lock.log', expect.any(Function));
    expect(await screen.findByRole('region', { name: 'Log B' })).toBeTruthy();
    expect(compareLogs).toHaveBeenCalledWith({ ignoreCounters: true, ignoreChangesWithinA: true });
    expect(await screen.findByRole('row', { name: /^450 BODY/ })).toBeTruthy();
  });

  it('reads a file dropped on the drop zone as log B', async () => {
    const openCompareLog = vi.fn(async () => logB);
    renderInShell(CompareView, { core: compareCore(RESULTS, { compareLogInfo: async () => null, openCompareLog }) });
    const zone = (await screen.findByText('Choose a second log')).closest('.cmp-drop')!;

    const file = new File(['x'], 'door-lock.log');
    fireEvent.drop(zone, { dataTransfer: { files: [file] } });
    await waitFor(() => expect(openCompareLog).toHaveBeenCalledWith(file, 'door-lock.log', expect.any(Function)));
  });

  it('refuses a log without frames and drops it from the core', async () => {
    const closeCompareLog = vi.fn(async () => {});
    const core = compareCore(RESULTS, {
      compareLogInfo: async () => null,
      openCompareLog: async () => logInfo({ name: 'empty.log', frames: 0 }),
      closeCompareLog,
    });
    const { user, state } = renderInShell(CompareView, { core });
    await screen.findByText('Choose a second log');
    await user.upload(fileInputs()[0], new File([''], 'empty.log'));
    await waitFor(() => expect(state.error).toMatch(/empty\.log/));
    expect(closeCompareLog).toHaveBeenCalled();
    expect(screen.getByText('Choose a second log')).toBeTruthy();
  });

  it('shows no log B, and forgets the saved one, when replacing log B fails', async () => {
    let held: typeof logB | null = logB;
    const core = compareCore([steady], {
      compareLogInfo: async () => held,
      openCompareLog: async () => {
        held = null;
        throw new Error('Not a CAN log');
      },
    });
    const { user, state } = renderInShell(CompareView, { core });
    expect(await screen.findByRole('heading', { name: 'These logs look the same' })).toBeTruthy();

    await user.upload(fileInputs()[0], new File(['x'], 'photo.jpg'));
    await waitFor(() => expect(state.error).toBe('Not a CAN log'));
    expect(await screen.findByText('Choose a second log')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'These logs look the same' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Log B' })).toBeNull();
    expect(session.forget).toHaveBeenCalledWith('compare');
  });

  it('forgets a saved log B that no longer reads', async () => {
    session.loadSaved.mockResolvedValueOnce({ name: 'gone.log', blob: new Blob(['x']) });
    const core = compareCore(RESULTS, {
      compareLogInfo: async () => null,
      openCompareLog: async () => {
        throw new Error('Not a CAN log');
      },
    });
    renderInShell(CompareView, { core });
    expect(await screen.findByText('Choose a second log')).toBeTruthy();
    await waitFor(() => expect(session.forget).toHaveBeenCalledWith('compare'));
  });

  it('forgets the saved log B when this browser could not keep the new one', async () => {
    session.save.mockResolvedValue(false);
    const core = compareCore(RESULTS, { compareLogInfo: async () => null, openCompareLog: async () => logB });
    const { user } = renderInShell(CompareView, { core });
    await screen.findByText('Choose a second log');
    await user.upload(fileInputs()[0], new File(['b'], 'door-lock.log'));
    expect(await screen.findByText(/Not kept for a reload/)).toBeTruthy();
    expect(session.forget).toHaveBeenCalledWith('compare');
  });

  it('keeps Replace log A and Swap off while log B is read', async () => {
    let finish: (info: typeof logB) => void = () => {};
    const openCompareLog = vi.fn(() => new Promise<typeof logB>((resolve) => (finish = resolve)));
    const core = compareCore(RESULTS, { compareLogInfo: async () => null, openCompareLog });
    const { user } = renderInShell(CompareView, { core });
    await screen.findByText('Choose a second log');
    await user.upload(fileInputs()[0], new File(['b'], 'door-lock.log'));

    expect(await screen.findByText(/^Reading/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Replace log A\u2026' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Swap logs A and B' }).hasAttribute('disabled')).toBe(true);
    finish(logB);
    await screen.findByRole('region', { name: 'Log B' });
    expect(screen.getByRole('button', { name: 'Replace log A\u2026' }).hasAttribute('disabled')).toBe(false);
  });
});

describe('results', () => {
  it('groups the IDs and shows the rates, score and reason', async () => {
    renderInShell(CompareView, { core: compareCore() });
    expect(await screen.findByRole('row', { name: '450 BODY 10 10 100% Byte 3 takes new values' })).toBeTruthy();
    const groups = screen.getAllByRole('button', { expanded: true }).map((b) => b.textContent);
    expect(groups).toEqual([
      'In both \u00b7 different bytes(1)',
      'Only in B(1)',
      'Only in A(1)',
      'In both \u00b7 no significant differences(1)',
    ]);
    expect(screen.getByRole('row', { name: /^7DF .* Appears only in B$/ })).toBeTruthy();
  });

  it('shows the groups the sidebar asks for', async () => {
    const { user } = renderInShell(CompareView, { core: compareCore() });
    await screen.findByRole('row', { name: /^450 BODY/ });
    await user.click(screen.getByRole('radio', { name: /Only in A/ }));
    expect(screen.getByRole('row', { name: /^456/ })).toBeTruthy();
    expect(screen.queryByRole('row', { name: /^450/ })).toBeNull();
    expect(screen.queryByRole('row', { name: /^7DF/ })).toBeNull();
  });

  it('collapses a group from its heading', async () => {
    const { user } = renderInShell(CompareView, { core: compareCore() });
    await screen.findByRole('row', { name: /^450 BODY/ });
    await user.click(groupButton(/^Only in B/));
    expect(groupButton(/^Only in B/).getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('row', { name: /^7DF/ })).toBeNull();
  });

  it('selects the most different ID first and moves with the arrow keys', async () => {
    const { user } = renderInShell(CompareView, { core: compareCore() });
    const first = await screen.findByRole('row', { name: /^450 BODY/ });
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(first.tabIndex).toBe(0);
    expect(await screen.findByRole('heading', { name: '450BODY' })).toBeTruthy();

    first.focus();
    await user.keyboard('{ArrowDown}');
    const next = screen.getByRole('row', { name: /^7DF/ });
    expect(next.getAttribute('aria-current')).toBe('true');
    expect(document.activeElement).toBe(next);
    expect(await screen.findByText('Only in log B: swap the logs to open it in Reverse Engineer.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open in Reverse Engineer' }).hasAttribute('disabled')).toBe(true);
  });

  it('describes the differing byte and bits in text, with both logs at the cursor', async () => {
    renderInShell(CompareView, { core: compareCore() });
    const findings = await screen.findByText(/takes new values/, { selector: '.cmp-findings li' });
    expect(findings.textContent).toBe('Byte 3 \u00b7 100% \u00b7 Byte 3 takes new values (B shows 01). Bit 0 differs');
    const byte3 = screen.getByRole('button', { name: /^Byte 3/ });
    expect(byte3.className).toContain('changed');
    expect(byte3.getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => expect(byte3.textContent).toBe('Byte 3A 00B 01 (differs)Changed'));
  });

  it('opens the selected ID and byte in Reverse Engineer on log A', async () => {
    const { user, state } = renderInShell(CompareView, { core: compareCore() });
    await screen.findByRole('heading', { name: '450BODY' });
    await user.click(screen.getByRole('button', { name: 'Open in Reverse Engineer' }));
    expect(state.view).toBe('reverse');
    expect(state.selected).toBe(0x450);
  });

  it('says why Enter does nothing on an ID only in log B', async () => {
    const { user } = renderInShell(CompareView, { core: compareCore() });
    const row = await screen.findByRole('row', { name: /^7DF/ });
    row.focus();
    await user.keyboard('{Enter}');
    expect(row.getAttribute('aria-current')).toBe('true');
    expect(screen.getByText('Only in log B: swap the logs to open it in Reverse Engineer.', { selector: '[role="status"]' })).toBeTruthy();
  });

  it('says how buses were paired when the logs name them differently', async () => {
    const renamed = RESULTS.map((c) => (c.presence === 'both' ? { ...c, busB: 'vcan0' } : c));
    renderInShell(CompareView, { core: compareCore(renamed) });
    expect(await screen.findByText('Buses matched by order: can0 = vcan0')).toBeTruthy();
  });

  it('says how buses were paired on logs that look the same', async () => {
    renderInShell(CompareView, { core: compareCore([{ ...steady, busB: 'vcan0' }]) });
    expect(await screen.findByRole('heading', { name: 'These logs look the same' })).toBeTruthy();
    expect(screen.getByText('Buses matched by order: can0 = vcan0')).toBeTruthy();
  });

  it('swaps the logs through the shell', async () => {
    const swapCompareLog = vi.fn(async () => true);
    const { user } = renderInShell(CompareView, { core: compareCore(), swapCompareLog });
    await screen.findByRole('row', { name: /^450 BODY/ });
    await user.click(screen.getByRole('button', { name: 'Swap logs A and B' }));
    expect(swapCompareLog).toHaveBeenCalled();
  });

  it('keeps Swap off for a capture, which the core cannot swap', async () => {
    renderInShell(CompareView, { core: compareCore(), log: logInfo({ name: 'capture.log', format: 'capture' }) });
    await screen.findByRole('row', { name: /^450 BODY/ });
    expect(screen.getByRole('button', { name: 'Swap logs A and B' }).hasAttribute('disabled')).toBe(true);
  });

  it('waits for a running capture to stop, without reading log B', async () => {
    const compareLogInfo = vi.fn(async () => logB);
    renderInShell(CompareView, { core: compareCore(RESULTS, { compareLogInfo }), capturing: true });
    expect(screen.getByText(/A capture can be compared once it stops/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Open log B/ })).toBeNull();
    expect(compareLogInfo).not.toHaveBeenCalled();
  });

  it('recompares when an ignore rule changes', async () => {
    const compareLogs = vi.fn(async (_options: CompareOptions) => RESULTS);
    const { user } = renderInShell(CompareView, { core: compareCore(RESULTS, { compareLogs }) });
    await screen.findByRole('row', { name: /^450 BODY/ });
    await user.click(screen.getByRole('checkbox', { name: 'Ignore IDs that also change within A alone' }));
    await waitFor(() => expect(compareLogs).toHaveBeenLastCalledWith({ ignoreCounters: true, ignoreChangesWithinA: false }));
  });
});

describe('logs that look the same', () => {
  it('says so, with the ignore rules and Replace log B... to go on', async () => {
    const compareLogs = vi.fn(async (_options: CompareOptions) => [steady]);
    const { user } = renderInShell(CompareView, { core: compareCore([steady], { compareLogs }) });
    expect(await screen.findByRole('heading', { name: 'These logs look the same' })).toBeTruthy();
    expect(screen.getByText(/0 changed IDs/).textContent).toBe('0 changed IDs \u00b7 1 compared');
    const primaries = [...document.querySelectorAll('.cmp .primary')].map((b) => b.textContent);
    expect(primaries).toEqual(['Replace log B\u2026']);

    await user.click(screen.getByRole('button', { name: 'Review ignore rules\u2026' }));
    const sheet = screen.getByRole('dialog', { name: 'Ignore Rules' });
    await user.click(within(sheet).getByRole('checkbox', { name: /^Ignore counters and checksums/ }));
    await waitFor(() => expect(compareLogs).toHaveBeenLastCalledWith({ ignoreCounters: false, ignoreChangesWithinA: true }));
  });

  it('says how many IDs the within-A rule left out', async () => {
    const drifting = comparison(0x3e9, { score: 1, reason: 'Also changes within A', changesWithinA: true });
    renderInShell(CompareView, { core: compareCore([steady, drifting]) });
    expect(await screen.findByRole('heading', { name: 'These logs look the same' })).toBeTruthy();
    expect(screen.getByText('1 ID changes within A; turn off the rule to see it.')).toBeTruthy();
  });

  it('leaves IDs with too few frames to their own group', async () => {
    const few = comparison(0x5a0, { framesA: 3, framesB: 6, tooFewFrames: true, reason: 'Too few frames to compare; payloads differ' });
    const { user } = renderInShell(CompareView, { core: compareCore([body, few]) });
    expect(await screen.findByRole('button', { name: 'Too few frames to compare(1)' })).toBeTruthy();
    expect(screen.getByRole('row', { name: /^5A0 / })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /Too few frames to compare/ }));
    expect(screen.queryByRole('row', { name: /^5A0 / })).toBeNull();
  });
});

describe('a core that stops', () => {
  it('forgets the saved log B when the core restarts while comparing it', async () => {
    let reset = () => {};
    const core = compareCore(RESULTS, {
      compareLogs: () => new Promise(() => {}),
      onReset: (listener) => {
        reset = listener;
        return () => {};
      },
    });
    renderInShell(CompareView, { core });
    expect(await screen.findByRole('region', { name: 'Log B' })).toBeTruthy();
    await waitFor(() => expect(session.forget).not.toHaveBeenCalled());
    reset();
    expect(session.forget).toHaveBeenCalledWith('compare');
  });

  it('keeps the saved log B when the core restarts with no work on it', async () => {
    let reset = () => {};
    const core = compareCore(RESULTS, {
      onReset: (listener) => {
        reset = listener;
        return () => {};
      },
    });
    renderInShell(CompareView, { core });
    expect(await screen.findByRole('row', { name: /^450 BODY/ })).toBeTruthy();
    reset();
    expect(session.forget).not.toHaveBeenCalled();
  });
});

describe('a comparison with no IDs', () => {
  it('does not say the logs look the same', async () => {
    renderInShell(CompareView, { core: compareCore([]) });
    expect(await screen.findByText('No IDs to show here.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'These logs look the same' })).toBeNull();
  });
});

describe('replacing log A', () => {
  it('opens the new log A in place and reads log B again', async () => {
    const openCompareLog = vi.fn(async () => logB);
    const openLog = vi.fn(async () => true);
    const core = compareCore(RESULTS, { compareLogInfo: async () => null, openCompareLog });
    const { user } = renderInShell(CompareView, { core, openLog });
    await screen.findByText('Choose a second log');
    const fileB = new File(['b'], 'door-lock.log');
    await user.upload(fileInputs()[0], fileB);
    await screen.findByRole('region', { name: 'Log B' });

    const fileA = new File(['a'], 'idle-2.log');
    await user.upload(fileInputs()[1], fileA);
    expect(openLog).toHaveBeenCalledWith(fileA, 'idle-2.log');
    await waitFor(() => expect(openCompareLog).toHaveBeenCalledTimes(2));
    expect(openCompareLog).toHaveBeenLastCalledWith(fileB, 'door-lock.log', expect.any(Function));
  });
});
