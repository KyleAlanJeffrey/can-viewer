import type { MessageDef, RawSignalSpec, Suggestion, SuggestionKind } from '../../core/api';
import { signalBits } from '../../signalBits';
import { layoutString, plainNumber, rangeBits } from './bits';
import type { Pin } from './pins';
import type { FormState } from './SignalForm';
import { suggestionId, type Discovery } from './useDiscovery';

export const KIND_LABELS: Record<SuggestionKind, string> = {
  counter: 'Counter',
  checksum: 'Checksum',
  flag: 'Flag',
  enum: 'Enum',
  continuous: 'Continuous value',
  signed: 'Signed value',
  float: 'Float',
  multiplexor: 'Multiplexor',
};

/** Whose suggestions the Byte Values panel lists. */
export type SuggestionScope = 'selected' | 'all';

/** The Byte Values panel's width in pixels, as dragged. */
export const PANEL_WIDTH = { min: 300, max: 560, initial: 360 };

/** A suggestion as listed for one message, numbered as on the bit grid. */
export interface ShownSuggestion {
  id: string;
  number: number;
  suggestion: Suggestion;
  bits: number[];
}

/**
 * For each of the first `bitCount` payload bits, the signal of `message` covering it, if any.
 * With a `page`, signals of the message's other multiplexed pages are left out.
 */
export function bitOwners(message: MessageDef | null, bitCount: number, page: number | null = null): (string | null)[] {
  const owner = new Array<string | null>(bitCount).fill(null);
  for (const s of message?.signals ?? []) {
    if (page !== null && s.muxValue !== null && s.muxValue !== page) continue;
    for (const b of signalBits(s)) if (b >= 0 && b < owner.length && owner[b] === null) owner[b] = s.name;
  }
  return owner;
}

/**
 * The message's suggestions to list and outline: dismissed ones and ones over bits a DBC already
 * describes are left out, unless they were accepted here.
 */
export function shownSuggestions(
  discovery: Pick<Discovery, 'results' | 'dismissed' | 'accepted'>,
  key: number,
  message: MessageDef | null,
  bitCount: number,
  showDismissed = false,
): ShownSuggestion[] {
  const found = discovery.results[key]?.suggestions ?? [];
  const listed: ShownSuggestion[] = [];
  const ownersByPage = new Map<number | null, (string | null)[]>();
  for (const suggestion of found) {
    const id = suggestionId(key, suggestion);
    const bits = rangeBits(suggestion.spec);
    const page = suggestion.spec.mux?.value ?? null;
    let owners = ownersByPage.get(page);
    if (!owners) ownersByPage.set(page, (owners = bitOwners(message, bitCount, page)));
    if (!discovery.accepted[id] && bits.some((b) => owners[b])) continue;
    listed.push({ id, number: listed.length + 1, suggestion, bits });
  }
  // Numbers stay put when a suggestion is dismissed, so they keep matching the grid.
  return showDismissed ? listed : listed.filter((s) => !discovery.dismissed.has(s.id));
}

/** `bit 12`, `bits 16-31`, or the DBC layout when the bits aren't one run, as for Motorola across bytes. */
export function describeBits(spec: RawSignalSpec): string {
  const bits = rangeBits(spec);
  const lo = Math.min(...bits);
  const hi = Math.max(...bits);
  return bits.length === 1 ? `bit ${lo}` : hi - lo + 1 === bits.length ? `bits ${lo}-${hi}` : layoutString(spec, spec.signed);
}

/** The payload bytes a suggestion's bits fall in, lowest first. */
export function suggestionBytes(s: ShownSuggestion): number[] {
  return [...new Set(s.bits.map((b) => b >> 3))].sort((a, b) => a - b);
}

/** `Byte 1`, or `Bytes 2-3`. */
export function describeBytes(bytes: number[]): string {
  return bytes.length === 1 ? `Byte ${bytes[0]}` : `Bytes ${bytes[0]}-${bytes[bytes.length - 1]}`;
}

/** The pinned reference Plot it adds for a suggestion of message `key`. */
export function suggestionPin(key: number, s: ShownSuggestion): Pin {
  return {
    kind: 'range',
    key,
    spec: s.suggestion.spec,
    label: `Suggested ${KIND_LABELS[s.suggestion.kind].toLowerCase()}`,
    unit: s.suggestion.fit?.unit ?? '',
  };
}

/** The New Signal form fields that put a suggestion's bits, reading and any fitted scale in the form. */
export function suggestionForm(s: Suggestion): Partial<FormState> {
  const { spec, fit } = s;
  return {
    startBit: String(spec.startBit),
    size: String(spec.size),
    byteOrder: spec.byteOrder,
    signed: spec.signed,
    float: !!spec.float,
    multiplexor: s.kind === 'multiplexor',
    mux: spec.mux ?? null,
    fromGrid: false,
    limits: null,
    ...(fit && { factor: plainNumber(spec.factor), offset: plainNumber(spec.offset), unit: fit.unit }),
  };
}
