import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeSerialPort } from '../test/fakeSerial';
import { ListenOnlyUnconfirmedError, type CaptureAdapter } from './adapter';
import { CaptureSheet } from './CaptureSheet';
import { SlcanAdapter } from './slcan';

const slcan = () => new SlcanAdapter(new FakeSerialPort(), { commandMs: 50, settleMs: 1 });

describe('CaptureSheet', () => {
  it('explains that this browser cannot capture, with nothing to start', async () => {
    const onClose = vi.fn();
    render(<CaptureSheet open onClose={onClose} onStart={vi.fn()} kinds={[]} />);
    expect(screen.getByText(/Live capture needs Chrome or Edge on a desktop computer/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Start Capture' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('starts with the chosen adapter, bitrate and listen-only setting, then closes', async () => {
    const adapter = slcan();
    const request = vi.fn(async () => adapter);
    const onStart = vi.fn(async () => {});
    const onClose = vi.fn();
    render(<CaptureSheet open onClose={onClose} onStart={onStart} kinds={['slcan']} request={request} />);

    const start = screen.getByRole('button', { name: 'Start Capture' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText('None chosen')).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: 'Adapter type' })).toBeNull();

    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    expect(request).toHaveBeenCalledWith('slcan');
    expect(screen.getByText('USB serial device 16D0:117E')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose Another\u2026', description: 'USB serial device 16D0:117E' })).toBeTruthy();

    expect((screen.getByLabelText('Bitrate') as HTMLSelectElement).value).toBe('500000');
    await userEvent.selectOptions(screen.getByLabelText('Bitrate'), '250 kbit/s');
    const listenOnly = screen.getByRole('switch', { name: 'Listen only' }) as HTMLInputElement;
    expect(listenOnly.checked).toBe(true);
    await userEvent.click(listenOnly);

    await userEvent.click(start);
    expect(onStart).toHaveBeenCalledWith(adapter, { bitrate: 250_000, bus: 'can0', listenOnly: false, allowUnconfirmedListenOnly: false });
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the sheet open with the reason when the adapter fails to start', async () => {
    const onClose = vi.fn();
    const onStart = vi.fn(() => Promise.reject(new Error('The adapter refused the bitrate. Check that it runs slcan firmware.')));
    render(<CaptureSheet open onClose={onClose} onStart={onStart} kinds={['slcan']} request={async () => slcan()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Capture' }));
    expect((await screen.findByRole('alert')).textContent).toBe('The adapter refused the bitrate. Check that it runs slcan firmware.');
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Start Capture' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('shows the button as starting while the adapter opens', async () => {
    let finish = () => {};
    const onStart = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<CaptureSheet open onClose={() => {}} onStart={onStart} kinds={['slcan']} request={async () => slcan()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Capture' }));
    expect((screen.getByRole('button', { name: 'Starting\u2026' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
    finish();
    await screen.findByRole('button', { name: 'Start Capture' });
  });

  it("asks before starting an adapter that can't confirm listen-only", async () => {
    const onClose = vi.fn();
    const onStart = vi.fn(async (_adapter: CaptureAdapter, settings: { allowUnconfirmedListenOnly?: boolean }) => {
      if (!settings.allowUnconfirmedListenOnly) throw new ListenOnlyUnconfirmedError("This adapter can't confirm listen-only mode, so it may acknowledge frames on the bus.");
    });
    render(<CaptureSheet open onClose={onClose} onStart={onStart} kinds={['slcan']} request={async () => slcan()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Capture' }));
    expect((await screen.findByRole('alert')).textContent).toBe("This adapter can't confirm listen-only mode, so it may acknowledge frames on the bus. Start anyway?");
    expect(onClose).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: 'Start Anyway' }));
    expect(onStart).toHaveBeenLastCalledWith(expect.anything(), { bitrate: 500_000, bus: 'can0', listenOnly: true, allowUnconfirmedListenOnly: true });
    expect(onClose).toHaveBeenCalled();
  });

  it('asks again from the start once the listen-only setting changes', async () => {
    const onStart = vi.fn(() => Promise.reject(new ListenOnlyUnconfirmedError('No listen-only.')));
    render(<CaptureSheet open onClose={() => {}} onStart={onStart} kinds={['slcan']} request={async () => slcan()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Capture' }));
    await screen.findByRole('button', { name: 'Start Anyway' });
    await userEvent.click(screen.getByRole('switch', { name: 'Listen only' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Listen only' }));
    expect(screen.getByRole('button', { name: 'Start Capture' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('stays open on Escape while starting', async () => {
    let finish = () => {};
    const onClose = vi.fn();
    const onStart = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    render(<CaptureSheet open onClose={onClose} onStart={onStart} kinds={['slcan']} request={async () => slcan()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    await userEvent.click(screen.getByRole('button', { name: 'Start Capture' }));
    const dialog = screen.getByRole('dialog') as HTMLDialogElement;
    act(() => {
      if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
    });
    expect(dialog.open).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    finish();
    await screen.findByRole('button', { name: 'Start Capture' });
    expect(onClose).toHaveBeenCalled();
  });

  it('names the bus, offering the buses the DBCs are set to, and keeps the name for the next start', async () => {
    const onStart = vi.fn(async () => {});
    const { rerender } = render(<CaptureSheet open onClose={() => {}} onStart={onStart} kinds={['slcan']} request={async () => slcan()} buses={['body', 'chassis']} />);
    const name = screen.getByLabelText('Bus name') as HTMLInputElement;
    expect(name.value).toBe('can0');
    const options = [...document.getElementById(name.getAttribute('list')!)!.querySelectorAll('option')].map((o) => o.value);
    expect(options).toEqual(['body', 'chassis']);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));

    await userEvent.clear(name);
    expect(screen.getByText('Enter a bus name, such as can0.')).toBeTruthy();
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByRole('button', { name: 'Start Capture' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(name, 'body two');
    expect(screen.getByText('A bus name has no spaces.')).toBeTruthy();
    await userEvent.clear(name);
    await userEvent.type(name, ' body ');
    await userEvent.click(screen.getByRole('button', { name: 'Start Capture' }));
    expect(onStart).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ bus: 'body' }));

    rerender(<CaptureSheet open={false} onClose={() => {}} onStart={onStart} kinds={['slcan']} request={async () => slcan()} buses={['body', 'chassis']} />);
    rerender(<CaptureSheet open onClose={() => {}} onStart={onStart} kinds={['slcan']} request={async () => slcan()} buses={['body', 'chassis']} />);
    expect((screen.getByLabelText('Bus name') as HTMLInputElement).value).toBe(' body ');
  });

  it('sets a serial speed and custom bit timing for slcan under Advanced', async () => {
    const onStart = vi.fn(async () => {});
    render(<CaptureSheet open onClose={() => {}} onStart={onStart} kinds={['slcan', 'gsusb']} request={async () => slcan()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    await userEvent.click(screen.getByText('Advanced'));
    expect((screen.getByLabelText('Serial speed') as HTMLSelectElement).value).toBe('115200');
    await userEvent.selectOptions(screen.getByLabelText('Serial speed'), '57,600 baud');

    const timing = screen.getByLabelText('Bit timing (BTR0 BTR1)');
    await userEvent.type(timing, '31');
    expect(screen.getByText('Enter four hex digits, BTR0 then BTR1, such as 031C.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start Capture' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(timing);
    await userEvent.type(timing, '031c');
    expect(screen.getByText(/^Sent as s031C in place of the bitrate: 125 kbit\/s/)).toBeTruthy();
    expect((screen.getByLabelText('Bitrate') as HTMLSelectElement).disabled).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Start Capture' }));
    expect(onStart).toHaveBeenLastCalledWith(expect.anything(), {
      bitrate: 125_000,
      bus: 'can0',
      listenOnly: true,
      allowUnconfirmedListenOnly: false,
      serialBaudRate: 57_600,
      btr: '031C',
    });

    await userEvent.click(screen.getByRole('radio', { name: 'USB (candleLight)' }));
    expect(screen.queryByText('Advanced')).toBeNull();
  });

  it('stays without an adapter when the device prompt is dismissed', async () => {
    render(<CaptureSheet open onClose={() => {}} onStart={vi.fn()} kinds={['slcan']} request={async () => null} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    expect(screen.getByText('None chosen')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Start Capture' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('offers both adapter types where the browser has both, and forgets the device on a switch', async () => {
    const usbAdapter: CaptureAdapter = { label: 'candleLight USB to CAN adapter (1D50:606F)', start: vi.fn(), stop: vi.fn() };
    const request = vi.fn(async (kind: string) => (kind === 'slcan' ? slcan() : usbAdapter));
    render(<CaptureSheet open onClose={() => {}} onStart={vi.fn()} kinds={['slcan', 'gsusb']} request={request} />);
    expect(screen.getByText(/USBtin/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    expect(screen.getByText('USB serial device 16D0:117E')).toBeTruthy();

    await userEvent.click(screen.getByRole('radio', { name: 'USB (candleLight)' }));
    expect(screen.getByText('None chosen')).toBeTruthy();
    expect(screen.getByText(/candleLight firmware and other gs_usb adapters/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    expect(request).toHaveBeenLastCalledWith('gsusb');
    expect(screen.getByText('candleLight USB to CAN adapter (1D50:606F)')).toBeTruthy();
  });
});
