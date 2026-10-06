import type { CaptureFrame } from '../core/api';
import { packFrames } from '../core/captureFrames';
import { canKeepCaptures, forgetCapture, KEPT_CAPTURE_LAYOUT, keptCaptures, lockCapture, writeCaptureChunk, type HeldCapture, type KeptCapture } from '../session';

export interface KeeperOptions {
  /** How often the frames that have arrived are written. */
  intervalMs: number;
  /** Write at once when this many frames are waiting. */
  maxFrames: number;
  /** The most that every kept capture together may store, in bytes of packed frames. */
  maxBytes: number;
}

/** 512 MB holds about 24 million classic frames, about what a capture holds when it stops by itself. */
export const KEEPER_DEFAULTS: KeeperOptions = { intervalMs: 1000, maxFrames: 20_000, maxBytes: 512 * 1024 ** 2 };

/** Why a capture stopped being kept: storage full, over `maxBytes`, or storage refused otherwise. */
export type NotKeptReason = 'full' | 'tooLarge' | 'failed';

/** What the app says, after naming the capture, when it stopped being kept. */
export function notKeptDetail(reason: NotKeptReason, options: KeeperOptions = KEEPER_DEFAULTS): string {
  if (reason === 'full') return 'Its storage is full.';
  if (reason === 'tooLarge') return `It needs more than the ${Math.round(options.maxBytes / 1024 ** 2)} MB kept for unsaved captures.`;
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
 * `maxFrames`), one write at a time. If storage refuses a write or the capture outgrows
 * `maxBytes`, what was stored is deleted and `onNotKept` is called; the capture goes on.
 */
export class CaptureKeeper implements HeldCapture {
  /** Called at most once, when the capture stops being kept. */
  onNotKept: ((reason: NotKeptReason) => void) | null = null;
  /** The capture this one replaces in the core, whose stored copy goes once this one begins. */
  replaces: HeldCapture | null = null;
  private state: 'idle' | 'keeping' | 'stopped' | 'gone' = 'idle';
  private capture: KeptCapture | null = null;
  private release: () => void = () => {};
  private budget = 0;
  private parts: Uint8Array[] = [];
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
  async begin(info: Pick<KeptCapture, 'name' | 'bus' | 'startedAtMs' | 'bitrate'>): Promise<void> {
    const replaced = this.replaces;
    this.replaces = null;
    await replaced?.forget();
    if (this.state !== 'idle' || !canKeepCaptures()) return;
    const id = crypto.randomUUID();
    const release = await lockCapture(id);
    if (!release) return;
    this.release = release;
    const others = this.state === 'idle' ? await keptCaptures() : [];
    // Stopped or forgotten meanwhile.
    if (this.state !== 'idle') {
      release();
      return;
    }
    this.budget = this.options.maxBytes - others.reduce((sum, c) => sum + c.bytes, 0);
    this.capture = { id, ...info, layout: KEPT_CAPTURE_LAYOUT, frames: 0, bytes: 0 };
    this.state = 'keeping';
    this.timer = setInterval(() => void this.flush(), this.options.intervalMs);
    await this.flush(true);
  }

  /** Notes `frames`, which the core has taken. */
  add(frames: CaptureFrame[]) {
    if (this.state !== 'keeping' || frames.length === 0) return;
    this.parts.push(packFrames(frames));
    this.partFrames += frames.length;
    for (const frame of frames) this.partLastNs = Math.max(this.partLastNs, frame.timeNs);
    if (this.partFrames >= this.options.maxFrames) void this.flush();
  }

  /** For a rolling capture: the core dropped frames before `beforeNs`, so whole chunks of them go too. */
  trim(beforeNs: number) {
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

  /** Writes the last frames and stops writing, still holding the capture. */
  async stop(): Promise<void> {
    this.clearTimer();
    await this.flush();
    // Stopped before it began, it never will.
    if (this.state === 'keeping' || this.state === 'idle') this.state = 'stopped';
  }

  async forget(): Promise<void> {
    if (this.state === 'gone') return;
    const stored = this.kept;
    this.state = 'gone';
    this.clearTimer();
    this.parts = [];
    // A write under way lands first, so the delete takes it too.
    await this.writing;
    if (stored) await forgetCapture(this.capture!.id);
    this.release();
  }

  async letGo(): Promise<void> {
    if (this.state === 'keeping') await this.stop();
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
    if (parts.length === 0 && dropBefore === this.dropped && !always) return;
    this.parts = [];
    this.partFrames = 0;
    this.partLastNs = -Infinity;
    const bytes = concat(parts);
    if (this.bytes + bytes.length > this.budget) {
      await this.giveUp('tooLarge');
      return;
    }
    const seq = this.nextSeq;
    const capture = { ...this.capture, frames: this.frames + frames, bytes: this.bytes + bytes.length };
    try {
      await writeCaptureChunk(capture, bytes.length > 0 ? { seq, bytes: bytes.buffer as ArrayBuffer } : undefined, dropBefore);
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
    if (this.state !== 'keeping') return;
    this.state = 'gone';
    this.clearTimer();
    this.parts = [];
    await forgetCapture(this.capture!.id);
    this.release();
    this.onNotKept?.(reason);
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
