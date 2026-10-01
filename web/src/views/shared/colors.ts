import { cssVar } from '../../format';

const SLOTS = 6;

/** The 16% tint of a series colour, for a layout region outlined in that colour. */
export function seriesTint(color: string): string {
  for (let i = 1; i <= SLOTS; i++) {
    if (cssVar(`--series-${i}`).toLowerCase() === color.toLowerCase()) return cssVar(`--tint-${i}`);
  }
  return cssVar('--unset-cell');
}
