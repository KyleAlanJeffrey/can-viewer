import { useId, useState } from 'react';
import type { CoreApi, LogFormat, LogInfo } from '../core/api';
import { formatCount } from '../format';
import { hasSaveDialog, startBlobSave, type FileKind } from '../views/shared/saveFile';
import { Sheet } from './Sheet';

interface ExportFormat {
  format: LogFormat;
  label: string;
  /** What the file keeps and loses, in one line. */
  note: string;
  kind: FileKind;
}

const NUMBERED_BUSES = 'Buses are numbered, not named.';

export const EXPORT_FORMATS: ExportFormat[] = [
  {
    format: 'candump',
    label: 'candump',
    note: 'Keeps every frame, bus name and error class. Times to the microsecond.',
    kind: { description: 'candump log', mime: 'text/plain', extension: '.log' },
  },
  {
    format: 'asc',
    label: 'Vector ASC',
    note: `${NUMBERED_BUSES} Error frames lose their class and data. Times to the microsecond.`,
    kind: { description: 'Vector ASC log', mime: 'text/plain', extension: '.asc' },
  },
  {
    format: 'blf',
    label: 'Vector BLF',
    note: `${NUMBERED_BUSES} Error frames lose their class. Compressed; times to the nanosecond.`,
    kind: { description: 'Vector BLF log', mime: 'application/octet-stream', extension: '.blf' },
  },
  {
    format: 'trc',
    label: 'PEAK TRC',
    note: `${NUMBERED_BUSES} Error frames lose their class. Times to the microsecond.`,
    kind: { description: 'PEAK TRC log', mime: 'text/plain', extension: '.trc' },
  },
  {
    format: 'mf4',
    label: 'ASAM MF4',
    note: `${NUMBERED_BUSES} Error frames lose their class. Compressed; times to the nanosecond.`,
    kind: { description: 'ASAM MF4 log', mime: 'application/octet-stream', extension: '.mf4' },
  },
  {
    format: 'csv',
    label: 'CSV',
    note: 'Keeps every frame and bus name. Times to the microsecond. Spreadsheets show about a million rows at most.',
    kind: { description: 'CSV file', mime: 'text/csv', extension: '.csv' },
  },
];

/** `drive.blf` exported with `.asc` is `drive.asc`; a name that would stay the same gets `-export`. */
export function exportFileName(logName: string, extension: string): string {
  const dot = logName.lastIndexOf('.');
  const stem = (dot > 0 ? logName.slice(0, dot) : logName) || 'log';
  const name = `${stem}${extension}`;
  return name.toLowerCase() === logName.toLowerCase() ? `${stem}-export${extension}` : name;
}

interface Props {
  open: boolean;
  onClose: () => void;
  core: CoreApi;
  log: LogInfo;
  /** Runs the export as the app's busy task, which shows its label and any error. */
  run: (label: string, task: () => Promise<void>) => Promise<boolean>;
}

/** Pick a format to save the open log in. The file is made in the browser and never uploaded. */
export function ExportLogSheet({ open, onClose, core, log, run }: Props) {
  const [format, setFormat] = useState<LogFormat>(() => (log.format === 'candump' ? 'asc' : 'candump'));
  const id = useId();
  const saveDialog = hasSaveDialog();

  const exportLog = () => {
    const target = EXPORT_FORMATS.find((f) => f.format === format) ?? EXPORT_FORMATS[0];
    // The save dialog must open straight from the click.
    const save = startBlobSave(exportFileName(log.name, target.kind.extension), target.kind);
    onClose();
    void run(`Exporting ${log.name} as ${target.label}\u2026`, async () => {
      await save(() => core.exportLog(target.format));
    });
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Export Log"
      description={`Save ${log.name} in another format. The file is made on your computer and never uploaded.`}
      footer={
        <>
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={exportLog}>
            {saveDialog ? 'Export\u2026' : 'Download'}
          </button>
        </>
      }
    >
      <fieldset className="export-formats">
        <legend className="sr-only">Format</legend>
        {EXPORT_FORMATS.map((f) => (
          <label key={f.format} className="export-format">
            <input
              type="radio"
              name={`${id}-format`}
              value={f.format}
              checked={format === f.format}
              onChange={() => setFormat(f.format)}
              aria-label={`${f.label} (${f.kind.extension})`}
              aria-describedby={`${id}-${f.format}`}
            />
            <span className="export-format-name">
              {f.label} <span className="export-format-extension mono">{f.kind.extension}</span>
            </span>
            <span id={`${id}-${f.format}`} className="export-format-note">
              {f.note}
            </span>
          </label>
        ))}
      </fieldset>
      {log.reassembledFrames > 0 && (
        <p className="export-note">
          The {formatCount(log.reassembledFrames)} J1939 {log.reassembledFrames === 1 ? 'transfer' : 'transfers'} reassembled from packets{' '}
          {log.reassembledFrames === 1 ? 'is' : 'are'} left out. The packets are kept, so opening the file reassembles them again.
        </p>
      )}
    </Sheet>
  );
}
