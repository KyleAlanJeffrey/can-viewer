import type { MessageDef, Suggestion, SuggestionKind } from '../../core/api';
import { signalBits } from '../../signalBits';
import { rangeBits } from './bits';
import { suggestionId, type Discovery } from './useDiscovery';

export const KIND_LABELS: Record<SuggestionKind, string> = {
  counter: 'Counter',
  checksum: 'Checksum',
  flag: 'Flag',
  enum: 'Enum',
  continuous: 'Continuous value',
  signed: 'Signed value',
};

/** A suggestion as listed for one message, numbered as on the bit grid. */
export interface ShownSuggestion {
  id: string;
  number: number;
  suggestion: Suggestion;
  bits: number[];
}

/** For each of the first `bitCount` payload bits, the signal of `message` covering it, if any. */
export function bitOwners(message: MessageDef | null, bitCount: number): (string | null)[] {
  const owner = new Array<string | null>(bitCount).fill(null);
  for (const s of message?.signals ?? []) {
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
  owners: (string | null)[],
  showDismissed = false,
): ShownSuggestion[] {
  const found = discovery.results[key]?.suggestions ?? [];
  const listed: ShownSuggestion[] = [];
  for (const suggestion of found) {
    const id = suggestionId(key, suggestion);
    const bits = rangeBits(suggestion.spec);
    if (!discovery.accepted[id] && bits.some((b) => owners[b])) continue;
    listed.push({ id, number: listed.length + 1, suggestion, bits });
  }
  // Numbers stay put when a suggestion is dismissed, so they keep matching the grid.
  return showDismissed ? listed : listed.filter((s) => !discovery.dismissed.has(s.id));
}
