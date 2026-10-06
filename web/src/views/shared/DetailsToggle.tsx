import { PanelRight } from 'lucide-react';
import type { ViewContext } from '../types';

interface Props {
  ctx: ViewContext;
  /** Why there is nothing to show yet; the toggle is disabled meanwhile. */
  emptyReason?: string | null;
}

/** Shows or hides the inspector pane beside the view. */
export function DetailsToggle({ ctx, emptyReason = null }: Props) {
  const empty = emptyReason !== null;
  return (
    <button
      type="button"
      className="toolbar-button details-toggle"
      aria-pressed={!empty && ctx.inspectorOpen}
      aria-controls="inspector"
      disabled={empty}
      title={emptyReason ?? (ctx.inspectorOpen ? 'Hide details' : 'Show details')}
      onClick={ctx.toggleInspector}
    >
      <PanelRight size={16} strokeWidth={1.5} aria-hidden="true" />
      Details
    </button>
  );
}
