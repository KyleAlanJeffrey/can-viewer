import { Fragment } from 'react';
import { FLAG_FD, type LogInfo } from '../../core/api';
import { formatCount } from '../../format';
import { IdListSidebar } from '../shared/IdListSidebar';
import type { ViewContext, ViewProps } from '../types';
import { BusLoadCard } from './BusLoadCard';
import { IdTable } from './IdTable';
import './overview.css';

/** The log at a glance: a few facts, DBC coverage, bus load and every ID with its timing. */
export function OverviewView({ ctx }: ViewProps) {
  const { log } = ctx;
  if (!log) return null;
  return (
    <>
      <IdListSidebar ctx={ctx} />
      <div className="ov">
        <div className="ov-top">
          <Facts ctx={ctx} log={log} />
          <DbcCoverage ctx={ctx} />
        </div>
        <BusLoadCard core={ctx.core} log={log} logVersion={ctx.logVersion} />
        <IdTable ctx={ctx} />
      </div>
    </>
  );
}

function Facts({ ctx, log }: { ctx: ViewContext; log: LogInfo }) {
  const { ids } = ctx;
  const buses = log.channels.map((name, channel) => {
    const onBus = ids.filter((s) => s.channel === channel);
    return { name, ids: onBus.length, fd: onBus.some((s) => s.flags & FLAG_FD) };
  });
  // Null until the core reports error frames.
  const errors = typeof log.errorFrames === 'number' ? log.errorFrames : null;

  return (
    <dl className="ov-facts">
      <div className="ov-fact card">
        <dt>Unique IDs</dt>
        <dd className="ov-value">{formatCount(ids.length)}</dd>
        <dd className="ov-detail">{buses.map((b) => `${formatCount(b.ids)} on ${b.name}`).join(' \u00b7 ')}</dd>
      </div>
      <div className="ov-fact card">
        <dt>Buses</dt>
        <dd className="ov-value">{formatCount(buses.length)}</dd>
        <dd className="ov-detail">
          {buses.map((b, i) => (
            <Fragment key={i}>
              {i > 0 && ' \u00b7 '}
              <span className="mono">{b.name}</span>
              {b.fd && (
                <span className="tag" title="Carries CAN FD frames">
                  FD
                </span>
              )}
            </Fragment>
          ))}
        </dd>
      </div>
      <div className="ov-fact card">
        <dt>Error frames</dt>
        <dd className="ov-value">{errors === null ? '\u2014' : formatCount(errors)}</dd>
        <dd className="ov-detail">
          {errors === null ? 'Not reported for this log' : errors === 0 ? 'None in this log' : `${formatShare(errors / log.frames)} of frames`}
        </dd>
      </div>
    </dl>
  );
}

function DbcCoverage({ ctx }: { ctx: ViewContext }) {
  const { dbcs, ids, messageOf } = ctx;
  const unknown = ids
    .filter((s) => !messageOf(s.key))
    .sort((a, b) => a.channel - b.channel || a.id - b.id);
  const matched = ids.length - unknown.length;
  const loaded = dbcs.length > 0;
  const names = dbcs.map((d) => d.db.name);

  const reverseEngineer = () => {
    ctx.select(unknown[0].key);
    ctx.setView('reverse');
  };

  return (
    <section className="ov-dbc card" aria-labelledby="ov-dbc-title">
      <div className="ov-dbc-text">
        <div className="ov-dbc-head">
          <h2 id="ov-dbc-title" className="ov-label">
            DBC coverage
          </h2>
          {loaded && (
            <span className="ov-dbc-name" title={names.join(', ')}>
              <span className="ov-dbc-file">{names[0]}</span>
              {names.length > 1 && <span className="ov-dbc-more">+ {names.length - 1} more</span>}
            </span>
          )}
        </div>
        {loaded ? (
          <p className="ov-dbc-line">
            <span className="ov-value">
              {formatCount(matched)} of {formatCount(ids.length)}
            </span>{' '}
            IDs match your {dbcs.length === 1 ? 'DBC' : 'DBCs'}
          </p>
        ) : (
          <>
            <p className="ov-dbc-line">
              <span className="ov-value">No DBC</span>
            </p>
            <p className="ov-detail">Open one to name and decode these IDs.</p>
          </>
        )}
      </div>
      {loaded ? (
        unknown.length > 0 && (
          <button type="button" className="button" onClick={reverseEngineer}>
            Reverse Engineer {formatCount(unknown.length)} Unknown {unknown.length === 1 ? 'ID' : 'IDs'}
          </button>
        )
      ) : (
        <button type="button" className="button" onClick={ctx.openDbcPicker}>
          Open DBC&hellip;
        </button>
      )}
    </section>
  );
}

function formatShare(fraction: number): string {
  const percent = fraction * 100;
  if (percent < 0.01) return 'Under 0.01%';
  return `${percent < 1 ? percent.toFixed(2) : percent.toFixed(1)}%`;
}
