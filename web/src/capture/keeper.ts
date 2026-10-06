import type { CaptureFrame } from '../core/api';
import { packFrames } from '../core/captureFrames';
import { settleWithin } from './adapter';
import { canKeepCaptures, forgetCapture, KEPT_CAPTURE_LAYOUT, keptCaptures, lockCapture, markCaptureForgotten, writeKeptCapture, type HeldCapture, type KeptCapture } from '../session';

export interface KeeperOptions {
  /** How often the frames that have arrived are written. */
  intervalMs: number;
  /** Write at once when this many frames are waiting. */
  maxFrames: number;
  /** The most that every kept capture together may store, in bytes of packed frames. */
  maxBytes: number;
  /** How often, in chunks, to look again at what other tabs' captures store. */
  recountEvery: number;
  /** Give up once this many packed bytes wait for storage that doesn't keep up. */
  maxWaitingBytes: number;
  /** How long a stop waits for the last write, which otherwise lands later, so it always finishes. */
  stopWaitMs: number;
}

/** 512 MB holds about 24 million classic frames, about what a capture holds when it stops by itself. */
export const KEEPER_DEFAULTS: KeeperOptions = { intervalMs: 1000, maxFrames: 20_000, maxBytes: 512 * 1024 ** 2, recountEvery: 30, maxWaitingBytes: 8 * 1024 ** 2, stopWaitMs: 3000 };

/** Why a capture stopped being kept: storage full, over `maxBytes`, too slow, or refused otherwise. */
export type NotKeptReason = 'full' | 'tooLarge' | 'slow' | 'failed';

/** What the app says, after naming the capture, when it stopped being kept. */
export function notKeptDetail(reason: NotKeptReason, options: KeeperOptions = KEEPER_DEFAULTS): string {
  if (reason === 'full') return 'Its storage is full.';
  if (reason === 'slow') return "Its storage couldn't keep up with the capture.";
  if (reason === 'tooLarge') return `The unsaved captures kept in this browser would need more than ${Math.round(options.maxBytes / 1024 ** 2)} MB.`;
  return 'Its storage may be full or turned off.';
}

interface StoredChunk {
  seq: number;
  lastNs: number;
  frames: number;
  bytes: number;
}

/**
 * Keeps a running capture in the browser's storage, so a reload or a crash doesn't lose it: the
 * frames the core took are packed as they come and written as one chunk every `intervalMs` (or
 * `maxFrames`), one write at a time. If storage refuses a write or falls behind, or the kept
 * captures outgrow `maxBytes`, what was stored is deleted and `onNotKept` is called; the capture
 * goes on. Frames that arrive before it has begun wait for it.
 */
export class CaptureKeeper implements HeldCapture {
  /** Called at most once, when the capture stops being kept. */
  onNotKept: ((reason: NotKeptReason) => void) | null = null;
  /** The capture this one replaces in the core, whose stored copy goes once this one begins. */
  replaces: HeldCapture | null = null;
  private state: 'idle' | 'keeping' | 'stopped' | 'gone' = 'idle';
  private capture: KeptCapture | null = null;
  private release: () => void = () => {};
  private beginning: Promise<void> = Promise.resolve();
  private begun = false;
  private finishing: Promise<void> | null = null;
  /** Set once its copy is being deleted, so no write still to land can bring it back. */
  private deleted = false;
  /** What other tabs' captures stored when last looked at. */
  private othersBytes = 0;
  private sinceRecount = 0;
  private trimmedBeforeNs: number | undefined;
  private parts: Uint8Array[] = [];
  private partBytes = 0;
  private overflowed = false;
  private partFrames = 0;
  private partLastNs = -Infinity;
  private nextSeq = 0;
  /** Stored, oldest first, for a rolling capture's drops. */
  private chunks: StoredChunk[] = [];
  private frames = 0;
  private bytes = 0;
  /** Chunks before this are to be deleted, and before `dropped` already are. */
  private dropBefore = 0;
  private dropped = 0;
  private writing: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly options: KeeperOptions;

  constructor(options: Partial<KeeperOptions> = {}) {
    this.options = { ...KEEPER_DEFAULTS, ...options };
  }

  get kept(): boolean {
    return (this.state === 'keeping' || this.state === 'stopped') && this.capture !== null;
  }

  /** Starts keeping the capture the core has just started. Never rejects. */
  begin(info: Pick<KeptCapture, 'name' | 'bus' | 'startedAtMs' | 'bitrate'>): Promise<void> {
    this.begun = true;
    this.beginning = this.start(info);
    return this.beginning;
  }

  private async start(info: Pick<KeptCapture, 'name' | 'bus' | 'startedAtMs' | 'bitrate'>) {
    const replaced = this.replaces;
    this.replaces = null;
    await replaced?.forget();
    if (this.state !== 'idle') return;
    const id = crypto.randomUUID();
    const release = canKeepCaptures() ? await lockCapture(id) : null;
    if (!release) {
      if (this.state === 'idle') this.state = 'gone';
      this.clearParts();
      return;
    }
    this.release = release;
    const othersBytes = this.state === 'idle' ? await this.countOthers(id) : 0;
    // Stopped, forgotten or given up meanwhile.
    if (this.state !== 'idle') {
      release();
      return;
    }
    this.othersBytes = othersBytes;
    this.capture = { id, ...info, layout: KEPT_CAPTURE_LAYOUT, frames: 0, bytes: 0 };
    this.state = 'keeping';
    this.timer = setInterval(() => void this.flush(), this.options.intervalMs);
    await this.flush(true);
  }

  /** Notes `frames`, which the core has taken. */
  add(frames: CaptureFrame[]) {
    if ((this.state !== 'keeping' && this.state !== 'idle') || this.overflowed || frames.length === 0) return;
    const packed = packFrames(frames);
    this.parts.push(packed);
    this.partBytes += packed.length;
    this.partFrames += frames.length;
    for (const frame of frames) this.partLastNs = Math.max(this.partLastNs, frame.timeNs);
    if (this.partBytes > this.options.maxWaitingBytes) {
      this.overflowed = true;
      this.clearParts();
      // After the write under way, so the delete takes it too.
      this.writing = this.writing.then(() => this.giveUp('slow'));
    } else if (this.partFrames >= this.options.maxFrames) {
      void this.flush();
    }
  }

  /** For a rolling capture: the core dropped frames before `beforeNs`, so whole chunks of them go too. */
  trim(beforeNs: number) {
    this.trimmedBeforeNs = beforeNs;
    while (this.chunks.length > 0 && this.chunks[0].lastNs < beforeNs) {
      const chunk = this.chunks.shift()!;
      this.dropBefore = chunk.seq + 1;
      this.frames -= chunk.frames;
      this.bytes -= chunk.bytes;
    }
  }

  /** Writes what has arrived, after any write under way. Resolves once it is written or given up. */
  flush(always = false): Promise<void> {
    this.writing = this.writing.then(() => this.write(always));
    return this.writing;
  }

  /**
   * Writes the last frames and stops writing, still holding the capture. Resolves after
   * `stopWaitMs` at most: storage that is slower goes on beginning or writing in the background.
   */
  async stop(): Promise<void> {
    // Stopped before it began, it never will.
    if (this.state === 'idle' && !this.begun) {
      this.state = 'stopped';
      return;
    }
    this.finishing ??= (async () => {
      await this.beginning;
      this.clearTimer();
      await this.flush();
      if (this.state === 'keeping') this.state = 'stopped';
    })();
    await settleWithin(this.finishing, this.options.stopWaitMs);
  }

  async forget(): Promise<void> {
    if (this.state === 'gone') return;
    const stored = this.kept;
    this.state = 'gone';
    this.deleted = true;
    this.clearTimer();
    this.clearParts();
    if (stored) markCaptureForgotten(this.capture!.id);
    // A write under way lands first, so the delete takes it too.
    await this.writing;
    // Held on to if the delete fails, so no other tab restores what was saved or replaced.
    if (!stored || (await forgetCapture(this.capture!.id))) this.release();
  }

  async letGo(): Promise<void> {
    if (this.state === 'keeping' || this.state === 'idle') await this.stop();
    if (this.state === 'gone') return;
    this.state = 'gone';
    this.release();
  }

  private async write(always: boolean) {
    if (this.state !== 'keeping' || !this.capture) return;
    const parts = this.parts;
    const frames = this.partFrames;
    const lastNs = this.partLastNs;
    const dropBefore = this.dropBefore;
    const trimmedBeforeNs = this.trimmedBeforeNs;
    if (parts.length === 0 && dropBefore === this.dropped && !always) return;
    this.clearParts();
    const bytes = concat(parts);
    const id = this.capture.id;
    const tooLarge = () => this.othersBytes + this.bytes + bytes.length > this.options.maxBytes;
    // Other tabs' captures may have been saved, or begun, since last counted.
    if (tooLarge() || (bytes.length > 0 && ++this.sinceRecount >= this.options.recountEvery)) {
      this.othersBytes = await this.countOthers(id);
      if (this.state !== 'keeping') return;
    }
    if (tooLarge()) {
      await this.giveUp('tooLarge');
      return;
    }
    const seq = this.nextSeq;
    const capture: KeptCapture = { ...this.capture, frames: this.frames + frames, bytes: this.bytes + bytes.length, trimmedBeforeNs };
    try {
      await writeKeptCapture(capture, bytes.length > 0 ? { seq, bytes: bytes.buffer as ArrayBuffer } : undefined, dropBefore, () => !this.deleted);
    } catch (e) {
      await this.giveUp((e as { name?: unknown } | null)?.name === 'QuotaExceededError' ? 'full' : 'failed');
      return;
    }
    this.dropped = dropBefore;
    if (bytes.length === 0) return;
    this.nextSeq++;
    this.frames += frames;
    this.bytes += bytes.length;
    this.chunks.push({ seq, lastNs, frames, bytes: bytes.length });
  }

  private async giveUp(reason: NotKeptReason) {
    if (this.state !== 'keeping' && this.state !== 'idle') return;
    // Not begun yet, nothing is stored, and `start` lets go.
    const stored = this.state === 'keeping';
    this.state = 'gone';
    this.deleted = true;
    this.clearTimer();
    this.clearParts();
    // Said at once: storage that is too slow may take a long time to delete too.
    this.onNotKept?.(reason);
    if (stored && (await forgetCapture(this.capture!.id))) this.release();
  }

  private async countOthers(id: string): Promise<number> {
    this.sinceRecount = 0;
    const others = (await keptCaptures()).filter((c) => c.id !== id);
    return others.reduce((sum, c) => sum + c.bytes, 0);
  }

  private clearParts() {
    this.parts = [];
    this.partBytes = 0;
    this.partFrames = 0;
    this.partLastNs = -Infinity;
  }

  private clearTimer() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const all = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}
