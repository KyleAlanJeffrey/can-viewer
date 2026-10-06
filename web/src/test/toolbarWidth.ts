import { act } from '@testing-library/react';
import { vi } from 'vitest';

/**
 * Gives the toolbar a width, and its view switcher one, as jsdom lays nothing out. `resize`
 * changes the toolbar's width and tells its observers, as the browser would. Undo it with
 * `vi.restoreAllMocks()` and `vi.unstubAllGlobals()`.
 */
export function stubToolbarWidth(width: number, switcherWidth = 480) {
  let current = width;
  // Only the toolbar's observers hear of a resize; the rest stay as quiet as setup.ts has them.
  const toolbarObservers = new Map<ResizeObserver, { callback: ResizeObserverCallback; target: Element }>();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return new DOMRect(0, 0, this.classList.contains('toolbar') ? current : 0, 0);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('view-switcher') ? switcherWidth : 0;
  });
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        if (target.classList.contains('toolbar')) toolbarObservers.set(this as unknown as ResizeObserver, { callback: this.callback, target });
      }
      unobserve() {}
      disconnect() {
        toolbarObservers.delete(this as unknown as ResizeObserver);
      }
    },
  );
  return {
    resize(next: number) {
      current = next;
      act(() => {
        for (const [observer, { callback, target }] of toolbarObservers) {
          callback([{ target, contentRect: new DOMRect(0, 0, next, 0) } as unknown as ResizeObserverEntry], observer);
        }
      });
    },
  };
}
