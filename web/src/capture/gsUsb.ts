/**
 * candleLight and other gs_usb adapters over WebUSB: the protocol of the Linux `gs_usb` driver.
 * The host sets up the device with vendor control requests, then reads one 20-byte host frame
 * per bulk IN transfer. Only the first channel is used, and only classic CAN is asked for.
 */

import { FLAG_BRS, FLAG_ERROR, FLAG_FD, FLAG_RTR, type CaptureFrame } from '../core/api';
import { errorText, usbIds, type CaptureAdapter, type CaptureEvents, type CaptureSettings, type StartedCapture } from './adapter';
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

const MODE_RESET = 0;
const MODE_START = 1;
const MODE_FLAG_LISTEN_ONLY = 1 << 0;
const FEATURE_LISTEN_ONLY = 1 << 0;

const FRAME_FLAG_OVERFLOW = 1 << 0;
const FRAME_FLAG_FD = 1 << 1;
const FRAME_FLAG_BRS = 1 << 2;

/** SocketCAN `can_id` bits, which gs_usb host frames use. */
const CAN_EFF_FLAG = 0x8000_0000;
const CAN_RTR_FLAG = 0x4000_0000;
const CAN_ERR_FLAG = 0x2000_0000;
const CAN_EFF_MASK = 0x1fff_ffff;

/** What the device sends back for a frame it transmitted; received frames have this echo ID. */
const RX_ECHO_ID = 0xffff_ffff;
const HOST_FRAME_HEADER = 12;
const FD_LENGTHS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64];
/** Bulk reads kept waiting at once, so frames don't queue up in the device between reads. */
const READS_IN_FLIGHT = 8;
const READ_LENGTH = 128;

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
 * Bit timing for exactly `bitrate`, with the sample point as near 87.5% as the limits allow
 * (CiA 301's recommendation up to 800 kbit/s) and, among equals, the most time quanta. Null if
 * no prescaler divides the clock into a whole number of quanta per bit within the limits.
 */
export function bitTiming(limits: BitTimingLimits, bitrate: number, samplePoint = 0.875): BitTiming | null {
  let best: BitTiming | null = null;
  let bestError = Infinity;
  const step = Math.max(1, limits.brpInc);
  for (let brp = Math.max(1, limits.brpMin); brp <= limits.brpMax; brp += step) {
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

export type HostFrame = { frame: Omit<CaptureFrame, 'timeNs'>; overflow: boolean } | null;

/** A received `gs_host_frame`, or null for an echo of a sent frame or a transfer too short. */
export function parseHostFrame(view: DataView): HostFrame {
  if (view.byteLength < HOST_FRAME_HEADER || view.getUint32(0, true) !== RX_ECHO_ID) return null;
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
  const flags = (fd ? FLAG_FD : 0) | (fd && frameFlags & FRAME_FLAG_BRS ? FLAG_BRS : 0) | (remote ? FLAG_RTR : 0) | (error ? FLAG_ERROR : 0);
  const id = error || extended ? canId & CAN_EFF_MASK : canId & 0x7ff;
  return { frame: { id, extended, flags, data }, overflow: (frameFlags & FRAME_FLAG_OVERFLOW) !== 0 };
}

function u32s(...values: number[]): ArrayBuffer {
  const view = new DataView(new ArrayBuffer(4 * values.length));
  values.forEach((v, i) => view.setUint32(4 * i, v, true));
  return view.buffer;
}

export class GsUsbAdapter implements CaptureAdapter {
  readonly label: string;
  private interfaceNumber = 0;
  private endpoint = 1;
  private running = false;
  private reads: Promise<void>[] = [];
  private stopping: Promise<void> | null = null;
  private events: CaptureEvents | null = null;
  private clock: () => number = () => 0;

  constructor(private readonly device: UsbDeviceLike) {
    const ids = usbIds({ usbVendorId: device.vendorId, usbProductId: device.productId });
    this.label = `${device.productName || 'USB CAN adapter'} (${ids})`;
  }

  async start(settings: CaptureSettings, events: CaptureEvents, clock: () => number): Promise<StartedCapture> {
    // The sheet keeps the chosen adapter, so it can be started again after a stop.
    this.stopping = null;
    this.reads = [];
    this.events = events;
    this.clock = clock;
    try {
      await this.device.open();
      if (this.device.configuration === null) await this.device.selectConfiguration(1);
      this.findEndpoint();
      await this.device.claimInterface(this.interfaceNumber);
    } catch (e) {
      await this.device.close().catch(() => undefined);
      throw new Error(
        `The adapter couldn't be opened (${errorText(e)}). Close any other program or tab using it. On Linux, the gs_usb driver holds it: unbind the driver first.`,
      );
    }
    try {
      await this.controlOut(BREQ_HOST_FORMAT, 1, u32s(0x0000_beef));
      const limits = parseBitTimingLimits(await this.controlIn(BREQ_BT_CONST, 0, 40));
      const timing = bitTiming(limits, settings.bitrate);
      if (!timing) throw new Error(`The adapter can't run at ${settings.bitrate} bit/s.`);
      const listenOnly = settings.listenOnly && (limits.feature & FEATURE_LISTEN_ONLY) !== 0;
      await this.controlOut(BREQ_MODE, 0, u32s(MODE_RESET, 0));
      await this.controlOut(BREQ_BITTIMING, 0, u32s(timing.propSeg, timing.phaseSeg1, timing.phaseSeg2, timing.sjw, timing.brp));
      await this.controlOut(BREQ_MODE, 0, u32s(MODE_START, listenOnly ? MODE_FLAG_LISTEN_ONLY : 0));
      this.running = true;
      this.reads = Array.from({ length: READS_IN_FLIGHT }, () => this.readLoop());
      return { listenOnly };
    } catch (e) {
      await this.stop();
      throw e;
    }
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      const wasRunning = this.running;
      this.running = false;
      if (wasRunning) await this.controlOut(BREQ_MODE, 0, u32s(MODE_RESET, 0)).catch(() => undefined);
      await this.device.releaseInterface(this.interfaceNumber).catch(() => undefined);
      // Closing the device fails the reads still waiting.
      await this.device.close().catch(() => undefined);
      await Promise.all(this.reads);
    })();
    return this.stopping;
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
    const parsed = parseHostFrame(view);
    if (!parsed) return;
    if (parsed.overflow) this.events?.onProblem("The adapter's receive buffer overflowed, so frames were lost.");
    this.events?.onFrames([{ ...parsed.frame, timeNs: this.clock() }]);
  }
}
