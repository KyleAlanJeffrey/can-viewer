import { useRef, type ReactNode } from 'react';
import { Video } from 'lucide-react';
import type { LogIdentity } from './sync';
import { useLoadingLog, videoSession } from './videoSession';

// Some browsers leave files out of video/* when they don't know the type, as with .mkv.
const ACCEPT = 'video/*,.mp4,.m4v,.mov,.webm,.mkv,.ogv,.avi';

/** Opens a local video for the log through a file picker. */
export function AddVideoButton({ log, children }: { log: LogIdentity; children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  const loadingLog = useLoadingLog();
  return (
    <>
      <button className="button" onClick={() => input.current?.click()} disabled={loadingLog} title="Video stays on this computer. Never uploaded.">
        <Video size={16} strokeWidth={1.5} aria-hidden="true" />
        {children ?? <>Add video&hellip;</>}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) videoSession.open(file, log);
        }}
      />
    </>
  );
}
