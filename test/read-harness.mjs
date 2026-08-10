// CONTRACT-V8 — find, scoped reads, and diffs, against a page too big for one read.
// Each check is a rung of §6's Definition of Done. The ones that matter most are §6.6
// and §6.11: their failure mode is not an error, it is a confident wrong answer.
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

await page.goto(`file://${ROOT}/test/mock-long.html`);
await page.addScriptTag({ path: `${ROOT}/content/content-script.js` });

const exec = (tool, args = {}) => page.evaluate(([t, a]) => window.__exec(t, a), [tool, args]);
// The first line that both matches AND carries a ref — a heading like
// `FOUND 1 match for "Referral code"` matches the regex but has no ref on it.
const refOf = (text, re) => {
  const line = text.split('\n').find((l) => re.test(l) && /\[e\d+\]/.test(l));
  const m = line && line.match(/\[(e\d+)\]/);
  return m ? m[1] : null;
};
const valueOf = (id) => page.evaluate((i) => document.getElementById(i).value, id);

let r;

// ------------------------------------------------- §6.10 changes with no baseline
r = await exec('read_page', { mode: 'changes' });
check('§6.10 changes with no baseline does a FULL read and says so',
  r.ok && /No previous read_page in this frame/.test(r.result) && /ELEMENTS:/.test(r.result),
  (r.result || r.error || '').split('\n')[0].slice(0, 90));

// ------------------------------------------------------ §6.2 the premise is real
const full = (await exec('read_page')).result;
check('§6.2 read_page truncates on a long page',
  /\[truncated\]/.test(full) || /more links not shown/.test(full),
  `${full.split('\n').length} lines, ${full.length} chars`);
check('§6.2 ...and the last field is genuinely ABSENT from the inventory',
  !/Referral code/.test(full));

const firstRef = refOf(full, /label="First name"/);
const yearsRef = refOf(full, /label="Years of experience"/);
check('the fields before the filler are present', Boolean(firstRef && yearsRef), `${firstRef} ${yearsRef}`);

// --------------------------------------------------------------- §6.3 find it
r = await exec('find', { text: 'Referral code' });
check('§6.3 find locates the field read_page could not show',
  r.ok && /Referral code/.test(r.result), (r.result || r.error || '').split('\n')[1] || '');
const referralRef = refOf(r.result || '', /Referral code/);
check('...and hands back a usable ref', Boolean(referralRef), String(referralRef));

r = await exec('fill', { ref: referralRef, value: 'JOBPILOT-7' });
check('§6.3 ...and a fill through it lands in the right field',
  r.ok && (await valueOf('referral-code')) === 'JOBPILOT-7',
  (r.result || r.error || '').slice(0, 70));

// ------------------------------------------------------- §6.4 ranking and role
r = await exec('find', { text: 'Continue' });
const firstMatch = (r.result || '').split('\n')[1] || '';
check('§6.4 an exact name outranks a substring',
  r.ok && /"Continue"/.test(firstMatch) && !/Continue where/.test(firstMatch), firstMatch.slice(0, 80));

r = await exec('find', { text: 'Continue', role: 'button' });
check('§6.4 role filters out the same-named text field',
  r.ok && /button "Continue"/.test(r.result) && !/text input label="Continue"/.test(r.result),
  (r.result || '').split('\n').slice(1, 3).join(' | ').slice(0, 90));

r = await exec('find', { text: 'Continue', role: 'textbox' });
check('§6.4 ...and the other way round',
  r.ok && /text input label="Continue"/.test(r.result) && !/button "Continue"/.test(r.result),
  (r.result || '').split('\n')[1] || '');

r = await exec('find', { text: 'Notice', role: 'nonsense' });
check('an unknown role is refused with the list of real ones',
  !r.ok && /Unknown role/.test(r.error || '') && /dropdown/.test(r.error || ''), (r.error || '').slice(0, 80));

// -------------------------------------------------------------- §6.5 no match
r = await exec('find', { text: 'Blood type' });
check('§6.5 a no-match reports what it SEARCHED, not just that it failed',
  r.ok && /searched \d+ visible elements/.test(r.result), (r.result || '').slice(0, 100));
check('§6.5 ...and offers the names that are actually there',
  /Names that ARE here/.test(r.result || ''), (r.result || '').slice(-90));

// ------------------------------------------- §6.6 partial views must NOT renumber
r = await exec('find', { text: 'Referral' });
r = await exec('read_page', { within: refOf(full, /section|Personal/) || firstRef });
r = await exec('fill', { ref: firstRef, value: 'Jane' });
check('§6.6 THE ONE THAT MATTERS: a ref from the full read still points at the SAME field after find + a scoped read',
  r.ok && (await valueOf('first')) === 'Jane' && (await valueOf('email')) === '',
  `first="${await valueOf('first')}" email="${await valueOf('email')}" | ${(r.error || '').slice(0, 50)}`);

// ------------------------------------------------------------- §6.7 scoped read
r = await exec('find', { text: 'Experience' });
const sectionRef = refOf(r.result || '', /^\[e\d+\] section/);
check('find returns a SECTION ref to scope a read to', Boolean(sectionRef),
  (r.result || '').split('\n').find((l) => /section/.test(l)) || '(none)');

r = await exec('read_page', { within: sectionRef });
check('§6.7 a scoped read returns only that section',
  r.ok && /Years of experience/.test(r.result) && !/First name/.test(r.result) && !/Referral/.test(r.result),
  (r.result || r.error || '').split('\n').slice(0, 2).join(' | ').slice(0, 100));
check('§6.7 ...and says the earlier refs are still good',
  /still valid/.test(r.result || ''));

// -------------------------------------------------------------- §6.8/§6.11 diff
// The scoped read above sits between the full read and this diff on purpose: if a
// scoped read set the baseline, everything outside that section reports as GONE.
r = await exec('read_page', { mode: 'changes' });
check('§6.11 a scoped read did NOT become the diff baseline',
  r.ok && !/GONE/.test(r.result), (r.result || '').split('\n').slice(0, 2).join(' | ').slice(0, 100));
check('§6.8 changes right after a full read + one fill reports just that fill',
  r.ok && /CHANGED \(1\)/.test(r.result) && /First name/.test(r.result),
  (r.result || '').replace(/\n/g, ' | ').slice(0, 130));

r = await exec('read_page', { mode: 'changes' });
check('§6.8 ...and with nothing touched since, it reports no changes at all',
  r.ok && /^No changes since the last read/.test(r.result), (r.result || '').slice(0, 90));

// ------------------------------------------------- §6.9 new + changed + gone
const revealRef = refOf(full, /button "Reveal extra questions"/);
r = await exec('click', { ref: revealRef });
check('clicked the control that mutates the page three ways', r.ok, (r.result || r.error || '').slice(0, 70));

r = await exec('read_page', { mode: 'changes' });
const diff = r.result || '';
check('§6.9 changes reports the two NEW fields',
  /NEW \(2\)/.test(diff) && /Visa status/.test(diff) && /Willing to relocate/.test(diff),
  (diff.split('\n').find((l) => /NEW/.test(l)) || '') + ' | ' + (diff.split('\n').find((l) => /Visa/.test(l)) || '').slice(0, 60));
check('§6.9 ...the CHANGED value, with what it was before',
  /CHANGED \(1\)/.test(diff) && /Years of experience/.test(diff) && /\(was value=""\)/.test(diff),
  (diff.split('\n').find((l) => /Years/.test(l)) || '').slice(0, 110));
check('§6.9 ...and the button that is GONE',
  /GONE \(1\)/.test(diff) && /Discard draft/.test(diff),
  (diff.split('\n').find((l) => /Discard/.test(l)) || '').slice(0, 80));
// Inserting two fields near the top pushes two elements off the end of a 400-element
// inventory. Calling those GONE would tell the model a control was removed when it is
// still sitting on the page.
// The note names the cap as the LIKELY cause rather than asserting it: this bucket also
// catches an element that stopped matching DISCOVERY_SELECTOR or whose line threw. What it
// must never say is that the element was removed.
check('§6.9 ...while elements merely pushed past the cap are NOT reported as removed',
  /not listed this time/.test(diff) && /STILL on the page/.test(diff) && /400-element cap/.test(diff),
  (diff.split('\n').find((l) => /not listed this time/.test(l)) || '(absent)').slice(0, 130));
check('§6.9 an unchanged element KEEPS the ref the full read gave it',
  diff.includes(`[${yearsRef}]`), `expected ${yearsRef} in the changed line`);
check('§6.9 ...and the unchanged elements are counted, not repeated',
  /unchanged elements are NOT repeated/.test(diff) && !/First name/.test(diff) && !/Related role/.test(diff),
  `${diff.length} chars vs ${full.length} for a full read`);
check('§6.9 the diff is dramatically cheaper than re-reading',
  diff.length < full.length / 4, `${diff.length} vs ${full.length} chars`);

// The new fields must be actionable straight out of the diff.
const visaRef = refOf(diff, /Visa status/);
r = await exec('fill', { ref: visaRef, value: 'Citizen' });
check('§6.9 a NEW element is usable straight from the diff',
  r.ok && (await valueOf('visa')) === 'Citizen', (r.result || r.error || '').slice(0, 70));

// A dead ref must fail loudly, never silently hit something else.
const deadRef = refOf(full, /button "Discard draft"/);
r = await exec('click', { ref: deadRef });
check('a ref reported GONE is dead, and fails honestly rather than hitting something else',
  !r.ok && /Stale ref/.test(r.error || ''), (r.error || '').slice(0, 70));

// ------------------------------------------- CAPTCHA detection (ApplyPilot port)
// A captcha must be REPORTED, or a form that will not submit reads as anything but
// what it is. Visible widgets show in read_page too; the invisible kinds only in
// read_errors, where a dead submit gets investigated — an invisible v3 script on an
// ordinary page may never fire, and announcing it on every read is a false alarm.
r = await exec('read_errors');
check('a page with no captcha reports none', r.ok && !/CAPTCHA/.test(r.result),
  (r.result || '').slice(0, 60));

await page.evaluate(() => {
  const d = document.createElement('div');
  d.className = 'h-captcha';
  d.dataset.sitekey = 'k';
  d.id = 'cap-test';
  d.style.cssText = 'width:300px;height:78px;background:#eee';
  document.body.appendChild(d);
});
r = await exec('read_errors');
check('a visible hCaptcha is reported by read_errors',
  r.ok && /CAPTCHA on this page: hCaptcha/.test(r.result) && /USER's to solve/.test(r.result),
  (r.result || '').split('\n').find((l) => /CAPTCHA/.test(l)) || '(absent)');
r = await exec('read_page');
check('...and by a full read_page, in its ERRORS block',
  r.ok && /CAPTCHA on this page: hCaptcha/.test(r.result));

await page.evaluate(() => {
  document.getElementById('cap-test').remove();
  const s = document.createElement('script');
  s.src = 'https://www.google.com/recaptcha/api.js?render=sitekey123';
  document.head.appendChild(s);
});
r = await exec('read_errors');
check('an invisible reCAPTCHA v3 (script only) surfaces in read_errors',
  r.ok && /reCAPTCHA v3 \(invisible/.test(r.result) && /block a submit with no error/.test(r.result),
  (r.result || '').split('\n').find((l) => /CAPTCHA/.test(l)) || '(absent)');
r = await exec('read_page');
check('THE POINT: but an ordinary read_page stays quiet about it — it may never fire',
  r.ok && !/CAPTCHA/.test(r.result));

// The v3 badge (bottom-corner "protected by reCAPTCHA") is a VISIBLE iframe matching
// src*="recaptcha" — but it is telemetry, not a challenge. It must classify as
// invisible v3, never as a widget the user is asked to "solve".
await page.evaluate(() => {
  document.querySelector('script[src*="recaptcha"]').remove();
  const badge = document.createElement('div');
  badge.className = 'grecaptcha-badge';
  badge.style.cssText = 'width:256px;height:60px;position:fixed;right:0;bottom:14px';
  const f = document.createElement('iframe');
  f.src = 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=sitekey123&size=invisible';
  f.style.cssText = 'width:256px;height:60px;border:0';
  badge.appendChild(f);
  document.body.appendChild(badge);
});
r = await exec('read_errors');
check('the v3 badge classifies as invisible v3, not as a solvable widget',
  r.ok && /reCAPTCHA v3 \(invisible/.test(r.result) && !/on this page: reCAPTCHA\. /.test(r.result),
  (r.result || '').split('\n').find((l) => /CAPTCHA/.test(l)) || '(absent)');
r = await exec('read_page');
check('...and read_page stays quiet about the badge too',
  r.ok && !/CAPTCHA/.test(r.result));

// A captcha widget is not a tracked form control, so a challenge appearing mid-run
// (Workday does this between wizard steps) would otherwise vanish into "No changes
// since the last read." — the model then re-clicks submit forever.
await page.evaluate(() => document.querySelector('.grecaptcha-badge').remove());
r = await exec('read_page'); // baseline for the diff
await page.evaluate(() => {
  const d = document.createElement('div');
  d.className = 'h-captcha';
  d.dataset.sitekey = 'k';
  d.style.cssText = 'width:300px;height:78px;background:#eee';
  document.body.appendChild(d);
});
r = await exec('read_page', { mode: 'changes' });
check('a captcha that APPEARS between reads shows up in mode:"changes"',
  r.ok && /CAPTCHA on this page: hCaptcha/.test(r.result),
  (r.result || '').split('\n').find((l) => /CAPTCHA|No changes/.test(l)) || '(absent)');

check('no page errors across the whole harness', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILING` : '\nall read/find checks passed');
process.exit(fail ? 1 : 0);
