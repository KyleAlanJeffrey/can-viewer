import { downloadBlob, downloadText } from '../../download';

/** The File System Access API, which only Chromium ships; declared here as the DOM lib leaves it out. */
interface SaveFilePicker {
  (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }): Promise<WritableHandle>;
}

interface WritableHandle {
  createWritable(): Promise<{ write(data: string | Blob): Promise<void>; close(): Promise<void> }>;
}

export interface FileKind {
  description: string;
  mime: string;
  extension: string;
}

/** Whether saving opens the browser's save dialog, rather than downloading. */
export function hasSaveDialog(): boolean {
  return typeof (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker === 'function';
}

/** Opens the save dialog, resolving to the chosen file or null if cancelled; null at once without one. */
function pickFile(name: string, kind: FileKind): Promise<WritableHandle | null> | null {
  const picker = (window as unknown as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (!picker) return null;
  return picker({ suggestedName: name, types: [{ description: kind.description, accept: { [kind.mime]: [kind.extension] } }] }).catch(
    (e: unknown) => {
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      throw e;
    },
  );
}

async function writeFile(file: WritableHandle, data: string | Blob) {
  const writable = await file.createWritable();
  await writable.write(data);
  await writable.close();
}

/**
 * Starts saving a text file. Where the browser has a save dialog it opens at once, so call this
 * straight from the click, before awaiting anything, or the browser refuses it. The returned
 * function writes the text once it's ready and resolves false if the dialog was cancelled.
 * Elsewhere it falls back to a download, which has no completion signal and never resolves false.
 */
export function startTextSave(name: string, kind: FileKind): (text: string) => Promise<boolean> {
  const handle = pickFile(name, kind);
  if (!handle) {
    return async (text) => {
      downloadText(name, text, kind.mime);
      return true;
    };
  }
  return async (text) => {
    const file = await handle;
    if (!file) return false;
    await writeFile(file, text);
    return true;
  };
}

/**
 * Like `startTextSave`, for a file that takes a while to make: the returned function calls
 * `make` only once a file was chosen, so a cancelled dialog costs nothing.
 */
export function startBlobSave(name: string, kind: FileKind): (make: () => Promise<Blob>) => Promise<boolean> {
  const handle = pickFile(name, kind);
  if (!handle) {
    return async (make) => {
      downloadBlob(name, await make());
      return true;
    };
  }
  return async (make) => {
    const file = await handle;
    if (!file) return false;
    await writeFile(file, await make());
    return true;
  };
}
