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

/** The frames `packFrames` packed into `bytes`. Each payload is a view into `bytes`, not a copy. */
export function unpackFrames(bytes: Uint8Array): CaptureFrame[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: CaptureFrame[] = [];
  let at = 0;
  while (at + CAPTURE_RECORD_HEADER <= bytes.length) {
    const rawId = view.getUint32(at + 8, true);
    const flags = bytes[at + 12];
    const remote = (flags & FLAG_RTR) !== 0;
    const length = remote ? 0 : bytes[at + 13];
    const start = at + CAPTURE_RECORD_HEADER;
    const frame: CaptureFrame = {
      timeNs: view.getFloat64(at, true),
      id: flags & FLAG_ERROR ? rawId & CAN_EFF_MASK : rawId & (rawId & EXT_FLAG ? CAN_EFF_MASK : 0x7ff),
      extended: (rawId & EXT_FLAG) !== 0,
      flags,
      data: bytes.subarray(start, start + length),
    };
    if (remote) frame.dlc = bytes[at + 13];
    if (start + length > bytes.length) break;
    frames.push(frame);
    at = start + length;
  }
  if (at !== bytes.length) throw new Error('some of its frames are cut short');
  return frames;
}
