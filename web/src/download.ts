/** Hand the viewer a file to save. Nothing leaves the computer: the blob is built in the page. */
export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  // The click starts the download synchronously, but some browsers read the URL a tick later.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function downloadText(name: string, text: string, type = 'text/plain') {
  downloadBlob(name, new Blob([text], { type: `${type};charset=utf-8` }));
}
