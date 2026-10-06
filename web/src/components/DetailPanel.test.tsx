import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { fakeCore, summary } from '../test/fixtures';
import { DetailPanel } from './DetailPanel';

describe('DetailPanel', () => {
  it('rates bit changes against the pairs of frames compared, not the remote frames of a polled ID', async () => {
    // Six frames, every other one a remote frame: the three data frames make two pairs.
    const flips = new Uint32Array(8);
    flips[0] = 2;
    const polled = summary({ id: 0x100, count: 6, flipPairs: 2, minLen: 1, maxLen: 1 });
    const core = fakeCore({ bitFlips: async () => flips });
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
    const heatmap = await screen.findByRole('img', { name: 'Bit change rates for 1 bytes' });
    // Bit 0 is the rightmost of the eight 24 px columns after the 22 px byte labels, below the 22 px header.
    fireEvent.pointerMove(heatmap, { clientX: 22 + 7 * 24 + 12, clientY: 22 + 12 });
    expect(await screen.findByText('Changed 2 times \u00b7 100.00% of frames')).toBeTruthy();
  });
});
