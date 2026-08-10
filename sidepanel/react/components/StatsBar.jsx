// StatsBar.jsx — the session-stats HUD that sits under the composer.
//
// Port of panel.js renderStats (1465) + wireStats (1528), and the <div id="stats-bar">
// block of panel.html.orig (~103). Same markup, same class names, same numbers, same
// honesty rules: every figure that had to be substituted or estimated is still marked
// with a "~", and the note paragraph still spells out in prose which of the four things
// went wrong. A guessed number presented as a measurement is the failure mode stats.js
// was written against, and it stays that way here.
//
// ---------------------------------------------------------------------------------
// WHY THIS COMPONENT POLLS
// ---------------------------------------------------------------------------------
// SessionStats is a MUTABLE class instance that lives in ChatView and is mutated in
// place by the agent's stream callbacks (beginStream / onDelta / abandonStream /
// endStream). React cannot see a field change inside an object it already holds, and
// stats.js is off-limits — test/panel-harness.mjs and agent.js both depend on its shape,
// so it does not become immutable state.
//
// The vanilla panel solved this by calling renderStats() by hand after every mutation.
// The React equivalent is to re-read the instance on an explicit signal:
//
//   * Every render re-reads the instance from scratch. So any parent re-render — and
//     ChatView re-renders on essentially every transcript change, including the ones
//     that bracket a stream — already refreshes the HUD for free. If the integration
//     agent later wants something tighter it can pass a `version` prop that ChatView
//     bumps; a changed prop re-renders this component and needs NO change in here.
//   * While `stats.streaming` is true the tokens/sec figure moves faster than the
//     transcript does (onDelta fires per streamed token, and re-rendering ChatView per
//     token is exactly what the store contract forbids). So for the duration of a stream
//     ONLY, a 250ms interval bumps a local tick. 250ms is slow enough to be free and
//     fast enough that the live rate reads as live.
//   * The interval is self-cancelling: when the stream ends, the next tick re-renders,
//     `streaming` reads false, and the effect's cleanup clears it. So a missed re-render
//     around endStream cannot leave a timer running.
//
// Deliberately NOT ticking: the "Session" elapsed clock in the detail panel. panel.js
// only recomputed it inside renderStats, so it advanced when something happened and sat
// still otherwise (opening the detail is one of those somethings — wireStats:1536 called
// renderStats on expand for exactly that reason). Adding a heartbeat here would be a
// behaviour change, not a port.

import { useEffect, useReducer, useState } from 'react';
import {
  modelInfo,
  formatTokens,
  formatCost,
  formatRate,
  formatDuration,
} from '../../js/stats.js';
import { useSettings } from '../state/store.jsx';
import { showToast } from './Toast.jsx';

// Fast enough to read as live, slow enough to cost nothing. Only runs mid-stream.
const STREAM_POLL_MS = 250;

/**
 * @param {SessionStats} props.stats  the live, mutable instance ChatView owns
 * @param {number} [props.rev]        the "version prop" this file's header invites, and
 *   which StatsSlot passes. It is deliberately never read: its only job is to be a prop
 *   that CHANGED, so that a stats mutation React cannot see (the instance identity never
 *   changes) still forces a re-render, and so this component stays correct if it is ever
 *   wrapped in React.memo. Reading it would imply the value means something; it does not.
 */
// eslint-disable-next-line no-unused-vars -- see `rev` above; there is no eslint in this
// repo (npm run check is `node --check`), so this is documentation, not suppression.
export default function StatsBar({ stats, rev }) {
  const { settings } = useSettings();

  // wireStats (1528): the summary button is a disclosure for the detail grid.
  const [open, setOpen] = useState(false);

  // The "re-read the mutable instance" signal. useReducer's dispatch has a stable
  // identity, so it is safe as an interval callback and in an effect dep array.
  const [, bump] = useReducer((n) => n + 1, 0);

  const streaming = Boolean(stats && stats.streaming);

  useEffect(() => {
    if (!streaming) return undefined;
    const id = setInterval(bump, STREAM_POLL_MS);
    // StrictMode mounts effects twice in a dev build; without this cleanup the second
    // mount would leave an orphan interval bumping a dead component.
    return () => clearInterval(id);
  }, [streaming, stats]);

  // ChatView owns the instance and may render before it exists.
  if (!stats) return null;

  // Nothing measured yet — an empty stats bar is just noise.
  const visible = !(stats.requests === 0 && !stats.streaming);

  const info = modelInfo(settings && settings.model, settings || {});
  const frac = stats.contextFraction(info);

  // The context gauge fills toward amber, then red — a window about to overflow is the
  // one thing here the user must notice without reading a number. The 2% floor keeps a
  // just-started session from rendering an invisible sliver.
  const fillWidth = frac == null ? '0%' : `${Math.max(2, Math.round(frac * 100))}%`;
  const fillClass = frac == null
    ? 'ctx-fill'
    : `ctx-fill${frac >= 0.9 ? ' danger' : frac >= 0.7 ? ' warn' : ''}`;
  const ctxText = frac == null
    ? (stats.contextTokens ? formatTokens(stats.contextTokens) : '—')
    : `${formatTokens(stats.contextTokens)}/${formatTokens(info.context)}`;

  // A rate needs a sampling window, so liveTokensPerSec is 0 for the first moments of every
  // stream — and rendering that as "—" made the collapsed bar blank its rate each time a
  // request started, which reads as "no data" while a perfectly good session average sits
  // one click away in the detail grid. Fall back to the average instead of blanking.
  const rateText = formatRate(
    stats.streaming && stats.liveTokensPerSec > 0 ? stats.liveTokensPerSec : stats.avgTokensPerSec,
  );

  // "~" whenever a rate had to be substituted or a count was estimated. A number the user
  // reads as exact, when it isn't, is the failure mode this whole module is built against.
  const costPrefix = (stats.costApprox || stats.estimated) ? '~' : '';
  const costText = stats.costKnown ? costPrefix + formatCost(stats.cost) : '—';

  // detail
  const detailContext = frac == null
    ? formatTokens(stats.contextTokens)
    : `${formatTokens(stats.contextTokens)} / ${formatTokens(info.context)} (${Math.round(frac * 100)}%)`;

  // Say plainly when a number is a guess rather than a measurement.
  const notes = [];
  if (!stats.costKnown) {
    notes.push(`No price known for "${(settings && settings.model) || 'this model'}". Set Input/Output $/1M in Settings to see cost.`);
  }
  if (info.context == null) {
    notes.push('Context window unknown for this model — set it in Settings to see how full it is.');
  }
  if (stats.estimated) {
    notes.push('Your endpoint did not report token usage, so some counts are estimated from text length (~4 chars/token).');
  }
  if (stats.costApprox) {
    notes.push('This model returned cached tokens but has no known cache price, so they are billed here at the full input rate — the real cost is likely lower.');
  }

  function handleReset() {
    stats.reset();
    bump(); // the renderStats() that followed stats.reset() in wireStats (1542)
    showToast('Session stats reset', 'success');
  }

  return (
    <div id="stats-bar" className="stats-bar" hidden={!visible}>
      <button
        id="stats-summary"
        type="button"
        className="stats-summary"
        aria-expanded={String(open)}
        title="Session stats — click for detail"
        // wireStats:1536 re-rendered on expand so a detail panel that had been closed
        // through a whole run did not open showing stale numbers. Toggling state here
        // re-renders, which re-reads the instance — same guarantee, no manual call.
        onClick={() => setOpen((v) => !v)}
      >
        <span className="stats-item">
          <span id="stats-ctx-gauge" className="ctx-gauge">
            <span id="stats-ctx-fill" className={fillClass} style={{ width: fillWidth }} />
          </span>
          <span id="stats-ctx" className="stats-val">{ctxText}</span>
        </span>
        <span className="stats-sep" />
        <span className="stats-item"><span id="stats-rate" className="stats-val">{rateText}</span></span>
        <span className="stats-sep" />
        <span className="stats-item"><span id="stats-cost" className="stats-val">{costText}</span></span>
        <svg className="stats-caret" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
          <path d="M3 4.5 6 7.5 9 4.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div id="stats-detail" className="stats-detail" hidden={!open}>
        <div className="stats-grid">
          <div className="stats-cell">
            <span className="stats-label">Context</span>
            <span id="sd-context" className="stats-num">{detailContext}</span>
          </div>
          <div className="stats-cell">
            <span className="stats-label">Model</span>
            <span id="sd-model" className="stats-num">{(settings && settings.model) || '—'}</span>
          </div>
          <div className="stats-cell">
            <span className="stats-label">Input</span>
            <span id="sd-input" className="stats-num">{formatTokens(stats.inputTokens)}</span>
          </div>
          <div className="stats-cell">
            <span className="stats-label">Output</span>
            <span id="sd-output" className="stats-num">{formatTokens(stats.outputTokens)}</span>
          </div>
          <div className="stats-cell">
            <span className="stats-label">Requests</span>
            <span id="sd-requests" className="stats-num">{String(stats.requests)}</span>
          </div>
          <div className="stats-cell">
            <span className="stats-label">Avg speed</span>
            <span id="sd-avg" className="stats-num">{formatRate(stats.avgTokensPerSec)}</span>
          </div>
          <div className="stats-cell">
            <span className="stats-label">Session</span>
            <span id="sd-elapsed" className="stats-num">{formatDuration(Date.now() - stats.startedAt)}</span>
          </div>
          <div className="stats-cell">
            <span className="stats-label">Cost</span>
            <span id="sd-cost" className="stats-num">
              {stats.costKnown ? costPrefix + formatCost(stats.cost) : 'unknown'}
            </span>
          </div>
        </div>
        <p id="sd-note" className="stats-note" hidden={notes.length === 0}>{notes.join(' ')}</p>
        <button id="stats-reset" type="button" className="btn-link" onClick={handleReset}>
          Reset session stats
        </button>
      </div>
    </div>
  );
}
