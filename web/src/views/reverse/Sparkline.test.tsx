import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Sparkline } from './Sparkline';

describe('Sparkline', () => {
  it('breaks the line at NaN and fits the other values', () => {
    const x = [0, 1, 2, 3, 4];
    const { container } = render(<Sparkline x={x} y={[NaN, 0, 10, NaN, 5]} x0={0} x1={4} />);
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    expect(d).not.toContain('NaN');
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).toContain('L50.00,2.00');
  });

  it('draws nothing when no two values in a row are finite', () => {
    const { container } = render(<Sparkline x={[0, 1, 2]} y={[1, NaN, 2]} x0={0} x1={2} />);
    expect(container.querySelector('path')).toBeNull();
  });
});
