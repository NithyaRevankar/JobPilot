// ChatToolbar.jsx — the target-tab chip and New chat. panel.html.orig lines 51-60, driven
// by refreshTargetTab (panel.js:1896).

import { memo, useEffect, useState } from 'react';

/**
 * @param {string}   props.title       already formatted — "Acting on: …" or "No target tab"
 * @param {string}   props.favIconUrl  '' when the tab has none, or it is not http(s)
 * @param {Function} props.onNewChat
 * @param {Function} props.onNewRun    start a SECOND application, alongside this one
 * @param {boolean}  props.canOpenRun  false at the concurrency cap
 * @param {string}   props.newRunHint  why, when it is false
 */
function ChatToolbar({ title, favIconUrl, onNewChat, onNewRun, canOpenRun, newRunHint }) {
  // panel.js:2638 wired an `error` handler on the <img> that hid it, because a favicon URL
  // the browser has cached for the tab can still 404 for us, and a broken-image glyph next
  // to the page title looks like the extension is broken. Reset it whenever the URL
  // changes so a new tab gets its own chance to load.
  const [favBroken, setFavBroken] = useState(false);
  useEffect(() => setFavBroken(false), [favIconUrl]);

  return (
    <div className="chat-toolbar">
      <div id="target-tab" className="target-tab" title="The tab the agent will act on">
        {favIconUrl && !favBroken ? (
          <img
            id="target-favicon"
            className="target-favicon"
            alt=""
            src={favIconUrl}
            onError={() => setFavBroken(true)}
          />
        ) : null}
        <span id="target-title" className="target-title">{title}</span>
      </div>
      <div className="chat-toolbar-actions">
        <button
          id="btn-new-chat"
          className="btn-ghost btn-small"
          title="Start a new conversation"
          onClick={onNewChat}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          {' '}New chat
        </button>
        {/* The entry point to running several applications at once. It lives here rather
            than in the run strip because the strip only appears once there IS more than
            one run — with it there, a single-run panel would have no way to get a second. */}
        <button
          id="btn-new-run"
          className="btn-ghost btn-small"
          title={newRunHint}
          disabled={!canOpenRun}
          onClick={onNewRun}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <rect x="2" y="3" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M6 13h7a1 1 0 0 0 1-1V6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          {' '}New job
        </button>
      </div>
    </div>
  );
}

export default memo(ChatToolbar);
