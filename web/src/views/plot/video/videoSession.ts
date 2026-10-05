import { useSyncExternalStore } from 'react';
import { rememberOffset, rememberedOffset, roundOffset } from './sync';

export interface LoadedVideo {
  name: string;
  /** An object URL for the file, revoked when the video is closed. */
  url: string;
  /** The log the video was added to, for remembering its offset. */
  logName: string;
  /** Log time minus video time. Null until the video is synced. */
  offset: number | null;
  /** The offset the last sync set, which Reset returns to after nudges. */
  syncedOffset: number | null;
}

const VIDEO_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv|ogv|avi)$/i;

export function isVideoFile(file: File): boolean {
  return file.type.startsWith('video/') || VIDEO_EXTENSIONS.test(file.name);
}

/**
 * The video added to the open log. It lives outside the views, so it survives switching views,
 * and in memory only: a reload or another log drops it.
 */
export class VideoSession {
  private video: LoadedVideo | null = null;
  private listeners = new Set<() => void>();
  /** Where playback was when the panel last unmounted. Not state: nothing renders from it. */
  position = 0;

  get = () => this.video;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  open(file: File, logName: string) {
    this.release();
    const offset = rememberedOffset(logName, file.name);
    this.video = { name: file.name, url: URL.createObjectURL(file), logName, offset, syncedOffset: offset };
    this.position = 0;
    this.emit();
  }

  close() {
    if (!this.video) return;
    this.release();
    this.video = null;
    this.emit();
  }

  /** Sets the offset a sync found, which also becomes the one Reset returns to. */
  sync(offset: number) {
    const rounded = roundOffset(offset);
    this.change({ offset: rounded, syncedOffset: rounded });
  }

  /** Changes the offset without moving the synced baseline, as a nudge does. */
  setOffset(offset: number) {
    this.change({ offset: roundOffset(offset) });
  }

  private change(fields: Partial<LoadedVideo>) {
    if (!this.video) return;
    this.video = { ...this.video, ...fields };
    if (this.video.offset !== null) rememberOffset(this.video.logName, this.video.name, this.video.offset);
    this.emit();
  }

  private release() {
    if (this.video) URL.revokeObjectURL(this.video.url);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }
}

export const videoSession = new VideoSession();

export function useVideo(session: VideoSession = videoSession): LoadedVideo | null {
  return useSyncExternalStore(session.subscribe, session.get);
}
