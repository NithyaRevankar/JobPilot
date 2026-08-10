// PortalChip.jsx — the detected ATS portal for the target tab (CONTRACT-V3 §6.3).
// panel.html.orig line 63, painted by refreshPortalChip (panel.js:1393).
//
// panel.js hid this with `chip.hidden = true`. That never actually worked: panel.css:1475
// declares `.portal-chip { display: flex }`, an author rule which outranks the user-agent's
// `[hidden] { display: none }`, so the chip stayed on screen as an empty pill whenever it
// had nothing to say. (`.run-strip[hidden]` at panel.css:545 carries the comment "Author
// display:flex would otherwise defeat the hidden attribute" — the same fix was never
// applied here.) Not rendering the element is what the original meant, needs no CSS change,
// and panel.css is out of scope for this migration.

import { memo } from 'react';

/**
 * @param {object|null} props.chip  {text, cold} or null when there is nothing to show
 * @param {Function}    props.onClick
 */
function PortalChip({ chip, onClick }) {
  if (!chip) return null;
  return (
    <button
      id="portal-chip"
      className={'portal-chip' + (chip.cold ? ' cold' : '')}
      title="Portal detected for this tab — click to open Memory"
      onClick={onClick}
    >
      <span className="portal-dot" />
      <span>{chip.text}</span>
    </button>
  );
}

export default memo(PortalChip);
