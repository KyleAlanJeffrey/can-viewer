import { useLayoutEffect, useState, type RefObject } from 'react';

/** Toolbar buttons that move into the More menu as the toolbar narrows. */
export type SpareAction = 'open-dbc' | 'export-log' | 'save-capture' | 'capture';

/** The order they move in, the least needed first. */
const OVERFLOW_ORDER: SpareAction[] = ['capture', 'export-log', 'open-dbc', 'save-capture'];

/** The room each takes in the toolbar, its gap included, as measured in Chrome. */
const ACTION_WIDTH: Record<SpareAction, number> = {
  'open-dbc': 127,
  'export-log': 130,
  'save-capture': 146,
  capture: 140,
};

/** The buttons that never move into the menu, measured the same way (Open Log as the amber button, the wider). */
export const FIXED_WIDTH = { openLog: 107, stopCapture: 141, cancel: 96, more: 40 };

const TOOLBAR_PADDING = 24;
const GAP = 12;
/** Left for the sidebar toggle and the log's name and status, so they stay readable. */
const DOC_ROOM = 340;
/** On one row with the views, the status line gets more, as it is cut short otherwise. */
const DOC_ROOM_ONE_ROW = 400;

export interface ToolbarLayout {
  /** The views fit on the row with the log and its actions; otherwise they get a row of their own. */
  oneRow: boolean;
  /** The spare actions shown as buttons; the rest are in the More menu. */
  inline: ReadonlySet<SpareAction>;
}

/**
 * Where the toolbar's parts go at `width`: the views beside the log only when everything fits,
 * else on a second row, and spare actions in the More menu once even that row runs out of room.
 * `fixed` is the width of the buttons that always stay, `views` the view switcher's (0 if none).
 * A width of 0 (not measured yet) shows every action, on two rows.
 */
export function toolbarLayout(width: number, spare: SpareAction[], fixed: number, views: number): ToolbarLayout {
  const all = spare.reduce((sum, a) => sum + ACTION_WIDTH[a], 0);
  if (width === 0) return { oneRow: false, inline: new Set(spare) };
  if (views > 0 && width - TOOLBAR_PADDING - DOC_ROOM_ONE_ROW - fixed - views - 2 * GAP >= all) return { oneRow: true, inline: new Set(spare) };
  const room = width - TOOLBAR_PADDING - DOC_ROOM - fixed;
  const inline = new Set(spare);
  let used = all;
  for (const action of OVERFLOW_ORDER) {
    if (used <= room) break;
    if (inline.delete(action)) used -= ACTION_WIDTH[action];
  }
  return { oneRow: false, inline };
}

/**
 * `toolbarLayout` for the toolbar `ref`, kept up to date as it or its view switcher resizes.
 * `hasViews` says whether the switcher is shown, to watch it once it is.
 */
export function useToolbarLayout(ref: RefObject<HTMLElement | null>, spare: SpareAction[], fixed: number, hasViews: boolean): ToolbarLayout {
  const [size, setSize] = useState({ width: 0, views: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const switcher = el.querySelector<HTMLElement>('.view-switcher');
    const measure = () => {
      const views = switcher?.offsetWidth ?? 0;
      const width = el.getBoundingClientRect().width;
      setSize((s) => (s.width === width && s.views === views ? s : { width, views }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (switcher) observer.observe(switcher);
    return () => observer.disconnect();
  }, [ref, hasViews]);

  return toolbarLayout(size.width, spare, fixed, size.views);
}
