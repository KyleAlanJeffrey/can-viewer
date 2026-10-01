import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NO_BYTE } from '../../core/api';
import { ROW_PAYLOAD } from '../../core/rows';
import { fakeCore, makeRowBatch, summary } from '../../test/fixtures';
import { BitHistory } from './BitHistory';

/** Byte `i` of transfer `k`, as in a test log of long J1939 transfers. */
const byteOf = (k: number, i: number) => (3 * i + k) & 0xff;

/** Reports a fixed width, so the strip has columns to fetch frames for. */
class WideResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback([{ target, contentRect: { width: 400 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
  unobserve() {}
  disconnect() {}
}

beforeEach(() => vi.stubGlobal('ResizeObserver', WideResizeObserver));
afterEach(() => vi.unstubAllGlobals());

/** Transfers of 18FECA00, one per second, transfer `k` being `lengths[k]` bytes long. */
function transfersOf(lengths: number[]) {
  const ids = summary({ id: 0x18feca00, extended: true, count: lengths.length, minLen: Math.min(...lengths), maxLen: Math.max(...lengths) });
  const rowBytes = vi.fn(async (_key: number, start: number, count: number, first: number, byteCount: number) =>
    Uint16Array.from({ length: count * byteCount }, (_, i) => {
      const k = start + Math.floor(i / byteCount);
      const byte = first + (i % byteCount);
      return byte < lengths[k] ? byteOf(k, byte) : NO_BYTE;
    }),
  );
  const core = fakeCore({
    rowAtTime: async (_key, t) => (t > 0 ? lengths.length - 1 : 0),
    rows: async (key, start, count) =>
      makeRowBatch(
        key,
        start,
        lengths.slice(start, start + count).map((length, i) => ({
          t: start + i,
          id: 0x98feca00,
          index: start + i,
          data: Array.from({ length: Math.min(length, ROW_PAYLOAD) }, (_, byte) => byteOf(start + i, byte)),
          fullLength: length,
        })),
      ),
    rowBytes,
  });
  return { ids, core, rowBytes };
}

const bitsOfByte = (byte: number) => Array.from({ length: 8 }, (_, bit) => byte * 8 + bit);

/** Hovers frame `column` of the strip, counted from the oldest drawn. */
async function hover(column: number) {
  const canvas = await screen.findByRole('img', { name: /over the last [1-9]\d* frames/ });
  fireEvent.pointerMove(canvas, { clientX: 45 + column * 4, clientY: 10 });
}

describe('Bit History', () => {
  it('draws bytes past the 64 in a row, fetched for every drawn row at once', async () => {
    const { ids, core, rowBytes } = transfersOf([100, 100, 100]);
    render(<BitHistory core={core} summary={ids} duration={10} window={[0, 10]} logVersion={1} selected={bitsOfByte(97)} />);

    await waitFor(() => expect(rowBytes).toHaveBeenCalledWith(ids.key, 0, 3, 96, 3));
    expect(await screen.findByRole('img', { name: /bytes 96 to 98 over the last 3 frames/ })).toBeTruthy();
    await hover(0);
    expect(await screen.findByText('B96-B98: 20 23 26 (100 bytes)')).toBeTruthy();
  });

  it('keeps the bytes past 64 of the frames it shows while the next ones load', async () => {
    const { ids, core, rowBytes } = transfersOf([100, 100, 100]);
    const view = (t1: number) => <BitHistory core={core} summary={ids} duration={10} window={[0, t1]} logVersion={1} selected={bitsOfByte(97)} />;
    const { rerender } = render(view(10));
    await waitFor(() => expect(rowBytes).toHaveBeenCalledTimes(1));

    rowBytes.mockImplementationOnce(() => new Promise(() => {}));
    rerender(view(9));
    await waitFor(() => expect(rowBytes).toHaveBeenCalledTimes(2));
    await hover(0);
    expect(await screen.findByText('B96-B98: 20 23 26 (100 bytes)')).toBeTruthy();
  });

  it('reads a selection under byte 64 from the rows alone', async () => {
    const { ids, core, rowBytes } = transfersOf([100, 100, 100]);
    render(<BitHistory core={core} summary={ids} duration={10} window={[0, 10]} logVersion={1} selected={bitsOfByte(10)} />);

    await hover(1);
    expect(await screen.findByText('B9-B11: 1C 1F 22 (100 bytes)')).toBeTruthy();
    expect(rowBytes).not.toHaveBeenCalled();
  });

  it('marks the bytes a shorter frame lacks with dashes', async () => {
    const { ids, core } = transfersOf([97, 100]);
    render(<BitHistory core={core} summary={ids} duration={10} window={[0, 10]} logVersion={1} selected={bitsOfByte(97)} />);

    await hover(0);
    expect(await screen.findByText('B96-B98: 20 -- -- (97 bytes)')).toBeTruthy();
    await hover(1);
    expect(await screen.findByText('B96-B98: 21 24 27 (100 bytes)')).toBeTruthy();
  });
});
