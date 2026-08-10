// Markdown.jsx — the React port of renderMarkdown (panel.js:157) + appendInline (186).
//
// Supports **bold**, *italic*, `code`, fenced blocks, [t](url), line breaks.
//
// SECURITY, and this is the whole point of the file: the text handed to this component is
// written by the LLM, which in turn has read an untrusted web page. The vanilla version
// built DOM nodes and set textContent precisely so that no attacker-controlled string was
// ever parsed as HTML. The React port keeps that property by construction — every piece of
// input becomes a JSX *child*, which React escapes. There is NO dangerouslySetInnerHTML in
// this file and there must never be one. If a future feature needs richer output, extend
// the tokenizer; do not reach for innerHTML.

/**
 * The inline tokenizer from panel.js:184, unchanged. `matchAll` clones the regex
 * internally, so a module-level /g literal is safe to share across calls.
 */
const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

/**
 * appendInline's React twin: instead of appending to a parent node, return the children.
 * @returns {Array<string|JSX.Element>}
 */
function inlineNodes(text, keyPrefix) {
  const out = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${n++}`;
    if (m[1]) {
      out.push(<code key={key}>{m[1].slice(1, -1)}</code>);
    } else if (m[2]) {
      out.push(<strong key={key}>{m[2].slice(2, -2)}</strong>);
    } else if (m[3]) {
      out.push(<em key={key}>{m[3].slice(1, -1)}</em>);
    } else {
      // target=_blank without rel=noopener hands the opened page a window.opener handle
      // back into the panel. Carried across verbatim from panel.js:207.
      out.push(
        <a key={key} href={m[5]} target="_blank" rel="noopener noreferrer">
          {m[4]}
        </a>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * The block-level pass. Returns an array of elements rather than a DocumentFragment.
 * Exported on its own because a caller sometimes wants the nodes without a wrapper.
 *
 * @param {string} text
 * @returns {Array<JSX.Element>}
 */
export function renderMarkdown(text) {
  const out = [];
  const parts = String(text).split(/```/);

  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Fenced code block; first line may be a language tag — drop it.
      out.push(
        <pre key={`f${i}`}>
          <code>{part.replace(/^[\w-]*\n/, '').replace(/\n$/, '')}</code>
        </pre>,
      );
    } else if (part) {
      part.split(/\n{2,}/).forEach((para, pi) => {
        if (!para.trim()) return;
        const kids = [];
        para.split('\n').forEach((line, li) => {
          if (li > 0) kids.push(<br key={`b${i}-${pi}-${li}`} />);
          kids.push(...inlineNodes(line, `i${i}-${pi}-${li}`));
        });
        out.push(<p key={`p${i}-${pi}`}>{kids}</p>);
      });
    }
  });

  return out;
}

/**
 * Drop-in for `el.appendChild(renderMarkdown(text))`.
 *
 * Renders a bare fragment — no wrapper element — because panel.css styles the markdown
 * through its container (`.msg-assistant p`, `.msg-assistant pre`, `.msg-assistant a`).
 * An extra <div> here would break those selectors.
 *
 * @param {{text:string}} props
 */
export default function Markdown({ text }) {
  return <>{renderMarkdown(text)}</>;
}
