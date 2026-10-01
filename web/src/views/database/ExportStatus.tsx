import { useEffect, useState } from 'react';
import type { LoadedDbc } from '../types';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long ago `at` was, coarsely: `just now`, `3 min ago`, `2 h ago`, `5 d ago`. */
export function formatAgo(at: number, now: number): string {
  const ms = Math.max(0, now - at);
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min ago`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`;
  return `${Math.floor(ms / DAY)} d ago`;
}

/** Whether `dbc`'s edits are in a file: `Edited`, and when it was last exported, kept current. */
export function ExportStatus({ dbc }: { dbc: LoadedDbc }) {
  const [now, setNow] = useState(() => Date.now());
  const exportedAt = dbc.exportedAt ?? null;

  useEffect(() => {
    if (exportedAt === null) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [exportedAt]);

  const exported = exportedAt === null ? 'Not exported' : `Exported ${formatAgo(exportedAt, now)}`;
  return (
    <p className="db-status" role="status">
      {dbc.edited && <>Edited &middot; </>}
      <span title={exportedAt === null ? undefined : new Date(exportedAt).toLocaleString()}>{exported}</span>
    </p>
  );
}
