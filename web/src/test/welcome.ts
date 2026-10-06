import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/** Goes from the welcome's first step to its live setup, whose settings load on first use. */
export async function openLiveSetup() {
  // A worker's first render can take over a second under load.
  await userEvent.click(await screen.findByRole('radio', { name: 'Connect live' }, { timeout: 3000 }));
  await userEvent.click(screen.getByRole('button', { name: 'Continue with live capture' }));
}

/** The welcome, where the live setup's settings, alerts and Start Capture are. */
export const welcomeRegion = () => screen.getByRole('region', { name: 'Welcome' });
