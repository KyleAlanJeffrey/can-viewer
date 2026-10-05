import { CompareView } from './compare/CompareView';
import { DatabaseView } from './database/DatabaseView';
import { OverviewView } from './overview/OverviewView';
import { PlotView } from './plot/PlotView';
import { ReverseView } from './reverse/ReverseView';
import { TraceView } from './trace/TraceView';
import type { ViewId, ViewMeta } from './types';

export const VIEWS: ViewMeta[] = [
  { id: 'overview', label: 'Overview', Component: OverviewView, search: 'Filter IDs and signals', hasInspector: false, hasPrimary: false, needsLog: true },
  { id: 'trace', label: 'Trace', Component: TraceView, search: 'Filter IDs and signals', hasInspector: true, hasPrimary: false, needsLog: true },
  { id: 'plot', label: 'Plot', Component: PlotView, search: 'Filter signals', hasInspector: false, hasPrimary: false, needsLog: true },
  { id: 'reverse', label: 'Reverse Engineer', Component: ReverseView, search: 'Filter IDs and signals', hasInspector: true, hasPrimary: true, needsLog: true },
  { id: 'compare', label: 'Compare', Component: CompareView, search: 'Filter IDs and names', hasInspector: false, hasPrimary: true, needsLog: true },
  { id: 'database', label: 'Database', Component: DatabaseView, search: 'Filter messages', hasInspector: true, hasPrimary: true, needsLog: false },
];

export function viewMeta(id: ViewId): ViewMeta {
  return VIEWS.find((v) => v.id === id) ?? VIEWS[1];
}
