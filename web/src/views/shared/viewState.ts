import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

/** 'log' state belongs to the open log and is cleared when another log is opened. */
export type ViewStateScope = 'app' | 'log';

interface Entry {
  scope: ViewStateScope;
  value: unknown;
}

/**
 * View state that outlives the view: it survives switching views and, through the shell's
 * session store, reloading the page. Values must be structured-cloneable plain data.
 */
export class ViewStateStore {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();
  /** Called after every change, so the shell can persist the store. */
  onChange: (() => void) | null = null;

  get(key: string): Entry | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: unknown, scope: ViewStateScope) {
    this.entries.set(key, { scope, value });
    this.emit();
  }

  clearScope(scope: ViewStateScope) {
    for (const [key, entry] of this.entries) if (entry.scope === scope) this.entries.delete(key);
    this.emit();
  }

  snapshot(): [string, Entry][] {
    return [...this.entries];
  }

  restore(entries: [string, Entry][]) {
    this.entries = new Map(entries);
    this.emit();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emit() {
    this.listeners.forEach((l) => l());
    this.onChange?.();
  }
}

export const ViewStateContext = createContext<ViewStateStore>(new ViewStateStore());

/**
 * Like useState, but kept by the shell: it survives switching views and reloading the page.
 * Prefix keys with the view (`plot.markers`). Use scope 'log' for anything about the open log.
 */
export function useViewState<T>(
  key: string,
  initial: T | (() => T),
  scope: ViewStateScope = 'app',
): [T, (next: T | ((prev: T) => T)) => void] {
  const store = useContext(ViewStateContext);
  const entry = useSyncExternalStore(store.subscribe, () => store.get(key));
  const value = entry ? (entry.value as T) : typeof initial === 'function' ? (initial as () => T)() : initial;

  const setValue = useCallback(
    (next: T | ((prev: T) => T)) => {
      const current = store.get(key);
      const prev = current ? (current.value as T) : typeof initial === 'function' ? (initial as () => T)() : initial;
      store.set(key, typeof next === 'function' ? (next as (p: T) => T)(prev) : next, scope);
    },
    // `initial` is only a fallback and often an inline literal; it must not churn the setter.
    [store, key, scope],
  );

  return [value, setValue];
}
