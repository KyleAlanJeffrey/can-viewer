import type { CaptureFrame } from '../core/api';

export interface BatcherOptions {
  /** How often what has arrived is sent. */
  intervalMs: number;
  /** Send at once when this many frames are waiting, rather than waiting for the timer. */
  maxFrames: number;
}

const DEFAULTS: BatcherOptions = { intervalMs: 100, maxFrames: 5000 };

/**
 * Gathers frames as they arrive and sends them on in batches, one batch at a time and in the
 * order they came. Nothing is sent until `start`. Once a send fails, the batcher sends nothing
 * more and calls `onError` once.
 */
export class FrameBatcher {
  private waiting: CaptureFrame[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private started = false;
  private failed = false;
  private sending: Promise<void> = Promise.resolve();
  private readonly options: BatcherOptions;

  constructor(
    private readonly send: (frames: CaptureFrame[]) => Promise<void>,
    private readonly onError: (e: unknown) => void,
    options: Partial<BatcherOptions> = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Frames waiting to be sent. */
  get pending(): number {
    return this.waiting.length;
  }

  add(frames: CaptureFrame[]) {
    if (this.failed) return;
    for (const frame of frames) this.waiting.push(frame);
    if (this.started && this.waiting.length >= this.options.maxFrames) void this.flush();
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => void this.flush(), this.options.intervalMs);
    if (this.waiting.length >= this.options.maxFrames) void this.flush();
  }

  /** Sends what has arrived, after any batch already on its way. Resolves once that is sent. */
  flush(): Promise<void> {
    if (!this.started || this.failed || this.waiting.length === 0) return this.sending;
    const batch = this.waiting;
    this.waiting = [];
    this.sending = this.sending.then(async () => {
      if (this.failed) return;
      try {
        await this.send(batch);
      } catch (e) {
        this.failed = true;
        this.waiting = [];
        this.onError(e);
      }
    });
    return this.sending;
  }

  /** Stops the timer and sends the last frames. */
  async stop(): Promise<void> {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
    this.started = false;
  }
}
