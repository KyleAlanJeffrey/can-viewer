import { describe, expect, it } from 'vitest';
import { toolbarLayout, type SpareAction } from './toolbarLayout';

const ALL: SpareAction[] = ['open-dbc', 'export-log', 'save-capture', 'capture'];
const inline = (width: number, spare = ALL, views = 500) => [...toolbarLayout(width, spare, 160, views).inline];

describe('toolbarLayout', () => {
  it('shows every action, on two rows, until the toolbar is measured', () => {
    expect(toolbarLayout(0, ALL, 160, 0)).toEqual({ oneRow: false, inline: new Set(ALL) });
  });

  it('puts the views beside the log only when everything fits', () => {
    expect(toolbarLayout(1800, ALL, 160, 500).oneRow).toBe(true);
    expect(toolbarLayout(1200, ALL, 160, 500).oneRow).toBe(false);
    // Without a view switcher there is no second row to save.
    expect(toolbarLayout(1800, ALL, 160, 0).oneRow).toBe(false);
  });

  it('moves the least needed actions into the More menu first', () => {
    expect(inline(1200)).toEqual(ALL);
    expect(inline(1000)).toEqual(['open-dbc', 'export-log', 'save-capture']);
    expect(inline(800)).toEqual(['open-dbc', 'save-capture']);
    expect(inline(700)).toEqual(['save-capture']);
    expect(inline(400)).toEqual([]);
  });

  it('keeps the actions a log without a capture has, when they fit', () => {
    expect(inline(1000, ['open-dbc', 'export-log', 'capture'])).toEqual(['open-dbc', 'export-log', 'capture']);
  });
});
