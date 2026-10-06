import { useId, useState } from 'react';
import { Segmented } from '../components/Segmented';
import { Sheet } from '../components/Sheet';
import { BITRATES, busNameProblem, DATA_BITRATES, errorText, formatBitrate, isListenOnlyUnconfirmed, type CaptureAdapter, type CaptureSettings } from './adapter';
import { ADAPTER_KINDS, availableKinds, requestAdapter, type AdapterKind } from './devices';
import { parseBtr, SERIAL_BAUD_RATE, SERIAL_BAUD_RATES, sja1000Bitrate } from './slcan';

const DEFAULT_BITRATE = 500_000;
const DEFAULT_BUS = 'can0';
/** Windows offered for a rolling capture, in minutes. */
const KEEP_MINUTES = [1, 5, 10, 30, 60];
/** Channels offered for gs_usb adapters; multi-channel ones have two to four. */
const CHANNELS = 8;

interface Props {
  open: boolean;
  onClose: () => void;
  /** Starts capturing from `adapter`. Rejects with a message for the user if it can't. */
  onStart: (adapter: CaptureAdapter, settings: CaptureSettings) => Promise<void>;
  /** The adapter kinds the browser can reach. */
  kinds?: AdapterKind[];
  /** Shows the browser's device prompt; tests pass a stand-in. */
  request?: (kind: AdapterKind) => Promise<CaptureAdapter | null>;
  /** The buses the loaded DBCs are set to, offered as bus names. */
  buses?: string[];
}

/** Choose an adapter, a bitrate and listen-only, then start a live capture. */
export function CaptureSheet({ open, onClose, onStart, kinds = availableKinds(), request = requestAdapter, buses = [] }: Props) {
  const ids = useId();
  const [kind, setKind] = useState<AdapterKind>(kinds[0] ?? 'slcan');
  const [adapter, setAdapter] = useState<CaptureAdapter | null>(null);
  const [bitrate, setBitrate] = useState(DEFAULT_BITRATE);
  // 0: classic CAN.
  const [dataBitrate, setDataBitrate] = useState(0);
  const [listenOnly, setListenOnly] = useState(true);
  const [bus, setBus] = useState(DEFAULT_BUS);
  // 0: every frame.
  const [keepMinutes, setKeepMinutes] = useState(0);
  const [serialBaudRate, setSerialBaudRate] = useState(SERIAL_BAUD_RATE);
  // From 0, shown from 1.
  const [channel, setChannel] = useState(0);
  // Empty: the bitrate chosen sets the timing.
  const [btrText, setBtrText] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Why listen-only can't be confirmed, while the user decides whether to start anyway.
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);

  if (kinds.length === 0) {
    return (
      <Sheet
        open={open}
        onClose={onClose}
        title="Live Capture"
        footer={
          <button type="button" className="button" onClick={onClose}>
            Close
          </button>
        }
      >
        <p className="cap-text">Live capture needs Chrome or Edge on a desktop computer. This browser can&rsquo;t reach serial or USB devices.</p>
        {!window.isSecureContext && <p className="cap-text">The app also has to be opened over HTTPS.</p>}
        <p className="cap-text cap-quiet">You can still open logs recorded with another tool.</p>
      </Sheet>
    );
  }

  const chooseKind = (next: AdapterKind) => {
    setKind(next);
    setAdapter(null);
    setError(null);
    setUnconfirmed(null);
  };

  const choose = async () => {
    setError(null);
    try {
      const picked = await request(kind);
      if (picked) {
        setAdapter(picked);
        setUnconfirmed(null);
      }
    } catch (e) {
      setError(`The browser couldn't list the adapters: ${errorText(e)}`);
    }
  };

  const busProblem = busNameProblem(bus.trim());
  const slcan = kind === 'slcan';
  const btrTrimmed = btrText.trim();
  const btr = slcan && btrTrimmed !== '' ? parseBtr(btrTrimmed) : null;
  const btrProblem = slcan && btrTrimmed !== '' && !btr ? 'Enter four hex digits, BTR0 then BTR1, such as 031C.' : null;
  const btrBitrate = btr ? Math.round(sja1000Bitrate(...btr)) : null;
  const invalid = busProblem !== null || btrProblem !== null;

  const start = async () => {
    if (!adapter || invalid) return;
    setStarting(true);
    setError(null);
    try {
      await onStart(adapter, {
        bitrate: btrBitrate ?? bitrate,
        dataBitrate: dataBitrate > 0 ? dataBitrate : undefined,
        channel: !slcan && channel > 0 ? channel : undefined,
        bus: bus.trim(),
        keepMinutes: keepMinutes > 0 ? keepMinutes : undefined,
        listenOnly,
        allowUnconfirmedListenOnly: unconfirmed !== null,
        serialBaudRate: slcan && serialBaudRate !== SERIAL_BAUD_RATE ? serialBaudRate : undefined,
        btr: btr ? btrTrimmed.toUpperCase() : undefined,
      });
      setUnconfirmed(null);
      onClose();
    } catch (e) {
      if (isListenOnlyUnconfirmed(e)) setUnconfirmed(e.message);
      else setError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const detail = ADAPTER_KINDS.find((k) => k.kind === kind)?.detail;

  return (
    <Sheet
      open={open}
      onClose={() => !starting && onClose()}
      dismissible={!starting}
      title="Live Capture"
      description="Record frames from a CAN adapter on this computer. Nothing is uploaded."
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={starting}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={start} disabled={!adapter || invalid || starting}>
            {starting ? 'Starting\u2026' : unconfirmed ? 'Start Anyway' : 'Start Capture'}
          </button>
        </>
      }
    >
      <div className="cap-form">
        {kinds.length > 1 && (
          <div className="field">
            <span className="field-label">Adapter type</span>
            <Segmented
              label="Adapter type"
              options={ADAPTER_KINDS.filter((k) => kinds.includes(k.kind)).map((k) => ({ value: k.kind, label: k.label, disabled: starting }))}
              value={kind}
              onChange={chooseKind}
            />
          </div>
        )}
        <div className="field">
          <span className="field-label">Adapter</span>
          <div className="cap-device">
            <span id={`${ids}device`} className={adapter ? 'cap-device-name' : 'cap-device-name cap-quiet'}>
              {adapter?.label ?? 'None chosen'}
            </span>
            <button type="button" className="button" onClick={choose} disabled={starting} aria-describedby={`${ids}device`}>
              {adapter ? 'Choose Another\u2026' : 'Choose Adapter\u2026'}
            </button>
          </div>
          <p className="cap-hint">{detail}</p>
        </div>
        <div className="cap-row">
          <div className="field">
            <label htmlFor={`${ids}bitrate`} className="field-label">
              Bitrate
            </label>
            <select
              id={`${ids}bitrate`}
              className="select cap-bitrate"
              value={bitrate}
              onChange={(e) => setBitrate(Number(e.target.value))}
              disabled={starting || btr !== null}
            >
              {BITRATES.map((b) => (
                <option key={b} value={b}>
                  {formatBitrate(b)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${ids}databitrate`} className="field-label">
              CAN FD data bitrate
            </label>
            <select
              id={`${ids}databitrate`}
              className="select cap-bitrate"
              value={dataBitrate}
              onChange={(e) => setDataBitrate(Number(e.target.value))}
              disabled={starting}
            >
              <option value={0}>Off (classic CAN)</option>
              {DATA_BITRATES.map((b) => (
                <option key={b} value={b}>
                  {formatBitrate(b)}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field">
          <div className="cap-row">
            <div className="field">
              <label htmlFor={`${ids}bus`} className="field-label">
                Bus name
              </label>
              <input
                id={`${ids}bus`}
                className="input mono cap-bus"
                value={bus}
                onChange={(e) => setBus(e.target.value)}
                list={buses.length > 0 ? `${ids}buses` : undefined}
                spellCheck={false}
                autoComplete="off"
                disabled={starting}
                aria-invalid={busProblem !== null}
                aria-describedby={`${ids}bushint`}
              />
              {buses.length > 0 && (
                <datalist id={`${ids}buses`}>
                  {buses.map((b) => (
                    <option key={b} value={b} />
                  ))}
                </datalist>
              )}
            </div>
            <div className="field">
              <label htmlFor={`${ids}keep`} className="field-label">
                Keep
              </label>
              <select
                id={`${ids}keep`}
                className="select cap-bitrate"
                value={keepMinutes}
                onChange={(e) => setKeepMinutes(Number(e.target.value))}
                disabled={starting}
                aria-describedby={`${ids}bushint`}
              >
                <option value={0}>Every frame</option>
                {KEEP_MINUTES.map((m) => (
                  <option key={m} value={m}>
                    Last {m} min
                  </option>
                ))}
              </select>
            </div>
          </div>
          <p id={`${ids}bushint`} className={busProblem ? 'field-error' : 'cap-hint'}>
            {busProblem ?? 'The frames are stored under the bus name, so a DBC set to that bus decodes them.'}
            {!busProblem && keepMinutes > 0 && ' Older frames are dropped as new ones arrive, so a rolling capture can run for days; only what is kept is saved.'}
          </p>
        </div>
        <div className="field">
          <label className="cap-switch-row">
            <input
              type="checkbox"
              role="switch"
              className="switch"
              checked={listenOnly}
              onChange={(e) => {
                setListenOnly(e.target.checked);
                setUnconfirmed(null);
              }}
              disabled={starting}
            />
            <span>Listen only</span>
          </label>
          <p className="cap-hint">
            The adapter never acknowledges or sends a frame, so it can&rsquo;t disturb the bus. If an adapter can&rsquo;t confirm it, you&rsquo;ll be asked before it starts.
          </p>
        </div>
        <details className="cap-advanced">
          <summary>Advanced</summary>
          {!slcan && (
            <div className="cap-advanced-body">
              <div className="field">
                <label htmlFor={`${ids}channel`} className="field-label">
                  Channel
                </label>
                <select
                  id={`${ids}channel`}
                  className="select cap-bitrate"
                  value={channel}
                  onChange={(e) => setChannel(Number(e.target.value))}
                  disabled={starting}
                  aria-describedby={`${ids}channelhint`}
                >
                  {Array.from({ length: CHANNELS }, (_, c) => (
                    <option key={c} value={c}>
                      {c + 1}
                    </option>
                  ))}
                </select>
                <p id={`${ids}channelhint`} className="cap-hint">
                  For an adapter with more than one CAN port. The first is 1.
                </p>
              </div>
            </div>
          )}
          {slcan && (
            <div className="cap-advanced-body">
              <div className="field">
                <label htmlFor={`${ids}baud`} className="field-label">
                  Serial speed
                </label>
                <select
                  id={`${ids}baud`}
                  className="select cap-bitrate"
                  value={serialBaudRate}
                  onChange={(e) => setSerialBaudRate(Number(e.target.value))}
                  disabled={starting}
                  aria-describedby={`${ids}baudhint`}
                >
                  {SERIAL_BAUD_RATES.map((b) => (
                    <option key={b} value={b}>
                      {b.toLocaleString('en-US')} baud
                    </option>
                  ))}
                </select>
                <p id={`${ids}baudhint`} className="cap-hint">
                  For an adapter behind a UART. USB adapters ignore it.
                </p>
              </div>
              <div className="field">
                <label htmlFor={`${ids}btr`} className="field-label">
                  Bit timing (BTR0 BTR1)
                </label>
                <input
                  id={`${ids}btr`}
                  className="input mono cap-bus"
                  value={btrText}
                  onChange={(e) => setBtrText(e.target.value)}
                  placeholder="Off"
                  spellCheck={false}
                  autoComplete="off"
                  maxLength={4}
                  disabled={starting}
                  aria-invalid={btrProblem !== null}
                  aria-describedby={`${ids}btrhint`}
                />
                <p id={`${ids}btrhint`} className={btrProblem ? 'field-error' : 'cap-hint'}>
                  {btrProblem ??
                    (btrBitrate !== null
                      ? `Sent as s${btrTrimmed.toUpperCase()} in place of the bitrate: ${formatBitrate(btrBitrate)} on an SJA1000 at 16 MHz, such as the Lawicel CANUSB.`
                      : 'For a bitrate the list lacks: SJA1000 registers in hex, sent with the s command.')}
                </p>
              </div>
            </div>
          )}
        </details>
        {unconfirmed && (
          <p className="field-error" role="alert">
            {unconfirmed} Start anyway?
          </p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Sheet>
  );
}
