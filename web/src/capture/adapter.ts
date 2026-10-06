import type { CaptureFrame } from '../core/api';

/** The bitrates adapters are opened at, in bit/s: the nine slcan `S0` to `S8` offers. */
export const BITRATES = [10_000, 20_000, 50_000, 100_000, 125_000, 250_000, 500_000, 800_000, 1_000_000] as const;

/** CAN FD data phase bitrates offered, in bit/s: the five that CANable 2 slcan firmware sets with `Y`. */
export const DATA_BITRATES = [1_000_000, 2_000_000, 4_000_000, 5_000_000, 8_000_000] as const;

export interface CaptureSettings {
  /** One of `BITRATES`. */
  bitrate: number;
  /** The CAN FD data phase bitrate, one of `DATA_BITRATES`; not given for classic CAN. */
  dataBitrate?: number;
  /** Keep only about the last this many minutes, dropping older frames; every frame when not given. Adapters ignore it. */
  keepMinutes?: number;
  /** gs_usb: the device channel to capture, from 0; the first when not given. */
  channel?: number;
  /** The bus name the frames are stored under, `can0` when not given. Adapters ignore it. */
  bus?: string;
  /** slcan: the serial port's baud rate, 115200 when not given. USB CDC adapters ignore it. */
  serialBaudRate?: number;
  /**
   * slcan: SJA1000 bit timing registers BTR0 and BTR1 as four hex digits, sent with `s` in
   * place of `S<n>`. `bitrate` should then be the rate they give (see `sja1000Bitrate`).
   */
  btr?: string;
  /** Ask the adapter to only listen: it then never acknowledges, sends or disturbs a frame. */
  listenOnly: boolean;
  /**
   * With `listenOnly`, open the adapter even when it can't confirm listen-only mode, so it may
   * acknowledge frames. Set only once the user has agreed to that.
   */
  allowUnconfirmedListenOnly?: boolean;
}

/**
 * Thrown by `start` when listen-only was asked for and the adapter can't confirm it. The
 * adapter is left closed; the message says why, for the user to decide whether to go on.
 */
export class ListenOnlyUnconfirmedError extends Error {
  override name = 'ListenOnlyUnconfirmedError';
}

export function isListenOnlyUnconfirmed(e: unknown): e is ListenOnlyUnconfirmedError {
  return (e as { name?: unknown } | null)?.name === 'ListenOnlyUnconfirmedError';
}

/** What an adapter reports while it runs. */
export interface CaptureEvents {
  /** Frames as received, timed with the clock given to `start` or the adapter's own, anchored to it. */
  onFrames(frames: CaptureFrame[]): void;
  /** Something went wrong but frames keep coming, such as a line that didn't parse. */
  onProblem(message: string): void;
  /** The adapter stopped by itself, for example because it was unplugged. Not called after `stop`. */
  onEnd(message: string): void;
}

export interface StartedCapture {
  /** Whether the adapter confirmed listen-only mode. */
  listenOnly: boolean;
}

/**
 * A CAN adapter the browser can reach. Each kind is asked for through the browser's device
 * prompt (see `requestAdapter`), then started with a bitrate, and reports frames through
 * `CaptureEvents` until it is stopped.
 */
export interface CaptureAdapter {
  /** The device as the UI names it, e.g. "USB serial device 16D0:117E". */
  readonly label: string;
  /**
   * Open the device and start receiving. `clock` gives the time to stamp frames with, in
   * nanoseconds since the capture started. Rejects with a message for the user.
   */
  start(settings: CaptureSettings, events: CaptureEvents, clock: () => number): Promise<StartedCapture>;
  /**
   * Stop receiving and release the device. Never rejects. Called during `start`, it cuts the
   * start short: the start then rejects and leaves the device closed. A start before the last
   * one has settled is refused.
   */
  stop(): Promise<void>;
  /** As the page goes away: ask the device to stop, without waiting, as nothing more will run. */
  release?(): void;
}

/**
 * A start cut short by `stop`, as when the recorder gave up waiting. Nobody sees it: the
 * recorder has already rejected with its own message.
 */
export const START_CANCELLED = 'The capture was stopped while the adapter started.';

/**
 * How far past the host clock an adapter's timestamp may put a frame. A frame stamped further
 * ahead (a glitch in the adapter's clock) is held to it, as a rolling capture drops frames in
 * the order they came and can't drop past a frame until the window reaches its time.
 */
export const MAX_AHEAD_OF_HOST_NS = 1e9;

/** How fast `DeviceClock` moves its anchor to follow an adapter clock that runs fast or slow: 1000 ppm. */
const MAX_SLEW = 1e-3;

/** How long `DeviceClock` watches how late frames arrive before it slews forward to the least late. */
const SLEW_WINDOW_NS = 10e9;

/** How late the least late frame of a window is left, so the forward and back slews don't fight. */
const SLEW_MARGIN_NS = 1e6;

/**
 * How far before its arrival a frame may be timed before `DeviceClock` counts its anchor as off:
 * a second more than `MAX_AHEAD_OF_HOST_NS`, for USB and browser delays.
 */
export const MAX_BEHIND_HOST_NS = 2e9;

/** How long, in host time, frames must keep being timed past those bounds before `DeviceClock` re-anchors. */
export const REANCHOR_AFTER_NS = 2e9;

/** How many frames in a row must be timed past those bounds before `DeviceClock` re-anchors. */
export const REANCHOR_FRAMES = 3;

interface Stamp {
  deviceNs: number;
  hostNs: number;
}

/**
 * An adapter's own timestamps, from a counter that wraps every `wrapNs`, as capture times:
 * anchored to the host clock, and unwrapped by taking the number of wraps that brings the time
 * counted nearest to what the host clock says has passed. Times stay absolute, and the host's
 * USB and scheduling jitter is left out. A frame can't really be timed after it arrived, so
 * when one is, the anchor is moved back by up to `MAX_SLEW` of the adapter time since the latest
 * adapter time seen: that undoes an anchor taken late and follows an adapter clock that runs fast, while
 * times keep rising. When even the least late frame over `SLEW_WINDOW_NS` arrived more than
 * `SLEW_MARGIN_NS` after its time, the anchor moves forward the same way, which follows an
 * adapter clock that runs slow. A time still more than `MAX_AHEAD_OF_HOST_NS` past the host
 * clock is held to it and leaves the anchor alone. When `REANCHOR_FRAMES` frames in a row over
 * `REANCHOR_AFTER_NS` are held, or timed more than `MAX_BEHIND_HOST_NS` before they arrived, the
 * adapter's clock jumped (as when the computer sleeps): the clock re-anchors at the least late
 * of them, tells `onReanchor`, and keeps times rising past the last one given out.
 */
export class DeviceClock {
  private anchor: Stamp | null = null;
  /** The furthest adapter time since the anchor timed so far, which each slew is measured from. */
  private lastElapsedNs = 0;
  /** Since `sinceHostNs`, the latest anchor host time that would have timed no frame after its arrival. */
  private window = { sinceHostNs: 0, latestAnchorNs: Infinity };
  /** How far the anchor is still to move forward, from the last window. */
  private forwardNs = 0;
  /** While frames keep being timed past the bounds the same way: which way, since when, how many, and the least late. */
  private off: { ahead: boolean; sinceHostNs: number; frames: number; best: Stamp & { aheadNs: number } } | null = null;
  private lastTimeNs = -Infinity;
  /** Set by a re-anchor, until times pass the last one given out before it. */
  private catchingUp = false;

  constructor(
    private readonly wrapNs: number,
    private readonly onReanchor: (message: string) => void = () => {},
  ) {}

  /** The device read `deviceNs` at host time `hostNs`. Without it, the first frame anchors. */
  sync(deviceNs: number, hostNs: number) {
    this.anchor = { deviceNs, hostNs };
    this.lastElapsedNs = 0;
    this.window = { sinceHostNs: hostNs, latestAnchorNs: Infinity };
    this.forwardNs = 0;
    this.off = null;
  }

  /** The capture time of a frame the device stamped `deviceNs`, which arrived at host time `hostNs`. */
  time(deviceNs: number, hostNs: number): number {
    if (!this.anchor) this.sync(deviceNs, hostNs);
    const anchor = this.anchor!;
    const counted = deviceNs - anchor.deviceNs;
    const wraps = Math.round((hostNs - anchor.hostNs - counted) / this.wrapNs);
    const elapsedNs = counted + wraps * this.wrapNs;
    const aheadNs = anchor.hostNs + elapsedNs - hostNs;
    const best = this.keptOff({ deviceNs, hostNs, aheadNs });
    if (best) {
      this.sync(best.deviceNs, best.hostNs);
      this.catchingUp = true;
      const seconds = (Math.abs(best.aheadNs) / 1e9).toFixed(1);
      this.onReanchor(`The adapter's clock was ${seconds} s ${best.aheadNs > 0 ? 'ahead of' : 'behind'} the computer's, so it was anchored to the computer's clock again.`);
      return this.time(deviceNs, hostNs);
    }
    if (aheadNs > MAX_AHEAD_OF_HOST_NS) return this.givenOut(hostNs + MAX_AHEAD_OF_HOST_NS);
    const advanceNs = Math.max(0, elapsedNs - this.lastElapsedNs);
    this.lastElapsedNs = Math.max(this.lastElapsedNs, elapsedNs);
    if (aheadNs >= -MAX_BEHIND_HOST_NS) {
      this.window.latestAnchorNs = Math.min(this.window.latestAnchorNs, hostNs - elapsedNs);
      if (hostNs - this.window.sinceHostNs >= SLEW_WINDOW_NS) {
        this.forwardNs = Math.max(0, this.window.latestAnchorNs - SLEW_MARGIN_NS - anchor.hostNs);
        this.window = { sinceHostNs: hostNs, latestAnchorNs: Infinity };
      }
    }
    if (aheadNs > 0) {
      anchor.hostNs -= Math.min(aheadNs, MAX_SLEW * advanceNs);
      this.forwardNs = 0;
    } else if (this.forwardNs > 0 && aheadNs >= -MAX_BEHIND_HOST_NS) {
      const stepNs = Math.min(this.forwardNs, -aheadNs, MAX_SLEW * advanceNs);
      anchor.hostNs += stepNs;
      this.forwardNs -= stepNs;
    }
    return this.givenOut(anchor.hostNs + elapsedNs);
  }

  /**
   * The least late of the frames, this one included, timed past the bounds the same way for
   * `REANCHOR_FRAMES` and `REANCHOR_AFTER_NS`, or null while they haven't been.
   */
  private keptOff(frame: Stamp & { aheadNs: number }): (Stamp & { aheadNs: number }) | null {
    if (frame.aheadNs <= MAX_AHEAD_OF_HOST_NS && frame.aheadNs >= -MAX_BEHIND_HOST_NS) {
      this.off = null;
      return null;
    }
    const ahead = frame.aheadNs > 0;
    if (this.off?.ahead !== ahead) this.off = { ahead, sinceHostNs: frame.hostNs, frames: 0, best: frame };
    const off = this.off;
    off.frames += 1;
    if (frame.aheadNs > off.best.aheadNs) off.best = frame;
    return off.frames >= REANCHOR_FRAMES && frame.hostNs - off.sinceHostNs >= REANCHOR_AFTER_NS ? off.best : null;
  }

  /**
   * `timeNs`, except that after a re-anchor moved times back, times up to the last one given out
   * are put a nanosecond apart just past it. Anchoring past the held frames instead would leave
   * the clock at the hold's edge, where jitter holds frames again, and the back slew would take
   * about 17 minutes to remove that second.
   */
  private givenOut(timeNs: number): number {
    if (this.catchingUp) {
      if (timeNs > this.lastTimeNs) this.catchingUp = false;
      else timeNs = this.lastTimeNs + 1;
    }
    this.lastTimeNs = timeNs;
    return timeNs;
  }
}

/** Waits for `promise` to settle, but no longer than `ms`, as a hung device may never answer. Never rejects. */
export function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)));
  const settled = promise.then(
    () => undefined,
    () => undefined,
  );
  return Promise.race([settled, late]).finally(() => clearTimeout(timer));
}

/** An error's message. Some environments' DOMException isn't an Error, so any `message` will do. */
export function errorText(e: unknown): string {
  const message = (e as { message?: unknown } | null)?.message;
  return typeof message === 'string' ? message : String(e);
}

/** Why `name` can't name a bus, or null if it can: log formats split lines on spaces. */
export function busNameProblem(name: string): string | null {
  if (name === '') return 'Enter a bus name, such as can0.';
  if (/\s/.test(name)) return 'A bus name has no spaces.';
  if (name.length > 32) return 'A bus name has at most 32 characters.';
  return null;
}

export function formatBitrate(bitrate: number): string {
  return bitrate >= 1_000_000 ? `${bitrate / 1_000_000} Mbit/s` : `${bitrate / 1000} kbit/s`;
}

/** `16D0:117E`, or null when the device isn't on USB. */
export function usbIds(info: { usbVendorId?: number; usbProductId?: number }): string | null {
  if (info.usbVendorId === undefined || info.usbProductId === undefined) return null;
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
  return `${hex(info.usbVendorId)}:${hex(info.usbProductId)}`;
}
