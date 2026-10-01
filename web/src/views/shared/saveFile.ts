import { downloadText } from '../../download';

/** The File System Access API, which only Chromium ships; declared here as the DOM lib leaves it out. */
interface SaveFilePicker {
  (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }): Promise<WritableHandle>;
}

interface WritableHandle {
  createWritable(): Promise<{ write(data: string): Promise<void>; close(): Promise<void> }>;
}

export interface FileKind {
  description: string;
  mime: string;
  extension: string;
}

/**
 * Starts saving a text file. Where the browser has a save dialog it opens at once, so call this
 * straight from the click, before awaiting anything, or the browser refuses it. The returned
 * function writes the text once it's ready and resolves false if the dialog was cancelled.
 * Elsewhere it falls back to a download, which has no completion signal and never resolves false.
 */
export function startTextSave(name: string, kind: FileKind): (text: string) => Promise<boolean> {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (!picker) {
    return async (text) => {
      downloadText(name, text, kind.mime);
      return true;
    };
  }
  const handle = picker({ suggestedName: name, types: [{ description: kind.description, accept: { [kind.mime]: [kind.extension] } }] }).catch(
    (e: unknown) => {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      throw e;
    },
  );
  return async (text) => {
    const file = await handle;
    if (!file) return false;
    const writable = await file.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  };
}
