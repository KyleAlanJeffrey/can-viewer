import { useMemo, useReducer, useRef } from 'react';
import type { Database } from '../../core/api';
import type { LoadedDbc, ViewContext } from '../types';

/**
 * A change to one DBC, built from whatever version it's given. It can be applied to a version
 * that already has it, so applying it twice must give the same result as once.
 */
export type DbEdit = (db: Database) => Database;

/**
 * Edits reach ctx.dbcs only once the core has them, which can take a while when plots decode
 * again. Until then the view shows them applied over ctx.dbcs, so a field never flicks back.
 */
export function useWorkingDbcs(ctx: ViewContext) {
  const pending = useRef<{ id: string; change: DbEdit }[]>([]);
  const [version, bump] = useReducer((n: number) => n + 1, 0);

  const dbcs = useMemo<LoadedDbc[]>(
    () =>
      ctx.dbcs.map((d) => {
        const mine = pending.current.filter((p) => p.id === d.id);
        return mine.length === 0 ? d : { ...d, db: mine.reduce((db, p) => p.change(db), d.db), edited: true };
      }),
    // `version` stands for `pending`.
    [ctx.dbcs, version],
  );

  const edit = (id: string, change: DbEdit) => {
    const entry = { id, change };
    pending.current = [...pending.current, entry];
    bump();
    void ctx.run('Updating the database\u2026', () => ctx.updateDbc(id, (current) => ({ db: change(current.db) }))).then(() => {
      pending.current = pending.current.filter((p) => p !== entry);
      bump();
    });
  };

  return { dbcs, edit };
}
