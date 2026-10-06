/// A worker of the pool that reads a large log in parts: it parses one part of a text or BLF log at a
/// time into a frame store of its own and hands it, encoded, to the core worker, which joins the
/// parts in file order; or it reads the records of a part of an MF4 log's frames, for the core
/// worker to merge (see `readInParts.ts`).

import init, { parse_segment, read_mf4_part } from './pkg/can_wasm.js';
import { rangeBytes, taskBytes, type FramePartTask, type PartTask } from './readInParts';

interface PartPort {
  onmessage: ((e: MessageEvent<PartTask | FramePartTask>) => void) | null;
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
    const task = e.data;
    const segment = 'ranges' in task ? read_mf4_part(task.task, await rangeBytes(task.file, task.ranges)) : parse_segment(task.format, task.head, await taskBytes(task));
    port.postMessage({ segment }, [segment.buffer]);
  } catch (err) {
    port.postMessage({ error: messageOf(err) });
  }
};
