/**
 * The last session, kept in IndexedDB so a reload picks up where the user left off. Everything
 * stays in this browser. Storage can be unavailable (private windows, blocked site data) or full,
 * so every call fails soft: reads resolve to undefined and writes report failure.
 */

const DB_NAME = 'freecan-studio';
const STORE = 'session';

export type SessionKey = 'log' | 'dbcs' | 'ui' | 'views';

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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

export async function loadSaved<T>(key: SessionKey): Promise<T | undefined> {
  try {
    return await request<T | undefined>('readonly', (s) => s.get(key));
  } catch {
    return undefined;
  }
}

/** Resolves false when the browser refused the write, for example because storage is full. */
export async function save(key: SessionKey, value: unknown): Promise<boolean> {
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
