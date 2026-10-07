import type { ReactNode } from 'react';
import { Box, ChartLine, Check, ChevronRight, Database, GitCompareArrows, LayoutDashboard, List } from 'lucide-react';
import { VIEWS } from '../views';
import type { ViewId } from '../views/types';
import { Sheet } from './Sheet';

const VIEW_ICONS: Record<ViewId, ReactNode> = {
  overview: <LayoutDashboard size={20} strokeWidth={1.5} aria-hidden="true" />,
  trace: <List size={20} strokeWidth={1.5} aria-hidden="true" />,
  plot: <ChartLine size={20} strokeWidth={1.5} aria-hidden="true" />,
  reverse: <Box size={20} strokeWidth={1.5} aria-hidden="true" />,
  compare: <GitCompareArrows size={20} strokeWidth={1.5} aria-hidden="true" />,
  database: <Database size={20} strokeWidth={1.5} aria-hidden="true" />,
};

export interface SheetAction {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** A second line under the label. */
  note?: string;
  /** Leads to another sheet, so it ends with a chevron. */
  opensSheet?: boolean;
  /** Drawn with a hairline above it, to set it apart from the actions before. */
  separated?: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  view: ViewId;
  hasLog: boolean;
  onView: (view: ViewId) => void;
  actions: SheetAction[];
}

/** On phones, in place of the view tabs: every view, then the actions that start or change a session. */
export function ViewsSheet({ open, onClose, view, hasLog, onView, actions }: Props) {
  return (
    <Sheet open={open} onClose={onClose} title="Views" closeLabel="Close" className="views-sheet">
      <nav aria-label="Views">
        <ul className="views-list">
          {VIEWS.map((v) => {
            const current = v.id === view;
            return (
              <li key={v.id}>
                <button
                  type="button"
                  className="views-item"
                  data-view={v.id}
                  aria-current={current ? 'page' : undefined}
                  disabled={v.needsLog && !hasLog}
                  onClick={() => {
                    onClose();
                    if (!current) onView(v.id);
                  }}
                >
                  {VIEW_ICONS[v.id]}
                  <span className="views-label">{v.label}</span>
                  {current && <Check className="views-check" size={20} strokeWidth={1.75} aria-hidden="true" />}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <ul className="views-list views-actions" aria-label="Session">
        {actions.map((a) => (
          <li key={a.id} className={a.separated ? 'separated' : undefined}>
            <button
              type="button"
              className="views-item"
              data-action={a.id}
              disabled={a.disabled}
              onClick={(e) => {
                // Closed at once, so a file picker or another sheet opens over a page that isn't inert.
                e.currentTarget.closest('dialog')?.close();
                onClose();
                a.onSelect();
              }}
            >
              {a.icon}
              <span className="views-label">
                {a.label}
                {a.note && <span className="views-note">{a.note}</span>}
              </span>
              {a.opensSheet && <ChevronRight className="views-chevron" size={18} strokeWidth={1.5} aria-hidden="true" />}
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
