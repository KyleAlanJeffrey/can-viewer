import { useId, useState } from 'react';
import { Segmented } from '../components/Segmented';
import { Sheet } from '../components/Sheet';
import { BITRATES, busNameProblem, errorText, formatBitrate, isListenOnlyUnconfirmed, type CaptureAdapter, type CaptureSettings } from './adapter';
import { ADAPTER_KINDS, availableKinds, requestAdapter, type AdapterKind } from './devices';

const DEFAULT_BITRATE = 500_000;
const DEFAULT_BUS = 'can0';

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
  const [listenOnly, setListenOnly] = useState(true);
  const [bus, setBus] = useState(DEFAULT_BUS);
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

  const start = async () => {
    if (!adapter || busProblem) return;
    setStarting(true);
    setError(null);
    try {
      await onStart(adapter, { bitrate, bus: bus.trim(), listenOnly, allowUnconfirmedListenOnly: unconfirmed !== null });
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
          <button type="button" className="primary" onClick={start} disabled={!adapter || !!busProblem || starting}>
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
        <div className="field">
          <label htmlFor={`${ids}bitrate`} className="field-label">
            Bitrate
          </label>
          <select id={`${ids}bitrate`} className="select cap-bitrate" value={bitrate} onChange={(e) => setBitrate(Number(e.target.value))} disabled={starting}>
            {BITRATES.map((b) => (
              <option key={b} value={b}>
                {formatBitrate(b)}
              </option>
            ))}
          </select>
        </div>
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
          <p id={`${ids}bushint`} className={busProblem ? 'field-error' : 'cap-hint'}>
            {busProblem ?? 'The frames are stored under this name, so a DBC set to this bus decodes them.'}
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
