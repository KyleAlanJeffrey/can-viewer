import type { CoreApi, LogInfo } from '../core/api';
import { errorText, type CaptureAdapter, type CaptureSettings } from './adapter';
import { FrameBatcher, type BatcherOptions } from './batcher';

/** The bus name a capture's frames are stored under. */
export const CAPTURE_CHANNEL = 'can0';
/** The frame rate is averaged over about this long. */
const RATE_WINDOW_MS = 2000;

export interface CaptureStatus {
  /** Frames received so far. */
  frames: number;
  /** Frames per second over the last two seconds, or null right after the start. */
  rate: number | null;
  elapsedS: number;
  /** Lines that didn't parse, errors from the adapter or the serial port. */
  problems: number;
  lastProblem: string | null;
}

export interface RecorderClock {
  /** Monotonic milliseconds, as `performance.now()`. */
  now(): number;
  /** Milliseconds since the Unix epoch, as `Date.now()`. */
  wallNow(): number;
}

const BROWSER_CLOCK: RecorderClock = { now: () => performance.now(), wallNow: () => Date.now() };

/** A file name for a capture started at `date`, in local time: `capture-20261005-143210.log`. */
export function captureName(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}`;
  return `capture-${day}-${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}.log`;
}

/**
 * Runs one capture: starts the adapter, times its frames with the host clock and feeds them to
 * the core in batches, then ends the capture in the core when stopped.
 */
export class CaptureRecorder {
  /** The capture as the core last reported it. */
  info: LogInfo | null = null;
  /** Called once if the capture ends without `stop`: the adapter went away or the core failed. */
  onEnd: ((message: string) => void) | null = null;
  private frames = 0;
  private problems = 0;
  private lastProblem: string | null = null;
  private origin = 0;
  private samples: [number, number][] = [];
  private ended = false;
  private stopping: Promise<LogInfo> | null = null;
  private readonly batcher: FrameBatcher;

  constructor(
    private readonly core: CoreApi,
    private readonly adapter: CaptureAdapter,
    readonly name: string,
    private readonly clock: RecorderClock = BROWSER_CLOCK,
    batching: Partial<BatcherOptions> = {},
  ) {
    this.batcher = new FrameBatcher(
      async (frames) => {
        this.info = await this.core.appendFrames(frames);
      },
      (e) => this.end(`The capture stopped because the CAN core failed: ${errorText(e)}`),
      batching,
    );
  }

  /**
   * Starts the adapter, then the capture in the core. Rejects, with nothing changed in the core,
   * if the adapter can't start. Resolves with whether the adapter really listens only.
   */
  async start(settings: CaptureSettings): Promise<{ info: LogInfo; listenOnly: boolean }> {
    this.origin = this.clock.now();
    const startedAtMs = this.clock.wallNow();
    const started = await this.adapter.start(
      settings,
      {
        onFrames: (frames) => {
          this.frames += frames.length;
          this.batcher.add(frames);
        },
        onProblem: (message) => {
          this.problems += 1;
          this.lastProblem = message;
        },
        onEnd: (message) => this.end(message),
      },
      () => Math.round((this.clock.now() - this.origin) * 1e6),
    );
    try {
      this.info = await this.core.startCapture(this.name, CAPTURE_CHANNEL, startedAtMs);
    } catch (e) {
      await this.adapter.stop();
      throw e;
    }
    this.batcher.start();
    return { info: this.info, listenOnly: started.listenOnly };
  }

  status(): CaptureStatus {
    const now = this.clock.now();
    this.samples.push([now, this.frames]);
    while (this.samples.length > 2 && now - this.samples[1][0] >= RATE_WINDOW_MS) this.samples.shift();
    const [since, framesThen] = this.samples[0];
    const span = now - since;
    return {
      frames: this.frames,
      rate: span >= 500 ? ((this.frames - framesThen) * 1000) / span : null,
      elapsedS: (now - this.origin) / 1000,
      problems: this.problems,
      lastProblem: this.lastProblem,
    };
  }

  /** Stops the adapter, hands the core the last frames and ends the capture there. */
  stop(): Promise<LogInfo> {
    this.ended = true;
    this.stopping ??= (async () => {
      await this.adapter.stop();
      await this.batcher.stop();
      this.info = await this.core.endCapture();
      return this.info;
    })();
    return this.stopping;
  }

  private end(message: string) {
    if (this.ended) return;
    this.ended = true;
    this.onEnd?.(message);
  }
}
