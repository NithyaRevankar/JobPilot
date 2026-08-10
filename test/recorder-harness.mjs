// CONTRACT-V6 §7 — the recorder, against the real content script in a real Chromium.
// The user's actions are driven with Playwright (real trusted events), then the recorded
// macro is replayed on a FRESH copy of the page and the resulting DOM is checked.
//
// The recording session lives in the service worker (§8), so this harness stands one up
// on the Node side. That is not scaffolding for its own sake: the session surviving a
// navigation and spanning frames IS the thing under test, and neither is observable from
// inside a single page.
//
// Run: npm install && node test/recorder-harness.mjs
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

// ---------------------------------------------------- the service worker, faithfully
// Same rules as background/service-worker.js: upsert by step id, cap at 30, and tell a
// frame that asks on load whether it is inside a live recording.
let session = null;
let refuseNth = -1;   // set by a test to make the worker refuse one specific step
let stepsSeen = 0;
await page.exposeBinding('__sw', (_source, msg) => {
  if (!msg || typeof msg.kind !== 'string') return { ok: false };
  switch (msg.kind) {
    case 'jobpilot:rec-open':
      session = { steps: [], dropped: [] };
      stepsSeen = 0;
      return { ok: true };
    case 'jobpilot:rec-close': {
      const done = session;
      session = null;
      if (!done) return { ok: true, steps: [], dropped: 0, lost: [] };
      // Mirrors the worker's gap detection: ids run frame:0, frame:1, … so a missing
      // number is a step the user performed that never arrived.
      const seen = new Set([...done.steps.map((s) => s.id), ...done.dropped]);
      const top = new Map();
      for (const id of seen) {
        const at = id.lastIndexOf(':');
        const f = id.slice(0, at);
        top.set(f, Math.max(top.get(f) ?? -1, Number(id.slice(at + 1))));
      }
      const lost = [];
      for (const [f, n] of top) for (let i = 0; i < n; i++) if (!seen.has(`${f}:${i}`)) lost.push(`${f}:${i}`);
      return { ok: true, steps: done.steps, dropped: done.dropped.length, lost };
    }
    case 'jobpilot:rec-hello':
      return { ok: true, recording: Boolean(session) };
    // Stands in for the content script's direct read of chrome.storage.session — the
    // fast path that keeps a non-recording page from waking the worker at all.
    case '__peek':
      return session ? { recSession: session } : {};
    case 'jobpilot:rec-step': {
      const step = msg.step;
      if (!session || !step || typeof step.id !== 'string') return { ok: false };
      if (stepsSeen++ === refuseNth) return { ok: false }; // the worker declining to bank it
      const at = session.steps.findIndex((s) => s.id === step.id);
      if (at >= 0) session.steps[at] = step;
      else if (session.steps.length < 30) session.steps.push(step);
      else if (!session.dropped.includes(step.id)) session.dropped.push(step.id);
      return { ok: true };
    }
    default:
      return { ok: false };
  }
});

await page.addInitScript(() => {
  window.__handlers = [];
  window.chrome = {
    runtime: {
      onMessage: { addListener: (fn) => { window.__handlers.push(fn); } },
      sendMessage: (msg) => window.__sw(msg),
    },
    storage: { session: { get: () => window.__sw({ kind: '__peek' }) } },
  };
  window.__exec = (tool, args) => new Promise((resolve) => {
    window.__handlers[0]({ kind: 'jobpilot:exec', tool, args }, {}, resolve);
  });
});

const exec = (tool, args = {}) => page.evaluate(([t, a]) => window.__exec(t, a), [tool, args]);

// The manifest injects the content script into every frame of every page load. Here we
// do it by hand — including after a navigation, which is exactly what the real one does.
const inject = async (frame) => {
  await frame.addScriptTag({ path: `${ROOT}/content/content-script.js` });
  await frame.evaluate(() => new Promise((r) => setTimeout(r, 30))); // let rec-hello land
};
const load = async (fixture) => {
  await page.goto(`file://${ROOT}/test/${fixture}`);
  await inject(page.mainFrame());
};

/** What the panel does: open the session, then arm every frame that already exists. */
const recStart = async () => {
  await page.evaluate(() => window.__sw({ kind: 'jobpilot:rec-open', tabId: 1 }));
  for (const f of page.frames()) await f.evaluate(() => window.__exec('record_start', {}));
};
/** What the panel does: flush every frame, then read the session. */
const recStop = async () => {
  const unacked = new Set();
  for (const f of page.frames()) {
    try {
      const r = await f.evaluate(() => window.__exec('record_stop', {}));
      if (r && r.ok) for (const id of JSON.parse(r.result).unacked || []) unacked.add(id);
    } catch { /* frame gone — the worker's gap detection covers it */ }
  }
  const closed = await page.evaluate(() => window.__sw({ kind: 'jobpilot:rec-close' }));
  return { ...closed, lost: new Set([...unacked, ...(closed.lost || [])]).size };
};

// ============================================================ §4 — SECRETS
// The headline guarantee: a recorder that watches you type is a keylogger unless it
// is structurally unable to store what you typed. Type a real password and prove the
// characters exist nowhere in the recorded macro.
await load('mock-login.html');
await recStart();

const PASSWORD = 'hunter2-SUPER-SECRET-9f3a';
await page.fill('input[type=password]', PASSWORD);
const userField = await page.$('input[type=email], input[name=username], input[type=text]');
if (userField) await userField.fill('jane@example.com');
await page.keyboard.press('Tab'); // blur without clicking page content

let rec = await recStop();
const serialized = JSON.stringify(rec);

check('the password characters appear NOWHERE in the recorded macro',
  !serialized.includes(PASSWORD) && !serialized.includes('hunter2'),
  serialized.slice(0, 120));
check('the credential field records its SHAPE instead — a request_secret step',
  rec.steps.some((s) => s.action === 'request_secret' && s.secretKind === 'password'),
  JSON.stringify(rec.steps.map((s) => s.action)));
check('a request_secret step carries no value at all',
  rec.steps.filter((s) => s.action === 'request_secret').every((s) => s.value === undefined));

// THE ONE THAT NEARLY GOT THROUGH. mock-login's OTP box is <input type="text" name="code">
// with no autocomplete — the fixture says so itself. The AGENT is protected from it by the
// sticky secretFilledEls WeakSet, which only a secret fill populates... and a human typing
// during a demonstration never does. Recorded as a literal, a live 2FA code would be
// written to unencrypted storage and re-typed on every future application on this portal.
await page.click('#form-credentials button[type=submit]'); // advance to the OTP step
await page.waitForSelector('#code', { state: 'visible' });
await recStart();
const OTP = '914273';
await page.fill('#code', OTP);
await page.keyboard.press('Tab');
rec = await recStop();

check('an OTP box that attribute-sniffing does NOT flag is still never recorded literally',
  !JSON.stringify(rec).includes(OTP), JSON.stringify(rec.steps));
check('...it records as a request_secret step instead',
  rec.steps.some((s) => s.action === 'request_secret' && s.secretKind === 'otp'),
  JSON.stringify(rec.steps.map((s) => `${s.action}/${s.secretKind || ''}`)));

// ================================================ §3.2 — COALESCING TO INTENT
await load('mock-workday.html');
await recStart();

// The user does it by hand: type a name, then work the two prompt shapes.
await page.fill('#name--legalName--firstName', 'Jane');
await page.click('#phoneNumber--phoneType');            // opens the portal popup
await page.click('[data-automation-label="Mobile"]');   // picks from it
await page.fill('#address--city', 'Bengaluru');
await page.click('#source--source');                    // the multiselect search box
await page.fill('#source--source', 'Autodesk');         // types to filter
await page.waitForSelector('[data-automation-label="Autodesk Careers"]');
await page.click('[data-automation-label="Autodesk Careers"]');
await page.keyboard.press('Tab'); // blur without clicking page content

rec = await recStop();
const actions = rec.steps.map((s) => s.action);

check('typing a field records ONE fill, not a stream of keystrokes',
  rec.steps.filter((s) => s.action === 'fill' && /Given Name/i.test(s.label)).length === 1,
  JSON.stringify(actions));
check('open-dropdown-then-click-option collapses into ONE choose_option',
  rec.steps.filter((s) => s.action === 'choose_option').length === 2 && !actions.includes('click'),
  JSON.stringify(actions));
check('the choose_option carries the OPTION label, not a div',
  rec.steps.some((s) => s.action === 'choose_option' && s.value === 'Mobile') &&
  rec.steps.some((s) => s.action === 'choose_option' && s.value === 'Autodesk Careers'),
  JSON.stringify(rec.steps.filter((s) => s.action === 'choose_option').map((s) => s.value)));
check('typing into a prompt search box is NOT recorded as a fill (it selects nothing)',
  !rec.steps.some((s) => s.action === 'fill' && /Hear About Us/i.test(s.label)),
  JSON.stringify(rec.steps.map((s) => s.label)));
check('every step stores several locators, best first (data-automation-id wins)',
  rec.steps.every((s) => s.locators.length >= 2) && rec.steps.every((s) => s.locators.some((l) => l.by !== 'path')),
  JSON.stringify(rec.steps[0].locators));
// A locator identifies the FIELD. Deriving one from an input's .value would put the
// user's typed data back into the macro that §4 binds to the profile precisely to
// keep it out — and would be a worthless locator besides.
check('a locator is never derived from the value the user typed',
  !rec.steps.some((s) => s.locators.some((l) => l.value === 'Jane' || l.value === 'Bengaluru')),
  JSON.stringify(rec.steps.map((s) => s.locators.map((l) => `${l.by}=${l.value}`))));
// The steps land in the order the user acted, even though the coalescer revises earlier
// ones in place — a choose_option must not jump to the end of the list.
check('the steps are in the order the user performed them',
  actions.join() === 'fill,choose_option,fill,choose_option', actions.join());
// A recording can be dragged somewhere the user never meant to demonstrate (the page can
// open a tab while they record). They cannot consent to what they are not shown, so each
// step carries the host it happened on and the review dialog names any that are strays.
check('every step records the host it was performed on',
  rec.steps.every((s) => typeof s.host === 'string'),
  JSON.stringify(rec.steps.map((s) => s.host)));

const workdaySteps = rec.steps;

// ==================================================== §7.3 — REPLAY ON A FRESH PAGE
// The macro must reproduce the state the user demonstrated, on a page that has never
// seen the recording.
await load('mock-workday.html');
for (const step of workdaySteps) {
  const res = await exec('replay_step', { step });
  if (!res.ok) check(`replay of ${step.label}`, false, res.error);
}

const state = await page.evaluate(() => ({
  first: document.getElementById('name--legalName--firstName').value,
  city: document.getElementById('address--city').value,
  phoneType: document.getElementById('phoneNumber--phoneType').textContent,
  source: Array.from(document.querySelectorAll(
    '[data-automation-id=formField-source] [data-automation-id=selectedItem]')).map((p) => p.getAttribute('title')),
}));
check('replay reproduces the typed fields', state.first === 'Jane' && state.city === 'Bengaluru',
  JSON.stringify(state));
check('replay reproduces the single-select prompt', state.phoneType === 'Mobile', state.phoneType);
check('replay reproduces the multiselect pick', state.source.join() === 'Autodesk Careers',
  JSON.stringify(state.source));

// ================================================== §8 — SURVIVES A NAVIGATION
// THE BUG THIS SECTION EXISTS FOR. The recorder used to hold its steps in the content
// script's module scope, so `pagehide` threw them away — and a demonstration is
// PRECISELY the thing that navigates: the user is showing us how to get past an
// obstacle, and getting past it moves them to the next page. Every such recording
// came back empty, and the panel then told the user *they* had done nothing.
await load('mock-workday.html');
await page.evaluate(() => {
  const a = document.createElement('a');
  a.id = 'go-next';
  a.href = 'mock-application.html';
  a.textContent = 'Continue to the next page';
  document.querySelector('form').appendChild(a);
});
await recStart();

await page.fill('#name--legalName--firstName', 'Jane');   // page 1
await Promise.all([page.waitForNavigation(), page.click('#go-next')]);
await inject(page.mainFrame());                            // the manifest does this for real
await page.fill('#first-name', 'Jane Doe');                 // page 2, a NEW document
await page.keyboard.press('Tab');

rec = await recStop();
const labels = rec.steps.map((s) => s.label);
check('a step performed BEFORE the navigation survives it',
  rec.steps.some((s) => s.action === 'fill' && s.value === 'Jane'), JSON.stringify(labels));
check('the click that caused the navigation is recorded',
  rec.steps.some((s) => s.action === 'click' && /Continue to the next page/.test(s.label)),
  JSON.stringify(labels));
check('the page the user landed on keeps recording, into the SAME demonstration',
  rec.steps.some((s) => s.action === 'fill' && s.value === 'Jane Doe'), JSON.stringify(labels));
check('...and the two pages\' steps are in the order they happened',
  labels.length === 3 && /Jane"$/.test(labels[0]) && /Jane Doe"$/.test(labels[2]),
  JSON.stringify(labels));

// ======================================================= §8 — SEES INSIDE AN IFRAME
// The other half of the same bug: arming only the top frame. Half the ATS market
// (Greenhouse, iCIMS, Workable) renders its form in an embedded frame, and events do
// not cross that boundary — the top frame sees nothing at all.
await page.goto(`file://${ROOT}/test/mock-workday.html`);
await page.setContent(`<h1>Careers at Acme</h1>
  <iframe id="ats" src="file://${ROOT}/test/mock-application.html" width="800" height="600"></iframe>`);
await page.waitForSelector('#ats');
for (const f of page.frames()) await inject(f);
await recStart();

const embedded = page.frames().find((f) => /mock-application/.test(f.url()));
await embedded.fill('#first-name', 'Jane Doe');
await embedded.locator('#first-name').press('Tab');

rec = await recStop();
check('an action inside an embedded ATS frame is recorded',
  rec.steps.some((s) => s.action === 'fill' && s.value === 'Jane Doe'),
  JSON.stringify(rec.steps.map((s) => s.label)));

// ============================================ §3.1 — LOCATORS DEGRADE HONESTLY
// An ambiguous locator is not a coin flip: it must fall through to the next one.
await load('mock-workday.html');
await page.evaluate(() => {
  // A second element wearing the SAME automation id as the city field's wrapper.
  const twin = document.createElement('input');
  twin.type = 'text';
  twin.setAttribute('data-automation-id', 'cityTwin');
  document.querySelector('form').prepend(twin);
  document.getElementById('address--city').setAttribute('data-automation-id', 'cityTwin');
});
let res = await exec('replay_step', {
  step: {
    action: 'fill',
    value: 'Bengaluru',
    label: 'Fill "City"',
    locators: [{ by: 'automation', value: 'cityTwin' }, { by: 'id', value: 'address--city' }],
  },
});
const cityValue = await page.evaluate(() => document.getElementById('address--city').value);
check('an ambiguous locator falls through to the next one instead of guessing',
  res.ok && cityValue === 'Bengaluru', `${(res.result || res.error || '').slice(0, 60)} city="${cityValue}"`);

res = await exec('replay_step', {
  step: {
    action: 'fill',
    value: 'x',
    label: 'Fill "Gone"',
    locators: [{ by: 'automation', value: 'nope' }, { by: 'id', value: 'alsoNope' }],
  },
});
check('a macro whose locators all miss fails honestly and says what it tried',
  !res.ok && /page has changed/i.test(res.error) && /Tried:/.test(res.error),
  (res.error || '').slice(0, 110));

// ================================ §5.3 — a demonstration is not consent to auto-submit
// The irreversible flag is the ONLY thing between a replayed macro and a silent submit
// when autoSubmit is off, so it must not rest on an English word list: a wizard's real
// final control is often captioned "Continue", or "Absenden", or nothing at all.
await load('mock-workday.html');
await page.evaluate(() => {
  const form = document.querySelector('form');
  for (const [id, text, type] of [
    ['btn-de', 'Absenden', 'button'],        // non-English submit
    ['btn-plain', 'Continue', 'submit'],     // innocuous caption, real submit button
    ['btn-next', 'Save and Continue', 'button'], // a wizard NEXT — must NOT be flagged
  ]) {
    const b = document.createElement('button');
    b.id = id; b.type = type; b.textContent = text;
    form.appendChild(b);
  }
});
await recStart();
await page.click('#btn-de');
await page.click('#btn-next');
rec = await recStop();
const flagged = Object.fromEntries(rec.steps.map((s) => [s.label, Boolean(s.irreversible)]));
check('a non-English submit ("Absenden") is flagged irreversible',
  flagged['Click "Absenden"'] === true, JSON.stringify(flagged));
check('a wizard "Save and Continue" is NOT flagged — that would stall every macro',
  flagged['Click "Save and Continue"'] === false, JSON.stringify(flagged));

// ================================== a control that declares itself as no control at all
// Workday and every React portal build controls out of bare <div>s with click handlers.
// Those clicks used to be dropped in silence — another way to record nothing.
await load('mock-workday.html');
await page.evaluate(() => {
  const div = document.createElement('div');
  div.id = 'fake-btn';
  div.textContent = 'Add Another';
  div.style.cursor = 'pointer';   // the page telling the user "this is clickable"
  div.style.width = '120px';
  div.style.height = '30px';
  document.querySelector('form').appendChild(div);
});
await recStart();
await page.click('#fake-btn');
rec = await recStop();
check('a bare <div> control with cursor:pointer is recorded as a click',
  rec.steps.length === 1 && rec.steps[0].action === 'click' && /Add Another/.test(rec.steps[0].label),
  JSON.stringify(rec.steps.map((s) => s.label)));

// ...but that affordance must not drag <label>s back in. A <label> is pointer-cursored
// almost by definition, and clicking one only toggles the control it names — which records
// itself. One user action must not become two steps.
await load('mock-workday.html');
await page.evaluate(() => {
  const wrap = document.createElement('label');
  wrap.style.cursor = 'pointer';
  wrap.innerHTML = '<input type="checkbox" id="agree"> I agree to the terms';
  document.querySelector('form').appendChild(wrap);
});
await recStart();
await page.click('#agree');
rec = await recStop();
check('clicking a pointer-cursored <label> does not add a redundant click step',
  rec.steps.length === 1 && rec.steps[0].action === 'set_checkbox',
  JSON.stringify(rec.steps.map((s) => `${s.action}: ${s.label}`)));

// ============================================ §2 — the cap is REPORTED, not silent
// A demonstration longer than the 30-step cap must not quietly become a macro that does
// most of it. The user would approve 30 steps believing that was the whole thing, and the
// macro would stop halfway through an application with no explanation.
await load('mock-workday.html');
await page.evaluate(() => {
  const form = document.querySelector('form');
  for (let i = 0; i < 34; i++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.id = `many-${i}`;
    b.textContent = `Step ${i}`;
    form.appendChild(b);
  }
});
await recStart();
for (let i = 0; i < 34; i++) await page.click(`#many-${i}`);
rec = await recStop();
check('a demonstration longer than the cap keeps the first 30 steps',
  rec.steps.length === 30, String(rec.steps.length));
check('...and REPORTS the ones it had to drop, rather than truncating in silence',
  rec.dropped === 4, `dropped=${rec.dropped}`);

// ============================ §7.1 — a step that never lands must never pass unremarked
// The steps travel to the worker over a message channel now, so one can fail to arrive.
// A macro with a hole in it is worse than no macro: it replays every step AROUND the gap
// and reports full success. The worker finds the hole from the gaps in each frame's step
// sequence — the only way to know, since the frame that lost it is usually long gone.
await load('mock-workday.html');
await page.evaluate(() => {
  for (let i = 0; i < 3; i++) {
    const b = document.createElement('button');
    b.type = 'button'; b.id = `gap-${i}`; b.textContent = `Gap ${i}`;
    document.querySelector('form').appendChild(b);
  }
});
await recStart();
refuseNth = 1;                       // the worker refuses the SECOND step
await page.click('#gap-0');
await page.click('#gap-1');
await page.click('#gap-2');
rec = await recStop();
refuseNth = -1;
check('a step the worker never banked does not silently vanish from the demonstration',
  rec.lost === 1, `lost=${rec.lost} kept=${JSON.stringify(rec.steps.map((s) => s.label))}`);
check('...and it is counted ONCE, not twice by two different detectors',
  rec.steps.length === 2, JSON.stringify(rec.steps.map((s) => s.label)));

// ============================== the page must not be able to WRITE the demonstration
// A recording window is exactly when a hostile page would want to dispatch synthetic
// events: a step the user never performed, buried in a list they are about to approve.
await load('mock-workday.html');
await recStart();
await page.evaluate(() => {
  const evil = document.createElement('button');
  evil.textContent = 'Transfer everything';
  document.body.appendChild(evil);
  evil.click();                                                    // synthetic click
  const city = document.getElementById('address--city');
  city.value = 'injected';
  city.dispatchEvent(new Event('change', { bubbles: true }));      // synthetic change
});
await page.fill('#address--postalCode', '560001');                 // the REAL user action
await page.keyboard.press('Tab'); // blur without clicking page content
rec = await recStop();
check('events the page synthesized are NOT recorded — only what the user really did',
  rec.steps.length === 1 && rec.steps[0].action === 'fill' && /Postal Code/i.test(rec.steps[0].label),
  JSON.stringify(rec.steps.map((s) => s.label)));

// ================================================ §7.6 — NOT A BACKGROUND KEYLOGGER
await load('mock-workday.html');
await page.fill('#address--city', 'typed before any recording');
rec = await page.evaluate(() => window.__sw({ kind: 'jobpilot:rec-close' }));
check('nothing is captured when no recording is running', rec.steps.length === 0,
  JSON.stringify(rec.steps));

check('no page errors across the whole harness', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILING` : '\nall recorder checks passed');
process.exit(fail ? 1 : 0);
