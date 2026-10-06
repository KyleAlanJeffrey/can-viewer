import { webSerial } from './webSerial';
import { webUsb } from './webUsb';

export type AdapterKind = 'slcan' | 'gsusb';

/**
 * The adapter kinds this browser can reach: none in Firefox and Safari. Kept apart from the
 * adapters, so the welcome can ask without loading them.
 */
export function availableKinds(): AdapterKind[] {
  const kinds: AdapterKind[] = [];
  if (webSerial()) kinds.push('slcan');
  if (webUsb()) kinds.push('gsusb');
  return kinds;
}
