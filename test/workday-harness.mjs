// CONTRACT-V5 — the REAL content script against a faithful Workday reproduction,
// in a real Chromium. Every check here is a bug the user actually hit.
import { chromium } from 'playwright';

// Repo root, so the harness runs from anywhere: `node test/workday-harness.mjs`
// (needs Playwright: `npx playwright install chromium`).
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

await page.goto(`file://${ROOT}/test/mock-workday.html`);
await page.addScriptTag({ path: `${ROOT}/content/content-script.js` });

const exec = (tool, args = {}) => page.evaluate(([t, a]) => window.__exec(t, a), [tool, args]);
const refOf = (inv, re) => {
  const line = inv.split('\n').find((l) => re.test(l));
  const m = line && line.match(/^\[(e\d+)\]/);
  return m ? m[1] : null;
};
const lineOf = (inv, re) => inv.split('\n').find((l) => re.test(l)) || '';

// ------------------------------------------------------- read_page (§1)
let r;
let inv = (await exec('read_page')).result;

const sourceLine = lineOf(inv, /How Did You Hear About Us/i);
check('the multiselect search box is reported as a DROPDOWN, not a text input',
  /^\[e\d+\] dropdown /.test(sourceLine) && /use choose_option/.test(sourceLine),
  sourceLine.slice(0, 110));

const countryLine = lineOf(inv, /label="Country\*"/i);
check('the <button aria-haspopup=listbox> prompt is reported as a dropdown holding its value',
  /^\[e\d+\] dropdown /.test(countryLine) && /value="India"/.test(countryLine), countryLine.slice(0, 110));

const stateLine = lineOf(inv, /label="State"/i);
check('an unset prompt reports an EMPTY value, not the "Select One" placeholder',
  /value=""/.test(stateLine), stateLine.slice(0, 90));

const codeLine = lineOf(inv, /Country Phone Code/i);
check('a multiselect reports the value its PILLS hold (the search box is always empty)',
  /value="India \(\+91\)"/.test(codeLine), codeLine.slice(0, 110));

check('the hidden value-mirror input next to each prompt is not shown to the model',
  !/value="c4f78be1"/.test(inv));
check('...even when a validation icon sits between the button and its mirror',
  !/state-internal-id-9f2b/.test(inv),
  (inv.split('\n').find((l) => /state-internal-id/.test(l)) || '').slice(0, 80));

// isSecretEl matches "verification" as a bare substring. A dropdown it flags must
// still get a ref — dropping it would strand a required field with no way to act.
const verifyLine = lineOf(inv, /verify your identity/i);
const verifyRef = refOf(inv, /verify your identity/i);
check('a dropdown flagged credential-ish by substring still gets a ref (not dropped)',
  Boolean(verifyRef) && /dropdown/.test(verifyLine), verifyLine.slice(0, 100));
r = await exec('choose_option', { ref: verifyRef, option: 'Email' });
check('...and choose_option can still operate it — a button prompt cannot be typed into',
  r.ok && /Chose "Email"/.test(r.result), (r.result || r.error || '').slice(0, 100));

// -------------------------------------------------------------- fill (§2)
const sourceRef = refOf(inv, /How Did You Hear About Us/i);
r = await exec('fill', { ref: sourceRef, value: 'Autodesk Careers' });
check('fill REFUSES a Workday prompt instead of typing into its search box',
  !r.ok && /choose_option/.test(r.error), (r.error || '').slice(0, 100));
const sourceBoxValue = await page.evaluate(() => document.getElementById('source--source').value);
check('...and leaves the search box untouched', sourceBoxValue === '', `"${sourceBoxValue}"`);

const countryRef = refOf(inv, /label="Country\*"/i);
r = await exec('fill', { ref: countryRef, value: 'India' });
check('fill also refuses the button-style prompt', !r.ok && /choose_option/.test(r.error));

// ----------------------------------------------- choose_option (§3)
// Hierarchical: the first list shows CATEGORIES; only typing reveals the leaf.
r = await exec('choose_option', { ref: sourceRef, option: 'Autodesk Careers' });
check('choose_option drills through a hierarchical prompt to the leaf in ONE call',
  r.ok && /Chose "Autodesk Careers"/.test(r.result), (r.result || r.error || '').slice(0, 120));
const sourcePills = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-automation-id=formField-source] [data-automation-id=selectedItem]'))
    .map((p) => p.getAttribute('title')));
check('...and the value really lands as a pill (§7.1 verification is real)',
  sourcePills.join() === 'Autodesk Careers', JSON.stringify(sourcePills));
const searchLeftover = await page.evaluate(() => document.getElementById('source--source').value);
check('...leaving no probe text stranded in the search box', searchLeftover === '', `"${searchLeftover}"`);

// The single-select popup is a PORTAL at the end of <body> with role=option items.
const phoneTypeRef = refOf(inv, /Phone Device Type/i);
r = await exec('choose_option', { ref: phoneTypeRef, option: 'Mobile' });
check('choose_option handles the portal-rendered single-select popup',
  r.ok && /Chose "Mobile"/.test(r.result), (r.result || r.error || '').slice(0, 120));
const phoneTypeText = await page.evaluate(() => document.getElementById('phoneNumber--phoneType').textContent);
check('...and the button now displays the choice', phoneTypeText === 'Mobile', phoneTypeText);

// THE PILL TRAP: the chosen values are role=option too. Re-choosing must not
// click a pill, and must not toggle the value off.
const codeRef = refOf(inv, /Country Phone Code/i);
r = await exec('choose_option', { ref: codeRef, option: 'India (+91)' });
check('re-choosing an already-selected value is a no-op, not a silent DESELECT',
  r.ok && /already holds/.test(r.result), (r.result || r.error || '').slice(0, 110));
const codePills = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-automation-id=formField-countryPhoneCode] [data-automation-id=selectedItem]'))
    .map((p) => p.getAttribute('title')));
check('...the pill survives', codePills.join() === 'India (+91)', JSON.stringify(codePills));

// The subtle one: the pill reads "India (+91)" but the agent asks for "India".
// A containment check misses that, the option list offers "India (+91)", and
// clicking it DESELECTS the value the user already had.
r = await exec('choose_option', { ref: codeRef, option: 'India' });
const codePillsAfterPartial = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-automation-id=formField-countryPhoneCode] [data-automation-id=selectedItem]'))
    .map((p) => p.getAttribute('title')));
check('choosing "India" when the pill reads "India (+91)" does NOT toggle the value off',
  r.ok && /already holds/.test(r.result) && codePillsAfterPartial.join() === 'India (+91)',
  `${(r.result || r.error || '').slice(0, 80)} | pills=${JSON.stringify(codePillsAfterPartial)}`);

// A pick that does NOT land must never be vouched for by a pre-existing pill that
// merely contains the label: "Guinea-Bissau" is already chosen, "Guinea" is not.
const citizenRef = refOf(inv, /Country of Citizenship/i);
r = await exec('choose_option', { ref: citizenRef, option: 'Guinea' });
check('a pick that never registers is NOT vouched for by a pill that contains its label',
  r.ok && /may not have registered/.test(r.result) && !/^Chose/.test(r.result),
  (r.result || r.error || '').slice(0, 130));
const citizenPills = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-automation-id=formField-citizenship] [data-automation-id=selectedItem]'))
    .map((p) => p.getAttribute('title')));
check('...and the untouched field still holds only what it held',
  citizenPills.join() === 'Guinea-Bissau', JSON.stringify(citizenPills));

// A no-match must list what it saw, not the pills.
r = await exec('choose_option', { ref: phoneTypeRef, option: 'Carrier Pigeon' });
check('a no-match lists the real options',
  !r.ok && /Options seen/.test(r.error) && /"Home"/.test(r.error), (r.error || '').slice(0, 120));

// ---------------------------------------------------------- autofill (§4)
const fields = {
  firstName: 'Jane', lastName: 'Doe', fullName: 'Jane Doe',
  email: 'jane@example.com', phone: '5550109999', location: 'Bengaluru, India',
  linkedin: 'https://linkedin.com/in/jane',
};
r = await exec('autofill', { fields });
const vals = await page.evaluate(() => ({
  first: document.getElementById('name--legalName--firstName').value,
  middle: document.getElementById('name--legalName--middleName').value,
  last: document.getElementById('name--legalName--lastName').value,
  city: document.getElementById('address--city').value,
  phone: document.getElementById('phoneNumber--phoneNumber').value,
  ext: document.getElementById('phoneNumber--extension').value,
  codeSearch: document.getElementById('phoneNumber--countryPhoneCode').value,
  sourceSearch: document.getElementById('source--source').value,
}));
check('autofill maps Workday\'s "Given Name(s)" / "Family Name"',
  vals.first === 'Jane' && vals.last === 'Doe', JSON.stringify(vals));
check('the phone number does NOT land in the Country Phone Code search box',
  vals.codeSearch === '', `"${vals.codeSearch}"`);
check('...nor in any other prompt search box', vals.sourceSearch === '', `"${vals.sourceSearch}"`);
check('the phone number lands in Phone Number, not Phone Extension',
  vals.phone === '5550109999' && vals.ext === '', JSON.stringify({ phone: vals.phone, ext: vals.ext }));
check('"Middle Name" is not mistaken for the full-name field ("legalName" is in every name id)',
  vals.middle === '', `"${vals.middle}"`);
check('a "Bengaluru, India" location fills City with "Bengaluru"',
  vals.city === 'Bengaluru', `"${vals.city}"`);

// ------------------------------------------- commit-on-blur + errors (§5)
inv = (await exec('read_page')).result;
const addr1Ref = refOf(inv, /label="Address Line 1\*"/i);
const postalRef = refOf(inv, /label="Postal Code\*"/i);
const submitRef = refOf(inv, /button "Save and Continue"/i);
check('found the remaining refs', Boolean(addr1Ref && postalRef && submitRef),
  `${addr1Ref} ${postalRef} ${submitRef}`);

// First, prove the trap the user reported is REAL in this reproduction: a value
// written without losing focus is discarded by Workday, however good it looks.
await page.evaluate(() => {
  const el = document.getElementById('address--postalCode');
  el.focus();
  el.value = '560001';                                        // naive automation:
  el.dispatchEvent(new Event('input', { bubbles: true }));    // set + input, no blur
});
r = await exec('click', { ref: submitRef });
check('a value typed WITHOUT focus loss is rejected by Workday (the reported bug)',
  r.ok && /New validation errors:/.test(r.result), (r.result || '').slice(0, 120));
const postalShowsButFails = await page.evaluate(() => ({
  looksFilled: document.getElementById('address--postalCode').value,
  stillErrors: document.querySelectorAll('[data-automation-id=errorMessage]').length,
}));
check('...even though the box visibly reads "560001" — this is why it felt broken',
  postalShowsButFails.looksFilled === '560001' && postalShowsButFails.stillErrors > 0,
  JSON.stringify(postalShowsButFails));

const errs = await exec('read_errors');
check('read_errors sees Workday errors despite the emotion class names',
  errs.ok && /required/i.test(errs.result), (errs.result || '').slice(0, 90));

// Now do it JobPilot's way and require the form to actually pass.
r = await exec('fill', { ref: addr1Ref, value: '12 MG Road' });
check('fill lands Address Line 1', r.ok && /Filled/.test(r.result), (r.result || r.error || '').slice(0, 80));

// The gesture, not just the end state. "Focus evaporated" (el.blur(): focusout with a
// null relatedTarget and no focusin after it) and "the user clicked outside" (focus
// LANDS somewhere, so a focusin follows) leave an identical activeElement behind, and a
// widget that waits for focus to arrive somewhere can tell them apart when we cannot.
// A real click outside also fires `change` AFTER the focus loss, never during typing.
await page.evaluate(() => { window.__events = []; });
r = await exec('fill', { ref: postalRef, value: '560001' });
check('fill lands Postal Code', r.ok && /Filled/.test(r.result), (r.result || r.error || '').slice(0, 80));

const tape = await page.evaluate(() => window.__events);
const seq = tape.map((e) => e.type);
const outAt = seq.indexOf('focusout');
check('THE POINT: fill loses focus the way a click outside does — focus LANDS somewhere',
  outAt >= 0 && seq.indexOf('focusin', outAt) > outAt,
  seq.join(' → '));
check('...focus goes to the body, so focusout carries a real relatedTarget (not null)',
  tape.some((e) => e.type === 'focusout' && e.related === 'body'),
  JSON.stringify(tape.find((e) => e.type === 'focusout') || null));
check('...and `change` arrives AFTER the focus loss, where a browser really fires it',
  seq.lastIndexOf('change') > outAt && outAt >= 0, seq.join(' → '));

r = await exec('click', { ref: submitRef });
check('THE POINT: a Workday page filled by JobPilot passes validation — no new errors',
  r.ok && !/New validation errors/.test(r.result), (r.result || '').slice(0, 140));
const finalErrs = await exec('read_errors');
check('...and the page reports no errors at all',
  finalErrs.ok && /No visible errors/.test(finalErrs.result),
  (finalErrs.result || '').replace(/\n/g, ' | ').slice(0, 160));

// ------------------------------------------------- postal address autofill
// The address used to be one ask_user per line, on every single application: the
// profile had a one-line `location` and nothing else. On a fresh page, because
// autofill never overwrites and the pass above already committed half of these.
await page.goto(`file://${ROOT}/test/mock-workday.html`);
await page.addScriptTag({ path: `${ROOT}/content/content-script.js` });
await page.evaluate(() => { document.getElementById('phoneNumber--phoneNumber').value = '5550109999'; });

r = await exec('autofill', {
  fields: {
    addressLine1: '221B Baker Street', addressLine2: 'Flat 2',
    city: 'Bengaluru', state: 'Karnataka', postalCode: '560001',
    country: 'India', location: 'Bengaluru, India',
    phone: '5559999999', // the box is already filled — autofill must not touch it
  },
});
const addr = await page.evaluate(() => ({
  line1: document.getElementById('address--addressLine1').value,
  city: document.getElementById('address--city').value,
  postal: document.getElementById('address--postalCode').value,
  phone: document.getElementById('phoneNumber--phoneNumber').value,
  codeSearch: document.getElementById('phoneNumber--countryPhoneCode').value,
  sourceSearch: document.getElementById('source--source').value,
}));
check('autofill fills Address Line 1 from the profile',
  addr.line1 === '221B Baker Street', `"${addr.line1}"`);
check('...and Postal Code', addr.postal === '560001', `"${addr.postal}"`);
check('...and City from the city field, not by splitting the location',
  addr.city === 'Bengaluru', `"${addr.city}"`);
check('the country and state do NOT land in a prompt search box',
  addr.codeSearch === '' && addr.sourceSearch === '',
  JSON.stringify({ code: addr.codeSearch, source: addr.sourceSearch }));
check('an already-filled field is still left alone', addr.phone === '5550109999', `"${addr.phone}"`);

check('no page errors across the whole run', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
console.log(fail ? `\n${fail} FAILING` : '\nall Workday checks passed');
process.exit(fail ? 1 : 0);
