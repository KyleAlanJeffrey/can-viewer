import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleCheck } from 'lucide-react';
import type { CompareOptions, IdComparison, LogInfo } from '../../core/api';
import { formatCount, formatDuration, noFramesMessage } from '../../format';
import { forget, loadSaved, save } from '../../session';
import type { SelectedByte } from '../reverse/ByteMatrix';
import { errorText } from '../reverse/bits';
import { startTextSave } from '../shared/saveFile';
import { useViewState } from '../shared/viewState';
import { SidebarSlot } from '../slots';
import type { ViewContext, ViewProps } from '../types';
import { ByteCompare } from './ByteCompare';
import { CompareTable } from './CompareTable';
import { IgnoreRulesSheet } from './IgnoreRules';
import { LogCards, type Reading } from './LogCards';
import { DEFAULT_OPTIONS, GROUPS, SHOW_OPTIONS, busesMatchedByOrder, findingsCsv, groupOf, looksTheSame, matchesQuery, rowKey, stem, type Show } from './findings';
import './compare.css';

/** A log file as the session store keeps it. */
interface SavedLog {
  name: string;
  blob: Blob;
}

/**
 * Log B's file, held so Replace... on log A can read log B again after the new log A replaces
 * the session. Only valid while it names the log B the core holds.
 */
let heldB: SavedLog | null = null;

const ONLY_IN_B = 'Only in log B: swap the logs to open it in Reverse Engineer.';

/** Compares the open log (A) with a second log (B): which IDs and bytes behave differently. */
export function CompareView({ ctx }: ViewProps) {
  if (ctx.capturing) {
    return (
      <div className="cmp">
        <div className="cmp-intro">
          <p className="lede">A capture can be compared once it stops. Stop it, then open a second log here to compare it with.</p>
        </div>
      </div>
    );
  }
  return <CompareLogs ctx={ctx} />;
}

function CompareLogs({ ctx }: ViewProps) {
  const { core, log, logVersion, query, dbcs } = ctx;
  const [logB, setLogB] = useState<LogInfo | null | undefined>(undefined);
  const [reading, setReading] = useState<Reading | null>(null);
  const [notKept, setNotKept] = useState(false);
  const [results, setResults] = useState<IdComparison[] | null>(null);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [notice, setNotice] = useState('');
  const [options, setOptions] = useViewState<CompareOptions>('cmp.options', DEFAULT_OPTIONS);
  const [show, setShow] = useViewState<Show>('cmp.show', 'all');
  const [picked, setPicked] = useViewState<string | null>('cmp.selected', null);
  const [, setReverseMode] = useViewState<string>('re.mode', 'bytes');
  const [, setReverseByte] = useViewState<SelectedByte | null>('re.byte', null, 'log');
  const pickB = useRef<HTMLInputElement>(null);
  const pickA = useRef<HTMLInputElement>(null);
  const restoredFor = useRef<number | null>(null);
  /** Bumped by every read of log B, so an older check of the core can't overwrite a newer read. */
  const readsOfB = useRef(0);

  /** Reads `file` as log B. `persist` keeps a copy so a reload reopens it. */
  const readB = async (file: Blob, name: string, persist: boolean): Promise<LogInfo | null> => {
    let info: LogInfo | null = null;
    const thisRead = ++readsOfB.current;
    setReading({ name, fraction: 0 });
    await ctx.run(`Reading ${name}\u2026`, async () => {
      try {
        const read = await core.openCompareLog(file, name, (p) => setReading({ name, fraction: p.total > 0 ? p.bytes / p.total : 1 }));
        const empty = read.frames === 0 ? (noFramesMessage(read) ?? `No CAN frames in ${name}.`) : null;
        if (empty) {
          await core.closeCompareLog();
          throw new Error(empty);
        }
        info = read;
      } finally {
        setReading(null);
      }
    });
    if (info) {
      heldB = { name, blob: file };
      setLogB(info);
      if (persist) {
        void save('compare', { name, blob: file } satisfies SavedLog).then((kept) => {
          setNotKept(!kept);
          if (!kept) void forget('compare');
        });
      }
      return info;
    }
    // A failed read leaves the core without the earlier log B too.
    heldB = null;
    const left = await core.compareLogInfo().catch(() => null);
    if (readsOfB.current === thisRead) setLogB(left);
    if (!left) await forget('compare');
    return null;
  };

  // The core holds log B across view switches; after a reload it is read again from the saved copy.
  useEffect(() => {
    let live = true;
    setLogB(undefined);
    const reads = readsOfB.current;
    const current = () => live && readsOfB.current === reads;
    void (async () => {
      const info = await core.compareLogInfo().catch(() => null);
      if (!current()) return;
      if (info || restoredFor.current === logVersion) {
        setLogB(info);
        return;
      }
      restoredFor.current = logVersion;
      const saved = await loadSaved<SavedLog>('compare');
      if (!current()) return;
      if (!saved || !(await readB(saved.blob, saved.name, false))) {
        if (live && readsOfB.current <= reads + 1) setLogB(null);
      }
    })();
    return () => {
      live = false;
    };
    // readB only reads props through ctx; it must not rerun this.
  }, [core, logVersion]);

  useEffect(() => {
    if (!logB) {
      setResults(null);
      return;
    }
    let live = true;
    setResults(null);
    core.compareLogs(options).then(
      (found) => live && setResults(found),
      (e) => live && ctx.setError(errorText(e)),
    );
    return () => {
      live = false;
    };
    // dbcs: names come from the loaded databases.
  }, [core, logB, options, dbcs]);

  // In the table's order, so the first row is selected when none is picked.
  const visible = useMemo(() => {
    const groups = SHOW_OPTIONS.find((o) => o.id === show)?.groups ?? [];
    return GROUPS.flatMap((g) => (groups.includes(g.id) ? (results ?? []).filter((c) => groupOf(c) === g.id && matchesQuery(c, query)) : []));
  }, [results, show, query]);
  const selected = visible.find((c) => rowKey(c) === picked) ?? visible[0] ?? null;

  if (!log) return null;

  const openB = (file: File) => void readB(file, file.name, true);

  const replaceA = async (file: File) => {
    const keep = heldB && heldB.name === logB?.name ? heldB : await loadSaved<SavedLog>('compare');
    if (!(await ctx.openLog(file, file.name))) return;
    if (keep) await readB(keep.blob, keep.name, true);
  };

  const swap = async () => {
    heldB = null;
    setNotKept(false);
    await ctx.swapCompareLog();
  };

  const openInReverse = (c: IdComparison, byte: number) => {
    if (c.keyA === null) {
      setPicked(rowKey(c));
      setNotice(ONLY_IN_B);
      return;
    }
    ctx.select(c.keyA);
    setReverseByte({ key: c.keyA, byte });
    setReverseMode('advanced');
    ctx.setView('reverse');
  };

  const exportFindings = () => {
    if (!results || !logB) return;
    const write = startTextSave(`${stem(log.name)}-vs-${stem(logB.name)}.csv`, { description: 'CSV file', mime: 'text/csv', extension: '.csv' });
    write(findingsCsv(results, log, logB, options)).catch((e) => ctx.setError(errorText(e)));
  };

  const same = !!logB && results !== null && looksTheSame(results);
  const matchedBuses = results ? busesMatchedByOrder(results) : null;

  return (
    <>
      <CompareSidebar ctx={ctx} logB={logB ?? null} results={results} show={show} onShow={setShow} />
      <div className="cmp">
        <LogCards
          logA={log}
          logB={logB}
          reading={reading}
          notKept={notKept}
          onReplaceA={() => pickA.current?.click()}
          onPickB={() => pickB.current?.click()}
          onDropB={openB}
          onSwap={() => void swap()}
        />
        {logB === null && !reading ? (
          <div className="cmp-intro">
            <p className="lede">
              Compare two recordings of the same car to find what one action changes on the bus: record it idle as log A, then doing one thing, such as
              locking the doors, as log B. Messages and bytes are ranked by how differently they behave, with rates per second so the logs needn&rsquo;t be
              the same length.
            </p>
          </div>
        ) : same ? (
          <section className="cmp-same card" aria-labelledby="cmp-same-title">
            <CircleCheck className="cmp-same-icon" size={40} strokeWidth={1.25} aria-hidden="true" />
            <div className="cmp-same-text">
              <h2 id="cmp-same-title" className="section-title">
                These logs look the same
              </h2>
              <p className="hint">No differences found with the current ignore rules.</p>
              {matchedBuses && <p className="hint">Buses matched by order: {matchedBuses}</p>}
              <p className="cmp-same-count">
                0 changed IDs &middot; {formatCount(results.length)} compared
              </p>
            </div>
            <div className="cmp-same-actions">
              <button type="button" className="button" onClick={() => setRulesOpen(true)}>
                Review ignore rules&hellip;
              </button>
              <button type="button" className="primary" onClick={() => pickB.current?.click()} disabled={!!reading}>
                Replace log B&hellip;
              </button>
            </div>
          </section>
        ) : logB ? (
          <div className="cmp-body">
            <CompareTable
              results={results}
              show={show}
              query={query}
              selected={selected ? rowKey(selected) : null}
              onSelect={(c) => {
                setPicked(rowKey(c));
                setNotice('');
              }}
              onOpen={(c) => openInReverse(c, c.bytes[0] ?? 0)}
              busNote={matchedBuses && `Buses matched by order: ${matchedBuses}`}
              hasDbc={dbcs.length > 0}
              options={options}
              onOptions={setOptions}
            />
            {selected ? (
              <ByteCompare
                key={`${rowKey(selected)}:${logVersion}`}
                ctx={ctx}
                comparison={selected}
                logA={log}
                logB={logB}
                options={options}
                onOpenInReverse={(byte) => openInReverse(selected, byte)}
                onExport={exportFindings}
              />
            ) : (
              <section className="cmp-detail card cmp-detail-empty">
                <p className="hint">{results === null ? 'Comparing the logs\u2026' : 'Select a message to compare its bytes.'}</p>
              </section>
            )}
          </div>
        ) : null}
      </div>
      <p className="sr-only" role="status">
        {notice}
      </p>
      <IgnoreRulesSheet open={rulesOpen} onClose={() => setRulesOpen(false)} options={options} onChange={setOptions} />
      <input
        ref={pickB}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) openB(file);
        }}
      />
      <input
        ref={pickA}
        type="file"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void replaceA(file);
        }}
      />
    </>
  );
}

interface SidebarProps {
  ctx: ViewContext;
  logB: LogInfo | null;
  results: IdComparison[] | null;
  show: Show;
  onShow: (show: Show) => void;
}

function CompareSidebar({ ctx, logB, results, show, onShow }: SidebarProps) {
  const { log } = ctx;
  if (!log) return null;
  const count = (id: Show) => {
    const groups = SHOW_OPTIONS.find((o) => o.id === id)?.groups ?? [];
    return (results ?? []).filter((c) => groups.includes(groupOf(c))).length;
  };
  return (
    <SidebarSlot>
      <div className="cmp-side">
        <h2 className="cmp-side-head">Comparison</h2>
        <dl className="cmp-side-logs">
          <div>
            <dt>A</dt>
            <dd className="cmp-side-name" title={log.name}>
              {log.name}
            </dd>
            <dd className="cmp-side-dur">{formatDuration(log.durationS)}</dd>
          </div>
          <div>
            <dt>B</dt>
            <dd className="cmp-side-name" title={logB?.name}>
              {logB?.name ?? 'None yet'}
            </dd>
            <dd className="cmp-side-dur">{logB ? formatDuration(logB.durationS) : ''}</dd>
          </div>
        </dl>
        <fieldset className="cmp-show" disabled={!logB}>
          <legend className="cmp-side-head">Show</legend>
          {SHOW_OPTIONS.map((o) => (
            <label key={o.id} className="cmp-show-option">
              <input type="radio" name="cmp-show" value={o.id} checked={show === o.id} onChange={() => onShow(o.id)} />
              <span>{o.label}</span>
              {results && <span className="cmp-count">{formatCount(count(o.id))}</span>}
            </label>
          ))}
        </fieldset>
      </div>
    </SidebarSlot>
  );
}
