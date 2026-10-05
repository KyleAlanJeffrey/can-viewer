/**
 * The last session, kept in IndexedDB so a reload picks up where the user left off. Everything
 * stays in this browser. Storage can be unavailable (private windows, blocked site data) or full,
 * so every call fails soft: reads resolve to undefined and writes report failure.
 */

const DB_NAME = 'freecan-studio';
const STORE = 'session';
/** Where tabs of this app tell each other about changes. */
const CHANNEL = 'freecan-studio';
const DBCS_KEY = 'dbcs';

/** `compare` is the Compare view's second log, kept like `log` and dropped with it. */
export type SessionKey = 'log' | 'dbcs' | 'ui' | 'views' | 'compare';

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      // Let a newer version of the app in another tab upgrade the database.
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // An older tab is holding the database open; don't wait on it forever.
    req.onblocked = () => reject(new Error('blocked'));
  }).catch((err) => {
    opening = null;
    throw err;
  });
  return opening;
}

function request<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        // Resolve on commit, not on the request, so a write is durable before we report it.
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

export async function loadSaved<T>(key: Exclude<SessionKey, 'dbcs'>): Promise<T | undefined> {
  try {
    return await request<T | undefined>('readonly', (s) => s.get(key));
  } catch {
    return undefined;
  }
}

/** Resolves false when the browser refused the write, for example because storage is full. */
export async function save(key: Exclude<SessionKey, 'dbcs'>, value: unknown): Promise<boolean> {
  try {
    await request('readwrite', (s) => s.put(value, key));
    return true;
  } catch {
    return false;
  }
}

export async function forget(key: SessionKey): Promise<void> {
  try {
    await request('readwrite', (s) => s.delete(key));
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}

/*
 * The DBCs are the one value several tabs edit, each saving its whole list. The record carries a
 * revision: a tab writes only if the store still holds the revision it read, so an older tab
 * can't put back DBCs another tab has since changed. The first version stored a bare array,
 * which reads as revision 0.
 */

interface DbcRecord<T> {
  revision: number;
  dbcs: T;
}

export type DbcSaveResult = 'saved' | 'conflict' | 'failed';

/** The revision this tab last read or wrote, or null before its first read. */
let dbcRevision: number | null = null;
/** Saves run one after another, so each compares against the revision the previous one wrote. */
let dbcSaving: Promise<unknown> = Promise.resolve();
let channel: BroadcastChannel | null = null;
const dbcListeners = new Set<() => void>();

function revisionOf(stored: unknown): number {
  return stored && typeof stored === 'object' && !Array.isArray(stored) ? Number((stored as DbcRecord<unknown>).revision) || 0 : 0;
}

function openChannel(): BroadcastChannel | null {
  if (channel) return channel;
  if (typeof BroadcastChannel === 'undefined') return null;
  channel = new BroadcastChannel(CHANNEL);
  channel.onmessage = (e: MessageEvent) => {
    const msg = e.data;
    if (msg?.type !== DBCS_KEY || dbcRevision === null || msg.revision === dbcRevision) return;
    for (const listener of dbcListeners) listener();
  };
  return channel;
}

export async function loadSavedDbcs<T>(): Promise<T | undefined> {
  try {
    const stored = await request<unknown>('readonly', (s) => s.get(DBCS_KEY));
    dbcRevision = revisionOf(stored);
    if (stored === undefined) return undefined;
    return (Array.isArray(stored) ? stored : (stored as DbcRecord<T>).dbcs) as T;
  } catch {
    dbcRevision ??= 0;
    return undefined;
  }
}

/** Writes `dbcs` unless another tab has saved since this one last read or wrote them. */
export function saveDbcs(dbcs: unknown): Promise<DbcSaveResult> {
  const attempt = async (): Promise<DbcSaveResult> => {
    const db = await openDb();
    return new Promise<DbcSaveResult>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      let outcome: DbcSaveResult = 'conflict';
      let written = 0;
      const read = store.get(DBCS_KEY);
      read.onsuccess = () => {
        const stored = revisionOf(read.result);
        if (stored !== (dbcRevision ?? 0)) return;
        written = stored + 1;
        store.put({ revision: written, dbcs } satisfies DbcRecord<unknown>, DBCS_KEY);
        outcome = 'saved';
      };
      tx.oncomplete = () => {
        if (outcome === 'saved') {
          dbcRevision = written;
          openChannel()?.postMessage({ type: DBCS_KEY, revision: written });
        }
        resolve(outcome);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  };
  const result = dbcSaving.then(attempt).catch((): DbcSaveResult => 'failed');
  dbcSaving = result;
  return result;
}

/** Calls `listener` when another tab saves DBCs this tab doesn't have. Returns an unsubscribe. */
export function onDbcsChangedElsewhere(listener: () => void): () => void {
  dbcListeners.add(listener);
  openChannel();
  return () => {
    dbcListeners.delete(listener);
  };
}
