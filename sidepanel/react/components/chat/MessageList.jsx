// MessageList.jsx — #message-list. Port of appendToList (panel.js:266) and restoreChat's
// render loop (2085), with the scroll rules from isNearBottom (261) / scrollIfSticky (273).
//
// The whole component is memoized. That is the answer to the one hard performance problem
// in this screen: `rows` only changes when a message is APPENDED or a record is settled —
// a handful of times per run — so while the model streams, this component and every
// MessageItem under it render exactly zero times. The growing text lives in
// <StreamingBubble>, which is a leaf with its own state.
//
// The scroll ref and the scroll handler belong to ChatView, not here: scrollIfSticky is
// called from the streaming leaf and from ChatView's layout effect, both of which sit
// outside this component.

import { memo } from 'react';

import EmptyState from './EmptyState.jsx';
import MessageItem from './MessageItem.jsx';
import StreamingBubble from './StreamingBubble.jsx';

/**
 * @param {Array}    props.rows         [{id, rev, record, live}] in transcript order
 * @param {object}   props.runningStep  {rowId, index} — the step showing a spinner, or null
 * @param {object}   props.streamRef    ref handed to the live bubble so ChatView can sync it
 * @param {Function} props.onPaint      scrollIfSticky, called after every streamed paint
 * @param {object}   props.listRef      ref for the scrolling element itself
 * @param {Function} props.onScroll     records "is the user near the bottom" as they scroll
 */
function MessageList({
  rows, runningStep, streamRef, onPaint, listRef, onScroll,
  configured, onOpenSettings, onOpenProfile,
}) {
  return (
    <div id="message-list" className="message-list" ref={listRef} onScroll={onScroll}>
      {rows.length === 0 ? (
        <EmptyState configured={configured} onOpenSettings={onOpenSettings} onOpenProfile={onOpenProfile} />
      ) : null}
      {rows.map((row) =>
        row.live && row.record.type === 'assistant' ? (
          <StreamingBubble key={row.id} ref={streamRef} record={row.record} onPaint={onPaint} />
        ) : (
          <MessageItem
            key={row.id}
            row={row}
            runningIndex={runningStep && runningStep.rowId === row.id ? runningStep.index : -1}
          />
        ),
      )}
    </div>
  );
}

export default memo(MessageList);
