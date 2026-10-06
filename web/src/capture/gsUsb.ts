/**
 * candleLight and other gs_usb adapters over WebUSB: the protocol of the Linux `gs_usb` driver.
 * The host sets up the device with vendor control requests, then reads one 20-byte host frame
 * per bulk IN transfer, of the channel chosen, in classic CAN or, with a data bitrate, CAN FD.
 * Frames are timed by the device's microsecond counter when it has one (see `DeviceClock`).
 */

import { FLAG_BRS, FLAG_ERROR, FLAG_ESI, FLAG_FD, FLAG_RTR, type CaptureFrame } from '../core/api';
import {
  DeviceClock,
  errorText,
  ListenOnlyUnconfirmedError,
  settleWithin,
  START_CANCELLED,
  usbIds,
  type CaptureAdapter,
  type CaptureEvents,
  type CaptureSettings,
  type StartedCapture,
} from './adapter';
import type { UsbDeviceLike, UsbSetup } from './webUsb';

/** Devices the Linux driver binds to: candleLight, CANable with candleLight firmware and kin. */
export const GS_USB_FILTERS = [
  { vendorId: 0x1d50, productId: 0x606f },
  { vendorId: 0x1209, productId: 0x2323 },
  { vendorId: 0x1cd2, productId: 0x606f },
  { vendorId: 0x16d0, productId: 0x10b8 },
];

const BREQ_HOST_FORMAT = 0;
const BREQ_BITTIMING = 1;
const BREQ_MODE = 2;
const BREQ_BT_CONST = 4;
const BREQ_DEVICE_CONFIG = 5;
const BREQ_TIMESTAMP = 6;
const BREQ_DATA_BITTIMING = 10;
const BREQ_BT_CONST_EXT = 11;

const MODE_RESET = 0;
const MODE_START = 1;
const MODE_FLAG_LISTEN_ONLY = 1 << 0;
const MODE_FLAG_HW_TIMESTAMP = 1 << 4;
const MODE_FLAG_FD = 1 << 8;
const FEATURE_LISTEN_ONLY = 1 << 0;
const FEATURE_HW_TIMESTAMP = 1 << 4;
const FEATURE_FD = 1 << 8;
const FEATURE_BT_CONST_EXT = 1 << 10;

const FRAME_FLAG_OVERFLOW = 1 << 0;
const FRAME_FLAG_FD = 1 << 1;
const FRAME_FLAG_BRS = 1 << 2;
const FRAME_FLAG_ESI = 1 << 3;

/** SocketCAN `can_id` bits, which gs_usb host frames use. */
const CAN_EFF_FLAG = 0x8000_0000;
const CAN_RTR_FLAG = 0x4000_0000;
const CAN_ERR_FLAG = 0x2000_0000;
const CAN_EFF_MASK = 0x1fff_ffff;

/** What the device sends back for a frame it transmitted; received frames have this echo ID. */
const RX_ECHO_ID = 0xffff_ffff;
const HOST_FRAME_HEADER = 12;
/** With hardware timestamps, a u32 of microseconds follows the whole data field: 8 bytes, or 64 for CAN FD. */
const CLASSIC_DATA_FIELD = 8;
const FD_DATA_FIELD = 64;
const TIMESTAMP_WRAP_NS = 2 ** 32 * 1000;
const FD_LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
/** Bulk reads kept waiting at once, so frames don't queue up in the device between reads. */
const READS_IN_FLIGHT = 8;
const READ_LENGTH = 128;
/** CiA's recommendation for the data phase, which tolerates less propagation delay. */
const DATA_SAMPLE_POINT = 0.75;
/** Prescalers tried at most, so odd limits from a device can't make the search run long. */
const MAX_PRESCALERS = 4096;

/** The device's bit timing limits (`gs_device_bt_const`). */
export interface BitTimingLimits {
  feature: number;
  fclk: number;
  tseg1Min: number;
  tseg1Max: number;
  tseg2Min: number;
  tseg2Max: number;
  sjwMax: number;
  brpMin: number;
  brpMax: number;
  brpInc: number;
}

/**
 * The nominal and data phase limits of a CAN FD device (`gs_device_bt_const_extended`): the
 * classic fields, then tseg1, tseg2, sjw and prescaler limits for the data phase.
 */
export function parseBitTimingLimitsExt(view: DataView): { nominal: BitTimingLimits; data: BitTimingLimits } {
  const nominal = parseBitTimingLimits(view);
  const u32 = (i: number) => view.getUint32(4 * i, true);
  return {
    nominal,
    data: {
      feature: nominal.feature,
      fclk: nominal.fclk,
      tseg1Min: u32(10),
      tseg1Max: u32(11),
      tseg2Min: u32(12),
      tseg2Max: u32(13),
      sjwMax: u32(14),
      brpMin: u32(15),
      brpMax: u32(16),
      brpInc: u32(17),
    },
  };
}

/** A `gs_device_bittiming`: segments in time quanta and the prescaler. */
export interface BitTiming {
  propSeg: number;
  phaseSeg1: number;
  phaseSeg2: number;
  sjw: number;
  brp: number;
}

export function parseBitTimingLimits(view: DataView): BitTimingLimits {
  const u32 = (i: number) => view.getUint32(4 * i, true);
  return {
    feature: u32(0),
    fclk: u32(1),
    tseg1Min: u32(2),
    tseg1Max: u32(3),
    tseg2Min: u32(4),
    tseg2Max: u32(5),
    sjwMax: u32(6),
    brpMin: u32(7),
    brpMax: u32(8),
    brpInc: u32(9),
  };
}

/**
 * Bit timing for exactly `bitrate`, with the sample point as near CiA 301's recommendation as
 * the limits allow (87.5% up to 800 kbit/s, 75% above) and, among equals, the most time quanta.
 * Null if no prescaler divides the clock into a whole number of quanta per bit within the limits.
 */
export function bitTiming(limits: BitTimingLimits, bitrate: number, samplePoint = bitrate > 800_000 ? 0.75 : 0.875): BitTiming | null {
  let best: BitTiming | null = null;
  let bestError = Infinity;
  const step = Math.max(1, limits.brpInc);
  const first = Math.max(1, limits.brpMin);
  const last = Math.min(limits.brpMax, first + step * (MAX_PRESCALERS - 1));
  for (let brp = first; brp <= last; brp += step) {
    const quanta = limits.fclk / (brp * bitrate);
    if (!Number.isInteger(quanta)) continue;
    // One quantum is the sync segment; tseg1 and tseg2 share the rest.
    const segments = quanta - 1;
    const lowest = Math.max(limits.tseg1Min, segments - limits.tseg2Max);
    const highest = Math.min(limits.tseg1Max, segments - limits.tseg2Min);
    if (lowest > highest) continue;
    const tseg1 = Math.min(highest, Math.max(lowest, Math.round(samplePoint * quanta) - 1));
    const tseg2 = segments - tseg1;
    const error = Math.abs((1 + tseg1) / quanta - samplePoint);
    if (error < bestError - 1e-9) {
      bestError = error;
      const propSeg = Math.floor(tseg1 / 2);
      best = { propSeg, phaseSeg1: tseg1 - propSeg, phaseSeg2: tseg2, sjw: Math.max(1, Math.min(limits.sjwMax, Math.floor(tseg2 / 2))), brp };
    }
  }
  return best;
}

export type HostFrame = {
  frame: Omit<CaptureFrame, 'timeNs'>;
  overflow: boolean;
  /** The device's microsecond counter when it received the frame, with `timestamps`. */
  timestampUs?: number;
} | null;

/**
 * A received `gs_host_frame` of `channel`, or null for an echo of a sent frame, another
 * channel's frame or a transfer too short. With `timestamps`, the device was started with
 * hardware timestamps, and a transfer that carries one gives it.
 */
export function parseHostFrame(view: DataView, timestamps = false, channel = 0): HostFrame {
  if (view.byteLength < HOST_FRAME_HEADER || view.getUint32(0, true) !== RX_ECHO_ID) return null;
  if (view.getUint8(9) !== channel) return null;
  const canId = view.getUint32(4, true);
  const dlc = view.getUint8(8) & 0x0f;
  const frameFlags = view.getUint8(10);
  const fd = (frameFlags & FRAME_FLAG_FD) !== 0;
  const length = fd ? FD_LENGTHS[dlc] : Math.min(dlc, 8);
  const remote = !fd && (canId & CAN_RTR_FLAG) !== 0;
  const error = (canId & CAN_ERR_FLAG) !== 0;
  const dataLength = remote ? 0 : length;
  if (view.byteLength < HOST_FRAME_HEADER + dataLength) return null;
  const data = new Uint8Array(view.buffer, view.byteOffset + HOST_FRAME_HEADER, dataLength).slice();
  const extended = !error && (canId & CAN_EFF_FLAG) !== 0;
  const flags =
    (fd ? FLAG_FD : 0) |
    (fd && frameFlags & FRAME_FLAG_BRS ? FLAG_BRS : 0) |
    (fd && frameFlags & FRAME_FLAG_ESI ? FLAG_ESI : 0) |
    (remote ? FLAG_RTR : 0) |
    (error ? FLAG_ERROR : 0);
  const id = error || extended ? canId & CAN_EFF_MASK : canId & 0x7ff;
  const parsed: NonNullable<HostFrame> = { frame: { id, extended, flags, data }, overflow: (frameFlags & FRAME_FLAG_OVERFLOW) !== 0 };
  const timestampAt = HOST_FRAME_HEADER + (fd ? FD_DATA_FIELD : CLASSIC_DATA_FIELD);
  if (timestamps && view.byteLength >= timestampAt + 4) parsed.timestampUs = view.getUint32(timestampAt, true);
  return parsed;
}

function timingWords(t: BitTiming): ArrayBuffer {
  return u32s(t.propSeg, t.phaseSeg1, t.phaseSeg2, t.sjw, t.brp);
}

function u32s(...values: number[]): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(4 * values.length));
  values.forEach((v, i) => view.setUint32(4 * i, v, true));
  return view.buffer;
}

/** How long a stop waits on each request to the device; a hung device may never answer. */
const CLOSE_WAIT_MS = 1000;

export class GsUsbAdapter implements CaptureAdapter {
  readonly label: string;
  private interfaceNumber = 0;
  private endpoint = 1;
  private running = false;
  private reads: Promise<void>[] = [];
  private stopping: Promise<void> | null = null;
  private events: CaptureEvents | null = null;
  private clock: () => number = () => 0;
  /** The start under way, until it settles; another isn't begun before then. */
  private starting: Promise<StartedCapture> | null = null;
  /** Set by `stop`, so a start still under way stops at its next step. */
  private cancelled = false;
  /** Set once the device has been opened, and its interface claimed, for this start. */
  private claimed = false;
  /** The device channel captured, which every request about it names. */
  private channel = 0;
  /** The device was started with hardware timestamps. */
  private timestamps = false;
  private deviceClock = new DeviceClock(TIMESTAMP_WRAP_NS);

  constructor(private readonly device: UsbDeviceLike) {
    const ids = usbIds({ usbVendorId: device.vendorId, usbProductId: device.productId });
    this.label = `${device.productName || 'USB CAN adapter'} (${ids})`;
  }

  start(settings: CaptureSettings, events: CaptureEvents, clock: () => number): Promise<StartedCapture> {
    if (this.starting) return Promise.reject(new Error('The adapter is still busy with the last try. Unplug it, plug it back in, then choose it again.'));
    const starting = this.open(settings, events, clock);
    this.starting = starting;
    const settled = () => {
      if (this.starting === starting) this.starting = null;
    };
    starting.then(settled, settled);
    return starting;
  }

  private async open(settings: CaptureSettings, events: CaptureEvents, clock: () => number): Promise<StartedCapture> {
    // The sheet keeps the chosen adapter, so it can be started again after a stop.
    this.stopping = null;
    this.cancelled = false;
    this.claimed = false;
    this.timestamps = false;
    this.deviceClock = new DeviceClock(TIMESTAMP_WRAP_NS);
    this.channel = settings.channel ?? 0;
    this.reads = [];
    this.events = events;
    this.clock = clock;
    try {
      await this.device.open();
      this.checkCancelled();
      if (this.device.configuration === null) await this.device.selectConfiguration(1);
      this.checkCancelled();
      this.findEndpoint();
      await this.device.claimInterface(this.interfaceNumber);
      this.claimed = true;
      this.checkCancelled();
    } catch (e) {
      await settleWithin(this.device.close(), CLOSE_WAIT_MS);
      if (this.cancelled) throw new Error(START_CANCELLED);
      throw new Error(
        `The adapter couldn't be opened (${errorText(e)}). Close any other program or tab using it. On Linux, the gs_usb driver holds it: unbind the driver first.`,
      );
    }
    try {
      await this.controlOut(BREQ_HOST_FORMAT, 1, u32s(0x0000_beef));
      this.checkCancelled();
      if (this.channel > 0) {
        // `icount` is the number of channels less one.
        const channels = (await this.controlIn(BREQ_DEVICE_CONFIG, 1, 12)).getUint8(3) + 1;
        this.checkCancelled();
        if (this.channel >= channels) {
          throw new Error(`This adapter has ${channels === 1 ? 'one channel' : `${channels} channels`}. Choose channel ${channels === 1 ? '1' : `1 to ${channels}`} under Advanced.`);
        }
      }
      let limits = parseBitTimingLimits(await this.controlIn(BREQ_BT_CONST, this.channel, 40));
      this.checkCancelled();
      const fd = settings.dataBitrate !== undefined;
      let dataLimits = limits;
      if (fd) {
        if ((limits.feature & FEATURE_FD) === 0) throw new Error("This adapter can't do CAN FD. Set CAN FD data bitrate to Off for a classic bus.");
        // Without the extended limits, the data phase is held to the nominal ones.
        if (limits.feature & FEATURE_BT_CONST_EXT) {
          ({ nominal: limits, data: dataLimits } = parseBitTimingLimitsExt(await this.controlIn(BREQ_BT_CONST_EXT, this.channel, 72)));
          this.checkCancelled();
        }
      }
      const timing = bitTiming(limits, settings.bitrate);
      if (!timing) throw new Error(`The adapter can't run at ${settings.bitrate} bit/s.`);
      const dataTiming = fd ? bitTiming(dataLimits, settings.dataBitrate!, DATA_SAMPLE_POINT) : null;
      if (fd && !dataTiming) throw new Error(`The adapter can't run a CAN FD data phase at ${settings.dataBitrate} bit/s.`);
      const listenOnly = settings.listenOnly && (limits.feature & FEATURE_LISTEN_ONLY) !== 0;
      if (settings.listenOnly && !listenOnly && !settings.allowUnconfirmedListenOnly) {
        throw new ListenOnlyUnconfirmedError("This adapter can't listen only, so it would acknowledge frames on the bus.");
      }
      await this.controlOut(BREQ_MODE, this.channel, u32s(MODE_RESET, 0));
      this.checkCancelled();
      await this.controlOut(BREQ_BITTIMING, this.channel, timingWords(timing));
      this.checkCancelled();
      if (dataTiming) {
        await this.controlOut(BREQ_DATA_BITTIMING, this.channel, timingWords(dataTiming));
        this.checkCancelled();
      }
      const timestamps = (limits.feature & FEATURE_HW_TIMESTAMP) !== 0;
      const modeFlags = (listenOnly ? MODE_FLAG_LISTEN_ONLY : 0) | (timestamps ? MODE_FLAG_HW_TIMESTAMP : 0) | (fd ? MODE_FLAG_FD : 0);
      await this.controlOut(BREQ_MODE, this.channel, u32s(MODE_START, modeFlags));
      this.running = true;
      this.timestamps = timestamps;
      this.checkCancelled();
      if (timestamps) await this.syncClock();
      this.checkCancelled();
      this.reads = Array.from({ length: READS_IN_FLIGHT }, () => this.readLoop());
      return { listenOnly };
    } catch (e) {
      if (!this.cancelled) {
        await this.stop();
        throw e;
      }
      // After the stop's own teardown, which may have found the device not yet set up.
      await this.stopping;
      await this.teardown();
      throw new Error(START_CANCELLED);
    }
  }

  stop(): Promise<void> {
    this.cancelled = true;
    this.stopping ??= this.teardown();
    return this.stopping;
  }

  /** Lets the device go. Never rejects, and doesn't wait long on a device that has hung. */
  private async teardown(): Promise<void> {
    try {
      const wasRunning = this.running;
      this.running = false;
      if (wasRunning) await settleWithin(this.controlOut(BREQ_MODE, this.channel, u32s(MODE_RESET, 0)), CLOSE_WAIT_MS);
      if (this.claimed) await settleWithin(this.device.releaseInterface(this.interfaceNumber), CLOSE_WAIT_MS);
      this.claimed = false;
      // Closing the device fails the reads still waiting.
      await settleWithin(this.device.close(), CLOSE_WAIT_MS);
      await Promise.all(this.reads);
    } catch {
      // Stopping never fails; what is left of the device goes with the page.
    }
  }

  /**
   * Anchors the device's counter to the host clock halfway through a read of it, so the first
   * frame's USB delay isn't in every time. Without an answer, the first frame anchors instead.
   */
  private async syncClock() {
    const before = this.clock();
    try {
      const counter = (await this.controlIn(BREQ_TIMESTAMP, this.channel, 4)).getUint32(0, true);
      this.deviceClock.sync(counter * 1000, (before + this.clock()) / 2);
    } catch {
      // Not every firmware answers it.
    }
  }

  private checkCancelled() {
    if (this.cancelled) throw new Error(START_CANCELLED);
  }

  release() {
    if (!this.running) return;
    this.running = false;
    void this.device.controlTransferOut(this.setup(BREQ_MODE, this.channel), u32s(MODE_RESET, 0)).catch(() => undefined);
  }

  /** The interface with a bulk IN endpoint; candleLight has one, interface 0 endpoint 1. */
  private findEndpoint() {
    for (const iface of this.device.configuration?.interfaces ?? []) {
      const bulkIn = iface.alternate.endpoints.find((e) => e.direction === 'in' && e.type === 'bulk');
      if (bulkIn) {
        this.interfaceNumber = iface.interfaceNumber;
        this.endpoint = bulkIn.endpointNumber;
        return;
      }
    }
  }

  private setup(request: number, value: number): UsbSetup {
    return { requestType: 'vendor', recipient: 'interface', request, value, index: this.interfaceNumber };
  }

  private async controlOut(request: number, value: number, data: ArrayBuffer) {
    const result = await this.device.controlTransferOut(this.setup(request, value), data);
    if (result.status !== 'ok') throw new Error(`The adapter refused a setup request (${request}).`);
  }

  private async controlIn(request: number, value: number, length: number): Promise<DataView> {
    const result = await this.device.controlTransferIn(this.setup(request, value), length);
    if (result.status !== 'ok' || !result.data || result.data.byteLength < length) {
      throw new Error("The adapter didn't describe itself. Check that it runs candleLight (gs_usb) firmware.");
    }
    return result.data;
  }

  private async readLoop() {
    while (this.running) {
      try {
        const result = await this.device.transferIn(this.endpoint, READ_LENGTH);
        if (result.status === 'stall') {
          await this.device.clearHalt('in', this.endpoint);
          continue;
        }
        if (result.data) this.receive(result.data);
      } catch (e) {
        if (!this.running) return;
        this.running = false;
        this.events?.onEnd(`The adapter was disconnected (${errorText(e)}).`);
        return;
      }
    }
  }

  private receive(view: DataView) {
    const parsed = parseHostFrame(view, this.timestamps, this.channel);
    if (!parsed) return;
    if (parsed.overflow) this.events?.onProblem("The adapter's receive buffer overflowed, so frames were lost.");
    const hostNs = this.clock();
    const timeNs = parsed.timestampUs === undefined ? hostNs : this.deviceClock.time(parsed.timestampUs * 1000, hostNs);
    this.events?.onFrames([{ ...parsed.frame, timeNs }]);
  }
}
