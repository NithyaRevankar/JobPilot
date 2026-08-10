// StreamingBubble.jsx — the in-flight assistant message. Port of
// renderAssistantBubble(panel.js:299) in its `streaming` form plus appendAssistantText
// (panel.js:318).
//
// THIS COMPONENT EXISTS FOR ONE REASON: onText fires once per streamed token. panel.js
// could get away with `cur.el.textContent = cur.record.text` because that touches one text
// node; in React the equivalent naive move — putting the growing string in state that the
// message list also reads — re-renders the ENTIRE conversation on every character. So the
// live text lives here, in a leaf that owns it, and nothing above this component knows the
// text changed. The settled list is memoized and never re-renders while this is streaming.
//
// It renders PLAIN TEXT, not markdown. That is the original's fast path (panel.js:321) and
// it is also the honest one: half a fenced code block is not markdown yet. The finished
// message is re-rendered through <Markdown> once finalizeAssistantBubble settles it — see
// AssistantMessage.jsx for the second stage.

import { memo, useImperativeHandle, useLayoutEffect, useState } from 'react';

/**
 * @param {object}   props.record   the SAME mutable record ChatView keeps in its rows array
 *                                  and persists; `record.text` is the authority, this
 *                                  component only mirrors it into state so React paints.
 * @param {Function} props.onPaint  scrollIfSticky — called after every paint, which is what
 *                                  panel.js:322 did on every delta.
 * @param {object}   props.ref      React 19 passes ref as an ordinary prop. ChatView calls
 *                                  `ref.current.sync()` after mutating record.text.
 */
function StreamingBubble({ record, onPaint, ref }) {
  // Initialised FROM the record rather than from '' — the first delta can land before this
  // component has mounted (setRows is async, panel.js's appendChild was not), and starting
  // empty would drop those characters until the next one arrived.
  const [text, setText] = useState(() => record.text);

  useImperativeHandle(ref, () => ({ sync: () => setText(record.text) }), [record]);

  // No dependency array on purpose: every paint of a growing bubble is a chance to have
  // scrolled past the bottom, and scrollIfSticky is the thing that decides whether to move.
  useLayoutEffect(() => {
    onPaint();
  });

  return <div className="msg msg-assistant streaming">{text}</div>;
}

// Memoized so a re-render of the list around it (a notice arriving, the run strip changing
// its label) cannot reset this leaf. Its props are all stable for the life of one stream.
export default memo(StreamingBubble);
