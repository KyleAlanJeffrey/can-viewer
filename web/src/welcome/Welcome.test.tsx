import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Welcome, type WelcomeSource, type WelcomeStep } from './Welcome';

type Props = ComponentProps<typeof Welcome>;

/** The welcome with its step and source held as App holds them. */
function Harness(overrides: Partial<Props>) {
  const [step, setStep] = useState<WelcomeStep>('source');
  const [source, setSource] = useState<WelcomeSource>('file');
  return (
    <Welcome
      step={step}
      source={source}
      onChange={(nextStep, nextSource) => {
        setStep(nextStep);
        setSource(nextSource);
      }}
      busy={false}
      dbcNames={[]}
      onExplore={() => {}}
      onAddDbcs={() => {}}
      onOpenDbcs={() => {}}
      onEditDbcs={null}
      onDemo={() => {}}
      liveKinds={[]}
      liveSetup={null}
      {...overrides}
    />
  );
}

function renderWelcome(overrides: Partial<Props> = {}) {
  const user = userEvent.setup();
  const { container } = render(<Harness {...overrides} />);
  return { user, container };
}

const heading = (name: string) => screen.getByRole('heading', { name });
const currentStep = () => document.querySelector('[aria-current="step"]')?.textContent;
const nextHint = () => document.querySelector('.wel-next')?.textContent;

describe('Welcome', () => {
  it('starts at Source, with Open a log chosen', () => {
    renderWelcome();
    expect(heading('How would you like to start?')).toBeTruthy();
    expect(currentStep()).toBe('1Source');
    expect((screen.getByRole('radio', { name: 'Open a log' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('radio', { name: 'Connect live' }).getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: 'How would you like to start?' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Continue with a log' })).toBeTruthy();
    expect(nextHint()).toBe('Next: choose a log. Add a DBC if you have one.');
    expect(screen.getByText('Experimental \u00b7 requires a compatible adapter and browser')).toBeTruthy();
    expect(screen.getByText('Files and recordings stay on your device.')).toBeTruthy();
  });

  it('changes the Continue label and the next step with the choice, by click or arrow key', async () => {
    const { user } = renderWelcome();
    await user.click(screen.getByRole('radio', { name: 'Connect live' }));
    expect(screen.getByRole('button', { name: 'Continue with live capture' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Continue with a log' })).toBeNull();
    expect(nextHint()).toBe('Next: choose an adapter and a bitrate, then start the capture.');
    // Focus stays on the choice rather than moving to the heading.
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Connect live' }));

    await user.keyboard('{ArrowUp}');
    expect((screen.getByRole('radio', { name: 'Open a log' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole('button', { name: 'Continue with a log' })).toBeTruthy();
  });

  it('goes to Setup and Back again, keeping the choice', async () => {
    const { user } = renderWelcome();
    await user.click(screen.getByRole('button', { name: 'Continue with a log' }));
    expect(document.activeElement).toBe(heading('Choose your log'));
    expect(currentStep()).toBe('2Setup');
    expect(screen.getByText('Source').closest('li')?.textContent).toBe('Source (done)');
    expect(screen.getByText('candump \u00b7 ASC \u00b7 BLF \u00b7 TRC \u00b7 MF4 \u00b7 CSV')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(document.activeElement).toBe(heading('How would you like to start?'));
    expect(currentStep()).toBe('1Source');
    expect((screen.getByRole('radio', { name: 'Open a log' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  it('shows the file chosen with its size, and explores it only once one is chosen', async () => {
    const onExplore = vi.fn();
    const { user, container } = renderWelcome({ onExplore });
    await user.click(screen.getByRole('button', { name: 'Continue with a log' }));
    const explore = screen.getByRole('button', { name: 'Explore log' }) as HTMLButtonElement;
    expect(explore.disabled).toBe(true);
    expect(screen.getByText('No file chosen')).toBeTruthy();

    const file = new File(['x'.repeat(2500)], 'drive.blf');
    await user.upload(container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!, file);
    expect(screen.getByText('drive.blf')).toBeTruthy();
    expect(screen.getByText('3 kB')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Choose another\u2026' })).toBeTruthy();
    expect(explore.disabled).toBe(false);
    await user.click(explore);
    expect(onExplore).toHaveBeenCalledWith(file);
  });

  it('adds DBCs in Setup, lists those loaded, and says they can wait', async () => {
    const onAddDbcs = vi.fn();
    const { user, container } = renderWelcome({ onAddDbcs, dbcNames: ['body.dbc'] });
    await user.click(screen.getByRole('button', { name: 'Continue with a log' }));
    expect(screen.getByRole('heading', { name: 'Decode signals (optional)' })).toBeTruthy();
    expect(screen.getByText('You can add one later.')).toBeTruthy();
    expect(screen.getByRole('list', { name: 'DBCs loaded' }).textContent).toBe('body.dbc');
    const dbc = new File(['VERSION ""'], 'chassis.dbc');
    await user.upload(container.querySelector<HTMLInputElement>('input[accept=".dbc"]')!, dbc);
    expect(onAddDbcs).toHaveBeenCalledWith([dbc]);
  });

  it('opens a DBC on its own from Source, or edits the DBCs already loaded', async () => {
    const onOpenDbcs = vi.fn();
    const { user, container } = renderWelcome({ onOpenDbcs });
    expect(screen.getByRole('button', { name: 'Open a DBC\u2026' })).toBeTruthy();
    const dbc = new File(['VERSION ""'], 'body.dbc');
    await user.upload(container.querySelector<HTMLInputElement>('input[accept=".dbc"]')!, dbc);
    expect(onOpenDbcs).toHaveBeenCalledWith([dbc]);
  });

  it('offers the DBCs already loaded instead of opening one', async () => {
    const onEditDbcs = vi.fn();
    const { user } = renderWelcome({ onEditDbcs });
    expect(screen.queryByRole('button', { name: 'Open a DBC\u2026' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit your DBCs' }));
    expect(onEditDbcs).toHaveBeenCalled();
  });

  it('explains when this browser cannot capture, and offers a log or the demo instead', async () => {
    const onDemo = vi.fn();
    const { user } = renderWelcome({ onDemo, liveSetup: <p>Live settings</p> });
    await user.click(screen.getByRole('radio', { name: 'Connect live' }));
    await user.click(screen.getByRole('button', { name: 'Continue with live capture' }));
    expect(document.activeElement).toBe(heading('Live capture needs a compatible computer'));
    expect(screen.queryByText('Live settings')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try the Demo' }));
    expect(onDemo).toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Open a log instead' }));
    expect(document.activeElement).toBe(heading('Choose your log'));
    expect(currentStep()).toBe('2Setup');
  });

  it('shows the live setup it is given when this browser can capture', async () => {
    const { user } = renderWelcome({ liveKinds: ['slcan'], liveSetup: <p>Live settings</p> });
    await user.click(screen.getByRole('radio', { name: 'Connect live' }));
    await user.click(screen.getByRole('button', { name: 'Continue with live capture' }));
    expect(document.activeElement).toBe(heading('Connect to a CAN bus'));
    expect(screen.getByText('Live settings')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect((screen.getByRole('radio', { name: 'Connect live' }) as HTMLInputElement).checked).toBe(true);
  });

  it('holds back what would start a task while another runs', async () => {
    const { user } = renderWelcome({ busy: true });
    expect((screen.getByRole('button', { name: 'Try the Demo' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Open a DBC\u2026' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: 'Continue with a log' }));
    expect((screen.getByRole('button', { name: /Add DBC/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Choose a file\u2026' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
