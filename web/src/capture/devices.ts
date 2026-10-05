import type { CaptureAdapter } from './adapter';
import { GS_USB_FILTERS, GsUsbAdapter } from './gsUsb';
import { SlcanAdapter } from './slcan';
import { webSerial } from './webSerial';
import { webUsb } from './webUsb';

export type AdapterKind = 'slcan' | 'gsusb';

export const ADAPTER_KINDS: { kind: AdapterKind; label: string; detail: string }[] = [
  {
    kind: 'slcan',
    label: 'Serial (slcan)',
    detail: 'CANable with slcan firmware, USBtin, Lawicel CANUSB and other slcan adapters, through Web Serial.',
  },
  {
    kind: 'gsusb',
    label: 'USB (candleLight)',
    detail: 'candleLight, CANable with candleLight firmware and other gs_usb adapters, through WebUSB.',
  },
];

/** The adapter kinds this browser can reach: none in Firefox and Safari. */
export function availableKinds(): AdapterKind[] {
  const kinds: AdapterKind[] = [];
  if (webSerial()) kinds.push('slcan');
  if (webUsb()) kinds.push('gsusb');
  return kinds;
}

/**
 * Shows the browser's device prompt for `kind`. Call it straight from a click, or the browser
 * refuses. Resolves null when the prompt is dismissed.
 */
export async function requestAdapter(kind: AdapterKind): Promise<CaptureAdapter | null> {
  try {
    if (kind === 'slcan') {
      const serial = webSerial();
      return serial ? new SlcanAdapter(await serial.requestPort()) : null;
    }
    const usb = webUsb();
    return usb ? new GsUsbAdapter(await usb.requestDevice({ filters: GS_USB_FILTERS })) : null;
  } catch (e) {
    if ((e as { name?: string } | null)?.name === 'NotFoundError') return null;
    throw e;
  }
}
