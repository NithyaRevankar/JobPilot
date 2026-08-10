// CONTRACT-V9 — the controls a click and a keystroke cannot operate: a virtualized
// list whose rows do not exist yet, a chord, a paste-only editor, and a drag.
// Each check below is a rung of §7's Definition of Done.
import { chromium } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

const browser = await chromium.launch();
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

await page.addInitScript(() => {
  window.__handlers = [];
  window.chrome = { runtime: { onMessage: { addListener: (fn) => { window.__handlers.push(fn); } } } };
  window.__exec = (tool, args) => new Promise((resolve) => {
    window.__handlers[0]({ kind: 'jobpilot:exec', tool, args }, {}, resolve);
  });
});

await page.goto(`file://${ROOT}/test/mock-widgets.html`);
await page.addScriptTag({ path: `${ROOT}/content/content-script.js` });

const exec = (tool, args = {}) => page.evaluate(([t, a]) => window.__exec(t, a), [tool, args]);
const act = (actions) => exec('dom_act', { actions });
const text = (sel) => page.evaluate((s) => document.querySelector(s).textContent, sel);
const rows = () => page.evaluate(() => Array.from(document.querySelectorAll('#v-list .opt')).map((o) => o.textContent));
const refOf = (inv, re) => {
  const line = inv.split('\n').find((l) => re.test(l) && /\[e\d+\]/.test(l));
  const m = line && line.match(/\[(e\d+)\]/);
  return m ? m[1] : null;
};

let r;

// ==================================================== §1 the virtualized listbox
r = await act([{ op: 'click', selector: '#v-trigger' }]);
check('the virtualized listbox opens', r.ok && (await rows()).length > 0,
  `${(await rows()).length} rows | ${(r.result || r.error || '').slice(0, 70)}`);

// ------------------------------------------------------ §7.2 the premise is real
const openRows = await rows();
check('§7.2 it renders a WINDOW of a 500-option list, not the list',
  openRows.length > 5 && openRows.length < 40, `${openRows.length} of 500 rendered`);
check('§7.2 THE PREMISE: "Zanzibar" is not in the DOM at all — no selector can match it',
  !openRows.includes('Zanzibar') &&
  (await page.evaluate(() => Array.from(document.querySelectorAll('*')).some((e) => e.textContent === 'Zanzibar'))) === false,
  `last rendered row: ${openRows[openRows.length - 1]}`);

r = await exec('inspect_dom', { selector: '#v-list' });
check('...and inspect_dom cannot conjure it either — V7 was not enough',
  r.ok && !/Zanzibar/.test(r.result || ''), (r.result || '').split('\n')[0].slice(0, 80));

// --------------------------------------------------- §7.3 scroll makes it exist
r = await act([{ op: 'scroll', selector: '#v-list', by: 11400 }]);
const afterScroll = await rows();
check('§7.3 THE POINT: dom_act scroll makes the row EXIST',
  r.ok && afterScroll.includes('Zanzibar'),
  (r.result || r.error || '').slice(0, 110));
check('...and the result says where it ended up, so the model can scroll further',
  /scrolled .* to \d+\/\d+/.test(r.result || ''), (r.result || '').slice(0, 90));

// ------------------------------------------ §7.4 a scroll that kills refs says so
const beforeBottom = (await rows()).length;
r = await act([{ op: 'scroll', selector: '#v-list', to: 'bottom' }]);
const afterBottom = (await rows()).length;
check('§7.4 a scroll that changes the rendered rows WARNS that earlier refs may be dead',
  r.ok && beforeBottom !== afterBottom && /may now be stale/.test(r.result || ''),
  `${beforeBottom} → ${afterBottom} | ${(r.result || '').slice(-95)}`);

r = await act([{ op: 'scroll', selector: '#v-list', to: 'bottom' }]);
check('...and a scroll that goes nowhere says THAT, instead of reporting "ok"',
  r.ok && /did not move/.test(r.result || ''), (r.result || r.error || '').slice(0, 90));

r = await act([{ op: 'scroll' }]);
check('scroll is the one op that works with no target at all (it scrolls the page)',
  r.ok && /the page/.test(r.result || ''), (r.result || r.error || '').slice(0, 90));

// --------------------------------------- §7.5 choose_option does the hunt itself
await act([{ op: 'click', selector: '#v-trigger' }]);           // close it again
const inv = (await exec('read_page')).result;
const vRef = refOf(inv, /Country of citizenship|Select One/i);
check('read_page finds the trigger', Boolean(vRef),
  (inv.split('\n').find((l) => /Country of citizenship|Select One/i.test(l)) || '(absent)').slice(0, 90));

r = await exec('choose_option', { ref: vRef, option: 'Zanzibar' });
check('§7.5 THE WHOLE POINT: choose_option scrolls the list by itself and picks row 480',
  r.ok && (await text('#v-value')) === 'Zanzibar',
  `chosen="${await text('#v-value')}" | ${(r.result || r.error || '').slice(0, 100)}`);

r = await exec('choose_option', { ref: vRef, option: 'Atlantis' });
check('§7.6 a genuine miss reports HOW FAR it looked — "absent" and "not rendered" differ',
  !r.ok && /scrolled the list \d+×/.test(r.error || '') && /to the end/.test(r.error || ''),
  (r.error || '').slice(0, 150));

// ================================================= §2 modifier keys (the chord)
r = await act([{ op: 'key', selector: '#cover', key: 'Enter' }]);
check('§7.7 a bare Enter in the notes box is just a newline (the premise)',
  r.ok && (await text('#cover-value')) === 'newline', `log="${await text('#cover-value')}"`);

r = await act([{ op: 'key', selector: '#cover', key: 'Enter', ctrl: true }]);
check('§7.7 THE POINT: Ctrl+Enter submits — the chord the agent could not send before',
  r.ok && (await text('#cover-value')) === 'submitted', `log="${await text('#cover-value')}"`);
check('...and the result NAMES the chord, so a dropped modifier cannot hide',
  /Ctrl\+Enter/.test(r.result || ''), (r.result || '').slice(0, 80));

r = await act([{ op: 'scroll_into_view', selector: '#cover', ctrl: true }]);
check('§7.8 a modifier on an op that cannot hold one is REFUSED by name, not ignored',
  !r.ok && /ctrl is only meaningful on click and key/.test(r.error || ''), (r.error || '').slice(0, 110));

// ================================================================== §3 paste
r = await act([{ op: 'type', selector: '#editor', value: 'typed, not pasted' }]);
check('§7.9 the premise: typing into the rich editor never reaches its model',
  (await text('#editor-value')) === '', `model="${await text('#editor-value')}"`);

r = await act([{ op: 'paste', selector: '#editor', value: 'Dear hiring manager,' }]);
check('§7.9 THE POINT: paste reaches the editor that ignores typing',
  r.ok && (await text('#editor-value')) === 'Dear hiring manager,',
  `model="${await text('#editor-value')}" | ${(r.result || r.error || '').slice(0, 80)}`);
check('...and it says the page HANDLED the paste, which is the fact that matters',
  /handled the paste event/.test(r.result || ''), (r.result || '').slice(-70));

r = await act([{ op: 'paste', selector: '#cover', value: 'plain textarea' }]);
const coverValue = await page.evaluate(() => document.getElementById('cover').value);
check('§7.10 a paste nobody listens for falls back to setting the value...',
  r.ok && coverValue === 'plain textarea', `value="${coverValue}"`);
check('...and SAYS it fell back — "pasted" and "typed" are different things to an editor',
  /ignored the paste event/.test(r.result || ''), (r.result || '').slice(-80));

r = await act([{ op: 'paste', selector: '#pw', value: 'hunter2' }]);
const pwValue = await page.evaluate(() => document.getElementById('pw').value);
check('§7.11 paste into a password field is refused — V2 §0 keeps ONE door for secrets',
  !r.ok && /request_secret/.test(r.error || ''), (r.error || '').slice(0, 100));
check('...and nothing was pasted', pwValue === '', `"${pwValue}"`);

// ================================================================== §4 drag
r = await act([{ op: 'click', selector: '#rank li[data-skill=React]' }]);
check('§7.12 the premise: clicking a drag-to-rank list does nothing at all',
  (await text('#rank-value')) === 'React,Python,Rust', `order="${await text('#rank-value')}"`);

r = await act([{ op: 'drag', selector: '#rank li[data-skill=React]', to_selector: '#rank li[data-skill=Rust]' }]);
const order = await text('#rank-value');
check('§7.12 THE POINT: a pointer drag reorders the ranking, React to the bottom',
  r.ok && order === 'Python,Rust,React', `order="${order}" | ${(r.result || r.error || '').slice(0, 90)}`);
check('...and the result proves it with the sibling index, not with optimism',
  /position among its siblings changed/.test(r.result || ''), (r.result || '').slice(-70));

r = await act([{ op: 'drag', selector: '#chip', to_selector: '#bin' }]);
check('§7.13 an HTML5 draggable chip is dropped on its target (a different protocol entirely)',
  r.ok && (await text('#bin-value')) === 'Senior',
  `dropped="${await text('#bin-value')}" | ${(r.result || r.error || '').slice(0, 80)}`);
check('...and a drop is judged by what the TARGET said, since the chip itself never moves',
  /the target accepted the drop/.test(r.result || ''), (r.result || '').slice(-60));

r = await act([{ op: 'drag', selector: '#chip', to_selector: '#rank' }]);
check('...so a drop on something that is not a drop zone is reported as the miss it is',
  r.ok && /NEVER ACCEPTED it/.test(r.result || ''), (r.result || r.error || '').slice(0, 110));

r = await act([{ op: 'drag', selector: '#thumb', dx: 150 }]);
const salary = Number(await text('#slider-value'));
check('§7.14 dragging by dx moves a custom slider with no <input type=range> behind it',
  r.ok && salary > 90 && salary < 125, `salary=${salary} | ${(r.result || r.error || '').slice(0, 80)}`);

r = await act([{ op: 'drag', selector: '#bin', dx: 40 }]);
check('§7.15 a drag that moves NOTHING says so — the failure V3 §7.1 exists to prevent',
  r.ok && /NOTHING observably changed/.test(r.result || ''), (r.result || r.error || '').slice(0, 110));

r = await act([{ op: 'drag', selector: '#chip' }]);
check('§7.16 a drag with no destination is refused, and says what is missing',
  !r.ok && /drag needs somewhere to go/.test(r.error || ''), (r.error || '').slice(0, 100));

// ---------------------------------------------------------------- CONTRACT-V7 §8
// The click blocker descends into open shadow roots to find the top element, and
// Node.contains() does not cross that boundary. Reading that as an obstruction refuses
// every click on a web component — and blames the component's own button for covering it.

r = await act([{ op: 'click', selector: '#consent' }]);
check('§7.17 clicking a web-component HOST is not refused as "something is covering it"',
  r.ok && !/covering it/.test(r.error || ''),
  (r.result || r.error || '').slice(0, 110));

// And the click that a user would actually make — on the button inside the shadow root,
// which deepQueryAll reaches — lands and does its work.
r = await act([{ op: 'click', selector: '#agree-btn' }]);
check('...and the button inside the shadow root is clickable, not "covered" by its own host',
  r.ok && (await text('#consent-value')) === 'agreed',
  `consent="${await text('#consent-value')}" | ${(r.result || r.error || '').slice(0, 90)}`);

// A real obstruction must still be caught, or the fix above traded one lie for another.
await page.evaluate(() => {
  const veil = document.createElement('div');
  veil.id = 'veil';
  const rect = document.getElementById('consent').getBoundingClientRect();
  veil.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;` +
    `width:${rect.width}px;height:${rect.height}px;background:rgba(0,0,0,.5);z-index:99;`;
  document.body.appendChild(veil);
});
r = await act([{ op: 'click', selector: '#consent' }]);
check('...while something REALLY covering it is still refused, by name',
  !r.ok && /div#veil/.test(r.error || ''), (r.error || '').slice(0, 110));
await page.evaluate(() => document.getElementById('veil').remove());

// ---------------------------------------------------------------- CONTRACT-V9 §4
// `draggable` is true by default on <a> and <img>, so choosing the drag protocol from the
// PROPERTY sends a link-based sortable down the HTML5 path, where nothing is listening.

r = await act([{ op: 'drag', selector: '#places li:first-child a', to_selector: '#places li:last-child' }]);
check('§7.18 a sortable built from LINKS is driven by pointer events, not HTML5 drag',
  r.ok && (await text('#places-value')) !== 'Berlin,Lisbon,Oslo',
  `order="${await text('#places-value')}" | ${(r.result || r.error || '').slice(0, 100)}`);

// ---------------------------------------------------------------- CONTRACT-V9 §1
// The stale-ref warning after a scroll must key on IDENTITY. A virtualizer renders a
// constant-size window, so counting rows is blind to the scroll that kills every ref.

// Open it from a known state: earlier checks in this file leave the list closed or
// scrolled, and a premise that depends on where a previous test stopped is not a premise.
await page.evaluate(() => {
  const list = document.getElementById('v-list');
  const trigger = document.getElementById('v-trigger');
  if (list.style.display !== 'block') trigger.click();
  list.scrollTop = 0;
  list.dispatchEvent(new Event('scroll'));
});
const beforeRows = await page.evaluate(() =>
  [...document.querySelectorAll('#v-list [role=option]')].map((o) => o.textContent));
r = await act([{ op: 'scroll', selector: '#v-list', by: 2400 }]);
const afterRows = await page.evaluate(() =>
  [...document.querySelectorAll('#v-list [role=option]')].map((o) => o.textContent));
const overlap = afterRows.filter((t) => beforeRows.includes(t)).length;
check('§7.19 the premise: a fixed-window virtualizer replaces every row and keeps the COUNT',
  beforeRows.length === afterRows.length && overlap === 0,
  `${beforeRows.length} → ${afterRows.length} rows, ${overlap} in common`);
check('§7.19 THE POINT: the scroll still warns that refs into it are dead',
  r.ok && /may now be stale/.test(r.result || ''),
  (r.result || r.error || '').slice(0, 130));
await act([{ op: 'key', selector: '#v-trigger', key: 'Escape' }]);

// ============================================== §9 fields that fight the write
// The ApplyPilot-pass fixes: an unverified "typed X" from dom_act, a mask reported
// as "did not stick", and a native select refusing a whitespace-padded option.
r = await act([{ op: 'type', selector: '#locked', value: 'Senior Engineer' }]);
check('type on a value-reverting field reports the revert, never plain success',
  r.ok && /did not stick/.test(r.result || '') && /EMPTY/.test(r.result || ''),
  (r.result || r.error || '').slice(0, 110));

const inv9 = (await exec('read_page')).result;
const maskedRef = refOf(inv9, /Masked phone/i);
const spacedRef = refOf(inv9, /Pronouns/i);
check('the write-fighting fields are in the inventory', Boolean(maskedRef && spacedRef),
  `${maskedRef} ${spacedRef}`);

r = await exec('fill', { ref: maskedRef, value: '5551234567' });
check('a masked field that REFORMATS the value is reported as filled, not as failed',
  r.ok && /^Filled/.test(r.result || '') && /reformatted/.test(r.result || ''),
  (r.result || r.error || '').slice(0, 110));
check('...and the mask really did fire, so this test is not passing vacuously',
  (await page.evaluate(() => document.getElementById('masked').value)) === '(555) 123-4567');

r = await exec('select_option', { ref: spacedRef, option: ' Prefer not to say ' });
check('select_option tolerates whitespace on either side of the match',
  r.ok && /Prefer not to say/.test(r.result || ''),
  (r.result || r.error || '').slice(0, 90));

check('no page errors across the whole harness', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILING` : '\nall widget checks passed');
process.exit(fail ? 1 : 0);
