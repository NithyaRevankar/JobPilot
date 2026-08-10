// StatsSlot.jsx — the isolation layer around the session stats HUD.
//
// panel.js called renderStats() from onText, i.e. once per streamed token (panel.js:1950),
// and got away with it because renderStats wrote directly into eight text nodes. The React
// equivalent of that call is a state update, and a state update in ChatView would re-render
// the transcript for every character the model emits — the exact stutter this screen was
// decomposed to avoid.
//
// So the tick does not live in ChatView. ChatView owns the SessionStats instance and a set
// of listeners; this leaf subscribes, and a tick re-renders THIS component and nothing
// above it. <StatsBar> is another agent's component (sidepanel/react/components/StatsBar.jsx);
// it is handed the live instance plus a changing `rev`, so it repaints whether or not it
// memoizes on the instance identity — which never changes. That is the "version prop" its
// own header invites: StatsBar re-reads the mutable instance from scratch on every render,
// so a changed prop is all it needs.
//
// StatsBar additionally self-polls at 250ms while `stats.streaming` is true, so the two
// mechanisms overlap during a stream and neither is redundant: the tick is what makes
// beginStream / abandonStream / onUsage land immediately, including the ones that arrive
// while nothing is streaming.

import { memo, useEffect, useReducer } from 'react';

import StatsBar from '../StatsBar.jsx';

/**
 * @param {SessionStats} props.stats      the instance ChatView owns for the session
 * @param {Function}     props.subscribe  subscribe(cb) -> unsubscribe
 */
function StatsSlot({ stats, subscribe }) {
  const [rev, tick] = useReducer((n) => n + 1, 0);
  useEffect(() => subscribe(tick), [subscribe]);
  return <StatsBar stats={stats} rev={rev} />;
}

export default memo(StatsSlot);
