import { cleanup } from '@testing-library/react';
import { IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { afterEach } from 'vitest';

// Stand-ins for the browser APIs jsdom lacks. They do nothing; tests check the DOM, not pixels.

afterEach(() => cleanup());

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;

// Tests stub `indexedDB` with fake-indexeddb, whose key ranges are its own.
globalThis.IDBKeyRange ??= FakeIDBKeyRange;

window.matchMedia ??= (media: string) =>
  ({
    matches: false,
    media,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }) as MediaQueryList;

if (!('fonts' in document)) {
  Object.defineProperty(document, 'fonts', {
    value: { load: () => Promise.resolve([]), ready: Promise.resolve() },
  });
}

/** A 2D context whose every method is a no-op, enough for uPlot and the canvas views to draw nothing. */
function noopContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const methods = new Map<PropertyKey, unknown>();
  const values = new Map<PropertyKey, unknown>([
    ['canvas', canvas],
    ['measureText', () => ({ width: 0, actualBoundingBoxAscent: 0, actualBoundingBoxDescent: 0 })],
    ['getImageData', (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h })],
    ['createLinearGradient', () => ({ addColorStop() {} })],
    ['getLineDash', () => []],
  ]);
  return new Proxy({} as CanvasRenderingContext2D, {
    get(_target, prop) {
      if (values.has(prop)) return values.get(prop);
      if (!methods.has(prop)) methods.set(prop, () => undefined);
      return methods.get(prop);
    },
    set(_target, prop, value) {
      values.set(prop, value);
      return true;
    },
  });
}
class NoopPath2D {
  addPath() {}
  closePath() {}
  moveTo() {}
  lineTo() {}
  bezierCurveTo() {}
  quadraticCurveTo() {}
  arc() {}
  arcTo() {}
  ellipse() {}
  rect() {}
  roundRect() {}
}
globalThis.Path2D ??= NoopPath2D as unknown as typeof Path2D;

HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) {
  return noopContext(this);
} as unknown as HTMLCanvasElement['getContext'];

Element.prototype.scrollIntoView ??= function () {};

// jsdom has the dialog element but not its modal methods.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  if (!this.open) return;
  this.open = false;
  this.dispatchEvent(new Event('close'));
};
