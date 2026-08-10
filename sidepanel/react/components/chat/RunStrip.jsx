// RunStrip.jsx — panel.html.orig lines 85-92. Shown for exactly as long as a run is in
// flight; setRunning (panel.js:1928) is what toggles it, and onStatus (1979) writes its
// label. Rendered conditionally rather than with the `hidden` attribute the original used —
// panel.css:545 has an explicit `.run-strip[hidden] { display: none }` to defeat its own
// display:flex, and not rendering is the same thing without relying on that rule.

import { memo } from 'react';

/**
 * @param {string}   props.status  'Working…' by default; onStatus, onRequestDemo and
 *                                 handleStop all write their own text here.
 * @param {Function} props.onStop
 */
function RunStrip({ status, onStop }) {
  return (
    <div id="run-strip" className="run-strip">
      <span className="spinner" aria-hidden="true" />
      <span id="run-status" className="run-status">{status}</span>
      <button id="btn-stop" className="btn-stop" title="Stop the agent" onClick={onStop}>
        <svg viewBox="0 0 14 14" width="11" height="11" aria-hidden="true">
          <rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor" />
        </svg>
        {' '}Stop
      </button>
    </div>
  );
}

export default memo(RunStrip);
