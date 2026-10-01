import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface Slots {
  sidebar: HTMLElement | null;
  inspector: HTMLElement | null;
}

export const SlotContext = createContext<Slots>({ sidebar: null, inspector: null });

// A view renders its content in place and its sidebar and inspector through these, so one view
// component can share local state across all three panes.

/** Renders into the sidebar, below the brand and search field. */
export function SidebarSlot({ children }: { children: ReactNode }) {
  const { sidebar } = useContext(SlotContext);
  return sidebar ? createPortal(children, sidebar) : null;
}

/** Renders into the inspector pane on the right. */
export function InspectorSlot({ children }: { children: ReactNode }) {
  const { inspector } = useContext(SlotContext);
  return inspector ? createPortal(children, inspector) : null;
}
