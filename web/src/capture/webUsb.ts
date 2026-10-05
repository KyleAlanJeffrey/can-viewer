/**
 * The parts of the WebUSB API the capture uses. TypeScript's DOM library leaves the API out,
 * since only Chromium browsers ship it.
 */

export interface UsbSetup {
  requestType: 'standard' | 'class' | 'vendor';
  recipient: 'device' | 'interface' | 'endpoint' | 'other';
  request: number;
  value: number;
  index: number;
}

export interface UsbInResult {
  data?: DataView;
  status: 'ok' | 'stall' | 'babble';
}

export interface UsbEndpoint {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
}

export interface UsbInterface {
  interfaceNumber: number;
  alternate: { endpoints: UsbEndpoint[] };
}

export interface UsbDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly configuration: { interfaces: UsbInterface[] } | null;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  controlTransferIn(setup: UsbSetup, length: number): Promise<UsbInResult>;
  controlTransferOut(setup: UsbSetup, data?: BufferSource): Promise<{ status: 'ok' | 'stall' }>;
  transferIn(endpointNumber: number, length: number): Promise<UsbInResult>;
  clearHalt(direction: 'in' | 'out', endpointNumber: number): Promise<void>;
}

interface Usb {
  requestDevice(options: { filters: { vendorId?: number; productId?: number }[] }): Promise<UsbDeviceLike>;
}

/** `navigator.usb`, or null where the browser has no WebUSB. */
export function webUsb(): Usb | null {
  return (navigator as Navigator & { usb?: Usb }).usb ?? null;
}
