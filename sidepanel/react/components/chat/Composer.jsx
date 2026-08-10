// Composer.jsx — panel.html.orig lines 94-100, plus autoGrow (panel.js:2102) and
// wireComposer's key handling (2107).
//
// The draft lives HERE rather than in ChatView, and that is deliberate: a keystroke must
// not re-render the transcript, the run strip or the stats bar. ChatView never needs the
// half-typed text — handleSend receives it as an argument.
//
// The composer stays MOUNTED while a run is in flight and is hidden with the `.hidden`
// class, exactly as panel.js:1931 did (`$('composer').classList.toggle('hidden', on)`).
// Unmounting it would throw away a draft the user typed before pressing Send.

import { memo, useLayoutEffect, useRef, useState } from 'react';

function autoGrow(textarea) {
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
}

/**
 * @param {boolean}  props.hidden  true while a run is in flight
 * @param {Function} props.onSend  handleSend(text) -> boolean. TRUE means the message was
 *                                 accepted and the box should clear. FALSE means it was
 *                                 refused (unconfigured LLM, a run already going) and the
 *                                 text must survive — panel.js:2009 returned before it
 *                                 cleared the input for exactly that reason.
 */
function Composer({ hidden, onSend }) {
  const [value, setValue] = useState('');
  const inputRef = useRef(null);

  useLayoutEffect(() => {
    autoGrow(inputRef.current);
  }, [value]);

  const submit = () => {
    if (onSend(value)) setValue('');
  };

  return (
    <div id="composer" className={'composer' + (hidden ? ' hidden' : '')}>
      <textarea
        id="composer-input"
        ref={inputRef}
        className="composer-input"
        rows="1"
        placeholder="Paste job link(s) or ask anything…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return; // IME composition commit
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button
        id="btn-send"
        className="btn-send"
        title="Send (Enter)"
        disabled={!value.trim()}
        onClick={submit}
      >
        <svg viewBox="0 0 18 18" width="16" height="16" aria-hidden="true">
          <path d="M3 9 L15 3 12 9 15 15 Z" fill="currentColor" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

export default memo(Composer);
