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

/** How fast `DeviceClock` moves its anchor back to follow an adapter clock that runs fast: 1000 ppm. */
const MAX_SLEW = 1e-3;

/**
 * An adapter's own timestamps, from a counter that wraps every `wrapNs`, as capture times:
 * anchored to the host clock, and unwrapped by taking the number of wraps that brings the time
 * counted nearest to what the host clock says has passed. Times stay absolute, and the host's
 * USB and scheduling jitter is left out. A frame can't really be timed after it arrived, so
 * when one is, the anchor is moved back by up to `MAX_SLEW` of the adapter time since the latest
 * adapter time seen: that undoes an anchor taken late and follows an adapter clock that runs fast, while
 * times keep rising. A time still more than `MAX_AHEAD_OF_HOST_NS` past the host clock is held
 * to it and leaves the anchor alone.
 */
export class DeviceClock {
  private anchor: { deviceNs: number; hostNs: number } | null = null;
  /** The furthest adapter time since the anchor timed so far, which each slew is measured from. */
  private lastElapsedNs = 0;

  constructor(private readonly wrapNs: number) {}

  /** The device read `deviceNs` at host time `hostNs`. Without it, the first frame anchors. */
  sync(deviceNs: number, hostNs: number) {
    this.anchor = { deviceNs, hostNs };
    this.lastElapsedNs = 0;
  }

  /** The capture time of a frame the device stamped `deviceNs`, which arrived at host time `hostNs`. */
  time(deviceNs: number, hostNs: number): number {
    if (!this.anchor) this.sync(deviceNs, hostNs);
    const anchor = this.anchor!;
    const counted = deviceNs - anchor.deviceNs;
    const wraps = Math.round((hostNs - anchor.hostNs - counted) / this.wrapNs);
    const elapsedNs = counted + wraps * this.wrapNs;
    const aheadNs = anchor.hostNs + elapsedNs - hostNs;
    if (aheadNs > MAX_AHEAD_OF_HOST_NS) return hostNs + MAX_AHEAD_OF_HOST_NS;
    if (aheadNs > 0) anchor.hostNs -= Math.min(aheadNs, MAX_SLEW * Math.max(0, elapsedNs - this.lastElapsedNs));
    this.lastElapsedNs = Math.max(this.lastElapsedNs, elapsedNs);
    return anchor.hostNs + elapsedNs;
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
