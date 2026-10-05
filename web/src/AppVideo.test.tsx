import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeCore, logInfo } from './test/fixtures';

/** session.ts caches its open database, so each test loads a fresh copy of the app's modules. */
async function freshApp() {
  vi.resetModules();
  const { App } = await import('./App');
  const { videoSession } = await import('./views/plot/video/videoSession');
  return { App, videoSession };
}

/** Drops `files` on the window, as the browser does when files are dragged in. */
function drop(files: File[]) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files } });
  act(() => {
    window.dispatchEvent(event);
  });
}

const video = (name = 'dash.mp4') => new File(['x'], name, { type: 'video/mp4' });
const logFile = (name: string) => new File(['(1.0) can0 123#00'], name);

let revoked: string[];

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  revoked = [];
  let n = 0;
  URL.createObjectURL = () => `blob:video-${++n}`;
  URL.revokeObjectURL = (url: string) => void revoked.push(url);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function core() {
  return fakeCore({
    openLog: (_file, name) => Promise.resolve(logInfo({ name })),
    idSummary: () => Promise.resolve([]),
  });
}

describe('Adding a video to the app', () => {
  it('asks for a log first', async () => {
    const { App, videoSession } = await freshApp();
    render(<App core={core()} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });
    drop([video()]);
    expect((await screen.findByRole('alert')).textContent).toBe('Open a log first, then add the video to line it up with it.');
    expect(videoSession.get()).toBeNull();
  });

  it('opens a dropped video beside the plots, and drops it when another log opens', async () => {
    const { App, videoSession } = await freshApp();
    const { container } = render(<App core={core()} />);
    await screen.findByRole('heading', { name: 'Open a CAN log to get started' });

    drop([logFile('drive.log'), video()]);
    expect(await screen.findByRole('region', { name: 'Video' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Plot' }).getAttribute('aria-checked')).toBe('true');
    expect(videoSession.get()).toMatchObject({ name: 'dash.mp4', logName: 'drive.log' });

    const input = container.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!;
    await userEvent.upload(input, logFile('other.log'));
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Video' })).toBeNull());
    expect(videoSession.get()).toBeNull();
    expect(revoked).toEqual(['blob:video-1']);
  });
});
