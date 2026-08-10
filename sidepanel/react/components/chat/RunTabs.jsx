/**
 * RunTabs — the strip that says how many applications are in flight and lets you switch.
 *
 * Only rendered when there is more than one run, so someone applying to one job at a time
 * sees exactly the panel they saw before.
 */

import { memo } from 'react';

import { RUN_STATUS } from '../../state/runs-context.jsx';

/** A dot rather than a word: the strip is ~40px tall and holds up to five of these. */
const DOT = {
  [RUN_STATUS.RUNNING]: { cls: 'run-dot-working', title: 'Working' },
  [RUN_STATUS.BLOCKED]: { cls: 'run-dot-blocked', title: 'Waiting for you' },
  [RUN_STATUS.ERROR]: { cls: 'run-dot-error', title: 'Stopped on an error' },
  [RUN_STATUS.DONE]: { cls: 'run-dot-done', title: 'Finished' },
  [RUN_STATUS.IDLE]: { cls: 'run-dot-idle', title: 'Not started' },
};

function label(run, index) {
  if (run.host) return run.host.replace(/^www\./i, '');
  if (run.title) return run.title.replace(/^Acting on:\s*/, '').slice(0, 24);
  return `Application ${index + 1}`;
}

function RunTabs({ runs, selectedId, onSelect, onClose, onOpen, canOpen, openHint }) {
  if (runs.length < 2) return null;
  return (
    <div className="run-tabs" role="tablist" aria-label="Applications in progress">
      {runs.map((run, i) => {
        const dot = DOT[run.status] || DOT[RUN_STATUS.IDLE];
        const selected = run.id === selectedId;
        return (
          <div
            key={run.id}
            className={`run-tab${selected ? ' active' : ''}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={selected}
              className="run-tab-main"
              onClick={() => onSelect(run.id)}
              title={label(run, i)}
            >
              <span className={`run-dot ${dot.cls}`} title={dot.title} aria-label={dot.title} />
              <span className="run-tab-label">{label(run, i)}</span>
            </button>
            <button
              type="button"
              className="run-tab-close"
              // Closing a running application would abandon a half-filled form with no
              // warning, so it is simply not offered while it is working.
              disabled={run.running}
              title={run.running ? 'Stop it first' : 'Close this application'}
              aria-label={`Close ${label(run, i)}`}
              onClick={() => onClose(run.id)}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="run-tab-add"
        onClick={onOpen}
        disabled={!canOpen}
        title={openHint}
        aria-label="Start another application"
      >
        +
      </button>
    </div>
  );
}

export default memo(RunTabs);
