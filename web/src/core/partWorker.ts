/// A worker of the pool that reads a large text or BLF log in parts: it parses one part at a time into
/// a frame store of its own and hands it, encoded, to the core worker, which joins the parts in
/// file order (see `readInParts.ts`).

import init, { parse_segment } from './pkg/can_wasm.js';
import { taskBytes, type PartTask } from './readInParts';

interface PartPort {
  onmessage: ((e: MessageEvent<PartTask>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}

const port = self as unknown as PartPort;
const ready = init();
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));
// The core worker gives a part worker a while to load before reading without it.
ready.then(
  () => port.postMessage({ ready: true }),
  (err: unknown) => port.postMessage({ startError: messageOf(err) }),
);

port.onmessage = async (e) => {
  try {
    await ready;
    const segment = parse_segment(e.data.format, e.data.head, await taskBytes(e.data));
    port.postMessage({ segment }, [segment.buffer]);
  } catch (err) {
    port.postMessage({ error: messageOf(err) });
  }
};
