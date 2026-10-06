import { EXT_FLAG, FLAG_ERROR, FLAG_RTR, type CaptureFrame } from './api';

/** Bytes before each frame's payload in a packed batch; see `Session::push_frames`. */
export const CAPTURE_RECORD_HEADER = 14;

const CAN_ERR_FLAG = 0x2000_0000;
const CAN_EFF_MASK = 0x1fff_ffff;

/** The core's ID for a frame: the extended flag set, or the error flag for an error frame. */
function coreId(frame: CaptureFrame): number {
  if (frame.flags & FLAG_ERROR) return ((frame.id & CAN_EFF_MASK) | CAN_ERR_FLAG) >>> 0;
  return frame.extended ? ((frame.id & CAN_EFF_MASK) | EXT_FLAG) >>> 0 : frame.id & 0x7ff;
}

function payload(frame: CaptureFrame): Uint8Array {
  return frame.flags & FLAG_RTR ? frame.data.subarray(0, 0) : frame.data.subarray(0, 64);
}

/**
 * Packs frames into one buffer for the core worker: per frame, the time in nanoseconds (f64),
 * the core's ID (u32), the flags (u8) and the payload length (u8), little-endian, then the payload.
 * A remote frame has no payload, and its length byte is its DLC.
 */
export function packFrames(frames: CaptureFrame[]): Uint8Array {
  let size = 0;
  for (const f of frames) size += CAPTURE_RECORD_HEADER + payload(f).length;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let at = 0;
  for (const f of frames) {
    const data = payload(f);
    view.setFloat64(at, f.timeNs, true);
    view.setUint32(at + 8, coreId(f), true);
    bytes[at + 12] = f.flags;
    bytes[at + 13] = f.flags & FLAG_RTR ? (f.dlc ?? 0) & 0x0f : data.length;
    bytes.set(data, at + CAPTURE_RECORD_HEADER);
    at += CAPTURE_RECORD_HEADER + data.length;
  }
  return bytes;
}
