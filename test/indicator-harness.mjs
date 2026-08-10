// The "controlled by JobPilot" indicator, in a real browser.
//
// The feature is one pill and a ring, and every hard part of it is a NEGATIVE: the thing
// has to be visible to the user and simultaneously invisible to the page, to the agent's
// own reading of the page, and to hit testing. None of that can be checked by reading the
// code — a closed shadow root that is nevertheless reachable, an overlay that quietly eats
// the click on a Submit button, a `read_page` that starts describing our own pill as part
// of the employer's form, all look exactly like working code.
//
// It also checks the one guarantee nothing else can: the indicator takes ITSELF down when
// the side panel stops saying it is there. A panel that crashes sends no ctrl-off, and a
// tab left announcing that a dead process is typing into it is worse than no indicator at
// all. Playwright's clock control is what makes that testable in a second rather than 30.
//
// Run: node test/indicator-harness.mjs

import { chromium } from 'playwright';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

// Frozen at a fixed instant so the 30s watchdog can be reached by fast-forwarding rather
// than by waiting. install() must come before the content script runs — it patches
// Date.now and setInterval, which are exactly what the watchdog is built from.
await page.clock.install();

// The content script talks to the worker (ctrl-hello on load) and is talked to by it
// (ctrl-show / ctrl-hide). Both are stubbed: `__greeted` records the hello so the
// navigation-survival path is observable, and `__hello` is what the worker would answer.
await page.addInitScript(() => {
  window.__handlers = [];
  window.__greeted = 0;
  // An init script re-runs on every navigation, so the worker's answer is keyed off the
  // URL rather than set from the test: `?step=2` stands for "the agent navigated us here
  // mid-run", which is the case the greet exists for.
  window.__hello = location.search.includes('step=2')
    ? { ok: true, controlled: true, mode: 'acting', status: 'read_page' }
    : { ok: true, controlled: false };
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__handlers.push(fn); } },
      sendMessage: async (msg) => {
        if (msg.kind === 'jobpilot:ctrl-hello') { window.__greeted++; return window.__hello; }
        return { ok: true };
      },
    },
  };
  window.__send = (msg) => new Promise((resolve) => {
    window.__handlers[0](msg, {}, resolve);
  });
});

await page.goto(`file://${ROOT}/test/mock-application.html`);
await page.addScriptTag({ path: `${ROOT}/content/content-script.js` });

const send = (msg) => page.evaluate((m) => window.__send(m), msg);
const exec = (tool, args = {}) => page.evaluate(
  ([t, a]) => window.__send({ kind: 'jobpilot:exec', tool: t, args: a }), [tool, args]);
const hostCount = () => page.evaluate(() => document.querySelectorAll('jobpilot-indicator').length);

// ------------------------------------------------------------------ it is not there yet
check('nothing is drawn until the panel says a run is driving this tab', (await hostCount()) === 0);

// ------------------------------------------------------------------------ show it
await send({ kind: 'jobpilot:ctrl-show', mode: 'acting', status: 'fill e12 = "Jane Okoro"' });
check('the indicator is drawn on request', (await hostCount()) === 1);

const shown = await page.evaluate(() => {
  const host = document.querySelector('jobpilot-indicator');
  const cs = getComputedStyle(host);
  return {
    parentTag: host.parentElement.tagName,
    position: cs.position,
    pointerEvents: cs.pointerEvents,
    zIndex: cs.zIndex,
    // A closed root is not reachable from page script — this is the whole security claim.
    openRoot: host.shadowRoot !== null,
    lightText: host.textContent,
    box: host.getBoundingClientRect().toJSON(),
  };
});
check('it is pinned to the viewport, above everything',
  shown.position === 'fixed' && shown.zIndex === '2147483647', JSON.stringify(shown));
check('it fills the viewport, so the ring frames the whole page',
  shown.box.width === 1100 && shown.box.height === 780, JSON.stringify(shown.box));

// ============================================================ it is invisible to the PAGE
check('THE SECURITY CLAIM: the shadow root is CLOSED, so page script cannot read the step ' +
  'the agent is on', shown.openRoot === false);
check('...and nothing leaks into the light DOM either', shown.lightText === '', JSON.stringify(shown.lightText));
check('it hangs off <html>, NOT <body> — read_page text mode dumps body, and an indicator ' +
  'inside it would be read back to the model as part of the employer\'s page',
  shown.parentTag === 'HTML', shown.parentTag);

// ================================================== it is invisible to HIT TESTING
// `click` refuses to fire when something covers its target (a cookie banner absorbing a
// Submit is how a run "submits" an application that was never submitted). A full-viewport
// overlay would trip that on every click in the top strip of the page.
const covering = await page.evaluate(() => {
  const el = document.elementFromPoint(550, 20);
  return el ? el.tagName : null;
});
check('THE OTHER ONE: it takes no part in hit testing, so it can never absorb a click — ' +
  'not the agent\'s, not the user\'s',
  covering !== 'JOBPILOT-INDICATOR' && shown.pointerEvents === 'none', String(covering));

// ============================================== it is invisible to the AGENT'S OWN READING
// The URL line of an inventory is the file:// path of this checkout, which contains
// "jobpilot" — so match the indicator itself, not the product name.
const inventory = (await exec('read_page')).result;
check('read_page does not inventory it', !/jobpilot-indicator/i.test(inventory));
check('...and does not describe it as a heading or a control',
  !/controlling this tab/i.test(inventory));
const text = (await exec('read_page', { mode: 'text' })).result;
check('read_page text mode does not read it back to the model as page content',
  !/controlling this tab/i.test(text));
const found = (await exec('find', { text: 'JobPilot' })).result;
check('find cannot reach inside it either — shadowRoots() walks OPEN roots only',
  !/controlling this tab/i.test(found), found.slice(0, 90));

// ==================================================================== what it says
const words = () => page.evaluate(() => {
  // The test reads the closed root the only way anything can: by holding the reference
  // attachShadow returned. The content script has it; nobody else does. Re-creating that
  // here would defeat the point, so instead assert on what a USER can see — the rendered
  // pixels — via the element's own accessibility-free geometry and the page's paint.
  const host = document.querySelector('jobpilot-indicator');
  return { present: Boolean(host), mode: host && host.getAttribute('data-mode') };
});
check('it is marked as the acting state', (await words()).mode === 'acting');

await send({ kind: 'jobpilot:ctrl-show', mode: 'watching', status: 'do it in the page' });
check('request_demo switches it to WATCHING — the run is live but the user is the one ' +
  'typing, and a pill claiming JobPilot controls the tab would simply be false',
  (await words()).mode === 'watching');
check('...without drawing a second one', (await hostCount()) === 1);

// A screenshot is the only honest check that a closed shadow root actually rendered: no
// API can read into it, so "is anything on screen" is the question that matters.
const painted = await page.screenshot({ clip: { x: 380, y: 4, width: 340, height: 40 } });
const blank = await page.evaluate(() => {
  document.querySelector('jobpilot-indicator').remove();
  return true;
});
const empty = blank && await page.screenshot({ clip: { x: 380, y: 4, width: 340, height: 40 } });
check('the pill actually PAINTS — a closed root that renders nothing would pass every ' +
  'other check in this file', !painted.equals(empty));

// ------------------------------------------------------------------------ hide it
await send({ kind: 'jobpilot:ctrl-show', mode: 'acting', status: 'click e4' });
check('re-shown after the page tore it out (a single-page app swapping the document)',
  (await hostCount()) === 1);
await send({ kind: 'jobpilot:ctrl-hide' });
check('the run ends and it is gone', (await hostCount()) === 0);

// ==================================================== THE GUARANTEE: it removes itself
//
// The panel crashed. No ctrl-off is coming, ever. Nothing outside this page can help.
await send({ kind: 'jobpilot:ctrl-show', mode: 'acting', status: 'fill e12 = "Jane"' });
check('a run is driving the tab again', (await hostCount()) === 1);

await page.clock.fastForward(10_000); // beats would still be arriving
check('a live run keeps it up — the watchdog is not a timeout on the RUN', (await hostCount()) === 1);

await page.clock.fastForward(40_000); // the panel has said nothing for 50s
check('THE GUARANTEE: with no word from the panel the page takes the indicator down ITSELF, ' +
  'so a crashed panel cannot leave a tab announcing that a dead process is typing into it',
  (await hostCount()) === 0);

// ============================================ surviving the navigations the agent causes
// Every navigate() destroys this content script and the indicator with it. The fresh page
// asks the worker on load, which is the only reason the indicator does not vanish at the
// exact moment a run gets interesting.
await page.goto(`file://${ROOT}/test/mock-application.html?step=2`);
await page.addScriptTag({ path: `${ROOT}/content/content-script.js` });
await page.waitForFunction(() => window.__greeted > 0);
check('a page loaded mid-run asks whether it is being driven', (await page.evaluate(() => window.__greeted)) > 0);
// The greet is a round trip, so the indicator lands a tick after the question was asked.
await page.waitForFunction(() => document.querySelectorAll('jobpilot-indicator').length === 1)
  .catch(() => {});
check('...and comes up already showing the indicator', (await hostCount()) === 1);

// ------------------------------------------------------------------------- iframes
// A Workday application is three iframes deep and our content script runs in all of them.
const framed = await browser.newPage();
await framed.addInitScript(() => {
  window.__handlers = [];
  window.__greeted = 0;
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__handlers.push(fn); } },
      sendMessage: async () => { window.__greeted++; return { ok: true, controlled: true, mode: 'acting', status: 'x' }; },
    },
  };
  window.__send = (msg) => new Promise((resolve) => { window.__handlers[0](msg, {}, resolve); });
});
await framed.goto(`file://${ROOT}/test/mock-application-iframe.html`);
const inner = framed.frames().find((f) => f !== framed.mainFrame());
await inner.addScriptTag({ path: `${ROOT}/content/content-script.js` });
await inner.evaluate(() => window.__send({ kind: 'jobpilot:ctrl-show', mode: 'acting', status: 'x' }));
check('an embedded ATS iframe draws NOTHING — one indicator per tab, at the top, or a ' +
  'Workday form gets three, two of them clipped inside a box in the middle of the page',
  (await inner.evaluate(() => document.querySelectorAll('jobpilot-indicator').length)) === 0);
await framed.close();

check('no page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} indicator check(s) FAILED` : '\nall indicator checks passed');
process.exit(fail ? 1 : 0);
