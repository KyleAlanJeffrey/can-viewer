import { useMemo } from 'react';
import { idLabel } from '../../core/api';
import { IdList } from '../../components/IdList';
import { SidebarSlot } from '../slots';
import type { ViewContext } from '../types';

/** The ID source list shared by Overview, Trace and Reverse Engineer, filtered by the sidebar search. */
export function IdListSidebar({ ctx }: { ctx: ViewContext }) {
  const { ids, messageOf, query, log, dbcs, selected, select } = ctx;
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ids;
    return ids.filter((s) => {
      const m = messageOf(s.key);
      return (
        idLabel(s).toLowerCase().includes(q) ||
        (s.name ?? '').toLowerCase().includes(q) ||
        (m?.signals.some((sig) => sig.name.toLowerCase().includes(q)) ?? false)
      );
    });
  }, [ids, messageOf, query]);

  if (!log) return null;
  return (
    <SidebarSlot>
      <IdList
        ids={visible}
        channels={log.channels}
        totalFrames={log.frames}
        hasDbc={dbcs.length > 0}
        filtered={query.trim() !== ''}
        selected={selected}
        onSelect={select}
      />
    </SidebarSlot>
  );
}
