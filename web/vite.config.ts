/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { precachePlugin } from './src/offline/precachePlugin.ts';

/** Files in public/ that the app shell needs offline, precached with the built files. */
export const PRECACHED_PUBLIC_FILES = [
  'favicon.svg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

export default defineConfig({
  plugins: [react(), precachePlugin({ swEntry: '/src/offline/sw.ts', publicFiles: PRECACHED_PUBLIC_FILES })],
  worker: { format: 'es' },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test/setup.ts'],
  },
});
