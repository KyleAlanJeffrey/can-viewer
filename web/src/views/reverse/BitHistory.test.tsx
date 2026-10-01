import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NO_BYTE } from '../../core/api';
import { ROW_PAYLOAD } from '../../core/rows';
import { fakeCore, makeRowBatch, summary } from '../../test/fixtures';
import { BitHistory } from './BitHistory';

const LENGTH = 100;
/** Byte `i` of transfer `k`, as in a test log of 100-byte J1939 transfers. */
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

afterEach(() => vi.unstubAllGlobals());

describe('Bit History', () => {
  it('draws bytes past the 64 in a row, fetched for every drawn row at once', async () => {
    vi.stubGlobal('ResizeObserver', WideResizeObserver);
    const transfers = summary({ id: 0x18feca00, extended: true, count: 3, minLen: LENGTH, maxLen: LENGTH });
    const rowBytes = vi.fn(async (_key: number, start: number, count: number, first: number, byteCount: number) =>
      Uint16Array.from({ length: count * byteCount }, (_, i) => {
        const byte = first + (i % byteCount);
        return byte < LENGTH ? byteOf(start + Math.floor(i / byteCount), byte) : NO_BYTE;
      }),
    );
    const core = fakeCore({
      rowAtTime: async (_key, t) => (t > 0 ? 2 : 0),
      rows: async (key, start, count) =>
        makeRowBatch(
          key,
          start,
          Array.from({ length: count }, (_, k) => ({
            t: k,
            id: 0x98feca00,
            index: k,
            data: Array.from({ length: ROW_PAYLOAD }, (_, i) => byteOf(start + k, i)),
            fullLength: LENGTH,
          })),
        ),
      rowBytes,
    });
    const byte97 = Array.from({ length: 8 }, (_, bit) => 97 * 8 + bit);

    render(<BitHistory core={core} summary={transfers} duration={10} window={[0, 10]} logVersion={1} selected={byte97} />);

    const canvas = await screen.findByRole('img', { name: /bytes 96 to 98 over the last 3 frames/ });
    await waitFor(() => expect(rowBytes).toHaveBeenCalledWith(transfers.key, 0, 3, 96, 3));
    fireEvent.pointerMove(canvas, { clientX: 45, clientY: 10 });
    expect(await screen.findByText('B96-B98: 20 23 26 (100 bytes)')).toBeTruthy();
  });
});
