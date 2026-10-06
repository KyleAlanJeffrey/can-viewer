import { describe, expect, it } from 'vitest';
import { FLAG_BRS, FLAG_ERROR, FLAG_ESI, FLAG_FD, FLAG_RTR, type CaptureFrame } from '../core/api';
import { isListenOnlyUnconfirmed, type CaptureEvents } from './adapter';
import { GsUsbAdapter, bitTiming, parseHostFrame, type BitTimingLimits } from './gsUsb';
import type { UsbDeviceLike, UsbInResult, UsbSetup } from './webUsb';

/** An STM32F072 candleLight: 48 MHz CAN clock, bxCAN limits. */
const CANDLELIGHT: BitTimingLimits = {
  feature: 1,
  fclk: 48_000_000,
  tseg1Min: 1,
  tseg1Max: 16,
  tseg2Min: 1,
  tseg2Max: 8,
  sjwMax: 4,
  brpMin: 1,
  brpMax: 1024,
  brpInc: 1,
};

function hostFrame(canId: number, dlc: number, data: number[], { echoId = 0xffff_ffff, flags = 0, channel = 0, timestampUs = null as number | null } = {}): DataView {
  const dataField = Math.max(8, data.length);
  const view = new DataView(new ArrayBuffer(12 + dataField + (timestampUs === null ? 0 : 4)));
  if (timestampUs !== null) view.setUint32(12 + dataField, timestampUs, true);
  view.setUint32(0, echoId, true);
  view.setUint32(4, canId, true);
  view.setUint8(8, dlc);
  view.setUint8(9, channel);
  view.setUint8(10, flags);
  data.forEach((b, i) => view.setUint8(12 + i, b));
  return view;
}

describe('bitTiming', () => {
  it('times a candleLight at 87.5% up to 800 kbit/s and 75% above', () => {
    expect(bitTiming(CANDLELIGHT, 500_000)).toEqual({ propSeg: 6, phaseSeg1: 7, phaseSeg2: 2, sjw: 1, brp: 6 });
    expect(bitTiming(CANDLELIGHT, 1_000_000)).toEqual({ propSeg: 5, phaseSeg1: 6, phaseSeg2: 4, sjw: 2, brp: 3 });
    expect(bitTiming(CANDLELIGHT, 250_000)?.brp).toBe(12);
    for (const bitrate of [10_000, 20_000, 50_000, 100_000, 125_000, 250_000, 500_000, 800_000, 1_000_000]) {
      const t = bitTiming(CANDLELIGHT, bitrate)!;
      const quanta = 1 + t.propSeg + t.phaseSeg1 + t.phaseSeg2;
      expect(CANDLELIGHT.fclk / (t.brp * quanta), `${bitrate}`).toBe(bitrate);
      expect(t.propSeg + t.phaseSeg1).toBeLessThanOrEqual(16);
      expect(t.phaseSeg2).toBeLessThanOrEqual(8);
    }
  });

  it('keeps to the prescaler step and the segment limits', () => {
    const t = bitTiming({ ...CANDLELIGHT, fclk: 80_000_000, brpMin: 2, brpInc: 2 }, 500_000)!;
    expect(t.brp % 2).toBe(0);
    expect(80_000_000 / (t.brp * (1 + t.propSeg + t.phaseSeg1 + t.phaseSeg2))).toBe(500_000);
  });

  it('gives null when no prescaler fits the bitrate exactly', () => {
    expect(bitTiming(CANDLELIGHT, 83_333)).toBeNull();
    expect(bitTiming({ ...CANDLELIGHT, brpMax: 1 }, 10_000)).toBeNull();
  });

  it('tries a bounded number of prescalers, whatever limits the device reports', () => {
    expect(bitTiming({ ...CANDLELIGHT, brpMax: 0xffff_ffff }, 500_000)?.brp).toBe(6);
    expect(bitTiming({ ...CANDLELIGHT, brpMin: 5000, brpMax: 0xffff_ffff }, 500_000)).toBeNull();
  });
});

describe('parseHostFrame', () => {
  it('reads standard, extended, remote and error frames', () => {
    expect(parseHostFrame(hostFrame(0x123, 2, [0xde, 0xad]))).toEqual({ frame: { id: 0x123, extended: false, flags: 0, data: Uint8Array.of(0xde, 0xad) }, overflow: false });
    expect(parseHostFrame(hostFrame(0x9234_5678, 1, [7]))?.frame).toEqual({ id: 0x1234_5678, extended: true, flags: 0, data: Uint8Array.of(7) });
    expect(parseHostFrame(hostFrame(0x4000_0123, 8, []))?.frame).toEqual({ id: 0x123, extended: false, flags: FLAG_RTR, data: new Uint8Array(0) });
    expect(parseHostFrame(hostFrame(0x2000_0004, 8, [0, 0, 8, 0, 0, 0, 0, 0]))?.frame).toMatchObject({ id: 4, extended: false, flags: FLAG_ERROR });
  });

  it('reads CAN FD frames and the overflow flag', () => {
    const fd = parseHostFrame(hostFrame(0x321, 0xf, Array(64).fill(1), { flags: 0b0110 }));
    expect(fd?.frame.flags).toBe(FLAG_FD | FLAG_BRS);
    expect(fd?.frame.data).toHaveLength(64);
    expect(parseHostFrame(hostFrame(0x123, 0, [], { flags: 1 }))?.overflow).toBe(true);
  });

  it('skips echoes of sent frames and short transfers', () => {
    expect(parseHostFrame(hostFrame(0x123, 0, [], { echoId: 0 }))).toBeNull();
    expect(parseHostFrame(new DataView(new ArrayBuffer(8)))).toBeNull();
    expect(parseHostFrame(hostFrame(0x321, 0xf, [], { flags: 0b10 }))).toBeNull();
  });

  it('reads the hardware timestamp after the whole data field, when the device was asked for them', () => {
    expect(parseHostFrame(hostFrame(0x123, 1, [9], { timestampUs: 0xfedc_ba98 }), true)?.timestampUs).toBe(0xfedc_ba98);
    expect(parseHostFrame(hostFrame(0x123, 1, [9], { timestampUs: 5 }))?.timestampUs).toBeUndefined();
    expect(parseHostFrame(hostFrame(0x123, 1, [9]), true)?.timestampUs).toBeUndefined();
    const fd = parseHostFrame(hostFrame(0x321, 0x9, Array(64).fill(1), { flags: 0b10, timestampUs: 77 }), true);
    expect(fd?.frame.data).toHaveLength(12);
    expect(fd?.timestampUs).toBe(77);
  });

  it("skips another channel's frames", () => {
    expect(parseHostFrame(hostFrame(0x123, 1, [1], { channel: 1 }))).toBeNull();
    expect(parseHostFrame(hostFrame(0x123, 1, [1], { channel: 1 }), false, 1)?.frame.id).toBe(0x123);
    expect(parseHostFrame(hostFrame(0x123, 1, [1]), false, 1)).toBeNull();
  });

  it('reads the error state indicator of CAN FD frames', () => {
    expect(parseHostFrame(hostFrame(0x321, 1, [1], { flags: 0b1010 }))?.frame.flags).toBe(FLAG_FD | FLAG_ESI);
  });
});

/** A candleLight on the far side of WebUSB: answers setup requests, and hands out queued frames. */
class FakeUsbDevice implements UsbDeviceLike {
  readonly vendorId = 0x1d50;
  readonly productId = 0x606f;
  readonly productName = 'candleLight USB to CAN adapter';
  configuration: UsbDeviceLike['configuration'] = null;
  readonly requests: { request: number; value: number; data: number[] }[] = [];
  opened = false;
  closed = false;
  claimError: Error | null = null;
  limits = CANDLELIGHT;
  /** The data phase limits `BREQ_BT_CONST_EXT` reports, after the nominal ones. */
  dataLimits = CANDLELIGHT;
  channels = 1;
  /** What `BREQ_TIMESTAMP` reads, in microseconds; null makes the device stall it. */
  counterUs: number | null = 0;
  /** Set to make control transfers never finish until the device is closed, as on a hung device. */
  hangControl = false;
  /** Set to make `open` wait for it. */
  opening: Promise<void> | null = null;
  private queued: DataView[] = [];
  private waiting: { resolve: (r: UsbInResult) => void; reject: (e: Error) => void }[] = [];
  private hung: ((e: Error) => void)[] = [];

  async open() {
    await this.opening;
    this.opened = true;
    this.closed = false;
  }
  async close() {
    this.closed = true;
    const closed = () => new DOMException('The device was closed.', 'AbortError') as unknown as Error;
    for (const w of this.waiting.splice(0)) w.reject(closed());
    for (const reject of this.hung.splice(0)) reject(closed());
  }
  /** A control transfer that ends only when the device is closed. */
  private hang<T>(): Promise<T> {
    return new Promise((_, reject) => this.hung.push(reject));
  }
  async selectConfiguration() {
    this.configuration = { interfaces: [{ interfaceNumber: 0, alternate: { endpoints: [{ endpointNumber: 2, direction: 'out', type: 'bulk' }, { endpointNumber: 1, direction: 'in', type: 'bulk' }] } }] };
  }
  async claimInterface() {
    if (this.claimError) throw this.claimError;
  }
  async releaseInterface() {}
  async controlTransferIn(setup: UsbSetup, length: number): Promise<UsbInResult> {
    if (this.hangControl) return this.hang();
    this.requests.push({ request: setup.request, value: setup.value, data: [] });
    if (setup.request === 6) {
      if (this.counterUs === null) return { status: 'stall' };
      const counter = new DataView(new ArrayBuffer(4));
      counter.setUint32(0, this.counterUs, true);
      return { status: 'ok', data: counter };
    }
    if (setup.request === 5) {
      const config = new DataView(new ArrayBuffer(length));
      config.setUint8(3, this.channels - 1);
      return { status: 'ok', data: config };
    }
    const l = this.limits;
    const d = this.dataLimits;
    const values = [l.feature, l.fclk, l.tseg1Min, l.tseg1Max, l.tseg2Min, l.tseg2Max, l.sjwMax, l.brpMin, l.brpMax, l.brpInc];
    if (setup.request === 11) values.push(d.tseg1Min, d.tseg1Max, d.tseg2Min, d.tseg2Max, d.sjwMax, d.brpMin, d.brpMax, d.brpInc);
    const view = new DataView(new ArrayBuffer(length));
    values.forEach((v, i) => view.setUint32(4 * i, v, true));
    return { status: 'ok', data: view };
  }
  async controlTransferOut(setup: UsbSetup, data?: BufferSource) {
    if (this.hangControl) return this.hang<{ status: 'ok' }>();
    const view = new DataView(data as ArrayBuffer);
    const words = Array.from({ length: view.byteLength / 4 }, (_, i) => view.getUint32(4 * i, true));
    this.requests.push({ request: setup.request, value: setup.value, data: words });
    return { status: 'ok' as const };
  }
  transferIn(): Promise<UsbInResult> {
    const next = this.queued.shift();
    if (next) return Promise.resolve({ status: 'ok', data: next });
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  async clearHalt() {}

  receive(frame: DataView) {
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ status: 'ok', data: frame });
    else this.queued.push(frame);
  }

  unplug() {
    for (const w of this.waiting.splice(0)) w.reject(new DOMException('The device was disconnected.', 'NotFoundError') as unknown as Error);
  }
}

function recordingEvents() {
  const frames: CaptureFrame[] = [];
  const problems: string[] = [];
  const ends: string[] = [];
  const events: CaptureEvents = { onFrames: (f) => frames.push(...f), onProblem: (m) => problems.push(m), onEnd: (m) => ends.push(m) };
  return { frames, problems, ends, events };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('GsUsbAdapter', () => {
  it('sets the device up, starts it listen-only, and stamps received frames with the host clock', async () => {
    const device = new FakeUsbDevice();
    const adapter = new GsUsbAdapter(device);
    expect(adapter.label).toBe('candleLight USB to CAN adapter (1D50:606F)');
    const { frames, problems, events } = recordingEvents();
    expect(await adapter.start({ bitrate: 500_000, listenOnly: true }, events, () => 42)).toEqual({ listenOnly: true });
    expect(device.requests).toEqual([
      { request: 0, value: 1, data: [0xbeef] },
      { request: 4, value: 0, data: [] },
      { request: 2, value: 0, data: [0, 0] },
      { request: 1, value: 0, data: [6, 7, 2, 1, 6] },
      { request: 2, value: 0, data: [1, 1] },
    ]);

    device.receive(hostFrame(0x123, 1, [9]));
    device.receive(hostFrame(0x123, 0, [], { echoId: 3 }));
    device.receive(hostFrame(0x456, 0, [], { flags: 1 }));
    await tick();
    expect(frames).toEqual([
      { id: 0x123, extended: false, flags: 0, data: Uint8Array.of(9), timeNs: 42 },
      { id: 0x456, extended: false, flags: 0, data: new Uint8Array(0), timeNs: 42 },
    ]);
    expect(problems).toEqual(["The adapter's receive buffer overflowed, so frames were lost."]);

    await adapter.stop();
    expect(device.requests.at(-1)).toEqual({ request: 2, value: 0, data: [0, 0] });
    expect(device.closed).toBe(true);
  });

  it("times frames by the device's microsecond counter, anchored to the host clock and unwrapped", async () => {
    const device = new FakeUsbDevice();
    device.limits = { ...CANDLELIGHT, feature: 1 | (1 << 4) };
    device.counterUs = 2 ** 32 - 1000;
    const adapter = new GsUsbAdapter(device);
    const { frames, events } = recordingEvents();
    let now = 3_000_000;
    await adapter.start({ bitrate: 500_000, listenOnly: true }, events, () => now);
    expect(device.requests.slice(-2)).toEqual([
      { request: 2, value: 0, data: [1, 1 | (1 << 4)] },
      { request: 6, value: 0, data: [] },
    ]);

    now += 5_000_000;
    device.receive(hostFrame(0x123, 1, [1], { timestampUs: 2 ** 32 - 900 }));
    // Past the counter's wrap at 2^32 microseconds.
    device.receive(hostFrame(0x123, 1, [2], { timestampUs: 400 }));
    await tick();
    expect(frames.map((f) => f.timeNs)).toEqual([3_100_000, 4_400_000]);
    await adapter.stop();
  });

  it('anchors to the first frame when the device does not answer the counter read', async () => {
    const device = new FakeUsbDevice();
    device.limits = { ...CANDLELIGHT, feature: 1 | (1 << 4) };
    device.counterUs = null;
    const adapter = new GsUsbAdapter(device);
    const { frames, events } = recordingEvents();
    let now = 0;
    await adapter.start({ bitrate: 500_000, listenOnly: true }, events, () => now);
    now = 9_000_000;
    device.receive(hostFrame(0x123, 1, [1], { timestampUs: 1000 }));
    device.receive(hostFrame(0x123, 1, [2], { timestampUs: 1250 }));
    await tick();
    expect(frames.map((f) => f.timeNs)).toEqual([9_000_000, 9_250_000]);
    await adapter.stop();
  });

  it('starts CAN FD with the data phase timed from the extended limits, on the channel chosen', async () => {
    const device = new FakeUsbDevice();
    const fdFeatures = 1 | (1 << 8) | (1 << 10);
    device.limits = { ...CANDLELIGHT, feature: fdFeatures, fclk: 80_000_000, tseg1Max: 256, tseg2Max: 128, brpMax: 512 };
    device.dataLimits = { ...device.limits, tseg1Max: 32, tseg2Max: 16, sjwMax: 16, brpMax: 32 };
    device.channels = 2;
    const adapter = new GsUsbAdapter(device);
    const { frames, events } = recordingEvents();
    await adapter.start({ bitrate: 500_000, dataBitrate: 2_000_000, listenOnly: true, channel: 1 }, events, () => 0);
    const nominal = bitTiming(device.limits, 500_000)!;
    const data = bitTiming(device.dataLimits, 2_000_000, 0.75)!;
    expect(data).toEqual({ propSeg: 14, phaseSeg1: 15, phaseSeg2: 10, sjw: 5, brp: 1 });
    expect(device.requests).toEqual([
      { request: 0, value: 1, data: [0xbeef] },
      { request: 5, value: 1, data: [] },
      { request: 4, value: 1, data: [] },
      { request: 11, value: 1, data: [] },
      { request: 2, value: 1, data: [0, 0] },
      { request: 1, value: 1, data: [nominal.propSeg, nominal.phaseSeg1, nominal.phaseSeg2, nominal.sjw, nominal.brp] },
      { request: 10, value: 1, data: [14, 15, 10, 5, 1] },
      { request: 2, value: 1, data: [1, 1 | (1 << 8)] },
    ]);

    device.receive(hostFrame(0x123, 1, [1]));
    device.receive(hostFrame(0x321, 0xf, Array(64).fill(2), { channel: 1, flags: 0b0110 }));
    await tick();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ id: 0x321, flags: FLAG_FD | FLAG_BRS });
    expect(frames[0].data).toHaveLength(64);
    await adapter.stop();
    expect(device.requests.at(-1)).toEqual({ request: 2, value: 1, data: [0, 0] });
  });

  it('refuses CAN FD on a classic device, and a channel the device lacks', async () => {
    const device = new FakeUsbDevice();
    const adapter = new GsUsbAdapter(device);
    await expect(adapter.start({ bitrate: 500_000, dataBitrate: 2_000_000, listenOnly: true }, recordingEvents().events, () => 0)).rejects.toThrow(
      "This adapter can't do CAN FD. Set CAN FD data bitrate to Off for a classic bus.",
    );
    expect(device.closed).toBe(true);
    await expect(adapter.start({ bitrate: 500_000, listenOnly: true, channel: 1 }, recordingEvents().events, () => 0)).rejects.toThrow(
      'This adapter has one channel. Choose channel 1 under Advanced.',
    );
    device.channels = 2;
    await expect(adapter.start({ bitrate: 500_000, listenOnly: true, channel: 3 }, recordingEvents().events, () => 0)).rejects.toThrow(
      'This adapter has 2 channels. Choose channel 1 to 2 under Advanced.',
    );
  });

  it('times the data phase from the nominal limits when the device has no extended ones', async () => {
    const device = new FakeUsbDevice();
    device.limits = { ...CANDLELIGHT, feature: 1 | (1 << 8) };
    const adapter = new GsUsbAdapter(device);
    await adapter.start({ bitrate: 500_000, dataBitrate: 4_000_000, listenOnly: true }, recordingEvents().events, () => 0);
    expect(device.requests.some((r) => r.request === 11)).toBe(false);
    const data = bitTiming(CANDLELIGHT, 4_000_000, 0.75)!;
    expect(device.requests.find((r) => r.request === 10)?.data).toEqual([data.propSeg, data.phaseSeg1, data.phaseSeg2, data.sjw, data.brp]);
    await adapter.stop();
  });

  it('starts a device with no listen-only mode only when the user agrees', async () => {
    const device = new FakeUsbDevice();
    device.limits = { ...CANDLELIGHT, feature: 0 };
    const adapter = new GsUsbAdapter(device);
    const refusal = await adapter.start({ bitrate: 250_000, listenOnly: true }, recordingEvents().events, () => 0).catch((e: unknown) => e);
    expect(isListenOnlyUnconfirmed(refusal)).toBe(true);
    expect(device.requests.some((r) => r.request === 2 && r.data[0] === 1)).toBe(false);
    expect(device.closed).toBe(true);

    const settings = { bitrate: 250_000, listenOnly: true, allowUnconfirmedListenOnly: true };
    expect(await adapter.start(settings, recordingEvents().events, () => 0)).toEqual({ listenOnly: false });
    expect(device.requests.at(-1)).toEqual({ request: 2, value: 0, data: [1, 0] });
    await adapter.stop();
  });

  it('resets the device as the page goes away, without waiting', async () => {
    const device = new FakeUsbDevice();
    const adapter = new GsUsbAdapter(device);
    await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0);
    adapter.release();
    expect(device.requests.at(-1)).toEqual({ request: 2, value: 0, data: [0, 0] });
    await adapter.stop();
  });

  it("fails with a message when the interface can't be claimed", async () => {
    const device = new FakeUsbDevice();
    device.claimError = new Error('Unable to claim interface.');
    await expect(new GsUsbAdapter(device).start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0)).rejects.toThrow(
      "The adapter couldn't be opened (Unable to claim interface.).",
    );
    expect(device.closed).toBe(true);
  });

  it("fails with a message for a bitrate the clock can't make", async () => {
    const device = new FakeUsbDevice();
    await expect(new GsUsbAdapter(device).start({ bitrate: 83_333, listenOnly: true }, recordingEvents().events, () => 0)).rejects.toThrow("can't run at 83333 bit/s");
    expect(device.closed).toBe(true);
  });

  it('starts again after a stop, as the sheet keeps the chosen adapter', async () => {
    const device = new FakeUsbDevice();
    const adapter = new GsUsbAdapter(device);
    await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0);
    await adapter.stop();

    const { frames, events } = recordingEvents();
    await adapter.start({ bitrate: 500_000, listenOnly: true }, events, () => 7);
    expect(device.requests.at(-1)).toEqual({ request: 2, value: 0, data: [1, 1] });
    device.receive(hostFrame(0x321, 1, [5]));
    await tick();
    expect(frames).toEqual([{ id: 0x321, extended: false, flags: 0, data: Uint8Array.of(5), timeNs: 7 }]);
    await adapter.stop();
    expect(device.requests.at(-1)).toEqual({ request: 2, value: 0, data: [0, 0] });
  });

  it('lets the device go when a request hangs, and can start again', async () => {
    const device = new FakeUsbDevice();
    device.hangControl = true;
    const adapter = new GsUsbAdapter(device);
    const starting = adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0);
    await tick();
    await expect(adapter.stop()).resolves.toBeUndefined();
    expect(device.closed).toBe(true);
    await expect(starting).rejects.toThrow('The capture was stopped while the adapter started.');

    device.hangControl = false;
    expect(await adapter.start({ bitrate: 500_000, listenOnly: true }, recordingEvents().events, () => 0)).toEqual({ listenOnly: true });
    await adapter.stop();
  });

  it('closes a device that opens only after the start was stopped, without starting it', async () => {
    const device = new FakeUsbDevice();
    let opened = () => {};
    device.opening = new Promise((resolve) => (opened = resolve));
    const adapter = new GsUsbAdapter(device);
    const { frames, events } = recordingEvents();
    const starting = adapter.start({ bitrate: 500_000, listenOnly: true }, events, () => 0);
    await adapter.stop();
    await expect(adapter.start({ bitrate: 500_000, listenOnly: true }, events, () => 0)).rejects.toThrow('The adapter is still busy with the last try.');

    opened();
    await expect(starting).rejects.toThrow('The capture was stopped while the adapter started.');
    expect(device.requests).toEqual([]);
    expect(device.closed).toBe(true);
    device.receive(hostFrame(0x123, 1, [9]));
    await tick();
    expect(frames).toEqual([]);
  });

  it('ends the capture once when the adapter is unplugged', async () => {
    const device = new FakeUsbDevice();
    const adapter = new GsUsbAdapter(device);
    const { ends, events } = recordingEvents();
    await adapter.start({ bitrate: 500_000, listenOnly: true }, events, () => 0);
    device.unplug();
    await tick();
    expect(ends).toEqual(['The adapter was disconnected (The device was disconnected.).']);
    await adapter.stop();
  });
});
