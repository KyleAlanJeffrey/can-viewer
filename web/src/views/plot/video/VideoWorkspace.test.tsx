import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VideoWorkspace } from './VideoWorkspace';
import { videoSession } from './videoSession';

vi.mock('./VideoPanel', () => {
  throw new Error('chunk failed to load');
});

afterEach(() => {
  act(() => videoSession.close());
  vi.restoreAllMocks();
});

describe('Video workspace', () => {
  it('says so when the video panel cannot load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    URL.createObjectURL = () => 'blob:video-1';
    URL.revokeObjectURL = () => {};
    render(
      <VideoWorkspace logDuration={100} cursor={null} onCursor={() => {}}>
        <p>plots</p>
      </VideoWorkspace>,
    );
    act(() => videoSession.open(new File(['x'], 'dash.mp4', { type: 'video/mp4' }), { name: 'demo.log', bytes: 100 }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain("Couldn't load the video panel.");
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.getByText('plots')).toBeTruthy();
  });
});
