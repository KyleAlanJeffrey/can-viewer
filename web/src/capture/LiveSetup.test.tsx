import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FakeSerialPort } from '../test/fakeSerial';
import { LiveSetup } from './LiveSetup';
import { SlcanAdapter } from './slcan';

const slcan = () => new SlcanAdapter(new FakeSerialPort(), { commandMs: 50, settleMs: 1 });
const start = () => screen.getByRole('button', { name: 'Start Capture' }) as HTMLButtonElement;

describe('LiveSetup', () => {
  it('holds Start back until an adapter is chosen, and choosing one records nothing', async () => {
    const onStart = vi.fn(async () => {});
    render(<LiveSetup onStart={onStart} kinds={['slcan']} request={async () => slcan()} buses={[]} busy={false} />);
    expect(start().disabled).toBe(true);

    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByText('Nothing is recorded until you start.')).toBeTruthy();
    expect(start().disabled).toBe(false);
  });

  it('holds Start back while the app is busy', async () => {
    render(<LiveSetup onStart={vi.fn()} kinds={['slcan']} request={async () => slcan()} buses={[]} busy />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    expect(start().disabled).toBe(true);
  });

  it('reports a start while it runs', async () => {
    let finish = () => {};
    const onStart = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const onStartingChange = vi.fn();
    render(<LiveSetup onStart={onStart} kinds={['slcan']} request={async () => slcan()} buses={[]} busy={false} onStartingChange={onStartingChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Choose Adapter\u2026' }));
    await userEvent.click(start());
    expect(onStartingChange).toHaveBeenLastCalledWith(true);
    finish();
    await vi.waitFor(() => expect(onStartingChange).toHaveBeenLastCalledWith(false));
  });
});
