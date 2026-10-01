/**
 * Packed trace rows from `Session::rows` (crates/can-wasm/src/lib.rs), little-endian:
 *
 *   0  f64  time in seconds from the first frame
 *   8  u32  arbitration ID, bit 31 set for extended IDs
 *  12  u32  frame index in the log
 *  16  u8   channel
 *  17  u8   flags
 *  18  u8   payload length in the row, at most 64
 *  20  u16  full payload length, above 64 only for reassembled J1939 transfers
 *  24  u64  bit k set when byte k differs from the previous frame of the same ID
 *  32  64B  payload
 */
export const ROW_STRIDE = 96;

export class RowBatch {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;

  constructor(
    readonly key: number,
    readonly start: number,
    buffer: ArrayBuffer,
  ) {
    this.view = new DataView(buffer);
    this.bytes = new Uint8Array(buffer);
  }

  get length(): number {
    return this.bytes.length / ROW_STRIDE;
  }

  time(i: number): number {
    return this.view.getFloat64(i * ROW_STRIDE, true);
  }

  id(i: number): number {
    return this.view.getUint32(i * ROW_STRIDE + 8, true);
  }

  index(i: number): number {
    return this.view.getUint32(i * ROW_STRIDE + 12, true);
  }

  channel(i: number): number {
    return this.bytes[i * ROW_STRIDE + 16];
  }

  flags(i: number): number {
    return this.bytes[i * ROW_STRIDE + 17];
  }

  len(i: number): number {
    return this.bytes[i * ROW_STRIDE + 18];
  }

  /** The frame's whole payload length; `CoreApi.frameData` fetches bytes past the 64 in `data(i)`. */
  fullLength(i: number): number {
    return this.view.getUint16(i * ROW_STRIDE + 20, true);
  }

  changed(i: number, byte: number): boolean {
    const word = this.view.getUint32(i * ROW_STRIDE + (byte < 32 ? 24 : 28), true);
    return ((word >>> (byte & 31)) & 1) === 1;
  }

  data(i: number): Uint8Array {
    const at = i * ROW_STRIDE + 32;
    return this.bytes.subarray(at, at + this.len(i));
  }
}
