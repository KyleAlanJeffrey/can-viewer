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

/*
 * An unsaved capture is kept as it runs, as chunks of frames packed by `packFrames`, so a reload
 * or a crash doesn't lose it. The tab keeping one holds a Web Lock named for it until it lets go
 * or the page goes away; a page load restores only a capture whose lock it can take, so no tab
 * restores, or deletes, a capture another tab still has open. Without Web Locks nothing is kept.
 */

/** The frame layout of the chunks: `packFrames`'. A capture kept in another is dropped. */
export const KEPT_CAPTURE_LAYOUT = 1;

/** What is stored about a kept capture besides its chunks. */
export interface KeptCapture {
  id: string;
  name: string;
  bus: string;
  /** As given to `CoreApi.startCapture`. */
  startedAtMs: number;
  bitrate: number;
  layout: number;
  frames: number;
  /** Bytes of chunks stored. */
  bytes: number;
  /** For a rolling capture, where the core last dropped frames before, in ns; chunks may hold some. */
  trimmedBeforeNs?: number;
  /** Restores begun since it last restored that failed, or ended with the page crashing or killed. */
  failedRestores?: number;
  /** Why the last restore failed, if it failed rather than went away with the page. */
  lastRestoreError?: string;
}

/** An unsaved capture this tab keeps, which no other tab will restore or delete meanwhile. */
export interface HeldCapture {
  /** Whether a copy is stored, so a reload would restore it. */
  readonly kept: boolean;
  /** Deletes the stored copy, as the capture was saved or replaced, then lets go of it; holds on if the delete fails. */
  forget(): Promise<void>;
  /** Lets go of it, leaving what is stored for the next page load to restore. */
  letGo(): Promise<void>;
}

const capturesRange = () => IDBKeyRange.bound(['capture'], ['capture', []]);
const chunksRange = (id: string, from = 0, to: number | never[] = []) => IDBKeyRange.bound(['capture-chunk', id, from], ['capture-chunk', id, to], false, true);

function transaction(mode: IDBTransactionMode, run: (store: IDBObjectStore) => void, durability: IDBTransactionDurability = 'default'): Promise<void> {
  return openDb().then(
    (db) =>
      new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, mode, { durability });
        run(tx.objectStore(STORE));
        // At once, so a write as the page goes away lands before the page does. Not a read:
        // Chrome then completes it without the result of a getAll of large values.
        if (mode === 'readwrite') tx.commit?.();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

const listKeptCaptures = () => request<KeptCapture[]>('readonly', (s) => s.getAll(capturesRange()));

/** Every capture kept, whoever holds it. */
export async function keptCaptures(): Promise<KeptCapture[]> {
  try {
    return await listKeptCaptures();
  } catch {
    return [];
  }
}

/** The kept capture `id`, or undefined if there is none or storage can't be read. */
export async function keptCapture(id: string): Promise<KeptCapture | undefined> {
  try {
    return await request<KeptCapture | undefined>('readonly', (s) => s.get(['capture', id]));
  } catch {
    return undefined;
  }
}

/**
 * Stores `capture` with `chunk` as its chunk number `seq` (if any), deleting its chunks before
 * `dropBefore`, all at once. Rejects with the browser's error, a `QuotaExceededError` when full.
 * Writes nothing if, once storage is open, the capture is being deleted or `wanted` says no.
 */
export function writeKeptCapture(capture: KeptCapture, chunk?: { seq: number; bytes: ArrayBuffer }, dropBefore = 0, wanted = () => true): Promise<void> {
  // Relaxed: a chunk lost to a power cut is acceptable, and not waiting for the disk keeps writes cheap.
  return transaction(
    'readwrite',
    (store) => {
      // A write that waited on storage must not bring back a capture deleted meanwhile.
      if (!wanted() || forgottenCaptures().includes(capture.id)) return;
      if (dropBefore > 0) store.delete(chunksRange(capture.id, 0, dropBefore));
      if (chunk) store.put(chunk.bytes, ['capture-chunk', capture.id, chunk.seq]);
      store.put(capture, ['capture', capture.id]);
    },
    'relaxed',
  );
}

/** The capture IDs in `localStorage` under `key`, shared by every tab. */
function storedIds(key: string): string[] {
  try {
    const ids: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function storeIds(key: string, ids: string[]) {
  try {
    if (ids.length > 0) localStorage.setItem(key, JSON.stringify(ids));
    else localStorage.removeItem(key);
  } catch {
    // Without localStorage, what these IDs note is lost, which costs at most one restore.
  }
}

const FORGOTTEN_KEY = 'freecan-studio.forgotten-captures';

/** Kept captures meant to be deleted, in case a delete fails or the page goes first. */
const forgottenCaptures = () => storedIds(FORGOTTEN_KEY);
const setForgottenCaptures = (ids: string[]) => storeIds(FORGOTTEN_KEY, ids);

/**
 * Deletes a kept capture and its chunks, trying twice. Resolves false if storage refused; it
 * stays marked as forgotten, so no page load restores it, and the next claim deletes it.
 */
export async function forgetCapture(id: string): Promise<boolean> {
  setForgottenCaptures([...forgottenCaptures().filter((other) => other !== id), id]);
  for (let tries = 0; tries < 2; tries++) {
    try {
      await transaction('readwrite', (store) => {
        store.delete(chunksRange(id));
        store.delete(['capture', id]);
      });
      setForgottenCaptures(forgottenCaptures().filter((other) => other !== id));
      return true;
    } catch {
      // Tried again, then left to the next claim.
    }
  }
  return false;
}

const RESTORE_LEFT_KEY = 'freecan-studio.restore-interrupted';

/** Notes, as the page goes away, that its restore of capture `id` was cut short by a reload or a close, not a crash. */
export function markRestoreLeft(id: string) {
  storeIds(RESTORE_LEFT_KEY, [...storedIds(RESTORE_LEFT_KEY).filter((other) => other !== id), id]);
}

/** Whether the last restore of capture `id` was cut short by the page going away, forgetting the note. */
export function takeRestoreLeft(id: string): boolean {
  const left = storedIds(RESTORE_LEFT_KEY);
  if (!left.includes(id)) return false;
  storeIds(RESTORE_LEFT_KEY, left.filter((other) => other !== id));
  return true;
}

/** Calls `each` with each chunk of a kept capture in order, reading a few at a time. */
export async function readCaptureChunks(id: string, each: (bytes: Uint8Array) => Promise<void>): Promise<void> {
  let from = 0;
  for (;;) {
    let keys: IDBValidKey[] = [];
    let values: ArrayBuffer[] = [];
    await transaction('readonly', (store) => {
      const range = chunksRange(id, from);
      const gotKeys = store.getAllKeys(range, 8);
      const gotValues = store.getAll(range, 8);
      gotKeys.onsuccess = () => (keys = gotKeys.result);
      gotValues.onsuccess = () => (values = gotValues.result);
    });
    if (values.length === 0) return;
    for (const value of values) await each(new Uint8Array(value));
    from = ((keys[keys.length - 1] as [string, string, number])[2]) + 1;
  }
}

const lockName = (id: string) => `freecan-studio-capture-${id}`;

/**
 * Takes the lock on capture `id` if no tab holds it, resolving with the function that lets it go,
 * or null when another tab holds it or the browser has no Web Locks.
 */
export function lockCapture(id: string): Promise<(() => void) | null> {
  if (typeof navigator === 'undefined' || !navigator.locks) return Promise.resolve(null);
  return new Promise((resolve) => {
    navigator.locks
      .request(lockName(id), { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        // Held until this promise settles.
        return new Promise<void>((release) => resolve(() => release()));
      })
      .catch(() => resolve(null));
  });
}

/** Whether this browser can keep a capture: it needs Web Locks to tell which tab has one. */
export const canKeepCaptures = () => typeof navigator !== 'undefined' && !!navigator.locks;

/**
 * The most recent kept capture no tab holds, now held by this one, to restore after a reload or
 * a crash. Captures held by no tab that can't be restored (no frames, an older layout), or whose
 * delete failed, are deleted.
 */
export async function claimKeptCapture(): Promise<{ capture: KeptCapture; held: HeldCapture } | undefined> {
  if (!canKeepCaptures()) return undefined;
  let kept: KeptCapture[];
  try {
    kept = (await listKeptCaptures()).sort((a, b) => b.startedAtMs - a.startedAtMs);
  } catch {
    return undefined;
  }
  // Deleted since; another tab writing the list meanwhile may lose an ID, costing one restore.
  const forgotten = forgottenCaptures().filter((id) => kept.some((c) => c.id === id));
  setForgottenCaptures(forgotten);
  for (const listed of kept) {
    const release = await lockCapture(listed.id);
    if (!release) continue;
    if (forgotten.includes(listed.id)) {
      await forgetCapture(listed.id);
      release();
      continue;
    }
    // Its tab may have deleted it, or written more, before letting go.
    const capture = await keptCapture(listed.id);
    if (capture?.layout === KEPT_CAPTURE_LAYOUT && capture.frames > 0) return { capture, held: heldCapture(capture.id, release) };
    if (!capture || (await forgetCapture(capture.id))) release();
  }
  return undefined;
}

function heldCapture(id: string, release: () => void): HeldCapture {
  let kept = true;
  let held = true;
  return {
    get kept() {
      return kept;
    },
    async forget() {
      if (!held) return;
      held = false;
      kept = false;
      // Deleted before the lock goes, so no other tab can restore it meanwhile.
      if (await forgetCapture(id)) release();
    },
    async letGo() {
      if (!held) return;
      held = false;
      release();
    },
  };
}
