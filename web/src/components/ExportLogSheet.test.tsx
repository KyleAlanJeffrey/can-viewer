import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CoreApi, LogInfo } from '../core/api';
import { fakeCore, logInfo } from '../test/fixtures';
import { EXPORT_FORMATS, ExportLogSheet, exportFileName } from './ExportLogSheet';

const FILE = new Blob(['(1.000000) can0 123#00\n']);

/** A save dialog that resolves to a file collecting what is written, or fails with `error`. */
function stubPicker(error?: DOMException) {
  const written: unknown[] = [];
  const close = vi.fn(async () => undefined);
  const picker = vi.fn(async () => {
    if (error) throw error;
    return {
      createWritable: async () => ({
        write: async (data: unknown) => {
          written.push(data);
        },
        close,
      }),
    };
  });
  vi.stubGlobal('showSaveFilePicker', picker);
  return { picker, written, close };
}

/** Renders the open sheet with a `run` that, like the app's, keeps the error a task throws. */
function renderSheet(core: CoreApi, log: LogInfo = logInfo({ name: 'drive.mf4', format: 'mf4' })) {
  const errors: string[] = [];
  const run = vi.fn(async (_label: string, task: () => Promise<void>) => {
    try {
      await task();
      return true;
    } catch (e) {
      errors.push((e as Error).message);
      return false;
    }
  });
  const onClose = vi.fn();
  render(<ExportLogSheet open onClose={onClose} core={core} log={log} run={run} />);
  return { run, errors, onClose, user: userEvent.setup() };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Export Log sheet', () => {
  it('lists every format with what it keeps, and picks one other than the log has', () => {
    renderSheet(fakeCore(), logInfo({ name: 'drive.log', format: 'candump' }));
    const radios = screen.getAllByRole('radio');
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual([
      'candump (.log)',
      'Vector ASC (.asc)',
      'Vector BLF (.blf)',
      'PEAK TRC (.trc)',
      'ASAM MF4 (.mf4)',
      'CSV (.csv)',
    ]);
    expect(screen.getByRole('radio', { name: 'Vector ASC (.asc)', checked: true })).toBeTruthy();
    const csv = screen.getByRole('radio', { name: 'CSV (.csv)' });
    expect(csv.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(csv.getAttribute('aria-describedby')!)?.textContent).toBe(EXPORT_FORMATS[5].note);
    expect(screen.getByText(/never uploaded/)).toBeTruthy();
  });

  it('saves what the core exports to the file chosen in the save dialog', async () => {
    const { picker, written, close } = stubPicker();
    const exportLog = vi.fn<CoreApi['exportLog']>(async () => FILE);
    const { run, onClose, user } = renderSheet(fakeCore({ exportLog }));

    await user.click(screen.getByRole('radio', { name: 'Vector BLF (.blf)' }));
    await user.click(screen.getByRole('button', { name: 'Export\u2026' }));
    expect(picker).toHaveBeenCalledWith(
      expect.objectContaining({ suggestedName: 'drive.blf', types: [{ description: 'Vector BLF log', accept: { 'application/octet-stream': ['.blf'] } }] }),
    );
    expect(onClose).toHaveBeenCalled();
    expect(run).toHaveBeenCalledWith('Exporting drive.mf4 as Vector BLF\u2026', expect.any(Function));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(exportLog).toHaveBeenCalledWith('blf');
    expect(written).toEqual([FILE]);
  });

  it('exports nothing when the save dialog is cancelled', async () => {
    const { written } = stubPicker(new DOMException('The user aborted a request.', 'AbortError'));
    const exportLog = vi.fn<CoreApi['exportLog']>(async () => FILE);
    const { run, errors, user } = renderSheet(fakeCore({ exportLog }));

    await user.click(screen.getByRole('button', { name: 'Export\u2026' }));
    await waitFor(() => expect(run).toHaveResolvedWith(true));
    expect(exportLog).not.toHaveBeenCalled();
    expect(written).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('downloads the file where the browser has no save dialog', async () => {
    // jsdom has no object URLs.
    const createObjectURL = vi.fn(() => 'blob:export');
    Object.assign(URL, { createObjectURL, revokeObjectURL: () => undefined });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    const exportLog = vi.fn<CoreApi['exportLog']>(async () => FILE);
    const { user } = renderSheet(fakeCore({ exportLog }), logInfo({ name: 'drive.log', format: 'candump' }));

    await user.click(screen.getByRole('radio', { name: 'candump (.log)' }));
    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(exportLog).toHaveBeenCalledWith('candump');
    expect(createObjectURL).toHaveBeenCalledWith(FILE);
    expect(clicked[0].download).toBe('drive-export.log');
  });

  it('passes an export error on to be shown', async () => {
    const exportLog = vi.fn<CoreApi['exportLog']>(async () => {
      throw new Error("There isn't enough memory to build the exported file.");
    });
    const { errors, user } = renderSheet(fakeCore({ exportLog }));

    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() => expect(errors).toEqual(["There isn't enough memory to build the exported file."]));
  });

  it('says that reassembled J1939 transfers are left out', () => {
    renderSheet(fakeCore(), logInfo({ reassembledFrames: 1200 }));
    expect(screen.getByText(/The 1,200 J1939 transfers reassembled from packets are left out\./)).toBeTruthy();
  });
});

describe('exportFileName', () => {
  it('swaps the extension, and marks a name that would not change', () => {
    expect(exportFileName('drive.blf', '.asc')).toBe('drive.asc');
    expect(exportFileName('drive.v2.LOG', '.mf4')).toBe('drive.v2.mf4');
    expect(exportFileName('drive.LOG', '.log')).toBe('drive-export.log');
    expect(exportFileName('drive', '.csv')).toBe('drive.csv');
    expect(exportFileName('.hidden', '.csv')).toBe('.hidden.csv');
  });
});
