// Toast.jsx — the React port of panel.js's showToast (panel.js:62).
//
// The ergonomics are deliberately imperative, exactly as they were: any module — a view,
// an event handler, an agent callback, the store — calls `showToast(text, variant)` and
// does not care whether a React component is mounted. So the queue lives at module level
// and <ToastHost/> is a subscriber that renders it. Same pattern as Modal.jsx.
//
// The text can come from an error message or from the page, so it goes through JSX as a
// child (a text node), never through dangerouslySetInnerHTML.

import { useSyncExternalStore } from 'react';

/** panel.js:69 — how long a toast sits before it starts leaving. */
const DWELL_MS = 2500;
/** panel.js:70 — the .leaving animation is 200ms in panel.css; 220 is its old grace. */
const LEAVE_MS = 220;
/**
 * How many toasts may be on screen at once.
 *
 * The vanilla version had no cap and nor did this port, which is fine for the one-at-a-time
 * case they were both written for and wrong for the one that actually happens: dropping a
 * folder of files on the Profile tab toasts once per rejected file, and forty stacked
 * toasts cover the panel they are reporting on. Keeping the NEWEST is the right end to
 * keep — the last error is the one still on screen when the user looks up.
 */
const MAX_TOASTS = 4;

let toasts = [];
let seq = 0;
const listeners = new Set();

function emit() {
  for (const fn of [...listeners]) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot() {
  return toasts;
}

/**
 * Fire a toast. Callable from anywhere, at any time — including before <ToastHost/> has
 * mounted, in which case the toast simply expires unseen, which is what the vanilla
 * version did when #toast-container was not in the document yet.
 *
 * @param {string} text
 * @param {''|'success'|'error'|'warn'} variant  the class panel.css styles it with
 */
export function showToast(text, variant = '') {
  const id = ++seq;
  toasts = [...toasts, { id, text: String(text), variant, leaving: false }];
  if (toasts.length > MAX_TOASTS) toasts = toasts.slice(-MAX_TOASTS);
  emit();

  // Two-stage teardown, same as the original: add `.leaving` so the CSS animation can
  // play, then drop the node once it has finished.
  setTimeout(() => {
    toasts = toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t));
    emit();
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      emit();
    }, LEAVE_MS);
  }, DWELL_MS);
}

/**
 * Mounted once, by App. Renders the same #toast-container panel.html carried, so
 * `.toast-container` / `.toast` / `.toast.success|error|warn|leaving` all still apply.
 */
export function ToastHost() {
  const list = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (
    <div id="toast-container" className="toast-container" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast ${t.variant}${t.leaving ? ' leaving' : ''}`.trim()}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
