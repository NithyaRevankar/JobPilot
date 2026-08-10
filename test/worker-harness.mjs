// The recording session, against the REAL background/service-worker.js.
//
// Every other harness that touches recording reimplements the worker on the Node side
// (recorder-harness.mjs does, faithfully). That is the right call there — the thing under
// test is the content script — but it left the worker itself with no test at all, and the
// worker is where a demonstration is kept, capped, expired and thrown away.
//
// This stands up a chrome stub, imports the worker for real, and drives its message
// handler the way the panel and the content scripts do.
//
// Run: node test/worker-harness.mjs
let fail = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'ok  ' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) fail++;
};

// ------------------------------------------------------------------ chrome stub
const EXT = 'chrome-extension://jobpilottestid/';
const store = new Map();
const badgeText = { value: null };
const disarmed = [];
/** Everything the worker sent to a tab, so a check can assert on what a page was told. */
const painted = [];
let tabs = new Map();
let onMessage = null;
let onCreated = null;
let onRemoved = null;

globalThis.chrome = {
  sidePanel: { setPanelBehavior: () => Promise.resolve() },
  runtime: {
    getURL: (p) => EXT + p,
    onInstalled: { addListener: () => {} },
    onMessage: { addListener: (fn) => { onMessage = fn; } },
  },
  tabs: {
    onCreated: { addListener: (fn) => { onCreated = fn; } },
    onRemoved: { addListener: (fn) => { onRemoved = fn; } },
    get: (id) => (tabs.has(id) ? Promise.resolve(tabs.get(id)) : Promise.reject(new Error('no tab'))),
    sendMessage: (id, msg, opts) => {
      painted.push({ id, msg, opts });
      if (msg && msg.kind === 'jobpilot:rec-stop') disarmed.push(id);
      return Promise.resolve();
    },
  },
  action: {
    setBadgeText: ({ text }) => { badgeText.value = text; return Promise.resolve(); },
    setBadgeBackgroundColor: () => Promise.resolve(),
  },
  storage: {
    session: {
      get: (k) => Promise.resolve(store.has(k) ? { [k]: store.get(k) } : {}),
      set: (obj) => { for (const [k, v] of Object.entries(obj)) store.set(k, v); return Promise.resolve(); },
      remove: (k) => { store.delete(k); return Promise.resolve(); },
    },
  },
};

await import('../background/service-worker.js');

/** Send a message the way Chrome does, and resolve what the worker answers. */
const send = (msg, sender) => new Promise((resolve) => {
  const kept = onMessage(msg, sender, resolve);
  if (kept !== true) resolve(undefined);
});
const fromPanel = { url: `${EXT}sidepanel/panel.html` };
const fromTab = (id, url = 'https://acme.wd1.myworkdayjobs.com/apply') => ({ tab: { id }, url });
const step = (id, label = 'Fill "Name" = "Jane"') => ({ id, action: 'fill', label, locators: [{ by: 'id', value: 'n' }] });
const session = () => store.get('recSession');

tabs.set(1, { id: 1, url: 'https://acme.wd1.myworkdayjobs.com/apply', windowId: 9 });
tabs.set(2, { id: 2, url: 'https://mail.example.com/inbox', windowId: 9 });

// =============================================== the session is the panel's alone
let r = await send({ kind: 'jobpilot:rec-open', tabId: 1 }, fromTab(1));
check('a content script cannot open a recording session',
  r && r.ok === false && /side panel/i.test(r.error || ''), JSON.stringify(r));

r = await send({ kind: 'jobpilot:rec-close' }, fromTab(1));
check('...nor read one back (rec-close returns every value the user typed)',
  r && r.ok === false, JSON.stringify(r));

// ===================================================================== happy path
await send({ kind: 'jobpilot:rec-open', tabId: 1 }, fromPanel);
check('the panel opens a session and the toolbar says REC', badgeText.value === 'REC', String(badgeText.value));

r = await send({ kind: 'jobpilot:rec-hello' }, fromTab(1));
check('a frame in the watched tab is told it is inside a recording', r && r.recording === true, JSON.stringify(r));

r = await send({ kind: 'jobpilot:rec-step', step: step('f1:0') }, fromTab(1));
check('a step from that tab is banked', r && r.ok === true, JSON.stringify(r));

// Upsert, not append: the page coalesces as it records.
await send({ kind: 'jobpilot:rec-step', step: step('f1:0', 'Fill "Name" = "Jane Doe"') }, fromTab(1));
check('re-posting the same id REVISES the step instead of appending a second one',
  session().steps.length === 1 && /Jane Doe/.test(session().steps[0].label),
  JSON.stringify(session().steps.map((s) => s.label)));

// ============================================ THE BUG: steps from an unwatched tab
// The panel used to report these as "nothing was captured", which blamed the user and the
// page for a demonstration the worker had thrown away itself.
for (let i = 0; i < 3; i++) {
  r = await send({ kind: 'jobpilot:rec-step', step: step(`f2:${i}`) }, fromTab(2, 'https://mail.example.com/inbox'));
}
check('a step from a tab the session does not watch is REFUSED, not banked',
  r && r.ok === false && r.refused === true, JSON.stringify(r));
check('THE POINT: the frame is NOT told to stand down — the user may be sent back to it',
  r && r.recording === true, JSON.stringify(r));
check('...and the refusals are counted rather than silently dropped',
  session().refused.length === 3, JSON.stringify(session().refused));
check('...with the host, which is the only part of "tab 2" the user can act on',
  session().refused.every((x) => x.host === 'mail.example.com'), JSON.stringify(session().refused));
check('the banked steps are untouched by the refusals', session().steps.length === 1);

// ============================================================== adoption of new tabs
tabs.set(3, { id: 3, url: 'https://acme.wd1.myworkdayjobs.com/step2', windowId: 9 });
onCreated({ id: 3, openerTabId: 1, windowId: 9 });
await new Promise((res) => setTimeout(res, 10)); // the listener serialises through the queue
check('a tab the demonstration OPENED is adopted, so "Apply" opening a tab keeps recording',
  session().tabIds.includes(3), JSON.stringify(session().tabIds));
r = await send({ kind: 'jobpilot:rec-step', step: step('f3:0') }, fromTab(3));
check('...and its steps bank normally', r && r.ok === true && session().steps.length === 2);

tabs.set(4, { id: 4, url: 'https://news.example.com', windowId: 9 });
onCreated({ id: 4, openerTabId: undefined, windowId: 9 });
await new Promise((res) => setTimeout(res, 10));
check('a tab with no opener is NOT adopted — a recording must not follow the user around',
  !session().tabIds.includes(4), JSON.stringify(session().tabIds));

// ==================================================================== the §2 step cap
for (let i = 1; i <= 40; i++) await send({ kind: 'jobpilot:rec-step', step: step(`f1:${i}`) }, fromTab(1));
check('the demonstration is capped at 30 steps', session().steps.length === 30, String(session().steps.length));
check('...and what fell off the end is counted, so the panel can say the macro is short',
  session().dropped.length > 0, String(session().dropped.length));

// ================================================================== close and report
r = await send({ kind: 'jobpilot:rec-close' }, fromPanel);
check('close returns the demonstration', r.ok && r.steps.length === 30, String(r.steps.length));
check('...the refused count', r.refused === 3, String(r.refused));
check('...and the hosts they came from', r.refusedHosts.join(',') === 'mail.example.com', JSON.stringify(r.refusedHosts));
check('...the dropped count', r.dropped > 0, String(r.dropped));
check('the toolbar badge is cleared', badgeText.value === '', JSON.stringify(badgeText.value));
check('every tab in the session is told to stand down',
  disarmed.includes(1) && disarmed.includes(3), JSON.stringify(disarmed));
check('the session is gone from storage', !session());

// ============================================ §6: a session nobody owns is not a keylogger
// The panel heartbeats while its Recording dialog is up. When that stops the session must
// die — otherwise every page loaded afterwards arms a recorder nobody will ever stop.
await send({ kind: 'jobpilot:rec-open', tabId: 1 }, fromPanel);
const stale = session();
stale.aliveAt = Date.now() - 5 * 60 * 1000; // no word from the panel for five minutes
stale.steps = [step('f1:0')];
await chrome.storage.session.set({ recSession: stale });

r = await send({ kind: 'jobpilot:rec-hello' }, fromTab(1));
check('an orphaned session stops recording', r && r.recording === false, JSON.stringify(r));
check('...and its steps are destroyed rather than left sitting in storage',
  session().steps.length === 0, JSON.stringify(session().steps));
check('...but a TOMBSTONE is kept, so the panel can say what happened instead of "you did nothing"',
  session().expired === 'panel', JSON.stringify(session().expired));

r = await send({ kind: 'jobpilot:rec-close' }, fromPanel);
check('THE POINT: the panel is told the recording EXPIRED, not that it was empty',
  r.expired === 'panel' && r.steps.length === 0, JSON.stringify({ expired: r.expired, n: r.steps.length }));

// ======================================= one recorder, and it belongs to one run
//
// There is still exactly ONE recording session, because a demonstration is the user
// physically doing something and they can only be in one place. What concurrency changes
// is that a second run can now ask for it — and rec-close hands back every label and typed
// value the user produced, so "whoever asks" is a data leak, not just a lost recording.
store.clear();
painted.length = 0;

r = await send({ kind: 'jobpilot:rec-open', runId: 'A', tabId: 1 }, fromPanel);
check('a run opens a demonstration', r && r.ok === true, JSON.stringify(r));
await send({ kind: 'jobpilot:rec-step', step: step('f1:0', 'Fill "Password hint" = "my dog"') }, fromTab(1));

r = await send({ kind: 'jobpilot:rec-open', runId: 'B', tabId: 2 }, fromPanel);
check('a SECOND application cannot start one over the top of it — that used to overwrite ' +
  'silently, destroying a half-finished demonstration',
  r && r.ok === false && /already recording/i.test(r.error || ''), JSON.stringify(r));
check('...and the first run\'s steps are still banked', session().steps.length === 1);

r = await send({ kind: 'jobpilot:rec-close', runId: 'B' }, fromPanel);
check('THE POINT: a non-owner closing it is REFUSED — rec-close returns everything the ' +
  'user typed, so answering it would hand one application another\'s keystrokes',
  r && r.ok === false, JSON.stringify(r));
check('...and closing it did not happen either', session() && session().steps.length === 1);

r = await send({ kind: 'jobpilot:rec-tabs', runId: 'B' }, fromPanel);
check('...nor may a non-owner read which tabs are being watched', r && r.ok === false, JSON.stringify(r));

r = await send({ kind: 'jobpilot:rec-close', runId: 'A' }, fromPanel);
check('the OWNER closes it and gets its own steps back',
  r && r.ok === true && r.steps.length === 1, JSON.stringify(r));

// ==================================================== "controlled by JobPilot"
//
// The session that decides which tab shows the indicator. Everything below is about one
// property: the indicator is up exactly while a live panel is driving that exact tab, and
// there is no path — retarget, expiry, a page asking on its own — that leaves it claiming
// otherwise.

const ctrlPaint = (tabId) => [...painted].reverse().find((p) => p.id === tabId);
/** One run's control session. The worker keys them by runId — see CTRL_KEY. */
const ctrl = (runId = 'run-1') => (store.get('ctrlSessions') || {})[runId];
const fromFrame = (tabId, frameId) => ({ ...fromTab(tabId), frameId });

r = await send({ kind: 'jobpilot:ctrl-on', tabId: 1 }, fromTab(1));
check('a page cannot claim its own tab is being driven by JobPilot',
  r && r.ok === false && /side panel/i.test(r.error || ''), JSON.stringify(r));
check('...and nothing was written', !ctrl());

r = await send({ kind: 'jobpilot:ctrl-on', tabId: 1, status: 'fill e12 = "Jane"' }, fromPanel);
check('the panel marks a tab as controlled', r && r.ok === true && ctrl().tabId === 1);
let p = ctrlPaint(1);
check('...and the TOP FRAME is told to show it — never every frame, or a Workday form ' +
  'would draw three, two of them clipped inside the page',
  p.msg.kind === 'jobpilot:ctrl-show' && p.opts.frameId === 0, JSON.stringify(p));
check('...carrying the step, so the page can say what is being done to it',
  p.msg.status === 'fill e12 = "Jane"' && p.msg.mode === 'acting', JSON.stringify(p.msg));

r = await send({ kind: 'jobpilot:ctrl-hello' }, fromFrame(1, 0));
check('a page that loads mid-run asks and is told yes — this is what carries the indicator ' +
  'across the navigations the agent itself causes',
  r && r.controlled === true && r.status === 'fill e12 = "Jane"', JSON.stringify(r));

r = await send({ kind: 'jobpilot:ctrl-hello' }, fromFrame(1, 7));
check('an embedded ATS iframe asking is told NO — the top frame already shows it',
  r && r.controlled === false, JSON.stringify(r));

r = await send({ kind: 'jobpilot:ctrl-hello' }, fromFrame(2, 0));
check('a tab nobody is driving is told no', r && r.controlled === false, JSON.stringify(r));

// A run that follows "Apply" into a new tab, or whose working tab closes, re-targets
// (agent.js §10). Same run, different tab.
await send({ kind: 'jobpilot:ctrl-on', tabId: 2, status: 'read_page' }, fromPanel);
check('THE POINT: retargeting CLEARS the tab the run left — otherwise the indicator ' +
  'outlives the only thing that made it true, on a tab the user has gone back to using',
  ctrlPaint(1).msg.kind === 'jobpilot:ctrl-hide', JSON.stringify(ctrlPaint(1)));
check('...and the new tab is the one now showing it',
  ctrl().tabId === 2 && ctrlPaint(2).msg.kind === 'jobpilot:ctrl-show');

r = await send({ kind: 'jobpilot:ctrl-off' }, fromPanel);
check('the run ends and the indicator comes down',
  r.ok && !ctrl() && ctrlPaint(2).msg.kind === 'jobpilot:ctrl-hide', JSON.stringify(ctrlPaint(2)));

// ============================================ several applications at once
//
// The whole point of keying by runId. Two runs drive two tabs; each owns its own
// indicator, and neither run's beats, retargets or endings may disturb the other's.
tabs.set(3, { id: 3, url: 'https://boards.greenhouse.io/acme/jobs/7', windowId: 9 });
tabs.set(4, { id: 4, url: 'https://jobs.lever.co/acme/9', windowId: 9 });

await send({ kind: 'jobpilot:ctrl-on', runId: 'A', tabId: 3, status: 'fill "Name"' }, fromPanel);
await send({ kind: 'jobpilot:ctrl-on', runId: 'B', tabId: 4, status: 'click "Apply"' }, fromPanel);
check('two runs hold two indicators at once',
  ctrl('A').tabId === 3 && ctrl('B').tabId === 4,
  JSON.stringify(store.get('ctrlSessions')));
check('THE POINT: run B starting did NOT take run A\'s indicator down — with one session ' +
  'each beat tore down the other, on a tab that was still being typed into',
  ctrlPaint(3).msg.kind === 'jobpilot:ctrl-show', JSON.stringify(ctrlPaint(3)));

r = await send({ kind: 'jobpilot:ctrl-hello' }, fromFrame(3, 0));
check('each tab is told about the run that owns IT, not about whoever beat last',
  r && r.controlled === true && r.status === 'fill "Name"', JSON.stringify(r));
r = await send({ kind: 'jobpilot:ctrl-hello' }, fromFrame(4, 0));
check('...and so is the other one', r && r.controlled === true && r.status === 'click "Apply"',
  JSON.stringify(r));

// A run re-targets while another run is live: the move must stay inside run A.
await send({ kind: 'jobpilot:ctrl-on', runId: 'A', tabId: 1, status: 'read_page' }, fromPanel);
check('a retarget still clears the tab THAT run left', ctrlPaint(3).msg.kind === 'jobpilot:ctrl-hide');
check('...and leaves the other run\'s tab alone',
  ctrlPaint(4).msg.kind === 'jobpilot:ctrl-show' && ctrl('B').tabId === 4);

r = await send({ kind: 'jobpilot:ctrl-off', runId: 'A' }, fromPanel);
check('THE OTHER POINT: one application finishing takes down ITS indicator only',
  r.ok && !ctrl('A') && ctrl('B').tabId === 4, JSON.stringify(store.get('ctrlSessions')));
check('...and the tab it was on is cleared', ctrlPaint(1).msg.kind === 'jobpilot:ctrl-hide');
r = await send({ kind: 'jobpilot:ctrl-hello' }, fromFrame(4, 0));
check('...while the still-running application\'s page is still told it is being driven',
  r && r.controlled === true, JSON.stringify(r));

// A driven tab closes. Nothing depends on hearing it — entries expire — but the map must
// not carry dead tabs for the full idle window.
onRemoved(4, { windowId: 9, isWindowClosing: false });
await new Promise((resolve) => setTimeout(resolve, 0));
check('a closed tab drops its run\'s entry rather than waiting out the idle timeout',
  !ctrl('B'), JSON.stringify(store.get('ctrlSessions')));

// A panel that CRASHES sends no ctrl-off. The page tears its own indicator down when the
// beats stop (content-script.js) — this is the other half: the session must not survive to
// arm the NEXT page loaded in that tab with an indicator for a run that no longer exists.
await send({ kind: 'jobpilot:ctrl-on', tabId: 1, status: 'click e4' }, fromPanel);
const abandoned = ctrl();
abandoned.aliveAt = Date.now() - 5 * 60 * 1000;
await chrome.storage.session.set({ ctrlSessions: { 'run-1': abandoned } });

r = await send({ kind: 'jobpilot:ctrl-hello' }, fromFrame(1, 0));
check('a page loading into a session whose panel stopped beating is NOT marked as driven',
  r && r.controlled === false, JSON.stringify(r));
check('...and the dead session is gone rather than waiting to mark the page after it', !ctrl());

r = await send({ kind: 'jobpilot:ctrl-on' }, fromPanel);
check('a beat with no tab is refused rather than stored as a session pointing nowhere',
  r && r.ok === false, JSON.stringify(r));

console.log(fail ? `\n${fail} worker check(s) FAILED` : '\nall worker checks passed');
process.exit(fail ? 1 : 0);
