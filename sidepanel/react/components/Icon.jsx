// Icon.jsx — the React port of panel.js's `icon(name, size)` helper (panel.js:137).
//
// The vanilla version built each icon with createElementNS into a live <svg>; here the
// same path data is declared once and React renders it. Attribute names are written in
// React's camelCase form (strokeWidth, not 'stroke-width') because that is what JSX
// wants — the emitted SVG attributes are identical either way.
//
// `stroke: 'currentColor'` is applied to every shape that does not name its own stroke,
// exactly as icon() did, so an icon inherits the colour of whatever it sits in. That is
// how `.tool-step.running .gear { color: var(--amber) }` and friends keep working.

import { createElement } from 'react';

/**
 * Every icon panel.js draws. Names are the same strings the vanilla code passed to
 * icon(), so a port can be read side by side with the original.
 *
 * `brain` is unused today — it was in ICON_PATHS before this port and is carried across
 * rather than quietly dropped, because losing it would be an invisible regression the
 * day someone wants it back.
 */
const ICON_PATHS = {
  gear: [
    { tag: 'circle', cx: '10', cy: '10', r: '2.4', fill: 'none', strokeWidth: '1.5' },
    { tag: 'path', d: 'M10 3.2v2M10 14.8v2M3.2 10h2M14.8 10h2M5.2 5.2l1.4 1.4M13.4 13.4l1.4 1.4M14.8 5.2l-1.4 1.4M6.6 13.4l-1.4 1.4', fill: 'none', strokeWidth: '1.5', strokeLinecap: 'round' },
  ],
  question: [
    { tag: 'circle', cx: '10', cy: '10', r: '8', fill: 'none', strokeWidth: '1.5' },
    { tag: 'path', d: 'M7.8 7.7a2.3 2.3 0 1 1 3.3 2.1c-.7.3-1.1.8-1.1 1.5v.3', fill: 'none', strokeWidth: '1.5', strokeLinecap: 'round' },
    { tag: 'circle', cx: '10', cy: '14.3', r: '0.9', fill: 'currentColor', stroke: 'none' },
  ],
  file: [
    { tag: 'path', d: 'M5.5 2.5h6l3.5 3.5v11.5h-9.5Z', fill: 'none', strokeWidth: '1.5', strokeLinejoin: 'round' },
    { tag: 'path', d: 'M11.5 2.5v3.5h3.5', fill: 'none', strokeWidth: '1.5', strokeLinejoin: 'round' },
  ],
  star: [
    { tag: 'path', d: 'M10 2.5l2.3 4.7 5.2.8-3.8 3.6.9 5.2L10 14.3l-4.6 2.5.9-5.2-3.8-3.6 5.2-.8Z', fill: 'none', strokeWidth: '1.4', strokeLinejoin: 'round' },
  ],
  trash: [
    { tag: 'path', d: 'M4 5.5h12M8 5.5V3.8h4v1.7M6 5.5l.8 11h6.4l.8-11', fill: 'none', strokeWidth: '1.4', strokeLinecap: 'round', strokeLinejoin: 'round' },
    { tag: 'path', d: 'M8.5 8.5v5M11.5 8.5v5', fill: 'none', strokeWidth: '1.4', strokeLinecap: 'round' },
  ],
  lock: [
    { tag: 'rect', x: '4.5', y: '9', width: '11', height: '8', rx: '1.6', fill: 'none', strokeWidth: '1.5' },
    { tag: 'path', d: 'M7 9V6.6a3 3 0 0 1 6 0V9', fill: 'none', strokeWidth: '1.5', strokeLinecap: 'round' },
  ],
  caret: [
    { tag: 'path', d: 'M6 8.5 10 12.5 14 8.5', fill: 'none', strokeWidth: '1.6', strokeLinecap: 'round', strokeLinejoin: 'round' },
  ],
  brain: [
    { tag: 'path', d: 'M5 4.5h8.5a1.5 1.5 0 0 1 1.5 1.5v10.5H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5z', fill: 'none', strokeWidth: '1.5', strokeLinejoin: 'round' },
    { tag: 'path', d: 'M7 8h5M7 11h5', fill: 'none', strokeWidth: '1.5', strokeLinecap: 'round' },
  ],
};

export const ICON_NAMES = Object.keys(ICON_PATHS);

/**
 * @param {{name:string, size?:number, className?:string, solid?:boolean}} props
 *
 * `solid` fills the icon's FIRST shape with currentColor. It is the React analogue of
 * panel.js:2203 — `starIcon.querySelector('path').setAttribute('fill','currentColor')` —
 * which is how the default-document star renders solid instead of outlined.
 *
 * An unknown name renders nothing rather than throwing. The vanilla icon() crashed on a
 * typo (ICON_PATHS[name] was undefined and the for..of threw), which in a side panel
 * means a blank screen; a missing 14px glyph is the better failure.
 */
export default function Icon({ name, size = 14, className, solid = false, ...rest }) {
  const shapes = ICON_PATHS[name];
  if (!shapes) {
    console.warn(`[jobpilot] <Icon name="${name}"> is not a known icon — ${ICON_NAMES.join(', ')}`);
    return null;
  }
  return (
    <svg
      viewBox="0 0 20 20"
      width={size}
      height={size}
      aria-hidden="true"
      className={className}
      {...rest}
    >
      {shapes.map(({ tag, ...attrs }, i) =>
        createElement(tag, {
          key: i,
          stroke: 'currentColor',
          ...attrs,
          ...(solid && i === 0 ? { fill: 'currentColor' } : null),
        }),
      )}
    </svg>
  );
}
