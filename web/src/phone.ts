import { useSyncExternalStore } from 'react';

/** Phones get their own layout. Keep in step with the 600px media queries in the stylesheets. */
export const PHONE = '(max-width: 600px)';

const subscribe = (onChange: () => void) => {
  const query = window.matchMedia(PHONE);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
};

const isPhone = () => window.matchMedia(PHONE).matches;

/** Whether the window is phone-sized, kept up to date as it resizes. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, isPhone);
}
