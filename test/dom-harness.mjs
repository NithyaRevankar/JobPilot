// CONTRACT-V7 — the DOM escape hatch, against controls that defeat every recipe tool.
// Each check below is a rung of §9's Definition of Done.
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

await page.goto(`file://${ROOT}/test/mock-tricky.html`);
await page.addScriptTag({ path: `${ROOT}/content/content-script.js` });

const exec = (tool, args = {}) => page.evaluate(([t, a]) => window.__exec(t, a), [tool, args]);
const act = (actions) => exec('dom_act', { actions });
const refOf = (inv, re) => {
  const line = inv.split('\n').find((l) => re.test(l));
  const m = line && line.match(/^\[(e\d+)\]/);
  return m ? m[1] : null;
};

let r;
const inv = (await exec('read_page')).result;
const ccRef = refOf(inv, /Country Phone Code/i);
const kbRef = refOf(inv, /label="City\*"/i);
check('read_page found the tricky controls', Boolean(ccRef && kbRef), `${ccRef} ${kbRef}`);

check('read_page never showed the honeypot or the aria-hidden field (§3.1 premise)',
  !/"website"/.test(inv) && !/nickname/.test(inv));

// ------------------------------------------------------------ §9.3 inspect_dom
r = await exec('inspect_dom', { ref: ccRef });
const inspectClosed = r.result || '';
check('inspect_dom shows the raw attributes read_page summarised away',
  r.ok && /data-automation-id="promptTrigger"/.test(inspectClosed) && /aria-expanded="false"/.test(inspectClosed),
  (inspectClosed.split('\n')[2] || '').slice(0, 100));
check('...and says the popup is not open yet, instead of leaving the model guessing',
  /OPEN LAYERS: none visible/.test(inspectClosed));

// ---------------------------------------------------- §9.2 the premise is real
r = await exec('choose_option', { ref: ccRef, option: 'India (+91)' });
check('choose_option FAILS on the mousedown-only, portalled dropdown — V7 has a reason to exist',
  !r.ok && /no dropdown options appeared/i.test(r.error || ''), (r.error || r.result || '').slice(0, 110));
const portalAfterRecipe = await page.evaluate(() => document.getElementById('portal').style.display);
check('...because .click() on a native button emits no mouse events, so it never even opened',
  portalAfterRecipe !== 'block', `portal display="${portalAfterRecipe}"`);

r = await exec('choose_option', { ref: kbRef, option: 'Hyderabad' });
check('...and it fails on the keyboard-only combobox too',
  !r.ok, (r.error || r.result || '').slice(0, 110));
const kbAfterFail = await page.evaluate(() => document.getElementById('kb-input').value);
check('...leaving no probe text stranded in it', kbAfterFail === '', `"${kbAfterFail}"`);

// Open it the way the widget actually wants, then look again.
r = await act([{ op: 'click', ref: ccRef }]);
const portalAfterDomAct = await page.evaluate(() => document.getElementById('portal').style.display);
check('THE POINT: dom_act click opens the widget that .click() could not',
  r.ok && portalAfterDomAct === 'block', (r.result || r.error || '').slice(0, 90));

r = await exec('inspect_dom', { ref: ccRef });
const inspectOpen = r.result || '';
check('§9.3 inspect_dom surfaces the PORTALLED option list under OPEN LAYERS',
  r.ok && /OPEN LAYERS/.test(inspectOpen) && /India \(\+91\)/.test(inspectOpen),
  (inspectOpen.split('\n').find((l) => /India/.test(l)) || '').slice(0, 100));

const optRef = (() => {
  const line = inspectOpen.split('\n').find((l) => /India \(\+91\)/.test(l) && /\[e\d+\]/.test(l));
  const m = line && line.match(/\[(e\d+)\]/);
  return m ? m[1] : null;
})();
check('...and every option comes back with a WORKING ref, not just a description',
  Boolean(optRef), String(optRef));

r = await exec('inspect_dom', { selector: '#src-trigger' });
check('§9.3 a control that DECLARES its list resolves it under RELATED',
  r.ok && /RELATED/.test(r.result) && /aria-controls="src-list"/.test(r.result) && /Job Board/.test(r.result),
  (r.result || r.error || '').slice(0, 90));

// ------------------------------------------------- §9.4 dom_act drives it home
r = await act([
  { op: 'click', ref: optRef },
  { op: 'read', selector: '#cc-value' },
]);
check('§9.4 dom_act operates the control end to end',
  r.ok && /India \(\+91\)/.test(r.result || ''), (r.result || r.error || '').replace(/\n/g, ' | ').slice(0, 120));
const ccLanded = await page.evaluate(() => document.getElementById('cc-value').textContent);
check('...and the value REALLY lands (verification is not vibes)',
  ccLanded === 'India (+91)', ccLanded);

// The same thing as one sequence, from scratch — the shape the model will actually use.
await page.evaluate(() => { document.getElementById('cc-value').textContent = 'Select One'; });
r = await act([
  { op: 'click', selector: '#cc-trigger' },
  { op: 'wait_for', selector: '#portal .opt', timeout: 3 },
  { op: 'click', selector: '#portal .opt:nth-child(3)' },
  { op: 'read', selector: '#cc-value' },
]);
const ccSecond = await page.evaluate(() => document.getElementById('cc-value').textContent);
check('a whole open→wait→pick→verify sequence works in ONE call',
  r.ok && ccSecond === 'Germany (+49)', `${ccSecond} | ${(r.result || r.error || '').replace(/\n/g, ' | ').slice(0, 90)}`);

// ---------------------------------------------------- §9.5 keyboard-only combobox
r = await act([
  { op: 'focus', ref: kbRef },
  { op: 'key', ref: kbRef, key: 'ArrowDown', times: 2 },
  { op: 'key', ref: kbRef, key: 'Enter' },
  { op: 'read', ref: kbRef },
]);
const kbLanded = await page.evaluate(() => document.getElementById('kb-input').value);
check('§9.5 a keyboard-only combobox is driven with ArrowDown ×2 + Enter',
  r.ok && kbLanded === 'Hyderabad', `value="${kbLanded}" | ${(r.error || '').slice(0, 80)}`);

// ------------------------------------------------------------ §9.6 credentials
r = await act([{ op: 'type', selector: '#pw', value: 'hunter2', commit: true }]);
const pwValue = await page.evaluate(() => document.getElementById('pw').value);
check('§9.6 dom_act REFUSES to type into a password field',
  !r.ok && /request_secret/.test(r.error || ''), (r.error || '').slice(0, 100));
check('...and nothing was typed', pwValue === '', `"${pwValue}"`);
check('...and it says nothing was performed, so the model knows the page is untouched',
  /Nothing was performed/.test(r.error || ''), (r.error || '').slice(-60));

// ------------------------------------------------ §9.7 only what a human can touch
r = await act([{ op: 'type', selector: '#hp', value: 'bot was here' }]);
const hpValue = await page.evaluate(() => window.__honeypotFilled());
check('§9.7 an acting op refuses an off-screen honeypot',
  !r.ok && /not visible to a user/.test(r.error || ''), (r.error || '').slice(0, 100));
check('...and the honeypot stays empty', hpValue === '', `"${hpValue}"`);

r = await act([{ op: 'click', selector: '#aria-hidden-name' }]);
check('...and an aria-hidden control is refused too',
  !r.ok && /not visible to a user/.test(r.error || ''), (r.error || '').slice(0, 90));

r = await act([{ op: 'read', selector: '#hp' }]);
check('...but read may still LOOK at it, and says it is not visible (looking is not touching)',
  r.ok && /not visible/.test(r.result || ''), (r.result || r.error || '').replace(/\n/g, ' ').slice(0, 100));

// ------------------------------------------------- §9.8 a stopped sequence is honest
await page.evaluate(() => { document.getElementById('cc-value').textContent = 'Select One'; });
r = await act([
  { op: 'click', selector: '#cc-trigger' },
  { op: 'wait_for', selector: '#nothing-like-this', timeout: 1 },
  { op: 'click', selector: '#portal .opt' },
]);
check('§9.8 a sequence that fails midway names the action that stopped it',
  !r.ok && /Stopped at action 2 \(wait_for\)/.test(r.error || ''), (r.error || '').split('\n')[0].slice(0, 110));
check('...and reports the actions that ALREADY ran — their effects are on the page',
  /Actions that DID run/.test(r.error || '') && /1\. click:/.test(r.error || ''),
  (r.error || '').split('\n').slice(1).join(' | ').slice(0, 110));
const portalStillOpen = await page.evaluate(() => document.getElementById('portal').style.display);
check('...and that report is TRUE — the dropdown really is left open',
  portalStillOpen === 'block', portalStillOpen);

r = await act([{ op: 'click', selector: '#no-such-element' }]);
check('§9.8 a FIRST-action miss raises the frame sentinel, so the panel may retry another frame',
  !r.ok && /^NO_TARGET_IN_FRAME: /.test(r.error || ''), (r.error || '').slice(0, 90));

// ------------------------------------------------------- §9.9 ambiguity is failure
r = await act([{ op: 'click', selector: '#portal .opt' }]);
check('§9.9 an ambiguous selector fails and lists what it matched, instead of picking one',
  !r.ok && /matches 3 visible elements/.test(r.error || '') && /India/.test(r.error || ''),
  (r.error || '').slice(0, 130));
const ccUntouched = await page.evaluate(() => document.getElementById('cc-value').textContent);
check('...and nothing was chosen', ccUntouched === 'Select One', ccUntouched);

// ------------------------------------------------------------------ housekeeping
r = await act([{ op: 'wiggle', selector: '#notes' }]);
check('an unknown op is refused with the list of real ones',
  !r.ok && /unknown op/.test(r.error || '') && /scroll_into_view/.test(r.error || ''), (r.error || '').slice(0, 100));

r = await act(Array.from({ length: 13 }, () => ({ op: 'read', selector: 'body' })));
check('the 12-action cap is enforced in the page, not just in the panel',
  !r.ok && /at most 12 actions/.test(r.error || ''), (r.error || '').slice(0, 90));

r = await act([{ op: 'type', ref: kbRef, value: 'x', clear: true }, { op: 'key', ref: kbRef, key: 'Escape' }]);
check('type + key compose on an ordinary field', r.ok, (r.result || r.error || '').replace(/\n/g, ' | ').slice(0, 90));

r = await exec('inspect_dom', {});
check('inspect_dom with no target says what it needs',
  !r.ok && /needs \{ref\} or \{selector\}/.test(r.error || ''), (r.error || '').slice(0, 80));

// ============================================ §7 shadow DOM (web components)
const inv2 = (await exec('read_page')).result;
const shadowRef = refOf(inv2, /Preferred Name/i);
check('§7 read_page sees a field inside an OPEN shadow root at all',
  Boolean(shadowRef), (inv2.split('\n').find((l) => /Preferred Name/i.test(l)) || '(absent)').slice(0, 90));
check('...with its label resolved INSIDE that root, not from the outer document',
  /label="Preferred Name\*"/.test(inv2),
  (inv2.split('\n').find((l) => /Preferred Name/i.test(l)) || '').slice(0, 90));

r = await exec('fill', { ref: shadowRef, value: 'Janey' });
check('...and fill lands in it through an ordinary ref',
  r.ok && (await page.evaluate(() => window.__shadow('#inner'))) === 'Janey',
  (r.result || r.error || '').slice(0, 80));

r = await exec('inspect_dom', { selector: '#inner-btn' });
check('§7 inspect_dom resolves a selector across the shadow boundary',
  r.ok && /Verify/.test(r.result || ''), (r.result || r.error || '').split('\n')[1] || '');
check('...and warns that outer-document selectors will not reach it',
  /inside a shadow root/.test(r.result || ''));

r = await act([{ op: 'click', selector: '#inner-btn' }]);
const shadowStatus = await page.evaluate(() => window.__shadow('#inner-status'));
check('§7 dom_act drives a control inside the shadow root',
  r.ok && shadowStatus === 'verified:Janey', `status="${shadowStatus}"`);

// ================================== §8 a click that would land somewhere else
r = await act([{ op: 'click', selector: '#show-cookie' }]);
check('the cookie banner is up', r.ok, (r.error || '').slice(0, 80));

const inv3 = (await exec('read_page')).result;
const submitRef = refOf(inv3, /Submit application/i);
check('read_page still reports the covered submit button as perfectly normal',
  Boolean(submitRef), `${submitRef}`);

r = await exec('click', { ref: submitRef });
const submitStatus = await page.evaluate(() => document.getElementById('submit-status').textContent);
check('§8 click REFUSES to fire when a banner is covering the target',
  !r.ok && /would land on/.test(r.error || ''), (r.error || r.result || '').slice(0, 120));
check('...and names what is in the way, so the model can deal with it',
  /cookie-bar|cookies to make this form worse/.test(r.error || ''), (r.error || '').slice(-90));
check('...and the page was NOT submitted — this is the silent success V7 §8 kills',
  submitStatus === '', `status="${submitStatus}"`);

r = await exec('inspect_dom', { ref: submitRef });
check('§8 inspect_dom reports the obstruction BEFORE a click is attempted',
  r.ok && /COVERED BY/.test(r.result || ''),
  (r.result || '').split('\n').find((l) => /COVERED BY/.test(l)) || '(absent)');

r = await act([{ op: 'click', selector: '#cookie-accept' }, { op: 'wait_for', selector: '#cookie-bar', state: 'gone', timeout: 2 }]);
check('the banner can be dismissed the ordinary way', r.ok, (r.error || '').slice(0, 90));

r = await exec('click', { ref: submitRef });
const submitStatus2 = await page.evaluate(() => document.getElementById('submit-status').textContent);
check('§8 THE POINT: with the banner gone the same click goes through',
  r.ok && submitStatus2 === 'submitted', `status="${submitStatus2}" | ${(r.result || r.error || '').slice(0, 70)}`);

check('no page errors across the whole harness', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILING` : '\nall DOM-access checks passed');
process.exit(fail ? 1 : 0);
