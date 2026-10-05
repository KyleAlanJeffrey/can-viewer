import type { Suggestion, SuggestionKind } from '../../core/api';
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
