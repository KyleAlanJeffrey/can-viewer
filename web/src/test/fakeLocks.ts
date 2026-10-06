/**
 * Web Locks shared by every tab of a test, as a browser's are by every tab of a site. Only the
 * `ifAvailable` requests the app makes are supported.
 */
export class FakeLocks {
  /** Each lock held, by name, with a token for its holder. */
  private readonly held = new Map<string, object>();

  async request(name: string, options: { ifAvailable?: boolean }, callback: (lock: { name: string } | null) => unknown): Promise<unknown> {
    if (!options.ifAvailable) throw new Error('Only ifAvailable requests are supported.');
    if (this.held.has(name)) return callback(null);
    const token = {};
    this.held.set(name, token);
    try {
      return await callback({ name });
    } finally {
      // A holder that went away with `dropAll` lets go of nothing a later holder took.
      if (this.held.get(name) === token) this.held.delete(name);
    }
  }

  holds(name: string): boolean {
    return this.held.has(name);
  }

  heldNames(): Iterable<string> {
    return this.held.keys();
  }

  /** Lets go of every lock, as when the pages holding them go away. */
  dropAll() {
    this.held.clear();
  }
}

/** Gives `navigator` the Web Locks of `locks`; undo with `removeLocks`. */
export function installLocks(locks = new FakeLocks()): FakeLocks {
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
  return locks;
}

export function removeLocks() {
  delete (navigator as { locks?: unknown }).locks;
}
