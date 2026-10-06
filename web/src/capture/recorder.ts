import type { CaptureFrame, CoreApi, LogInfo } from '../core/api';
import { formatCount, formatCountOf, formatDuration } from '../format';
import { errorText, formatBitrate, type CaptureAdapter, type CaptureSettings } from './adapter';
import { FrameBatcher, type BatcherOptions } from './batcher';

/** The bus name a capture's frames are stored under when the settings name none. */
export const CAPTURE_CHANNEL = 'can0';
/**
 * A rolling capture is trimmed once its oldest frame is this share of the window past it, or
 * this long, whichever is more, so the store is rebuilt now and then rather than every batch.
 */
const TRIM_SLACK_SHARE = 0.1;
const MIN_TRIM_SLACK_NS = 10e9;
/**
 * How far past the computer's clock a frame's time may move a rolling capture's window, so one
 * frame timed far ahead (a glitch in the adapter's clock) can't drop the frames still in it.
 */
const MAX_AHEAD_OF_HOST_NS = 1e9;
/** The frame rate is averaged over about this long. */
const RATE_WINDOW_MS = 2000;
/**
 * A conservative share of the 4 GB a wasm32 core can address, as the views and saving the
 * capture need memory too.
 */
const MEMORY_BUDGET_BYTES = 2 * 1024 ** 3;
/** A frame's columns in the core besides its payload: time, ID, bus, flags, payload start, ID index row. */
const FRAME_COLUMN_BYTES = 24;

/** Roughly what `frame` costs in the core. Doubled, as the core's columns grow by doubling. */
export function captureFrameBytes(frame: CaptureFrame): number {
  return 2 * (FRAME_COLUMN_BYTES + frame.data.length);
}

/** In bytes of core memory, as `captureFrameBytes` counts them. */
export interface CaptureLimits {
  /** After this the user is told to save soon. */
  warnBytes: number;
  /** The capture stops by itself before this, so the core can't run out of memory. */
  maxBytes: number;
}

/**
 * Warns at half the budget, so there is room to save, and stops at three quarters: about 16.8
 * and 25.2 million classic 8-byte frames, or 6.1 and 9.2 million 64-byte CAN FD frames.
 */
export const CAPTURE_LIMITS: CaptureLimits = {
  warnBytes: MEMORY_BUDGET_BYTES * 0.5,
  maxBytes: MEMORY_BUDGET_BYTES * 0.75,
};

export interface CaptureStatus {
  /** Frames received so far. */
  frames: number;
  /** Frames per second over the last two seconds, or null right after the start. */
  rate: number | null;
  elapsedS: number;
  /** Lines that didn't parse, errors from the adapter or the serial port. */
  problems: number;
  lastProblem: string | null;
  /** The capture is big enough that it should be saved soon; it stops before `maxBytes`. */
  nearLimit: boolean;
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
 * Runs one capture: starts the adapter with the host clock to time its frames by, feeds them to
 * the core in batches, then ends the capture in the core when stopped.
 */
export class CaptureRecorder {
  /** The capture as the core last reported it. */
  info: LogInfo | null = null;
  /** What the app shows and announces about this capture, kept here to keep it out of the main chunk. */
  readonly text = {
    /** The recording status, what matters most first, as the toolbar may cut its end off. */
    summary: (status: CaptureStatus): string => {
      const parts = [
        status.problems > 0 ? formatCountOf(status.problems, 'error', 'errors') : null,
        this.listenOnly ? 'Listen only' : null,
        formatCountOf(status.frames, 'frame', 'frames'),
        stopwatch(status.elapsedS),
        status.rate === null ? null : `${formatCount(Math.round(status.rate))}/s`,
      ];
      return parts.filter((p) => p !== null).join(' \u00b7 ');
    },
    /** The whole recording status, for the status line's tooltip. */
    title: (status: CaptureStatus): string => {
      const rate = status.rate === null ? '' : ` at ${formatCount(Math.round(status.rate))} frames/s`;
      const lines = [
        `Recording ${this.bus} from ${this.adapter.label}${this.channel ? ` channel ${this.channel + 1}` : ''} at ${formatBitrate(this.bitrate)}${this.dataBitrate ? `, CAN FD data ${formatBitrate(this.dataBitrate)}` : ''}, ${this.listenOnly ? 'listen only' : 'not listen only'}.`,
        `${formatCountOf(status.frames, 'frame', 'frames')}${rate} in ${formatDuration(status.elapsedS)}.`,
      ];
      if (this.keepNs !== null) lines.push(`Keeping only about the last ${this.keepNs / 60e9} min.`);
      if (status.problems > 0) lines.push(`${formatCountOf(status.problems, 'error', 'errors')}. The last: ${status.lastProblem}`);
      return lines.join('\n');
    },
    started: () => `Recording from ${this.adapter.label}${this.listenOnly ? ', listen only' : ''}.`,
    listenOnlyUnconfirmed: "Listen-only mode isn't confirmed for this adapter, so it may acknowledge the frames it receives.",
    problem: (status: CaptureStatus) => `The adapter reported a problem: ${status.lastProblem}`,
    sizeWarning: () =>
      "This capture is getting large, so stop and save it soon. It stops by itself before the app runs out of memory.",
  };
  /** An adapter that hasn't started by then, such as a USB device that never answers, is given up on. */
  startTimeoutMs = 10_000;
  /** Called once if the capture ends without `stop`: the adapter went away or the core failed. */
  onEnd: ((message: string) => void) | null = null;
  private frames = 0;
  /** What the frames so far cost in the core, as `captureFrameBytes` counts it. */
  private bytes = 0;
  private full = false;
  private problems = 0;
  private lastProblem: string | null = null;
  private origin = 0;
  private bitrate = 0;
  private dataBitrate: number | undefined;
  private channel: number | undefined;
  /** The bus name the frames are stored under, once started. */
  bus = CAPTURE_CHANNEL;
  /** Whether the adapter confirmed listen-only mode. */
  private listenOnly = false;
  private samples: [number, number][] = [];
  /** For a rolling capture, how long to keep; null keeps every frame. */
  private keepNs: number | null = null;
  /** For a rolling capture: each batch sent to the core and its cost, oldest first. */
  private sent: { firstNs: number; lastNs: number; bytes: number }[] = [];
  private latestNs = -Infinity;
  private ended = false;
  private stopping: Promise<LogInfo> | null = null;
  private readonly batcher: FrameBatcher;

  constructor(
    private readonly core: CoreApi,
    private readonly adapter: CaptureAdapter,
    readonly name: string,
    private readonly clock: RecorderClock = BROWSER_CLOCK,
    batching: Partial<BatcherOptions> = {},
    readonly limits: CaptureLimits = CAPTURE_LIMITS,
  ) {
    this.batcher = new FrameBatcher(
      async (frames) => {
        this.info = await this.core.appendFrames(frames);
        if (this.keepNs !== null) await this.dropOld(frames, this.keepNs);
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
    const starting = this.adapter.start(
      settings,
      {
        onFrames: (frames) => {
          if (this.full) return;
          let fits = 0;
          for (const frame of frames) {
            const cost = captureFrameBytes(frame);
            if (this.bytes + cost > this.limits.maxBytes) {
              this.full = true;
              break;
            }
            this.bytes += cost;
            fits++;
          }
          this.frames += fits;
          this.batcher.add(fits < frames.length ? frames.slice(0, fits) : frames);
          if (this.full) this.end(`The capture stopped at ${this.frames.toLocaleString('en-US')} frames, before the app ran out of memory.`);
        },
        onProblem: (message) => {
          this.problems += 1;
          this.lastProblem = message;
        },
        onEnd: (message) => this.end(message),
      },
      () => Math.round((this.clock.now() - this.origin) * 1e6),
    );
    const started = await this.withinStartTimeout(starting);
    this.bitrate = settings.bitrate;
    this.keepNs = settings.keepMinutes ? settings.keepMinutes * 60e9 : null;
    this.dataBitrate = settings.dataBitrate;
    this.channel = settings.channel;
    this.bus = settings.bus || CAPTURE_CHANNEL;
    this.listenOnly = started.listenOnly;
    try {
      this.info = await this.core.startCapture(this.name, this.bus, startedAtMs);
    } catch (e) {
      await this.adapter.stop();
      throw e;
    }
    this.batcher.start();
    return { info: this.info, listenOnly: started.listenOnly };
  }

  /**
   * Notes `frames`, just sent, and once the oldest frame kept is well past `keepNs` before the
   * latest, drops what is older in the core. A batch counts towards the memory limit until
   * all of it is dropped.
   */
  private async dropOld(frames: CaptureFrame[], keepNs: number) {
    let firstNs = Infinity;
    let lastNs = -Infinity;
    let bytes = 0;
    for (const frame of frames) {
      firstNs = Math.min(firstNs, frame.timeNs);
      lastNs = Math.max(lastNs, frame.timeNs);
      bytes += captureFrameBytes(frame);
    }
    this.sent.push({ firstNs, lastNs, bytes });
    const hostNs = (this.clock.now() - this.origin) * 1e6;
    this.latestNs = Math.max(this.latestNs, Math.min(lastNs, hostNs + MAX_AHEAD_OF_HOST_NS));
    const cutoff = this.latestNs - keepNs;
    const slack = Math.max(MIN_TRIM_SLACK_NS, keepNs * TRIM_SLACK_SHARE);
    if (this.sent[0].firstNs >= cutoff - slack) return;
    this.info = await this.core.trimCapture(cutoff);
    while (this.sent.length > 0 && this.sent[0].lastNs < cutoff) this.bytes -= this.sent.shift()!.bytes;
  }

  /** `starting`, or a rejection once `startTimeoutMs` has passed, with the adapter stopped. */
  private withinStartTimeout<T>(starting: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        this.ended = true;
        // The stop cuts the start short, so it rejects rather than opening the bus later.
        void this.adapter.stop();
        starting.catch(() => undefined);
        reject(new Error(`The adapter didn't start within ${this.startTimeoutMs / 1000} seconds. Unplug it, plug it back in and try again.`));
      }, this.startTimeoutMs);
    });
    return Promise.race([starting, timedOut]).finally(() => clearTimeout(timer));
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
      nearLimit: this.bytes >= this.limits.warnBytes,
    };
  }

  /** As the page goes away: asks the adapter to stop, without waiting. */
  release() {
    this.ended = true;
    this.adapter.release?.();
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

/** Elapsed time as a stopwatch shows it: `0:05`, `12:34`, `1:02:03`. */
function stopwatch(seconds: number): string {
  const s = Math.floor(seconds);
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}
