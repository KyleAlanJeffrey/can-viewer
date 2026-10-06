import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, seriesInfo } from '../test/fixtures';
import { Plots, type PlotSpec } from './Plots';

/** Gives each plot room to draw, so it fetches a view. */
class SizedResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe() {
    const contentRect = { width: 600, height: 120 } as DOMRectReadOnly;
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

const spec: PlotSpec = { id: '1:Temp', label: 'Temp', info: seriesInfo(1, 'Temp'), color: 'c1' };

function renderPlots(last: number) {
  const core = fakeCore({ seriesView: async () => [Float64Array.of(0, 5, 10), Float64Array.of(1, 2, last)] });
  return render(<Plots core={core} specs={[spec]} duration={10} pinnedTime={null} onPin={() => {}} onRemove={() => {}} onClear={() => {}} />);
}

describe('Plots readout', () => {
  it('shows the last value in view', async () => {
    const { container } = renderPlots(3);
    await waitFor(() => expect(container.querySelector('.readout')?.textContent).toBe('3'));
  });

  it('shows NaN for a value the line leaves a gap for', async () => {
    const { container } = renderPlots(NaN);
    await waitFor(() => expect(container.querySelector('.readout')?.textContent).toBe('NaN'));
  });
});
