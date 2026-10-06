import { useViewState } from './viewState';

/** View state key of the bitrate of each bus, by bus name; it belongs to the open log. */
export const BUS_BITRATES_KEY = 'overview.bitrates';
/** Assumed for a bus nobody set: the most common rate on cars and trucks. */
export const DEFAULT_BUS_BITRATE = 500_000;

export type BusBitrates = Record<string, number>;

export function bitrateOf(bitrates: BusBitrates, bus: string): number {
  return bitrates[bus] ?? DEFAULT_BUS_BITRATE;
}

/** The bitrate of each bus of the open log, and a setter for one bus. */
export function useBusBitrates(): [BusBitrates, (bus: string, bitrate: number) => void] {
  const [bitrates, setBitrates] = useViewState<BusBitrates>(BUS_BITRATES_KEY, {}, 'log');
  return [bitrates, (bus, bitrate) => setBitrates((prev) => ({ ...prev, [bus]: bitrate }))];
}
