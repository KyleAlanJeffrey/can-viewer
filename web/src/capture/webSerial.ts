/**
 * The parts of the Web Serial API the capture uses. TypeScript's DOM library leaves the API out,
 * since only Chromium browsers ship it.
 */

export interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialPortLike {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): SerialPortInfo;
}

interface Serial {
  requestPort(options?: { filters?: SerialPortInfo[] }): Promise<SerialPortLike>;
}

/** `navigator.serial`, or null where the browser has no Web Serial. */
export function webSerial(): Serial | null {
  return (navigator as Navigator & { serial?: Serial }).serial ?? null;
}
