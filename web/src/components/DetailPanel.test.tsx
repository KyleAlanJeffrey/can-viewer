import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { bitFlips, fakeCore, summary } from '../test/fixtures';
import { DetailPanel } from './DetailPanel';

describe('DetailPanel', () => {
  it('rates each byte against the pairs of frames that had it, not every frame of the ID', async () => {
    // Six frames, every other one a remote frame: the three data frames make two pairs, and
    // only one of them has a byte 1. Bit 0 of each byte changes in all of its pairs.
    const counts = bitFlips(2, 0, { 0: 2, 8: 1 });
    counts.pairs.set([2, 1]);
    const polled = summary({ id: 0x100, count: 6, minLen: 1, maxLen: 2 });
    const core = fakeCore({ bitFlips: async () => counts });
    render(
      <DetailPanel
        core={core}
        summary={polled}
        channels={['can0']}
        message={null}
        logVersion={1}
        signalColors={[]}
        plotted={new Set()}
        onTogglePlot={() => {}}
      />,
    );
    const heatmap = await screen.findByRole('img', { name: 'Bit change rates for 2 bytes' });
    // Bit 0 is the rightmost of the eight 24 px columns after the 22 px byte labels; rows are
    // 24 px below the 22 px header.
    fireEvent.pointerMove(heatmap, { clientX: 22 + 7 * 24 + 12, clientY: 22 + 12 });
    expect(await screen.findByText('Changed 2 times \u00b7 100.00% of frames')).toBeTruthy();
    fireEvent.pointerMove(heatmap, { clientX: 22 + 7 * 24 + 12, clientY: 22 + 24 + 12 });
    expect(await screen.findByText('Changed 1 times \u00b7 100.00% of frames')).toBeTruthy();
  });
});
