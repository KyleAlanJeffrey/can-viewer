import { useRef, type ReactNode } from 'react';
import { Video } from 'lucide-react';
import { videoSession } from './videoSession';

/** Opens a local video for the log through a file picker. */
export function AddVideoButton({ logName, children }: { logName: string; children?: ReactNode }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="button" onClick={() => input.current?.click()} title="Video stays on this computer. Never uploaded.">
        <Video size={16} strokeWidth={1.5} aria-hidden="true" />
        {children ?? <>Add video&hellip;</>}
      </button>
      <input
        ref={input}
        type="file"
        accept="video/*"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) videoSession.open(file, logName);
        }}
      />
    </>
  );
}
