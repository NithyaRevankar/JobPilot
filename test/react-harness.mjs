// react-harness.mjs — the side panel itself.
//
// WHY THIS EXISTS. The React migration moved ~6,000 lines of behaviour out of
// sidepanel/js/panel.js and into sidepanel/react/, and not one of the other harnesses
// imports a single file from there. They cover the content script, the background worker,
// doctext, and the logic layer that the migration deliberately did NOT touch — so after
// the port, the code that could break was exactly the code nothing tested.
//
// It runs in two halves, for two different reasons:
//
//   PART 1 (node, no browser) drives ../sidepanel/react/modal-queue.js directly. That file
//   has no React in it precisely so this is possible. The queue is what a stopped run's
//   pending `await` resolves through — get its FIFO order or its settle-once rule wrong and
//   the agent hangs forever with no error — and it is pure state, so it deserves unit tests
//   rather than a browser.
//
//   PART 2 (playwright) builds dist/ and loads the REAL panel over http with a stubbed
//   `chrome`. Not jsdom and not a component harness: the things worth testing here are the
//   ones that only exist once React, the store, chrome.storage and panel.css are all in the
//   same page — a debounced write racing a keystroke, a restored transcript rendering
//   hostile text, a dialog's Enter key.
//
// Every check below is a bug that was found by reading the code, so each one fails against
// the version before it was fixed. Where that is the whole point, the comment says so.
//
// Run: node test/react-harness.mjs   (builds dist/ itself; no prior `npm run build` needed)

import http from 'node:http';
import fs from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { build } from 'vite';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');

let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

// ===========================================================================
// PART 1 — the modal queue, with no browser in sight
// ===========================================================================

const mq = await import('../sidepanel/react/modal-queue.js');

{
  // A job is only observable through getActive() and its promise, which is exactly the
  // surface ModalHost and agent.js each see.
  const seen = [];
  const stop = mq.subscribe(() => seen.push(mq.getActive()));

  const first = mq.openAsk({ title: 'one' });
  check('openAsk makes a job active immediately',
    mq.isModalOpen() && mq.getActive().spec.title === 'one');
  check('...and notifies subscribers, so <ModalHost/> can render it', seen.length === 1);

  const second = mq.openAsk({ title: 'two' });
  const third = mq.openConfirm({ title: 'three' });
  check('THE FIFO RULE: a second prompt does not replace the first, it waits',
    mq.getActive().spec.title === 'one', mq.getActive().spec.title);

  mq.settle(mq.getActive(), { action: 'submit', values: { a: '1' }, save: false });
  check('settling the head promotes the NEXT one, in order',
    mq.getActive().spec.title === 'two', mq.getActive().spec.title);
  check('...and the first caller gets its own value back',
    (await first).values.a === '1');

  // Stop (ChatView.handleStop) calls this so that every awaiting agent callback settles.
  // A queued job left unresolved is a run that never ends and never reports why.
  mq.closeAllModals();
  check('THE POINT OF closeAllModals: the OPEN modal resolves null', (await second) === null);
  check('...and so does every QUEUED one — a run must not hang on a prompt nobody saw',
    (await third) === null);
  check('...and nothing is left active afterwards', !mq.isModalOpen() && mq.getActive() === null);

  // Double-settle is reachable for real: a click on Submit and closeAllModals() from Stop
  // can land in the same turn. The second must be a no-op, not a second resolve.
  const fourth = mq.openConfirm({ title: 'four' });
  const job = mq.getActive();
  mq.settle(job, true);
  mq.settle(job, false);
  check('a job settles exactly once — a late Stop cannot overwrite the answer',
    (await fourth) === true);

  stop();
  check('unsubscribing stops the notifications', (() => {
    const before = seen.length;
    mq.openAsk({ title: 'five' });
    mq.closeAllModals();
    return seen.length === before;
  })());

  // ---- Stop belongs to ONE run.
  //
  // closeAllModals was right while a panel could only have one run: every dialog on screen
  // belonged to the run being stopped. With several applications going it is actively
  // wrong — the stopped run would answer `null` to the question a DIFFERENT run is blocked
  // on, and that run reads null as "the user declined" and abandons a half-filled form.
  const mine = mq.openAsk({ title: 'my question' }, 'run-A');
  const theirs = mq.openAsk({ title: 'their question' }, 'run-B');
  const shared = mq.openConfirm({ title: 'unlock the vault' }); // panel-wide, nobody's run

  mq.closeModalsFor('run-A');
  check('THE POINT OF closeModalsFor: stopping one run cancels ITS dialog',
    (await mine) === null);
  check('...and leaves the other run\'s question standing, because answering it null would ' +
    'read as "the user declined" and abandon a form that run was halfway through',
    mq.getActive() !== null && mq.getActive().spec.title === 'their question',
    mq.getActive() ? mq.getActive().spec.title : '(none)');

  mq.closeModalsFor('run-B');
  check('...and the run that owns it can still cancel its own', (await theirs) === null);
  check('an unowned, panel-wide dialog survives a run being stopped',
    mq.getActive() !== null && mq.getActive().spec.title === 'unlock the vault',
    mq.getActive() ? mq.getActive().spec.title : '(none)');

  mq.closeModalsFor(null);
  check('closeModalsFor with no owner is a no-op — it must not become closeAllModals by ' +
    'accident', mq.getActive() !== null);

  mq.closeAllModals();
  check('...while panel teardown still takes everything down', (await shared) === null);
}

{
  // What collect() hands the caller. The checklist encoding is the one nothing else in the
  // app would guess — onRequestDemo parses it back with .split(',').map(Number) to decide
  // which recorded steps get saved, so "which indices are ticked" is load-bearing.
  const fields = [
    { name: 'name', type: 'text', value: 'Acme' },
    { name: 'keep', type: 'checklist', items: [{ label: 'a' }, { label: 'b', checked: false }, { label: 'c' }] },
    { name: 'pick', type: 'choice', options: ['x', 'y'] },
  ];
  const values = mq.initialValues(fields);
  check('a checklist starts ticked unless an item says otherwise',
    JSON.stringify(values.keep) === '[true,false,true]', JSON.stringify(values.keep));
  check('a text field starts at its supplied value', values.name === 'Acme');

  check('a checklist collects as the TICKED INDICES, comma-joined',
    mq.fieldValueOf(fields[1], [true, false, true]) === '0,2',
    mq.fieldValueOf(fields[1], [true, false, true]));
  check('...and an all-unticked checklist collects as the empty string, not "-1"',
    mq.fieldValueOf(fields[1], [false, false, false]) === '');

  check('a choice collects the chosen option', mq.fieldValueOf(fields[2], { select: 'y', other: '' }) === 'y');
  check('...and "Something else…" collects the TYPED text, never the sentinel',
    mq.fieldValueOf(fields[2], { select: mq.CHOICE_OTHER, other: 'z' }) === 'z');

  const out = mq.collectValues(fields, { name: 'Acme', keep: [true, false, true], pick: { select: 'x', other: '' } });
  check('collectValues returns one plain string per field, keyed by name',
    out.name === 'Acme' && out.keep === '0,2' && out.pick === 'x', JSON.stringify(out));
}

// ===========================================================================
// PART 2 — the real panel, in a real browser
// ===========================================================================

console.log('\n  building dist/ …');
await build({ logLevel: 'error' });

const DIST = join(ROOT, 'dist');
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.map': 'application/json', '.png': 'image/png',
};

// ES modules will not load over file:// (opaque origin), so the built extension is served.
// 127.0.0.1 is a secure context, which crypto.subtle in vault.js needs.
const server = http.createServer((req, res) => {
  const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(DIST, rel);
  if (!file.startsWith(DIST) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('no');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();

/**
 * A panel page with a stubbed `chrome`.
 *
 * @param {object}  opts
 * @param {object}  opts.seed      what chrome.storage.local already holds at boot
 * @param {number}  opts.setDelay  ms to hold a storage WRITE open, to model the real
 *                                 cross-process chrome.storage.local.set the store's
 *                                 editGen guard exists for
 * @param {boolean} opts.failReads make every read throw, to exercise the fallback path
 */
async function openPanel({ seed = {}, setDelay = 0, failReads = false } = {}) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.addInitScript(([initial, delay, boom]) => {
    const store = { ...initial };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    window.__store = store;
    window.chrome = {
      runtime: {
        id: 'jobpilottestid',
        getURL: (p) => `chrome-extension://jobpilottestid/${p}`,
        sendMessage: async () => ({ ok: false }),
        onMessage: { addListener: () => {} },
        lastError: null,
      },
      storage: {
        local: {
          async get(key) {
            if (boom) throw new Error('storage unavailable');
            if (key == null) return { ...store };
            if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]));
            return key in store ? { [key]: store[key] } : {};
          },
          async set(obj) {
            if (delay) await sleep(delay);
            Object.assign(store, obj);
          },
          // The real API takes a key OR an array of them, and importAllData passes an
          // array. A stub that only handled the string silently kept every key a restore
          // was supposed to remove.
          async remove(key) {
            for (const k of (Array.isArray(key) ? key : [key])) delete store[k];
          },
          async clear() { for (const k of Object.keys(store)) delete store[k]; },
        },
        session: {
          async get() { return {}; }, async set() {}, async remove() {},
        },
      },
      // resolveTargetTab finds nothing, so the panel renders "No target tab" and the
      // portal chip stays absent. That is the correct state for a panel with no page
      // behind it, and it keeps platforms.js from probing anything.
      tabs: {
        async query() { return []; },
        async get() { throw new Error('no tab'); },
        async sendMessage() {},
        // The panel watches these so a run whose tab closes ends, and a run whose tab id
        // is swapped under it (prerender activation) is remapped rather than killed.
        onRemoved: { addListener() {}, removeListener() {} },
        onReplaced: { addListener() {}, removeListener() {} },
      },
      webNavigation: { async getAllFrames() { return []; } },
      scripting: { async executeScript() { return []; } },
    };
  }, [seed, setDelay, failReads]);

  await page.goto(`${ORIGIN}/sidepanel/panel.html`);
  // `ready` gates every view; the tab bar exists before it, the views do not.
  await page.waitForSelector('#view-profile .scroll-area', { timeout: 10000 }).catch(() => {});
  return { page, errors };
}

const read = (page, key) => page.evaluate((k) => window.__store[k], key);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ boot + shell

// A transcript written by an older build, holding the two things a restored chat has to
// survive: text an LLM produced after reading a hostile page, and tool steps that stopped
// to ask the user something.
const HOSTILE = 'Try <img src=x onerror="window.__xss=1"> and [click](javascript:alert(1)) and [ok](https://example.com/j).';
const seedChat = [
  { type: 'user', text: 'apply to this' },
  { type: 'assistant', text: HOSTILE },
  {
    type: 'activity',
    steps: [
      { name: 'fill_secret', label: 'Fill username', ok: true, result: 'ok', waiting: true },
      { name: 'fill_secret', label: 'Fill password', ok: true, result: 'ok', waiting: true },
    ],
  },
];

{
  const { page, errors } = await openPanel({ seed: { chatHistory: seedChat } });

  check('the panel boots with no uncaught error', errors.length === 0, errors.slice(0, 2).join(' | '));
  check('...and paints the shell: header, six tabs, six view slots',
    (await page.locator('#app .tabbar .tab').count()) === 6
    && (await page.locator('#app section.view').count()) === 6,
    `${await page.locator('#app .tabbar .tab').count()} tabs`);
  check('chat is the tab you land on', await page.locator('#view-chat').evaluate((el) => el.classList.contains('active')));

  await page.click('#tab-profile');
  check('clicking a tab activates it', await page.locator('#view-profile').evaluate((el) => el.classList.contains('active')));
  check('...and deactivates the old one', !(await page.locator('#view-chat').evaluate((el) => el.classList.contains('active'))));
  // The design invariant App.jsx is built around: ChatView owns the AgentRunner and a live
  // transcript, so leaving the tab must not unmount it. If this ever fails, switching tabs
  // mid-run kills the run.
  check('THE INVARIANT: the chat view is still MOUNTED, only hidden',
    (await page.locator('#view-chat #message-list').count()) === 1);

  // ------------------------------------------------- the restored transcript is not HTML
  await page.click('#tab-chat');
  const bubble = page.locator('#message-list .msg-assistant').first();
  check('a stored assistant message is restored', (await bubble.count()) === 1);
  check('SECURITY: markup in model output is TEXT, not an element',
    (await page.locator('#message-list img').count()) === 0
    && (await bubble.innerText()).includes('<img src=x'),
    `${await page.locator('#message-list img').count()} img(s)`);
  check('...and the onerror never ran', (await page.evaluate(() => window.__xss)) === undefined);
  check('SECURITY: a javascript: link is not turned into a link at all',
    (await page.locator('#message-list a[href^="javascript:"]').count()) === 0);
  const link = page.locator('#message-list a').first();
  check('...while an http(s) link still renders, with rel=noopener noreferrer',
    (await page.locator('#message-list a').count()) === 1
    && (await link.getAttribute('href')) === 'https://example.com/j'
    && (await link.getAttribute('rel')) === 'noopener noreferrer',
    await link.getAttribute('rel'));

  // ------------------------------------------- one "waiting" mark PER STEP, not a pointer
  // This was a single {rowId,index} pointer in ChatView, so the second credential prompt of
  // a run silently erased the first step's label — and it was never cleared, so it went on
  // pointing at a dead row. It is a field on the step record now, which is also why it
  // survives the reload this check is doing.
  const stepLabels = await page.locator('#message-list .tool-step .tool-label').allInnerTexts();
  check('BOTH steps that waited on the user say so, after a reload',
    stepLabels.length === 2 && stepLabels.every((t) => /waiting for you/.test(t)),
    JSON.stringify(stepLabels));

  await page.close();
}

// ------------------------------------------------ profile writes, and the keystroke race

{
  const { page } = await openPanel({ setDelay: 200 });
  await page.click('#tab-profile');

  await page.locator('#pf-fullName').pressSequentially('a');
  await sleep(450);           // the 400ms debounce has fired; the write is in flight
  await page.locator('#pf-fullName').pressSequentially('b');
  await sleep(1200);          // both writes have landed

  // THE POINT (store.jsx's editGenRef): the first write returns the pre-'b' profile that
  // storage normalized. Putting it back into state blindly makes the character the user
  // just typed vanish from the box, and then persists it away on the next tick.
  check('a keystroke landing DURING a save is not reverted by that save',
    (await page.inputValue('#pf-fullName')) === 'ab', await page.inputValue('#pf-fullName'));
  const stored = await read(page, 'profile');
  check('...and what is on disk is what the box shows', stored && stored.fullName === 'ab',
    stored && JSON.stringify(stored.fullName));

  // ------------------------------------------------------------------ toast cap
  // Six files the picker refuses, one toast each. Unbounded, they cover the panel they are
  // reporting on. One at a time because #doc-file-input is not `multiple` — panel.html.orig
  // line 144 was not either, so that is the port being faithful, not a regression; the
  // dropzone is the path that takes a whole folder at once. Well inside the 2.5s dwell, so
  // all six are live at the moment the count is taken.
  for (let i = 0; i < 5; i++) {
    await page.setInputFiles('#doc-file-input', {
      name: `junk${i}.exe`, mimeType: 'application/octet-stream', buffer: Buffer.from('x'),
    });
  }
  // The sixth is oversized rather than wrong-typed, only because THAT rejection names the
  // file — "Only PDF, DOC, DOCX and TXT files are supported" is the same string six times
  // over, so it cannot show which four survived.
  await page.setInputFiles('#doc-file-input', {
    name: 'toobig.txt', mimeType: 'text/plain', buffer: Buffer.alloc(9 * 1024 * 1024, 0x61),
  });
  await sleep(200);
  const toasts = await page.locator('#toast-container .toast').count();
  check('toasts are capped rather than stacking without limit', toasts > 0 && toasts <= 4,
    `${toasts} on screen after 6`);
  check('...and it is the NEWEST that are kept — the last error is the one still on screen',
    /toobig\.txt/.test(await page.locator('#toast-container').innerText()),
    (await page.locator('#toast-container').innerText()).replace(/\n/g, ' | ').slice(0, 90));

  await page.close();
}

// ------------------------------------------------------------- the dialog's Enter key

{
  const { page } = await openPanel({});
  await page.click('#tab-memory');
  const rowsBefore = await page.locator('#mem-list .mem-row').count();

  await page.click('#mem-add');
  await page.waitForSelector('#dlg-ask[open]');
  await page.locator('#dlg-ask .modal-input').first().fill('zzztestportal');

  // THE BUG: the keydown listener is on the <form>, so Enter anywhere inside it submitted.
  // Tab to Cancel, press Enter, and the dialog you were trying to escape did the thing.
  await page.locator('#dlg-ask .modal-cancel').focus();
  await page.keyboard.press('Enter');
  await sleep(200);
  check('Enter on a focused Cancel CANCELS — it does not submit the form',
    (await page.locator('#dlg-ask').count()) === 0
    && (await page.locator('#mem-list .mem-row').count()) === rowsBefore,
    `${await page.locator('#mem-list .mem-row').count()} rows vs ${rowsBefore}`);

  // …and the fix must not cost the thing it guards: Enter in a FIELD still submits.
  await page.click('#mem-add');
  await page.waitForSelector('#dlg-ask[open]');
  const field = page.locator('#dlg-ask .modal-input').first();
  await field.fill('zzztestportal');
  await field.press('Enter');
  await page.waitForSelector('#dlg-ask', { state: 'detached', timeout: 5000 }).catch(() => {});
  await sleep(250);
  check('Enter in a text field still submits',
    (await page.locator('#mem-list .mem-row').count()) === rowsBefore + 1,
    `${await page.locator('#mem-list .mem-row').count()} rows vs ${rowsBefore}`);

  await page.close();
}

// ------------------------------------------------------ a panel that cannot read storage

{
  const { page } = await openPanel({ failReads: true });
  await page.click('#tab-settings');

  // reloadAll used to fall back to `{}`, which is the wrong SHAPE: SettingsView seeds its
  // drafts from it, so every box became <input value={undefined}> — an UNCONTROLLED input
  // that stops tracking state — and the number fields printed the string "undefined".
  const maxSteps = await page.inputValue('#st-maxSteps');
  const baseUrl = await page.inputValue('#st-baseUrl');
  check('a storage read failure still renders the DEFAULTS, not "undefined"',
    maxSteps === '48' && baseUrl === '', `maxSteps=${JSON.stringify(maxSteps)} baseUrl=${JSON.stringify(baseUrl)}`);
  // The proof it is a controlled input and not a dead one.
  await page.locator('#st-baseUrl').pressSequentially('http://x');
  check('...and the form is still usable — the inputs are controlled',
    (await page.inputValue('#st-baseUrl')) === 'http://x', await page.inputValue('#st-baseUrl'));

  await page.close();
}

// ------------------------------------------------------- backup: export, then restore
//
// The storage half of this lives in panel-harness.mjs. What can only be checked HERE is the
// half that made the feature worth building: a restore replaces every key at once while all
// five views are mounted holding the old ones, so the panel has to be told. A restore the
// screen does not follow is indistinguishable from one that did not happen.

{
  const { page, errors } = await openPanel({
    seed: {
      settings: { baseUrl: 'https://old.example/v1', apiKey: 'sk-old', model: 'old-model' },
      profile: { fullName: 'Before' },
      chatHistory: [{ type: 'user', text: 'the old chat' }],
    },
  });

  await page.click('#tab-settings');

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('#btn-export-data'),
  ]);
  check('Export downloads a dated .json',
    /^jobpilot-backup-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename()),
    download.suggestedFilename());
  const saved = JSON.parse(fs.readFileSync(await download.path(), 'utf8'));
  check('...holding the API key, which is the thing a new extension id loses',
    saved.jobpilot === 'backup' && saved.data.settings.apiKey === 'sk-old');

  // A DIFFERENT backup, so every assertion below distinguishes "restored" from "never changed".
  const file = JSON.stringify({
    jobpilot: 'backup',
    format: 1,
    data: {
      settings: { baseUrl: 'https://new.example/v1', apiKey: 'sk-new', model: 'new-model' },
      profile: { fullName: 'After' },
      chatHistory: [{ type: 'user', text: 'the restored chat' }],
    },
  });
  await page.setInputFiles('#backup-file-input', {
    name: 'jobpilot-backup-2026-01-01.json',
    mimeType: 'application/json',
    buffer: Buffer.from(file),
  });

  await page.waitForSelector('#dlg-confirm[open]', { timeout: 5000 });
  const message = await page.locator('#dlg-confirm .modal-message').innerText();
  check('the confirm spells out what the FILE holds, so a wrong one can still be caught',
    message.includes('settings') && message.includes('profile') && message.includes('1 chat message'),
    message.slice(0, 90));
  await page.click('#dlg-confirm .modal-ok');
  await page.waitForFunction(() => window.__store.profile && window.__store.profile.fullName === 'After', null, { timeout: 5000 });

  // The settings drafts are seeded from `settings` ONCE, at mount. Without the explicit
  // re-sync after an import they keep showing the pre-restore values over restored storage.
  check('THE POINT: the settings form follows the restore',
    (await page.inputValue('#st-baseUrl')) === 'https://new.example/v1'
    && (await page.inputValue('#st-apiKey')) === 'sk-new',
    `${await page.inputValue('#st-baseUrl')} / ${await page.inputValue('#st-apiKey')}`);

  await page.click('#tab-profile');
  check('...and so does the profile', (await page.inputValue('#pf-fullName')) === 'After');

  // ChatView never unmounts, so its transcript and its AgentRunner outlive the import.
  await page.click('#tab-chat');
  const transcript = await page.locator('#message-list').innerText();
  check('...and the transcript is the restored one', transcript.includes('the restored chat'));
  check('...REPLACING the old one rather than being appended to it',
    !transcript.includes('the old chat'), transcript.slice(0, 80));

  check('no uncaught error anywhere in the restore', errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}

// Cancelling must change nothing — the confirm is the last point at which a wrong file can
// be stopped, so it has to actually stop it.
{
  const { page } = await openPanel({ seed: { profile: { fullName: 'Untouched' } } });
  await page.click('#tab-settings');
  await page.setInputFiles('#backup-file-input', {
    name: 'other.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ profile: { fullName: 'Should not land' } })),
  });
  await page.waitForSelector('#dlg-confirm[open]', { timeout: 5000 });
  await page.click('#dlg-confirm .modal-cancel');
  await sleep(200);
  check('Cancel on the restore confirm writes nothing',
    (await read(page, 'profile')).fullName === 'Untouched');

  // Same file again: the <input> is reset on every pick, so a second attempt still fires.
  await page.setInputFiles('#backup-file-input', {
    name: 'other.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ profile: { fullName: 'Should not land' } })),
  });
  check('...and picking the SAME file again still opens the confirm',
    await page.waitForSelector('#dlg-confirm[open]', { timeout: 5000 }).then(() => true, () => false));
  await page.click('#dlg-confirm .modal-cancel');
  await page.close();
}

// ------------------------------------------- several applications in one panel
//
// The feature, in the real panel. Everything else about concurrency is unit-tested
// elsewhere; what only a browser can show is that two runs really do mount side by side,
// that each keeps its own transcript, and that the one you are not looking at is HIDDEN
// rather than unmounted — unmounting it would tear down its AgentRunner and abandon an
// application halfway through a form.
{
  const { page, errors } = await openPanel({
    seed: {
      chatHistory: [{ type: 'user', text: 'the first application' }],
      // Configured, as a second-application panel always is in real life — the empty
      // state below asserts on the copy that depends on it.
      settings: { provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' },
    },
  });

  check('a fresh panel has ONE application, and no switcher for it',
    (await page.locator('.run-slot').count()) === 1
    && (await page.locator('.run-tabs').count()) === 0,
    `${await page.locator('.run-slot').count()} slot(s)`);
  check('...and the way to start another is on the toolbar, where it is reachable with ' +
    'only one run — the switcher itself does not exist yet',
    (await page.locator('#btn-new-run').count()) === 1);

  await page.click('#btn-new-run');
  await page.waitForSelector('.run-tabs', { timeout: 5000 });
  check('THE FEATURE: a second application mounts alongside the first',
    (await page.locator('.run-slot').count()) === 2,
    `${await page.locator('.run-slot').count()} slot(s)`);
  check('...and the switcher appears now that there is something to switch between',
    (await page.locator('.run-tab').count()) === 2);
  check('...with the new one selected',
    (await page.locator('.run-slot.active').count()) === 1
    && (await page.locator('.run-tab.active').count()) === 1);

  // Each run has its own everything. The second must NOT show the first's transcript.
  const slots = page.locator('.run-slot');
  const firstText = await slots.nth(0).locator('#message-list, .message-list').innerText();
  const secondText = await slots.nth(1).locator('.message-list').innerText();
  check('THE POINT: the second application has its OWN transcript, not the first one\'s',
    firstText.includes('the first application') && !secondText.includes('the first application'),
    secondText.slice(0, 60).replace(/\n/g, ' '));
  check('...and its empty state does NOT tell an already-configured user to "Connect your ' +
    'LLM" — that read as "did it lose my key?", not as a fresh chat',
    !secondText.includes('Connect your LLM') && secondText.includes('own tab'),
    secondText.slice(0, 80).replace(/\n/g, ' '));
  check('...and its own composer, so you can start it while the other one exists',
    (await page.locator('.run-slot .composer-input, .run-slot textarea').count()) === 2,
    `${await page.locator('.run-slot textarea').count()} composer(s)`);

  // Switching must HIDE, never unmount.
  await page.locator('.run-tab').nth(0).locator('.run-tab-main').click();
  check('switching back selects the first again',
    await slots.nth(0).evaluate((el) => el.classList.contains('active')));
  check('THE INVARIANT: the one you switched AWAY from is still mounted, only hidden — ' +
    'unmounting it would kill its AgentRunner and abandon that application',
    (await page.locator('.run-slot').count()) === 2
    && (await slots.nth(1).locator('.message-list').count()) === 1
    && !(await slots.nth(1).evaluate((el) => el.classList.contains('active'))));
  check('...and only one is visible at a time',
    (await page.locator('.run-slot.active').count()) === 1);

  // Closing.
  await page.locator('.run-tab').nth(1).locator('.run-tab-close').click();
  check('closing an application removes it', (await page.locator('.run-slot').count()) === 1);
  check('...and the switcher goes away with it, back to the single-run panel',
    (await page.locator('.run-tabs').count()) === 0);
  check('...leaving the surviving transcript intact',
    (await page.locator('.message-list').innerText()).includes('the first application'));

  check('no uncaught error anywhere in running two applications', errors.length === 0,
    errors.slice(0, 2).join(' | '));
  await page.close();
}

// ---------------------------- three applications, three submits, none eaten
//
// The regression this pins down: RunView's restore effect was keyed on the run API'S
// IDENTITY, which churns on every runs-context update. With three runs churning each
// other, every churn re-fired the restore and replaced the LIVE transcript with the disk
// copy — usually empty — then the debounced writer persisted the wipe. The loops kept
// running; the transcripts died. To the user that read as "after one submit, the other
// two applications stop".
{
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.addInitScript(() => {
    const store = {
      settings: { provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', maxConcurrentRuns: 3 },
      profile: { fullName: 'Jane Doe' },
    };
    const tabs = {
      11: { id: 11, title: 'Job A', url: 'https://jobs.example/a', status: 'complete', windowId: 9 },
      12: { id: 12, title: 'Job B', url: 'https://jobs.example/b', status: 'complete', windowId: 9 },
      13: { id: 13, title: 'Job C', url: 'https://jobs.example/c', status: 'complete', windowId: 9 },
    };
    window.__active = 11;
    window.__setActiveTab = (id) => { window.__active = id; };
    window.chrome = {
      runtime: {
        id: 't', getURL: (p) => `chrome-extension://t/${p}`,
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener() {}, removeListener() {} },
        lastError: null,
      },
      storage: {
        local: {
          async get(key) {
            if (key == null) return { ...store };
            if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]));
            return key in store ? { [key]: store[key] } : {};
          },
          async set(obj) { Object.assign(store, obj); },
          async remove(key) { for (const k of (Array.isArray(key) ? key : [key])) delete store[k]; },
          async clear() { for (const k of Object.keys(store)) delete store[k]; },
        },
        session: { async get() { return {}; }, async set() {}, async remove() {} },
      },
      tabs: {
        async query() { return [tabs[window.__active]]; },
        async get(id) { if (tabs[id]) return tabs[id]; throw new Error('no tab'); },
        async sendMessage(id, msg) {
          if (msg && msg.kind === 'jobpilot:ping') return { ok: true, ready: true };
          if (msg && msg.kind === 'jobpilot:exec') return { ok: true, result: 'Clicked "Apply".' };
          return { ok: true };
        },
        async update() {},
        onCreated: { addListener() {}, removeListener() {} },
        onUpdated: { addListener() {}, removeListener() {} },
        onRemoved: { addListener() {}, removeListener() {} },
        onReplaced: { addListener() {}, removeListener() {} },
      },
      webNavigation: { async getAllFrames() { return [{ frameId: 0, url: 'https://jobs.example/x' }]; } },
      scripting: { async executeScript() { return []; } },
    };
    // One scripted SSE stream per job, routed on the user's message. A finishes first —
    // that ordering is the regression: A's teardown churned the context under B and C.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const enc = new TextEncoder();
    const sse = (events, delayMs) => new Response(
      new ReadableStream({
        async start(c) {
          await sleep(delayMs);
          for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n`));
          c.enqueue(enc.encode('data: [DONE]\n'));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    const tool = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
    const scripts = {
      'JOB-A': [
        { delay: 100, events: [tool('a1', 'click', { ref: 'e1' })] },
        { delay: 100, events: [tool('a2', 'done', { status: 'submitted', summary: 'A in' })] },
      ],
      'JOB-B': [
        { delay: 300, events: [tool('b1', 'click', { ref: 'e1' })] },
        { delay: 1500, events: [tool('b2', 'done', { status: 'submitted', summary: 'B in' })] },
      ],
      'JOB-C': [
        { delay: 400, events: [tool('c1', 'click', { ref: 'e1' })] },
        { delay: 1500, events: [tool('c2', 'done', { status: 'submitted', summary: 'C in' })] },
      ],
    };
    window.fetch = async (url, init) => {
      const body = JSON.parse(init.body);
      const userText = (body.messages || []).filter((m) => m.role === 'user').map((m) => m.content).join(' ');
      const rounds = scripts[Object.keys(scripts).find((k) => userText.includes(k))];
      if (!rounds || !rounds.length) return new Response('no script', { status: 500 });
      const round = rounds.shift();
      return sse(round.events, round.delay);
    };
  });

  await page.goto(`${ORIGIN}/sidepanel/panel.html`);
  await page.waitForSelector('#view-chat .composer-input', { timeout: 10000 });

  const send = async (slotIndex, text) => {
    const box = page.locator('.run-slot').nth(slotIndex).locator('.composer-input');
    await box.fill(text);
    await box.press('Enter');
  };

  await send(0, 'apply to JOB-A');
  // #btn-new-run exists in every slot; only the active slot's is visible/clickable.
  await page.click('.run-slot.active #btn-new-run');
  await page.evaluate(() => window.__setActiveTab(12));
  await send(1, 'apply to JOB-B');
  await page.click('.run-slot.active #btn-new-run');
  await page.evaluate(() => window.__setActiveTab(13));
  await send(2, 'apply to JOB-C');

  // A lands ~200ms in; B and C ~2s. Wait for each slot's own submitted notice.
  const submitted = [];
  for (let i = 0; i < 3; i++) {
    const ok = await page.locator('.run-slot').nth(i)
      .locator('text=Application submitted')
      .first()
      // 'attached', not the default 'visible': two of the three slots are CSS-hidden
      // (only the selected application shows), and hidden-but-present is exactly the
      // design being asserted.
      .waitFor({ state: 'attached', timeout: 15000 })
      .then(() => true, () => false);
    submitted.push(ok);
  }
  check('THE POINT: three applications at once means three submits — the first finishing ' +
    'must not take the other two down with it',
    submitted.every(Boolean), `submitted per slot: ${submitted.join(', ')}`);

  for (let i = 0; i < 3; i++) {
    const users = await page.locator('.run-slot').nth(i).locator('.msg-user').count();
    check(`...and application ${i + 1} still shows the message that started it — the churn ` +
      'bug ate transcripts out from under LIVE runs',
      users === 1, `${users} user row(s)`);
  }
  check('no uncaught error across three concurrent streams', errors.length === 0,
    errors.slice(0, 2).join(' | '));
  await page.close();
}

// ================================================ CONTRACT-V11 — the plan card, for real
//
// panel-harness proves the LOGIC: what an unticked row means, which value reaches the page.
// None of that touches the dialog. This drives the actual card in a real browser, because
// the two things that can only fail here are the two that matter most: the checkbox the
// user clicks has to be the row they were reading, and the box they typed a correction into
// has to be the value that gets typed into their job application. A positional bug between
// `rows` and `values` passes every unit test and puts the wrong answer on a real form.
{
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.addInitScript(() => {
    const store = {
      settings: { provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', planMode: 'ask' },
      profile: { fullName: 'Jane Doe', phone: '555-0100' },
    };
    const tab = { id: 11, title: 'Job', url: 'https://jobs.example/a', status: 'complete', windowId: 9 };
    // Every fill the panel dispatches, in order — this is what the assertions read.
    window.__filled = [];
    window.chrome = {
      runtime: {
        id: 't', getURL: (p) => `chrome-extension://t/${p}`,
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener() {}, removeListener() {} },
        lastError: null,
      },
      storage: {
        local: {
          async get(key) {
            if (key == null) return { ...store };
            if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]));
            return key in store ? { [key]: store[key] } : {};
          },
          async set(obj) { Object.assign(store, obj); },
          async remove(key) { for (const k of (Array.isArray(key) ? key : [key])) delete store[k]; },
          async clear() { for (const k of Object.keys(store)) delete store[k]; },
        },
        session: { async get() { return {}; }, async set() {}, async remove() {} },
      },
      tabs: {
        async query() { return [tab]; },
        async get(id) { if (id === 11) return tab; throw new Error('no tab'); },
        async sendMessage(id, msg) {
          if (msg && msg.kind === 'jobpilot:ping') return { ok: true, ready: true };
          if (msg && msg.kind === 'jobpilot:exec') {
            window.__filled.push({ tool: msg.tool, ...msg.args });
            return { ok: true, result: `Filled ${msg.args.ref}.` };
          }
          return { ok: true };
        },
        async update() {},
        onCreated: { addListener() {}, removeListener() {} },
        onUpdated: { addListener() {}, removeListener() {} },
        onRemoved: { addListener() {}, removeListener() {} },
        onReplaced: { addListener() {}, removeListener() {} },
      },
      webNavigation: { async getAllFrames() { return [{ frameId: 0, url: 'https://jobs.example/a' }]; } },
      scripting: { async executeScript() { return []; } },
    };

    const enc = new TextEncoder();
    const sse = (events) => new Response(
      new ReadableStream({
        start(c) {
          for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n`));
          c.enqueue(enc.encode('data: [DONE]\n'));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
    const tool = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
    const rounds = [
      [tool('p1', 'propose_plan', {
        fills: [
          { ref: 'e1', label: 'Full name', value: 'Jane Doe' },
          { ref: 'e2', label: 'Phone', value: '555-0100' },
          { ref: 'e3', label: 'Why this company?', value: 'A sentence the model composed.' },
        ],
        unknowns: [{ question: 'Preferred start date?' }],
      })],
      [tool('p2', 'done', { status: 'ready_for_review', summary: 'filled' })],
    ];
    window.fetch = async () => sse(rounds.shift() || []);
  });

  await page.goto(`${ORIGIN}/sidepanel/panel.html`);
  await page.waitForSelector('#view-chat .composer-input', { timeout: 10000 });

  const box = page.locator('.run-slot').first().locator('.composer-input');
  await box.fill('apply to this job');
  await box.press('Enter');

  await page.waitForSelector('#dlg-ask[open] .modal-plan', { timeout: 10000 });

  const rows = page.locator('#dlg-ask .plan-row');
  check('V11 the plan card renders one row per field the agent means to enter',
    (await rows.count()) === 3, `${await rows.count()} rows`);

  const chips = await page.locator('#dlg-ask .plan-src').allInnerTexts();
  check('...each row says where its value came from',
    /profile/.test(chips[0]) && /profile/.test(chips[1]), chips.join(' | '));
  check('THE POINT: the one value the profile does not back is the one marked — that chip ' +
    'is how a user decides which of twenty rows to actually read',
    (await page.locator('#dlg-ask .plan-src-inferred').count()) === 1
    && /worked out/i.test(chips[2]),
    chips.join(' | '));

  check('...and the question the agent could not answer is in the SAME card, not a second one',
    (await page.locator('#dlg-ask .modal-field').count()) === 2
    && /Preferred start date/.test(await page.locator('#dlg-ask .modal-body').innerText()));
  const submit = page.locator('#dlg-ask .modal-submit');
  check('...the primary button says what it will do, not "Submit"',
    /Fill 3 fields/.test(await submit.innerText()), await submit.innerText());
  check('...and focus opens IN the card, not on its primary button — a review card that ' +
    'hands you "approve everything" one Enter away is not a review',
    await page.evaluate(() => {
      const a = document.activeElement;
      return Boolean(a && a.type === 'checkbox' && a.closest('.plan-row'));
    }),
    await page.evaluate(() => `${document.activeElement && document.activeElement.className}`));

  // Untick the phone row; correct the composed sentence; answer the question.
  await rows.nth(1).locator('input[type=checkbox]').uncheck();
  // Case-insensitive: .modal-label uppercases via CSS and innerText reports what is
  // RENDERED, so the assertion would be about the stylesheet rather than the count.
  check('...the header counts what will actually be filled as you change your mind',
    /2 of 3 fields/i.test(await page.locator('#dlg-ask .plan-head').innerText()),
    await page.locator('#dlg-ask .plan-head').innerText());
  check('THE POINT: and so does the BUTTON — a static label goes on promising to fill three ' +
    'after you unticked one, and it is the last thing read before the click',
    /Fill 2 fields/.test(await submit.innerText()), await submit.innerText());

  await rows.nth(2).locator('.plan-value').fill('My own sentence.');
  await page.locator('#dlg-ask .modal-field').nth(1).locator('.modal-input').fill('Two weeks');
  await page.click('#dlg-ask .modal-submit');

  await page.waitForFunction(() => window.__filled.length >= 2, null, { timeout: 10000 });
  await sleep(400);
  const filled = await page.evaluate(() => window.__filled);

  check('THE POINT: the row the user unticked is never typed into the real application',
    !filled.some((f) => f.ref === 'e2'), JSON.stringify(filled.map((f) => f.ref)));
  check('THE OTHER POINT: the box they typed a correction into is the value that lands — a ' +
    'positional slip between rows and values passes every unit test and files the wrong answer',
    filled.some((f) => f.ref === 'e3' && f.value === 'My own sentence.'),
    JSON.stringify(filled));
  check('...and the untouched row goes through as proposed',
    filled.some((f) => f.ref === 'e1' && f.value === 'Jane Doe'), JSON.stringify(filled));

  const transcript = await page.locator('.run-slot').first().innerText();
  check('...the transcript keeps a plain-language record of what was agreed, so scrolling ' +
    'back answers "what did I approve on page 3" without expanding a tool result',
    /Plan approved/.test(transcript) && /2 of 3 fields/.test(transcript),
    (transcript.match(/Plan approved[^\n]*/) || ['(no notice)'])[0]);
  check('no uncaught error driving the plan card', errors.length === 0, errors.slice(0, 2).join(' | '));

  await page.close();
}

// ============ CONTRACT-V11 §5 — the submit confirmation, in the browser
//
// The whole change is what the user has to DO, so the assertion has to be about the real
// dialog: two buttons, no box, and one click that actually submits. As an ask_user this was
// a required text field plus a second press, and the typed word only granted permission for
// a click that came later as its own step.
{
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.addInitScript(() => {
    const store = {
      settings: { provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', planMode: 'off', autoSubmit: false },
      profile: { fullName: 'Jane Doe' },
    };
    const tab = { id: 11, title: 'Job', url: 'https://jobs.example/a', status: 'complete', windowId: 9 };
    window.__clicked = [];
    window.chrome = {
      runtime: {
        id: 't', getURL: (p) => `chrome-extension://t/${p}`,
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener() {}, removeListener() {} }, lastError: null,
      },
      storage: {
        local: {
          async get(key) {
            if (key == null) return { ...store };
            if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]));
            return key in store ? { [key]: store[key] } : {};
          },
          async set(obj) { Object.assign(store, obj); },
          async remove(key) { for (const k of (Array.isArray(key) ? key : [key])) delete store[k]; },
          async clear() { for (const k of Object.keys(store)) delete store[k]; },
        },
        session: { async get() { return {}; }, async set() {}, async remove() {} },
      },
      tabs: {
        async query() { return [tab]; },
        async get(id) { if (id === 11) return tab; throw new Error('no tab'); },
        async sendMessage(id, msg) {
          if (msg && msg.kind === 'jobpilot:ping') return { ok: true, ready: true };
          if (msg && msg.kind === 'jobpilot:exec') {
            if (msg.tool === 'click') window.__clicked.push(msg.args.ref);
            // A real portal: clean until you press Submit, then it names what is missing.
            // window.__refuse lets one test take the happy path and the next the refusal.
            if (msg.tool === 'read_errors') {
              return {
                ok: true,
                result: (window.__refuse && window.__clicked.length)
                  ? 'Please go back to these steps before submitting your application\nError\nFinal certificate - Attachment is required.'
                  : 'No visible errors.',
              };
            }
            return { ok: true, result: msg.tool === 'click' ? 'Clicked "Submit application".' : 'Application submitted ✓' };
          }
          return { ok: true };
        },
        async update() {},
        onCreated: { addListener() {}, removeListener() {} },
        onUpdated: { addListener() {}, removeListener() {} },
        onRemoved: { addListener() {}, removeListener() {} },
        onReplaced: { addListener() {}, removeListener() {} },
      },
      webNavigation: { async getAllFrames() { return [{ frameId: 0, url: 'https://jobs.example/a' }]; } },
      scripting: { async executeScript() { return []; } },
    };
    const enc = new TextEncoder();
    const sse = (events) => new Response(new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n`));
        c.enqueue(enc.encode('data: [DONE]\n'));
        c.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const tool = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
    const rounds = [
      [tool('s1', 'confirm_submit', {
        ref: 'e9', label: 'Submit application',
        summary: 'Your application for Senior Engineer at Acme, with resume.pdf attached.',
      })],
      [tool('s2', 'done', { status: 'submitted', summary: 'in' })],
    ];
    window.fetch = async () => sse(rounds.shift() || []);
  });

  await page.goto(`${ORIGIN}/sidepanel/panel.html`);
  await page.waitForSelector('#view-chat .composer-input', { timeout: 10000 });
  const box = page.locator('.run-slot').first().locator('.composer-input');
  await box.fill('apply and submit');
  await box.press('Enter');

  await page.waitForSelector('#dlg-confirm[open]', { timeout: 10000 });
  check('V11 §5 THE CHANGE: the submit confirmation is a plain two-button dialog — there is ' +
    'nothing to type and no second press to send what you typed',
    (await page.locator('#dlg-confirm input, #dlg-confirm textarea').count()) === 0
    && (await page.locator('#dlg-confirm .modal-ok').count()) === 1
    && (await page.locator('#dlg-confirm .modal-cancel').count()) === 1,
    `${await page.locator('#dlg-confirm input, #dlg-confirm textarea').count()} input(s)`);
  check('...the primary button says Submit, not "Confirm"',
    /^Submit$/.test((await page.locator('#dlg-confirm .modal-ok').innerText()).trim()),
    await page.locator('#dlg-confirm .modal-ok').innerText());
  check('...and the dialog says what is being sent and which button it will press',
    /Senior Engineer at Acme/.test(await page.locator('#dlg-confirm .modal-message').innerText())
    && /Submit application/.test(await page.locator('#dlg-confirm .modal-message').innerText()),
    (await page.locator('#dlg-confirm .modal-message').innerText()).replace(/\n/g, ' ').slice(0, 90));
  check('...focus is on Submit, so approving is one click OR one Enter',
    await page.evaluate(() => Boolean(document.activeElement && document.activeElement.classList.contains('modal-ok'))));

  await page.click('#dlg-confirm .modal-ok');
  await page.waitForFunction(() => window.__clicked.length > 0, null, { timeout: 10000 });
  check('THE POINT: that ONE click is what submits — approval and the click are the same ' +
    'action, so the button cannot say Submit and leave the form unsent',
    (await page.evaluate(() => window.__clicked)).includes('e9'),
    JSON.stringify(await page.evaluate(() => window.__clicked)));

  await sleep(400);
  check('...and the transcript records that you approved it — "did I actually send that one?" ' +
    'is a question people ask weeks later',
    /You approved the submit/.test(await page.locator('.run-slot').first().innerText()));
  check('no uncaught error driving the submit confirmation', errors.length === 0, errors.slice(0, 2).join(' | '));

  await page.close();
}

// ============ CONTRACT-V11 §6 — a refused submit, as the user experiences it
//
// The reported failure, reproduced: a portal answers Submit with "Final certificate -
// Attachment is required". The click SUCCEEDS, so nothing in the tool result contradicts
// it. What has to be true is that the person who pressed Submit is told, in the chat, in
// the portal's own words — not left to expand an activity row, and never told it went in.
{
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  await page.addInitScript(() => {
    const store = {
      settings: { provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', planMode: 'off', autoSubmit: false },
      profile: { fullName: 'Jane Doe' },
    };
    const tab = { id: 11, title: 'Job', url: 'https://jobs.example/a', status: 'complete', windowId: 9 };
    window.__clicked = [];
    window.chrome = {
      runtime: {
        id: 't', getURL: (p) => `chrome-extension://t/${p}`,
        sendMessage: async () => ({ ok: true }),
        onMessage: { addListener() {}, removeListener() {} }, lastError: null,
      },
      storage: {
        local: {
          async get(key) {
            if (key == null) return { ...store };
            if (Array.isArray(key)) return Object.fromEntries(key.filter((k) => k in store).map((k) => [k, store[k]]));
            return key in store ? { [key]: store[key] } : {};
          },
          async set(obj) { Object.assign(store, obj); },
          async remove(key) { for (const k of (Array.isArray(key) ? key : [key])) delete store[k]; },
          async clear() { for (const k of Object.keys(store)) delete store[k]; },
        },
        session: { async get() { return {}; }, async set() {}, async remove() {} },
      },
      tabs: {
        async query() { return [tab]; },
        async get(id) { if (id === 11) return tab; throw new Error('no tab'); },
        async sendMessage(id, msg) {
          if (msg && msg.kind === 'jobpilot:ping') return { ok: true, ready: true };
          if (msg && msg.kind === 'jobpilot:exec') {
            if (msg.tool === 'click') { window.__clicked.push(msg.args.ref); return { ok: true, result: 'Clicked "Submit".' }; }
            if (msg.tool === 'read_errors') {
              return {
                ok: true,
                result: window.__clicked.length
                  ? 'Please go back to these steps before submitting your application\nError\nFinal certificate - Attachment is required.'
                  : 'No visible errors.',
              };
            }
            return { ok: true, result: 'ok' };
          }
          return { ok: true };
        },
        async update() {},
        onCreated: { addListener() {}, removeListener() {} },
        onUpdated: { addListener() {}, removeListener() {} },
        onRemoved: { addListener() {}, removeListener() {} },
        onReplaced: { addListener() {}, removeListener() {} },
      },
      webNavigation: { async getAllFrames() { return [{ frameId: 0, url: 'https://jobs.example/a' }]; } },
      scripting: { async executeScript() { return []; } },
    };
    const enc = new TextEncoder();
    const sse = (events) => new Response(new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n`));
        c.enqueue(enc.encode('data: [DONE]\n'));
        c.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const tool = (id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] });
    const rounds = [
      [tool('s1', 'confirm_submit', { ref: 'e9', label: 'Submit', summary: 'Senior Engineer at Acme.' })],
      [tool('s2', 'done', { status: 'blocked', summary: 'The form needs a Final certificate attachment.' })],
    ];
    window.fetch = async () => sse(rounds.shift() || []);
  });

  await page.goto(`${ORIGIN}/sidepanel/panel.html`);
  await page.waitForSelector('#view-chat .composer-input', { timeout: 10000 });
  const box = page.locator('.run-slot').first().locator('.composer-input');
  await box.fill('apply and submit');
  await box.press('Enter');

  await page.waitForSelector('#dlg-confirm[open]', { timeout: 10000 });
  await page.click('#dlg-confirm .modal-ok');

  const slot = page.locator('.run-slot').first();
  await slot.locator('text=Not submitted').first().waitFor({ state: 'attached', timeout: 15000 });
  const text = await slot.innerText();

  check('V11 §6 THE POINT: the user is TOLD the application did not go in — not left to ' +
    'expand an activity row, and never told it succeeded',
    /Not submitted/.test(text) && !/Application submitted/.test(text),
    (text.match(/Not submitted[^\n]*/) || ['(no notice)'])[0].slice(0, 120));
  check('...in the portal\'s OWN words, which is what makes it obviously the same message ' +
    'they can see sitting in the tab',
    /Final certificate - Attachment is required/.test(text));
  check('...and it names the one thing they have to do that JobPilot cannot do for them',
    /needs a file/i.test(text) && /Profile tab/.test(text),
    (text.match(/Not submitted[^\n]*/) || [''])[0].slice(-90));
  check('...the click really did happen — this is a refusal by the FORM, not a failure to press',
    (await page.evaluate(() => window.__clicked)).includes('e9'));
  const submitRow = slot.locator('.tool-step', { hasText: 'confirm submit' }).first();
  check('THE OTHER POINT: that row is marked FAILED, not ticked — onToolEnd is one-shot, so ' +
    'settling it optimistically when the dialog opened left a green ✓ on a submit that did not happen',
    /\bfail\b/.test(await submitRow.getAttribute('class') || ''),
    await submitRow.getAttribute('class'));
  check('no uncaught error on a refused submit', errors.length === 0, errors.slice(0, 2).join(' | '));

  await page.close();
}

// ============ CONTRACT-V12 — onboarding: the checklist, the meter, the resume read
{
  // Basics already filled, so the ranking has room to show what it is FOR: a field two real
  // forms have asked about, promoted above the general priors.
  const { page } = await openPanel({
    seed: {
      settings: { provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' },
      profile: {
        fullName: 'Jane', email: 'j@x.com', phone: '1',
        savedAnswers: [
          { q: 'What is your notice period?', a: '2 weeks' },
          { q: 'Notice period at current employer?', a: '2 weeks' },
        ],
      },
      documents: [],
    },
  });

  // --- the checklist
  await page.waitForSelector('.setup-strip', { timeout: 10000 });
  check('V12 §3 a half-set-up install is told what is left, in the header',
    (await page.locator('.setup-strip .setup-step').count()) === 3
    && /1 to go/i.test(await page.locator('.setup-lead').innerText()),
    await page.locator('.setup-strip').innerText().then((t) => t.replace(/\n/g, ' ')));
  check('...the finished steps are ticked, so it reads as progress rather than a scolding',
    (await page.locator('.setup-step.done').count()) === 2);
  await page.click('.setup-step:not(.done)');
  check('...and a step is a ROUTE — clicking it lands on the tab that completes it',
    await page.locator('#view-profile').evaluate((el) => el.classList.contains('active')));

  // --- the meter
  const meter = page.locator('.pf-meter');
  check('V12 §2 the meter names what to fill next rather than only counting',
    (await meter.locator('.pf-missing li').count()) > 0
    && /Notice period/.test(await meter.innerText()),
    (await meter.innerText()).replace(/\n/g, ' ').slice(0, 110));
  check('THE POINT: the field two real forms already asked about is TOP, and says why — that ' +
    'is evidence about this person\'s applications, not a general claim about forms',
    /asked you this 2 times/.test(await meter.innerText())
    && /Notice period/.test(await meter.locator('.pf-missing li').first().innerText()),
    (await meter.locator('.pf-missing li').first().innerText()).replace(/\n/g, ' '));

  await page.click('.pf-missing-link >> nth=0');
  check('...and clicking one puts the caret in that box, instead of leaving you to scroll',
    (await page.evaluate(() => document.activeElement && document.activeElement.id)) === 'pf-noticePeriod',
    await page.evaluate(() => document.activeElement && document.activeElement.id));

  // --- fill from resume, with nothing to read yet
  check('V12 §1 with no resume the button says so rather than failing when pressed',
    await page.locator('#btn-fill-from-resume').isDisabled());

  // Paste resume text, then read it. The stubbed provider answers with a tool call.
  await page.evaluate(() => {
    window.fetch = async () => new Response(
      new ReadableStream({
        start(c) {
          const enc = new TextEncoder();
          c.enqueue(enc.encode(`data: ${JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'profile_fields', arguments: JSON.stringify({ currentTitle: 'Staff Engineer', currentCompany: 'Acme', location: 'Bengaluru, India', city: 'Delhi' }) } }] } }],
          })}\n`));
          c.enqueue(enc.encode('data: [DONE]\n'));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  });
  await page.locator('#pf-resumeText').fill('Jane Doe — Staff Engineer at Acme, Bengaluru.');
  await page.locator('#pf-city').fill('Bengaluru');
  await sleep(700); // the store's debounced write

  check('V12 §3 THE POINT: the checklist REMOVES itself the moment the last step is done — a ' +
    'strip that survives completion is a nag you cannot dismiss',
    (await page.locator('.setup-strip').count()) === 0,
    `${await page.locator('.setup-strip').count()} strip(s) left`);

  await page.click('#btn-fill-from-resume');
  await page.waitForSelector('#dlg-ask[open] .modal-plan', { timeout: 10000 });

  const rows = page.locator('#dlg-ask .plan-row');
  check('V12 §1 the resume proposes values in the same review card plan mode uses',
    (await rows.count()) === 4, `${await rows.count()} rows`);
  const cityRow = page.locator('#dlg-ask .plan-row', { hasText: 'City' }).first();
  check('THE POINT: the row that would overwrite what the user typed starts UNTICKED and is ' +
    'marked — a machine extraction must never quietly beat an afternoon of their own typing',
    (await cityRow.locator('input[type=checkbox]').isChecked()) === false
    && (await cityRow.locator('.plan-src-inferred').count()) === 1
    && /replaces/.test(await cityRow.locator('.plan-src').innerText()),
    await cityRow.locator('.plan-src').innerText());
  const titleRow = page.locator('#dlg-ask .plan-row', { hasText: 'Current job title' }).first();
  check('...while the empty ones start ticked, because filling those is the entire point',
    (await titleRow.locator('input[type=checkbox]').isChecked()) === true
    && /empty now/.test(await titleRow.locator('.plan-src').innerText()),
    await titleRow.locator('.plan-src').innerText());
  check('...and the button counts only what will actually be written',
    /Fill 3 fields/.test(await page.locator('#dlg-ask .modal-submit').innerText()),
    await page.locator('#dlg-ask .modal-submit').innerText());

  await page.click('#dlg-ask .modal-submit');
  await sleep(700);
  check('V12 §1 the accepted values land in the real boxes',
    (await page.locator('#pf-currentTitle').inputValue()) === 'Staff Engineer'
    && (await page.locator('#pf-currentCompany').inputValue()) === 'Acme',
    `${await page.locator('#pf-currentTitle').inputValue()} / ${await page.locator('#pf-currentCompany').inputValue()}`);
  check('THE OTHER POINT: and the unticked one did NOT — Bengaluru is still what they typed',
    (await page.locator('#pf-city').inputValue()) === 'Bengaluru',
    await page.locator('#pf-city').inputValue());
  check('...the meter moves with it, so the work shows',
    !/Current job title/.test(await page.locator('.pf-meter').innerText()),
    (await page.locator('.pf-meter').innerText()).replace(/\n/g, ' ').slice(0, 110));

  await page.close();
}

await browser.close();
await new Promise((r) => server.close(r));

console.log(fail ? `\n${fail} react check(s) FAILED` : '\nall react checks passed');
process.exit(fail ? 1 : 0);
