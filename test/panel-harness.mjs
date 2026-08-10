// panel-harness.mjs — the half of JobPilot the other four harnesses never touch.
//
// Every existing harness injects content/content-script.js into a page and drives
// window.__exec directly, which means `npm test` executed ZERO lines of sidepanel/js/*
// and background/*. That is not a footnote: the worst bugs this codebase has had —
// run_macro calling a method that does not exist, a recorded step losing the frame it
// was demonstrated in, read_errors reporting an all-clear for a frame it could not read —
// all lived in that untested half, and no harness could have caught any of them.
//
// So this one runs the real modules against a stubbed `chrome` and a stubbed provider.
// No Playwright, no browser: the panel is plain ES modules, and everything it touches is
// either chrome.* or fetch.

import assert from 'node:assert';

let passed = 0;
const failures = [];

function check(name, cond, detail = '') {
  if (cond) {
    passed++;
    console.log(`ok    ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// --------------------------------------------------------------- chrome stub

const store = { local: {}, session: {} };

/**
 * What each frame answers. Keyed `${tabId}:${frameId}` → (tool, args) => response.
 * A frame with no entry behaves like one with no content script: sendMessage rejects
 * the way Chrome does, which is what pingFrame and the inject-on-demand path read.
 */
let frameHandlers = new Map();
// Tabs the test has killed or had suspended. Chrome models both, and a run must tell them
// apart: a closed tab throws from tabs.get, a DISCARDED one does not.
const deadTabs = new Set();
const discardedTabs = new Set();
let frames = [{ frameId: 0, url: 'https://jobs.acme.com/apply' }];
/** Everything that reached a frame, so a test can assert on what the panel actually sent. */
let sent = [];

/** A chrome.* event stub: addListener/removeListener as Chrome has them, plus fire(). */
function tabEvent() {
  const listeners = new Set();
  return {
    addListener: (fn) => listeners.add(fn),
    removeListener: (fn) => listeners.delete(fn),
    fire: (...args) => { for (const fn of [...listeners]) fn(...args); },
  };
}

const areaStub = (bag) => ({
  async get(keys) {
    if (keys == null) return { ...bag };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    for (const k of list) if (k in bag) out[k] = bag[k];
    return out;
  },
  async set(obj) { Object.assign(bag, obj); },
  async remove(keys) {
    for (const k of (Array.isArray(keys) ? keys : [keys])) delete bag[k];
  },
  async setAccessLevel() {},
});

globalThis.chrome = {
  storage: { local: areaStub(store.local), session: areaStub(store.session) },
  runtime: {
    getURL: (p) => `chrome-extension://jobpilot/${p}`,
    getManifest: () => ({ version: '0.1.0' }),
    async sendMessage() { return { ok: true }; },
  },
  tabs: {
    async get(tabId) {
      if (tabId === 999 || deadTabs.has(tabId)) throw new Error(`No tab with id ${tabId}`);
      // status:'complete' keeps waitForComplete's settle path bounded in tests.
      // `discarded` is what Memory Saver sets on a background tab: get() still SUCCEEDS,
      // which is exactly why a run has to look at it.
      return {
        id: tabId,
        url: 'https://jobs.acme.com/apply',
        title: 'Apply',
        status: 'complete',
        discarded: discardedTabs.has(tabId),
      };
    },
    async update() {},
    // Real event surfaces, so the run's tab-following is exercised against the same
    // add/remove/fire lifecycle Chrome gives it. Tests fire them via .fire(...).
    onCreated: tabEvent(),
    onUpdated: tabEvent(),
    async sendMessage(tabId, msg, opts) {
      const frameId = (opts && opts.frameId) || 0;
      const handler = frameHandlers.get(`${tabId}:${frameId}`);
      if (!handler) {
        // Exactly the shape Chrome uses, so the inject-and-retry path is exercised.
        throw new Error('Could not establish connection. Receiving end does not exist.');
      }
      if (msg.kind === 'jobpilot:ping') return { ok: true, ready: true };
      sent.push({ tabId, frameId, tool: msg.tool, args: msg.args });
      return handler(msg.tool, msg.args);
    },
  },
  webNavigation: { async getAllFrames() { return frames; } },
  scripting: { async executeScript() { return []; } },
};

function resetWorld() {
  store.local = {};
  store.session = {};
  globalThis.chrome.storage.local = areaStub(store.local);
  globalThis.chrome.storage.session = areaStub(store.session);
  frameHandlers = new Map();
  deadTabs.clear();
  discardedTabs.clear();
  frames = [{ frameId: 0, url: 'https://jobs.acme.com/apply' }];
  sent = [];
}

// Imported AFTER the chrome stub exists — these modules read chrome at call time, but
// keeping the order explicit means a future top-level read cannot silently break this.
const { executeTool, runMacro, TOOL_DEFS } = await import('../sidepanel/js/tools.js');
const storage = await import('../sidepanel/js/storage.js');
const { AgentRunner } = await import('../sidepanel/js/agent.js');

const getTabId = async () => 1;

/** Every callback the loop may reach for, as no-ops. The panel supplies these for real. */
const cb = (over = {}) => ({
  onText() {}, onToolStart() {}, onToolEnd() {}, onStatus() {}, onDone() {},
  onError(e) { throw e; }, onMemory() {}, onAskUser: async () => null,
  onRequestSecret: async () => null, onRequestDemo: async () => null, ...over,
});

// ============================================================ CONTRACT-V6 §8
// A recorded step must remember the frame it was demonstrated in.

resetWorld();
{
  const saved = await storage.saveMacro({
    platform: 'greenhouse',
    name: 'Add work history',
    steps: [{
      action: 'fill',
      host: 'boards.greenhouse.io',
      label: 'Fill "Company"',
      value: 'Acme',
      locators: [{ by: 'label', value: 'Company' }],
    }],
  });
  const roundTrip = (await storage.getMacros())[0];
  check('V6 §8 a saved step KEEPS the host it was demonstrated in',
    roundTrip.steps[0].host === 'boards.greenhouse.io',
    `host=${JSON.stringify(roundTrip.steps[0].host)}`);
  check('...which is what makes replayStep\'s frame preference reachable at all',
    saved.steps[0].host === 'boards.greenhouse.io');

  // The scrub still has to hold: a host is a bare hostname, never a URL.
  const dirty = await storage.saveMacro({
    platform: 'lever',
    name: 'Trick',
    steps: [{
      action: 'fill',
      host: 'https://evil.example/path?q=1',
      label: 'Fill "Name"',
      value: 'x',
      locators: [{ by: 'label', value: 'Name' }],
    }],
  });
  check('V3 §4.1 a "host" that is not a bare hostname is dropped, not stored',
    dirty.steps[0].host === undefined,
    `host=${JSON.stringify(dirty.steps[0].host)}`);
}

// ================================================== a credential never lands in a label
resetWorld();
{
  const m = await storage.saveMacro({
    platform: 'workday',
    name: 'Log in',
    steps: [{
      action: 'fill',
      label: 'Fill "One-time code" = "483920"',
      value: '483920',
      locators: [{ by: 'label', value: 'One-time code' }],
    }],
  });
  const step = m.steps[0];
  check('V2 §0 a credential-looking fill becomes request_secret',
    step.action === 'request_secret', `action=${step.action}`);
  check('...and the recorded VALUE is gone',
    step.value === undefined, `value=${JSON.stringify(step.value)}`);
  check('...and the code does not survive in the label either',
    !JSON.stringify(step).includes('483920'), JSON.stringify(step.label));
}

// ========================================================== CONTRACT-V6 §5.2
// run_macro used to be 100% dead: agent.js passed `this.getTabId`, which was never
// assigned, so every replay threw a TypeError and was then marked broken forever.

resetWorld();
{
  await storage.saveMacro({
    platform: 'workday',
    name: 'Add work history',
    steps: [{ action: 'click', label: 'Click "Add"', locators: [{ by: 'text', value: 'Add' }] }],
  });

  const runner = new AgentRunner({ getTabId, callbacks: cb() });
  runner.memory = { platform: 'workday', label: 'Workday', host: 'jobs.acme.com' };

  // Before a run, there is no tab bound — and that must be a NAMED refusal, not a
  // TypeError that gets recorded as the macro's fault.
  const noRun = await runner.handleRunMacro({ name: 'Add work history' });
  check('V6 §5.2 run_macro with no bound tab refuses by name, not by TypeError',
    noRun.ok === false && /no working tab/i.test(noRun.error),
    noRun.error);
  check('...and a macro is NOT marked broken for that',
    (await storage.getMacros())[0].status === 'unverified',
    `status=${(await storage.getMacros())[0].status}`);

  // With the run-scoped resolver installed — what run() now does — the replay reaches
  // the page. This is the assertion that would have failed for the life of the feature.
  runner.getTabId = getTabId;
  frameHandlers.set('1:0', () => ({ ok: true, result: 'Clicked "Add".' }));
  const res = await runner.handleRunMacro({ name: 'Add work history' });
  check('V6 §5.2 THE ONE THAT MATTERS: run_macro actually replays on the page',
    res.ok === true && /replayed all 1 steps/.test(res.result),
    res.ok ? res.result.split('\n')[0] : res.error);
  check('...and the macro is marked working, so it is offered next time',
    (await storage.getMacros())[0].status === 'working');
}

// ================================ a by-design stop must not retire a working macro
resetWorld();
{
  await storage.saveMacro({
    platform: 'workday',
    name: 'Submit',
    steps: [
      { action: 'click', label: 'Click "Next"', locators: [{ by: 'text', value: 'Next' }] },
      { action: 'click', label: 'Click "Submit"', irreversible: true, locators: [{ by: 'text', value: 'Submit' }] },
    ],
  });
  frameHandlers.set('1:0', () => ({ ok: true, result: 'Clicked.' }));

  const runner = new AgentRunner({ getTabId, callbacks: cb() });
  runner.memory = { platform: 'workday', label: 'Workday', host: 'jobs.acme.com' };
  runner.getTabId = getTabId;

  const res = await runner.handleRunMacro({ name: 'Submit' });
  check('V6 §5.3 a macro stops before an irreversible step when Auto-submit is off',
    res.ok === false && /Auto-submit is off/.test(res.error), res.error.slice(0, 90));
  check('THE POINT: that stop is BY DESIGN, so the macro is not marked broken',
    (await storage.getMacros())[0].status !== 'broken',
    `status=${(await storage.getMacros())[0].status}`);

  const runner2 = new AgentRunner({ getTabId, callbacks: cb() });
  runner2.memory = runner.memory;
  runner2.getTabId = getTabId;
  const again = await runner2.handleRunMacro({ name: 'Submit' });
  check('...so it can still be run again, rather than being refused forever',
    /Auto-submit is off/.test(again.error), again.error.slice(0, 60));
}

// ============================ a step that "succeeded" without taking effect is a failure
resetWorld();
{
  const macro = {
    name: 'Fill name',
    steps: [{ action: 'fill', label: 'Fill "Name"', value: 'Jane', locators: [{ by: 'label', value: 'Name' }] }],
  };
  frameHandlers.set('1:0', () => ({
    ok: true,
    result: 'Tried to fill "Name" with "Jane" but the value did not stick. Current value: "".',
  }));
  const res = await runMacro(getTabId, macro, { autoSubmit: false, onSecret: async () => ({ ok: false }) });
  check('V3 §7.1 a macro whose steps did not stick does NOT report "replayed all steps"',
    res.ok === false && /did NOT take effect/.test(res.error),
    res.ok ? res.result.split('\n')[0] : res.error.split('\n')[0]);
}

// ==== ...and the same honesty for the OTHER soft-failure phrasings a step can return.
// The shaky-step filter only knew toolFill's wording, so a choose_option that "may not
// have registered" or a checkbox "still checked=false" replayed as a success — and the
// macro was marked good forever.
resetWorld();
{
  const cases = [
    ['choose_option', { action: 'choose_option', label: 'Choose "Work auth"', option: 'Yes', locators: [{ by: 'label', value: 'Work auth' }] },
      'Clicked option "Yes" in "Work auth", but the control reads back empty — the selection may not have registered. Call read_page to verify before moving on.'],
    ['set_checkbox', { action: 'set_checkbox', label: 'Check "I agree"', checked: true, locators: [{ by: 'label', value: 'I agree' }] },
      'Clicked checkbox "I agree" but it is still checked=false. It may be disabled or script-controlled — try click on its label instead.'],
  ];
  for (const [name, step, msg] of cases) {
    frameHandlers.set('1:0', () => ({ ok: true, result: msg }));
    const res = await runMacro(getTabId, { name: `m-${name}`, steps: [step] },
      { autoSubmit: false, onSecret: async () => ({ ok: false }) });
    check(`...a ${name} step that did not take effect also fails the macro`,
      res.ok === false && /did NOT take effect/.test(res.error || ''),
      res.ok ? res.result.split('\n')[0] : (res.error || '').split('\n')[0]);
  }
}

// ============================================================ CONTRACT-V6 §8
// "Nothing matched" and "I could not look" must never read the same.

resetWorld();
{
  frames = [
    { frameId: 0, url: 'https://jobs.acme.com/apply' },
    { frameId: 7, url: 'https://boards.greenhouse.io/embed' },
  ];
  // The main frame is clean; the ATS iframe — the one holding the form — cannot answer.
  frameHandlers.set('1:0', () => ({ ok: true, result: 'No visible errors.' }));
  frameHandlers.set('1:7', () => ({ ok: false, error: 'The frame is still loading.' }));

  const res = await executeTool('read_errors', {}, getTabId);
  check('V6 §8 read_errors does not report a flat all-clear for a frame it could not read',
    res.ok === true && /could NOT be read/.test(res.result),
    res.result.replace(/\n+/g, ' ').slice(0, 120));
  check('...and it NAMES the frame, so the model can go and look',
    /boards\.greenhouse\.io/.test(res.result));

  // With every frame answering, the ordinary all-clear is still the plain one.
  frameHandlers.set('1:7', () => ({ ok: true, result: 'No visible errors.' }));
  const clean = await executeTool('read_errors', {}, getTabId);
  check('...while a page that really is clean still says so, plainly',
    clean.result === 'No visible errors.', clean.result);
}

resetWorld();
{
  frames = [
    { frameId: 0, url: 'https://jobs.acme.com/apply' },
    { frameId: 7, url: 'https://boards.greenhouse.io/embed' },
  ];
  frameHandlers.set('1:0', () => ({ ok: true, result: 'No button named "Submit" — searched 40 visible elements in this frame.' }));
  frameHandlers.set('1:7', () => ({ ok: false, error: 'Frame was removed.' }));

  const res = await executeTool('find', { text: 'Submit' }, getTabId);
  check('V6 §8 a find MISS says how much of the page it could not search',
    /could NOT be read/.test(res.result),
    res.result.replace(/\n+/g, ' ').slice(-110));
}

// ============================================================ CONTRACT-V9 §2
// A modifier the model asked for is either sent or REFUSED BY NAME — never dropped.

resetWorld();
{
  frameHandlers.set('1:0', () => ({ ok: true, result: '1. click: clicked' }));
  await executeTool('dom_act', { actions: [{ op: 'click', ref: 'e1', ctrl: true }] }, getTabId);
  check('V9 §2 a modifier on click reaches the page',
    sent.at(-1).args.actions[0].ctrl === true,
    JSON.stringify(sent.at(-1).args.actions[0]));

  sent = [];
  // The content script is what refuses this. The panel's job is to FORWARD the flag so
  // the refusal can happen at all — stripping it here made the refusal unreachable and
  // silently granted a chord the model never got.
  await executeTool('dom_act', { actions: [{ op: 'type', ref: 'e1', value: 'x', ctrl: true }] }, getTabId);
  check('V9 §2 THE POINT: a modifier on an op that cannot hold one is FORWARDED, not stripped',
    sent.at(-1).args.actions[0].ctrl === true,
    JSON.stringify(sent.at(-1).args.actions[0]));
}

// ================================================== a truncated write is not a success
resetWorld();
{
  frameHandlers.set('1:0', () => ({ ok: true, result: '1. type: typed' }));
  const long = 'x'.repeat(1800);
  const res = await executeTool('dom_act', { actions: [{ op: 'type', ref: 'e1', value: long }] }, getTabId);
  check('V3 §7.1 an over-length value is capped at 500 characters',
    sent.at(-1).args.actions[0].value.length === 500,
    `sent ${sent.at(-1).args.actions[0].value.length} of ${long.length}`);
  check('THE POINT: and the result SAYS so, instead of self-verifying against the truncation',
    /1300 were NOT entered/.test(res.result),
    res.result.replace(/\n/g, ' ').slice(-100));
}

// ========================= a subframe ref must carry the frame it belongs to (V8 §1)
resetWorld();
{
  frames = [
    { frameId: 0, url: 'https://jobs.acme.com/apply' },
    { frameId: 7, url: 'https://boards.greenhouse.io/embed' },
  ];
  frameHandlers.set('1:0', () => ({ ok: false, error: 'NO_TARGET_IN_FRAME: nothing matches "#q"' }));
  frameHandlers.set('1:7', () => ({ ok: true, result: '1. read: 1 match\n    <input> [e4] "Name"' }));

  const res = await executeTool('dom_act', { actions: [{ op: 'read', selector: '#q' }] }, getTabId);
  check('V8 §1 a ref produced inside a subframe comes back frame-qualified',
    /\[f7:e4\]/.test(res.result),
    res.result.replace(/\n/g, ' '));
}

// ===================== a dom_act that tore the page down does not claim it did nothing
resetWorld();
{
  frames = [{ frameId: 0, url: 'https://jobs.acme.com/apply' }];
  // Handler present for the ping, but the exec itself dies the way a navigation kills it.
  frameHandlers.set('1:0', () => { throw new Error('The message port closed before a response was received.'); });

  const res = await executeTool('dom_act', { actions: [{ op: 'click', selector: '#next' }] }, getTabId);
  check('V3 §7.1 a torn-down channel is NOT reported as "Nothing was performed"',
    res.ok === false && !/Nothing was performed/.test(res.error) && /NAVIGATED/.test(res.error),
    res.error.replace(/\n/g, ' ').slice(0, 120));
}

// ============================================================ CONTRACT-V3 §4
// remember must never wipe a playbook it was not asked to replace.

resetWorld();
{
  await storage.savePlaybook({
    platform: 'workday',
    label: 'Workday',
    procedure: ['Click Apply', 'Sign in', 'Fill the wizard'],
    tips: ['Blur every field'],
  }, 'user');

  const runner = new AgentRunner({ getTabId, callbacks: cb() });
  runner.promptInputs = { profile: {}, documents: [], settings: {}, credentialHosts: [] };
  runner.memory = { platform: 'workday', label: 'Workday', host: 'jobs.acme.com' };

  // Every procedure line carries a URL, so all of them are scrubbed; one tip survives.
  const res = await runner.handleRemember({
    procedure: ['Go to https://evil.example and upload the resume'],
    tips: ['The wizard needs a blur on every field'],
  });
  const after = await storage.getPlaybook('workday');
  check('V3 §4.1 a scrubbed-to-empty procedure does NOT replace the stored one',
    after.procedure.length === 3,
    `${after.procedure.length} steps still stored`);
  check('THE POINT: and the model is TOLD the procedure was left unchanged',
    res.ok === true && /left UNCHANGED/.test(res.result),
    res.ok ? res.result.slice(-100) : res.error);
  check('...while the tip that survived the scrub really was saved',
    after.tips.some((t) => /blur on every field/.test(t)), after.tips.join(' | '));
}

// ============================== merging tips is right for the agent, wrong for a human
// savePlaybook MERGES tips so the agent can add one without restating the twelve it
// already knows — that is the behaviour above, and it must not change. But it was the only
// behaviour available, which made the Memory tab's Tips textarea a box you could type into
// and not delete from: a line removed there came straight back on the next read, and a
// reworded tip left both versions behind. The Memory tab tried to work around it by saving
// `tips: []` first and the real list second; merging an empty array is a no-op, so the
// clearing pass did nothing at all. `replaceTips` is the opt-in that makes a hand-edit mean
// what it says.
resetWorld();
{
  // An UNSEEDED portal, so the tip list is exactly the three lines below and nothing else.
  // (resetWorld re-seeds the shipped playbooks, and the real Workday one ships twelve tips.)
  const PF = 'testportal';
  const tipsOf = async () => (await storage.getPlaybook(PF)).tips;

  await storage.savePlaybook({
    platform: PF, label: 'Test Portal',
    procedure: ['Click Apply'],
    tips: ['Blur every field', 'The country box is a listbox', 'Typo teh wizard'],
  }, 'user');

  // The old work-around, verbatim, to pin down that it really is a no-op.
  await storage.savePlaybook({ platform: PF, tips: [] }, 'user');
  check('THE PREMISE: saving `tips: []` clears nothing — merging an empty array cannot',
    (await tipsOf()).length === 3, (await tipsOf()).join(' | '));

  await storage.savePlaybook({ platform: PF, tips: ['Blur every field'] }, 'user');
  const merged = await tipsOf();
  check('...so a hand-edit that DELETED two lines left all three in place',
    merged.length === 3, merged.join(' | '));
  check('...and the default merge de-duplicates, rather than doubling the kept one',
    merged.filter((t) => t === 'Blur every field').length === 1, merged.join(' | '));

  // What the Memory tab does now: one write, replaceTips, the two lines the user left.
  await storage.savePlaybook({
    platform: PF, tips: ['Blur every field', 'The country box is a listbox'], replaceTips: true,
  }, 'user');
  const replaced = await storage.getPlaybook(PF);
  check('replaceTips DELETES what the user deleted',
    replaced.tips.length === 2 && !replaced.tips.some((t) => /Typo teh/.test(t)),
    replaced.tips.join(' | '));
  check('...and leaves the procedure alone, because it said nothing about it',
    replaced.procedure.length === 1 && replaced.procedure[0] === 'Click Apply',
    replaced.procedure.join(' | '));

  // The agent's path must be untouched by any of this — it never sets the flag.
  await storage.savePlaybook({ platform: PF, tips: ['Uploads need a real file input'] }, 'agent');
  const afterAgent = await tipsOf();
  check('THE POINT: the agent still MERGES — one new tip, nothing forgotten',
    afterAgent.length === 3 && afterAgent.some((t) => /real file input/.test(t)),
    afterAgent.join(' | '));
}

// ================================= a macro saved mid-run becomes visible to that run
resetWorld();
{
  const runner = new AgentRunner({ getTabId, callbacks: cb() });
  runner.promptInputs = { profile: {}, documents: [], settings: {}, credentialHosts: [] };
  runner.memory = { platform: 'workday', label: 'Workday', host: 'jobs.acme.com', macros: [] };

  await storage.saveMacro({
    platform: 'workday',
    name: 'Add education',
    steps: [{ action: 'click', label: 'Click "Add"', locators: [{ by: 'text', value: 'Add' }] }],
  });
  await runner.reloadMacros();
  check('V6 §5.1 a macro saved during the run is visible to the rest of it',
    runner.memory.macros.length === 1 && runner.memory.macros[0].name === 'Add education',
    `${runner.memory.macros.length} macro(s)`);
  check('...and reloading macros does not drop the portal memory it belongs to',
    runner.memory.platform === 'workday' && runner.memory.host === 'jobs.acme.com',
    `platform=${runner.memory.platform} host=${runner.memory.host}`);
}

// ===================== a blocked detection is not the same as "you left the portal"
resetWorld();
{
  const runner = new AgentRunner({ getTabId, callbacks: cb() });
  runner.promptInputs = { profile: {}, documents: [], settings: {}, credentialHosts: [] };
  const memory = { platform: 'workday', label: 'Workday', host: 'jobs.acme.com', macros: [] };
  runner.memory = memory;

  // A BLOCKED probe is what detectByDom reports as {error:true} — the scripting call
  // throwing is exactly how a restricted page, a CSP, or a torn-down tab shows up.
  const realExec = globalThis.chrome.scripting.executeScript;
  globalThis.chrome.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page.'); };
  await runner.refreshMemory(1);
  check('V6 §8 a detection that could not RUN does not drop the live playbook',
    runner.memory === memory, runner.memory ? 'memory kept' : 'memory WIPED');

  // And the other half of the same rule: a probe that ran and genuinely found nothing
  // still drops it, or the model keeps getting Workday advice on a page that is not Workday.
  globalThis.chrome.scripting.executeScript = async () => [];
  await runner.refreshMemory(1);
  check('...while a probe that RAN and found nothing does drop it',
    runner.memory === null, runner.memory ? 'memory kept' : 'memory dropped');
  globalThis.chrome.scripting.executeScript = realExec;
}

// ====================================== CONTRACT-V10 §2 — one ask, many questions
// A page with five unknown fields must cost the user ONE interruption, not five.
{
  const { normalizeQuestions, formatAnswers } = await import('../sidepanel/js/agent.js');

  const { questions: many } = normalizeQuestions({
    questions: [
      { question: 'Expected salary?' },
      { question: 'Notice period?', options: ['Immediate', '30 days'] },
      { question: '' },                      // unlabelled box nobody could answer
      'Why this company?',                   // a bare string, which models do send
      { question: 'Cover letter', long: true },
    ],
  });
  check('V10 §2 every question in one ask_user survives as its own box',
    many.length === 4 && many[0].question === 'Expected salary?' && many[3].long === true,
    JSON.stringify(many.map((q) => q.question)));
  check('...a question with no text is dropped, not shown as an empty box',
    !many.some((q) => !q.question), JSON.stringify(many.map((q) => q.question)));
  check('...and per-question options ride along with the question they belong to',
    JSON.stringify(many[1].options) === JSON.stringify(['Immediate', '30 days']),
    JSON.stringify(many[1]));

  const { questions: legacy } = normalizeQuestions({ question: 'Expected salary?', options: ['40 LPA'] });
  check('...while the single-question shape still works unchanged',
    legacy.length === 1 && legacy[0].question === 'Expected salary?' && legacy[0].options.length === 1,
    JSON.stringify(legacy));
  check('...and an ask_user with nothing in it is caught, not shown as a blank modal',
    normalizeQuestions({}).questions.length === 0 && normalizeQuestions({ questions: [] }).questions.length === 0);

  const flood = normalizeQuestions({ questions: Array.from({ length: 30 }, (_, i) => ({ question: `Q${i}` })) });
  check('...a 30-question ask is capped rather than becoming a wall',
    flood.questions.length === 8, `${flood.questions.length} questions`);
  // A cap the model is not told about reads as "you asked 8 questions and got 8 answers".
  check('THE POINT: and the model is TOLD how many were not shown, so it can ask again',
    flood.dropped === 22 && /were NOT shown/.test(formatAnswers(flood.questions, [], flood.dropped)),
    `dropped=${flood.dropped}`);

  // The answer text is what the model reads back. With several boxes, an answer that
  // cannot be matched to its question is worse than no answer at all.
  const text = formatAnswers(
    [{ question: 'Expected salary?' }, { question: 'Notice period?' }, { question: 'Willing to relocate?' }],
    ['40 LPA', '', 'Yes'],
  );
  check('V10 §2 each answer is reported NEXT TO the question it answers',
    /1\. Expected salary\? → "40 LPA"/.test(text) && /3\. Willing to relocate\? → "Yes"/.test(text),
    text.replace(/\n/g, ' | '));
  check('...and a blank is reported as a decision, so it is not asked again',
    /\(left blank\)/.test(text) && /do NOT ask again/.test(text),
    text.replace(/\n/g, ' | ').slice(-90));
  check('...while a single question keeps its original one-line result',
    formatAnswers([{ question: 'Expected salary?' }], ['40 LPA']) === 'User answered: "40 LPA"',
    formatAnswers([{ question: 'Expected salary?' }], ['40 LPA']));
}

// ===== six questions crammed into ONE box — the shape the user actually got served
// Told to batch, the model batched into the STRING. One box, a hand-numbered reply, and
// one savedAnswers row keyed on all six questions at once — which matches nothing next
// time, so the same six come back on every application. "It keeps asking me things I
// already told it" is this bug, not a memory bug.
{
  const { normalizeQuestions, formatAnswers, splitEnumerated } = await import('../sidepanel/js/agent.js');

  const BLOB = 'Need your answers for the application questions: 1. Current/most recent job title? ' +
    '2. Current/most recent company? 3. Are you currently located in Bengaluru (where this role is based)? ' +
    '4. Have you ever worked at PricewaterhouseCoopers LLP (PwC)? 5. Do you have unrestricted right to work ' +
    'in India? 6. Do you now or in future require sponsorship / visa transfer or extension? You can answer ' +
    'like: "1. Senior Engineer 2. Acme 3. Yes 4. No 5. Yes 6. No"';

  const { questions: split, unpacked } = normalizeQuestions({ question: BLOB });
  check('a numbered list inside ONE question becomes one box per question',
    split.length === 6, `${split.length}: ${JSON.stringify(split.map((q) => q.question.slice(0, 28)))}`);
  check('...the first question keeps its text and loses the "Need your answers…" preamble',
    split[0].question === 'Current/most recent job title?', JSON.stringify(split[0].question));
  check('...a question containing its own brackets and numbers survives intact',
    split[3].question === 'Have you ever worked at PricewaterhouseCoopers LLP (PwC)?',
    JSON.stringify(split[3].question));
  check('THE POINT: the model\'s worked example is stripped off the LAST question, not shown as part of it',
    split[5].question === 'Do you now or in future require sponsorship / visa transfer or extension?',
    JSON.stringify(split[5].question));
  check('...and the model is told what it did, so it stops doing it mid-run',
    unpacked === 6 && /never numbered inside one string/.test(formatAnswers(split, [], 0, unpacked)),
    `unpacked=${unpacked}`);

  // Each part is now its own savedAnswers row, which is the whole point: next application
  // asks "What is your current job title?" and THAT row matches.
  const rows = storage.mergeSavedAnswers([], split.map((q, i) => ({ q: q.question, a: `A${i}` })));
  check('...so six reusable answers are saved instead of one unmatchable blob',
    rows.list.length === 6, `${rows.list.length} rows`);

  // Prose must be left alone. A false split is a box nobody can answer.
  check('ordinary prose with a digit in it is NOT split',
    splitEnumerated('What is your notice period? Answer in weeks, e.g. 4.') === null,
    JSON.stringify(splitEnumerated('What is your notice period? Answer in weeks, e.g. 4.')));
  check('...a list that does not start at 1 is NOT split',
    splitEnumerated('Rank these: 3. Python 4. Go') === null,
    JSON.stringify(splitEnumerated('Rank these: 3. Python 4. Go')));
  check('...a single numbered item is NOT split',
    splitEnumerated('Pick one: 1. Yes') === null, JSON.stringify(splitEnumerated('Pick one: 1. Yes')));
  check('...a version number or an amount cannot open an item',
    splitEnumerated('Do you know v1.2 of the spec, and can you earn Rs.1,20,000?') === null,
    JSON.stringify(splitEnumerated('Do you know v1.2 of the spec, and can you earn Rs.1,20,000?')));

  // A question the model attached choices to is ONE question by construction.
  const withOpts = normalizeQuestions({
    questions: [{ question: 'Rate your skills: 1. Beginner 2. Expert', options: ['1', '2'] }],
  });
  check('...and a question carrying its own option list is left whole',
    withOpts.questions.length === 1 && withOpts.unpacked === 0,
    JSON.stringify(withOpts.questions.map((q) => q.question)));
}

// ============ CONTRACT-V10 §3 — saved answers are rows, and a repeat replaces its row
{
  const first = storage.mergeSavedAnswers([], [
    { q: 'Expected salary?', a: '40 LPA' },
    { q: 'Notice period?', a: '30 days' },
    { q: 'Blank one', a: '' },              // never stored: an empty answer answers nothing
  ]);
  check('V10 §3 a batched ask saves one row PER question, not one blob',
    first.list.length === 2 && first.added === 2,
    JSON.stringify(first.list));

  // The context-management half: the same question, asked again on the next portal,
  // must replace its row. Appending put it in every future prompt twice.
  const second = storage.mergeSavedAnswers(first.list, [{ q: 'expected salary?  ', a: '45 LPA' }]);
  check('THE POINT: the same question re-answered REPLACES its row instead of appending',
    second.list.length === 2 && second.updated === 1 && second.added === 0,
    JSON.stringify(second.list));
  check('...and the row holds the newer answer',
    second.list.find((e) => /salary/i.test(e.q)).a === '45 LPA',
    JSON.stringify(second.list));

  // Every row goes into EVERY future system prompt, so the list is bounded like the
  // playbooks are. An essay is not a reusable answer and is not stored at all.
  const essay = storage.mergeSavedAnswers([], [{ q: 'Cover letter', a: 'x'.repeat(1200) }]);
  check('V10 §3 a cover-letter-length answer is NOT stored in every future prompt',
    essay.list.length === 0 && essay.skipped === 1, JSON.stringify({ n: essay.list.length, skipped: essay.skipped }));

  const full = storage.mergeSavedAnswers(
    Array.from({ length: 40 }, (_, i) => ({ q: `Q${i}`, a: `A${i}` })),
    [{ q: 'Newest', a: 'yes' }],
  );
  check('...and the list is capped, dropping the oldest rather than growing forever',
    full.list.length === 40 && full.evicted === 1
      && full.list[0].q === 'Q1' && full.list[39].q === 'Newest',
    `${full.list.length} rows, evicted=${full.evicted}, first=${full.list[0].q}`);
}

// ===================== a seed line over the cap is TRUNCATED MID-SENTENCE when stored
// Storage clamps every playbook line to 200 chars and each list to its cap. A shipped
// seed that exceeds either is silently cut — and it is always the end of the sentence
// that goes, which is where the instruction lives ("…and never ask the user").
{
  const { SEEDS } = await import('../sidepanel/js/playbook-seeds.js');
  const long = [];
  const overCap = [];
  for (const s of SEEDS) {
    for (const [kind, lines] of [['procedure', s.procedure], ['tips', s.tips]]) {
      lines.forEach((l, i) => { if (l.length > 200) long.push(`${s.platform}.${kind}[${i}]=${l.length}`); });
    }
    if (s.procedure.length > 12) overCap.push(`${s.platform}.procedure=${s.procedure.length}`);
    if (s.tips.length > 14) overCap.push(`${s.platform}.tips=${s.tips.length}`);
  }
  check('no shipped seed line is long enough to be truncated when it is stored',
    long.length === 0, long.join(', '));
  check('...and no seed list is over the cap that would drop its tail',
    overCap.length === 0, overCap.join(', '));

  // The seeds only reach an existing install if the version says they are newer.
  const stored = await storage.getPlaybooks();
  const gh = stored.find((p) => p.platform === 'greenhouse');
  check('THE POINT: the reworded EEO step actually reaches the stored playbook intact',
    gh && gh.procedure.some((l) => /never ask the user \(rule 16\)/.test(l)),
    gh ? gh.procedure.filter((l) => /EEO/.test(l)).join(' | ').slice(0, 120) : 'no greenhouse playbook');
}

// ===================== backup / restore: the only way data crosses an extension id
//
// An unpacked extension's id comes from the FOLDER Chrome loaded it from, and
// chrome.storage.local is keyed by that id. Rebuilding into dist/, re-cloning to another
// path or moving machines is a NEW id and an empty profile, with the old data stranded.
// These checks are about the file being a faithful enough copy to survive that trip.

resetWorld();
{
  // A populated install: every one of the eight keys, including the awkward ones.
  await storage.saveSettings({ baseUrl: 'https://api.openai.com/v1/', apiKey: 'sk-secret', model: 'gpt-4o-mini', maxSteps: 0 });
  await storage.saveProfile({ fullName: 'Ada Lovelace', savedAnswers: [{ q: 'Why us?', a: 'Analytical engines' }] });
  await storage.saveDocument({ name: 'cv.pdf', mime: 'application/pdf', size: 12, dataBase64: 'AAAA', text: 'Ada' });
  await storage.saveChats(storage.DEFAULT_RUN_ID, [{ role: 'user', content: 'hello' }]);
  await storage.saveMacro({
    platform: 'workday',
    name: 'Sign in',
    steps: [{ action: 'fill', label: 'Fill "Email"', value: 'ada@example.com', locators: [{ by: 'label', value: 'Email' }] }],
  });
  await storage.savePlaybook({ platform: 'greenhouse', tips: ['Ada was here'] }, 'user');
  await chrome.storage.local.set({
    siteNotes: [{ host: 'jobs.acme.com', platform: 'workday', notes: ['Two-step login'], updatedAt: 1 }],
    vault: { v: 1, protected: true, kdf: { salt: 'c2FsdA==', iterations: 600000, hash: 'SHA-256' }, iv: 'aXY=', ct: 'Y3Q=' },
  });

  const bundle = await storage.exportAllData();
  const file = JSON.stringify(bundle);

  check('the export envelope says what it is, so a stray .json cannot be mistaken for one',
    bundle.jobpilot === 'backup' && bundle.format === storage.BACKUP_FORMAT && bundle.version === '0.1.0');
  check('...and it carries every key JobPilot owns',
    storage.BACKUP_KEYS.every((k) => bundle.data[k] !== undefined),
    storage.BACKUP_KEYS.filter((k) => bundle.data[k] === undefined).join(', ') || 'all 8');

  // The trip: wipe everything, exactly as a fresh extension id would look, then restore.
  await storage.clearAllData();
  check('a wipe really does leave nothing behind',
    Object.keys(await chrome.storage.local.get(null)).length === 0);

  const { data } = storage.parseBackup(file);
  await storage.importAllData(data);

  const settings = await storage.getSettings();
  const profile = await storage.getProfile();
  const docs = await storage.getDocuments();
  const macros = await storage.getMacros();
  const notes = await storage.getSiteNotes();
  const chats = await storage.getChats();

  check('THE POINT: the API key survives the move to a new extension id',
    settings.apiKey === 'sk-secret', settings.apiKey);
  check('...and CONTRACT-V4 §1\'s maxSteps 0 comes back as 0, not as the 48 default',
    settings.maxSteps === 0, String(settings.maxSteps));
  check('...and the profile, saved answers included',
    profile.fullName === 'Ada Lovelace' && profile.savedAnswers[0].a === 'Analytical engines');
  check('...and the resume BYTES, not just its name — an upload needs them',
    docs.length === 1 && docs[0].dataBase64 === 'AAAA' && docs[0].isDefault === true);
  check('...and the chat transcript', chats.length === 1 && chats[0].content === 'hello');
  check('...and the macro, with the step it recorded',
    macros.length === 1 && macros[0].steps[0].value === 'ada@example.com');
  check('...and the site note', notes.length === 1 && notes[0].host === 'jobs.acme.com');
  check('...and the vault blob, byte for byte — its salt is what the passphrase derives against',
    (await storage.getVaultBlob()).kdf.salt === 'c2FsdA==');
  const gh = (await storage.getPlaybooks()).find((p) => p.platform === 'greenhouse');
  check('...and a playbook the user taught', gh && gh.tips.includes('Ada was here'));
}

// A DELETED seeded playbook must stay deleted. getPlaybooks() hides tombstones and re-seeds
// anything missing, so an export that read through it would hand back the Workday playbook
// the user deleted on purpose — and every restore would undo that delete again.
resetWorld();
{
  await storage.getPlaybooks();               // seed
  await storage.deletePlaybook('workday');    // tombstone
  const before = (await storage.getPlaybooks()).some((p) => p.platform === 'workday');

  const file = JSON.stringify(await storage.exportAllData());
  await storage.clearAllData();
  await storage.importAllData(storage.parseBackup(file).data);

  const after = (await storage.getPlaybooks()).some((p) => p.platform === 'workday');
  check('a deliberately deleted seeded playbook does not come back through a restore',
    before === false && after === false, `before=${before} after=${after}`);
}

// The migration this feature exists for: data rescued from an older build with a DevTools
// one-liner is a BARE chrome.storage.local dump, with no envelope around it.
resetWorld();
{
  const dump = JSON.stringify({
    profile: { fullName: 'From the console' },
    settings: { baseUrl: 'http://localhost:11434/v1', model: 'llama3' },
  });
  const { data, meta } = storage.parseBackup(dump);
  check('a raw chrome.storage.local dump is accepted — it is what a console rescue produces',
    meta.bare === true && data.profile.fullName === 'From the console');

  await storage.importAllData(data);
  check('...and it restores', (await storage.getProfile()).fullName === 'From the console');
}

// What must NOT be accepted.
{
  const rejects = [
    ['not JSON at all', '<!doctype html>'],
    ['a JSON array', '[1,2,3]'],
    ['JSON with none of our keys', '{"hello":"world"}'],
    ['an envelope from a NEWER JobPilot', JSON.stringify({ jobpilot: 'backup', format: 99, data: { profile: {} } })],
  ];
  for (const [label, text] of rejects) {
    let threw = '';
    try {
      storage.parseBackup(text);
    } catch (e) {
      threw = e.message;
    }
    check(`${label} is refused, with a message about the FILE`, Boolean(threw), threw);
  }
}

// A restore is a REPLACE. Anything the file does not carry goes, or the user ends up with
// yesterday's vault against today's profile.
resetWorld();
{
  await storage.saveProfile({ fullName: 'Still here' });
  await chrome.storage.local.set({ vault: { v: 1, protected: false, entries: [{ id: 'a' }] } });

  await storage.importAllData(storage.parseBackup(JSON.stringify({ settings: { model: 'x' } })).data);

  check('a key the backup does not carry is REMOVED, not quietly left behind',
    (await storage.getProfile()).fullName === '' && (await storage.getVaultBlob()) === undefined);
}

// A backup file is a text file the user can edit, so it is exactly as untrusted as a form
// field. CONTRACT-V2 §0: a macro must never carry a credential it will type into a login.
resetWorld();
{
  const hostile = JSON.stringify({
    settings: { maxTokens: 999999999, temperature: 47 },
    macros: [{
      platform: 'workday',
      name: 'Sign in',
      steps: [
        { action: 'fill', label: 'Fill "Password"', value: 'hunter2', locators: [{ by: 'label', value: 'Password' }] },
        { action: 'evaluate', label: 'whatever', locators: [{ by: 'css', value: 'body' }] },
      ],
    }],
    vault: { v: 1, protected: true, kdf: { salt: 'c2FsdA==' } }, // no iv, no ct, no iterations
  });

  const summary = await storage.importAllData(storage.parseBackup(hostile).data);
  const settings = await storage.getSettings();
  const step = (await storage.getMacros())[0].steps[0];

  check('an out-of-range setting is clamped on import, not written raw',
    settings.maxTokens === 200000 && settings.temperature === 2,
    `maxTokens=${settings.maxTokens} temperature=${settings.temperature}`);
  check('SECURITY: a hand-edited macro step that types a password is rewritten, value dropped',
    step.action === 'request_secret' && step.value === undefined && step.secretKind === 'password',
    JSON.stringify(step));
  check('...and an action no tool dispatches is dropped rather than stored',
    (await storage.getMacros())[0].steps.length === 1);
  check('a malformed vault blob is SKIPPED and reported, never written',
    (await storage.getVaultBlob()) === undefined && summary.skipped.some((s) => s.key === 'vault'),
    JSON.stringify(summary.skipped));
}

// ...and skipping it must not be a way to destroy a working vault.
resetWorld();
{
  const good = { v: 1, protected: false, entries: [{ id: 'keep-me' }] };
  await chrome.storage.local.set({ vault: good });
  await storage.importAllData(storage.parseBackup(JSON.stringify({
    profile: { fullName: 'New' },
    vault: { garbage: true },
  })).data);
  const blob = await storage.getVaultBlob();
  check('a vault that could not be READ from the file leaves the existing one alone',
    blob && blob.entries[0].id === 'keep-me', JSON.stringify(blob));
}

// ===================== context budget: what actually reaches the provider each step
// The floor of one request is ~9k tokens (system prompt + tool defs) before a single page
// is read, so everything below it has to be worth its size. These check the three places
// that were not bounded: duplicate page inventories, tool-call arguments, and a read of a
// page whose form lives in more than one frame.
{
  const { pruneMessages } = await import('../sidepanel/js/agent.js');
  const { budgetSections } = await import('../sidepanel/js/tools.js');

  const inventory = (n) => Array.from({ length: n }, (_, i) => `[e${i}] textbox label="Field ${i}"`).join('\n');
  const sizeOf = (msgs) => msgs.reduce(
    (n, m) => n + (m.content || '').length + JSON.stringify(m.toolCalls || '').length, 0);

  // read → act → read → verify: the loop that actually fills the window.
  const convo = [
    { role: 'user', content: 'Apply to this job.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_page', argsJson: '{}' }] },
    { role: 'tool', toolCallId: 'c1', content: inventory(200) },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{
        id: 'c2',
        name: 'dom_act',
        argsJson: JSON.stringify({ actions: [{ op: 'fill', ref: 'e1', value: 'y'.repeat(500) }] }),
      }],
    },
    { role: 'tool', toolCallId: 'c2', content: 'Filled 1 field.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c3', name: 'read_page', argsJson: '{}' }] },
    { role: 'tool', toolCallId: 'c3', content: inventory(200) },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c4', name: 'read_page', argsJson: '{"mode":"changes"}' }] },
    { role: 'tool', toolCallId: 'c4', content: 'No changes since the last read, in any of the 2 frames checked.' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c5', name: 'read_page', argsJson: '{}' }] },
    { role: 'tool', toolCallId: 'c5', content: inventory(200) },
  ];
  const before = JSON.stringify(convo);
  const out = pruneMessages(convo);
  const byId = (id) => out.find((m) => m.role === 'tool' && m.toolCallId === id);

  check('THE POINT: only the NEWEST read_page inventory survives — the earlier ones are markers',
    /^\(superseded/.test(byId('c1').content) && /^\(superseded/.test(byId('c3').content) &&
    byId('c5').content === inventory(200),
    `c1=${byId('c1').content.length}ch c3=${byId('c3').content.length}ch c5=${byId('c5').content.length}ch`);

  // c3 sits inside KEEP_RECENT. Age-based pruning alone could never have touched it, which
  // is exactly why three full page dumps used to pile up in the window at once.
  check('...including one still inside the recent window, which age-based pruning cannot reach',
    out.indexOf(byId('c3')) >= out.length - 6 && /^\(superseded/.test(byId('c3').content));

  check('a small change-report is NOT superseded — it records what an action did',
    byId('c4').content === 'No changes since the last read, in any of the 2 frames checked.');

  const oldArgs = out[3].toolCalls[0].argsJson;
  let reparsed = null;
  try { reparsed = JSON.parse(oldArgs); } catch { /* asserted below */ }
  check('an OLD tool call keeps its shape but loses its long values, and is still valid JSON',
    reparsed !== null && reparsed.actions[0].ref === 'e1' && reparsed.actions[0].op === 'fill' &&
    reparsed.actions[0].value.length < 100 && reparsed.actions[0].value.endsWith('…[cut]'),
    `${convo[3].toolCalls[0].argsJson.length}ch → ${oldArgs.length}ch`);

  check('every assistant tool_call still has its matching tool message (providers reject otherwise)',
    out.filter((m) => m.role === 'assistant').flatMap((m) => m.toolCalls || [])
      .every((tc) => out.some((m) => m.role === 'tool' && m.toolCallId === tc.id)));

  check('pruning does not mutate the runner\'s live history', JSON.stringify(convo) === before);

  check('the run costs less to send than it did before any of this',
    sizeOf(out) < sizeOf(convo) / 2,
    `${sizeOf(convo)}ch → ${sizeOf(out)}ch`);

  // A tool call the model sent as malformed JSON must survive untouched: the Anthropic path
  // parses argsJson and swallows a failure as {}, so a half-cut string would silently become
  // a tool call with no arguments at all.
  const broken = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'b1', name: 'fill', argsJson: `{"value":"${'z'.repeat(300)}` }] },
    { role: 'tool', toolCallId: 'b1', content: 'ok' },
    ...Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `filler ${i}` })),
  ];
  check('unparseable tool arguments are left exactly as they were, never half-cut',
    pruneMessages(broken)[0].toolCalls[0].argsJson === broken[0].toolCalls[0].argsJson);

  // ---- one read of a multi-frame page is now bounded as a whole
  const main = '== MAIN ==\n' + inventory(10);          // a shell, as on Workday
  const big1 = '== FRAME f1 (x.com) ==\n' + inventory(400);
  const big2 = '== FRAME f2 (y.com) ==\n' + inventory(400);

  check('a read that already fits is returned untouched',
    budgetSections([main]).join('\n\n') === main);

  const fitted = budgetSections([main, big1, big2]);
  const joined = fitted.join('\n\n');
  check('THE POINT: a three-frame read is bounded as a WHOLE, not per frame',
    joined.length < 13000 && [main, big1, big2].join('\n\n').length > 25000,
    `${[main, big1, big2].join('\n\n').length}ch → ${joined.length}ch`);

  check('...the small main frame survives whole rather than being cut to an equal share',
    fitted[0] === main, `${fitted[0].length}ch of ${main.length}ch`);

  check('...and each cut frame keeps its header and SAYS what was lost',
    fitted[1].startsWith('== FRAME f1 (x.com) ==') && /more characters of this frame were cut/.test(fitted[1]) &&
    /more characters of this frame were cut/.test(fitted[2]));

  check('...cuts land on a line boundary, never mid-ref',
    fitted[1].split('\n').filter((l) => l.startsWith('[e')).every((l) => /label="Field \d+"$/.test(l)));
}

// ============================ session stats: a number nobody can reconcile is not a stat
{
  const { SessionStats, modelInfo, costOf } = await import('../sidepanel/js/stats.js');

  // Anthropic reports cache tokens ALONGSIDE input_tokens; the OpenAI path subtracts them
  // out of prompt_tokens so both providers mean the same thing by `inputTokens`. Either
  // way all three occupy the window.
  {
    const s = new SessionStats();
    const info = modelInfo('claude-sonnet-5', {});
    s.beginStream();
    s.endStream({ inputTokens: 4000, outputTokens: 100, cacheReadTokens: 18000, cacheWriteTokens: 2000 }, info);
    check('THE POINT: cached tokens fill the context window too — they are cheaper, not absent',
      s.contextTokens === 24000, `contextTokens=${s.contextTokens} (was 4000 before the fix)`);
    check('...so the gauge reads the real occupancy instead of a fraction of it',
      Math.round(s.contextFraction(info) * 200000) === 24000);
  }

  // A request that was served ENTIRELY from cache reports inputTokens 0. The old guard
  // (`if (inTok > 0)`) skipped it, freezing the gauge at whatever it read before.
  {
    const s = new SessionStats();
    s.beginStream();
    s.endStream({ inputTokens: 5000, outputTokens: 50 }, modelInfo('claude-sonnet-5', {}));
    s.beginStream();
    s.endStream({ inputTokens: 0, outputTokens: 50, cacheReadTokens: 31000 }, modelInfo('claude-sonnet-5', {}));
    check('a fully-cached request still moves the gauge, rather than freezing it at the last one',
      s.contextTokens === 31000, `contextTokens=${s.contextTokens}`);
  }

  // Billing a cache read at the full input rate is ~10x the real price.
  {
    const info = modelInfo('claude-sonnet-5', {});
    const { usd: split } = costOf({ inputTokens: 2000, outputTokens: 100, cacheReadTokens: 20000 }, info);
    const { usd: asAllInput } = costOf({ inputTokens: 22000, outputTokens: 100 }, info);
    check('a cache read is priced as a cache read, not as fresh input',
      split < asAllInput / 2, `$${split.toFixed(5)} vs $${asAllInput.toFixed(5)} if billed as input`);
  }

  // What the screenshot actually showed: Context 24k (this conversation) sitting beside
  // Requests 355 / Input 6.08M / Session 9h21m (every conversation since the panel opened).
  {
    const s = new SessionStats();
    const info = modelInfo('claude-sonnet-5', {});
    for (let i = 0; i < 5; i++) {
      s.beginStream();
      s.endStream({ inputTokens: 20000, outputTokens: 60 }, info);
    }
    check('a conversation\'s totals really do accumulate while it runs',
      s.requests === 5 && s.inputTokens === 100000);
    s.reset();
    check('THE POINT: starting a new chat clears them, so no lifetime total outlives its context',
      s.requests === 0 && s.inputTokens === 0 && s.outputTokens === 0 &&
      s.contextTokens === 0 && s.cost === 0,
      `requests=${s.requests} input=${s.inputTokens} context=${s.contextTokens}`);
  }

  // The collapsed bar and the detail grid are one render of one instance. They disagreed.
  {
    const s = new SessionStats();
    const info = modelInfo('claude-sonnet-5', {});
    s.beginStream();
    s.liveStartedAt = Date.now() - 4000;   // a stream long enough to rate
    s.endStream({ inputTokens: 1000, outputTokens: 480 }, info);
    check('a finished stream leaves a session average both readouts can show',
      s.avgTokensPerSec > 0 && !s.streaming, `${s.avgTokensPerSec.toFixed(1)} tok/s`);
    s.beginStream();  // next request starts: live rate is 0 until the window fills
    check('...and the next request starting does not erase it — the average is still there',
      s.streaming && s.liveTokensPerSec === 0 && s.avgTokensPerSec > 0,
      'StatsBar falls back to avgTokensPerSec rather than rendering "—"');
  }
}

// ================================== rate limiting, now that several runs share one key
//
// Three applications at once triples the request rate, so 429 stops being rare. A run that
// dies on one dies halfway through a form, which is the expensive place to fail.
{
  const { retryDelayMs, RETRY_STATUSES, chatStream: stream } = await import('../sidepanel/js/llm.js');
  const withHeader = (v) => ({ headers: { get: (k) => (k === 'retry-after' ? v : null) } });

  check('Retry-After in seconds is honoured — a guess is worse than the number they gave us',
    retryDelayMs(withHeader('2'), 0) === 2000, String(retryDelayMs(withHeader('2'), 0)));
  check('...and the HTTP-date form too',
    retryDelayMs(withHeader(new Date(1_000_000 + 3000).toUTCString()), 0, 1_000_000) === 3000,
    String(retryDelayMs(withHeader(new Date(1_000_000 + 3000).toUTCString()), 0, 1_000_000)));
  check('...clamped, so a provider asking for an hour does not hang the run',
    retryDelayMs(withHeader('9999'), 0) === 20000);
  check('a past date is not a negative wait', retryDelayMs(withHeader(new Date(0).toUTCString()), 0, 1_000_000) === 0);

  // No header: exponential, but JITTERED. Three runs backing off by the same amount
  // arrive together again on every attempt; the jitter is what breaks the lockstep.
  const noHeader = { headers: { get: () => null } };
  const first = Array.from({ length: 24 }, () => retryDelayMs(noHeader, 0));
  check('backoff without a header stays inside its window',
    first.every((ms) => ms >= 500 && ms <= 1000), `${Math.min(...first)}–${Math.max(...first)}`);
  check('THE POINT: it is jittered, so concurrent runs do not retry in lockstep',
    new Set(first).size > 1, `${new Set(first).size} distinct values in 24`);
  const third = Array.from({ length: 24 }, () => retryDelayMs(noHeader, 2));
  check('...and it backs off as attempts mount',
    Math.min(...third) >= 2000, `${Math.min(...third)}–${Math.max(...third)}`);

  check('only rate-limit / unavailable statuses retry — a 401 must surface, not be retried',
    RETRY_STATUSES.includes(429) && RETRY_STATUSES.includes(503)
    && !RETRY_STATUSES.includes(401) && !RETRY_STATUSES.includes(500),
    RETRY_STATUSES.join(','));

  // End to end: a 429 followed by a good response is retried, transparently.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } });
    }
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n`));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n'));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );
  };
  let text = '';
  try {
    for await (const ev of stream({
      settings: { provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' },
      messages: [{ role: 'user', content: 'hi' }], tools: [], signal: undefined,
    })) {
      if (ev.type === 'text') text += ev.delta;
    }
  } finally { globalThis.fetch = realFetch; }
  check('a 429 is retried rather than failing the application mid-form',
    calls === 2 && text === 'hi', `${calls} call(s), text=${JSON.stringify(text)}`);
}

// ============ the OpenAI usage block, where cached tokens hid inside prompt_tokens
{
  const { chatStream } = await import('../sidepanel/js/llm.js');

  const sse = (lines) => new Response(
    new ReadableStream({
      start(c) {
        for (const l of lines) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(l)}\n`));
        c.enqueue(new TextEncoder().encode('data: [DONE]\n'));
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

  const drain = async (usageBlock) => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async () => sse([
      { choices: [{ delta: { content: 'hi' } }] },
      { choices: [{ delta: {} }], usage: usageBlock },
    ]);
    try {
      const events = [];
      for await (const ev of chatStream({
        settings: { provider: 'openai', baseUrl: 'https://x.test/v1', apiKey: 'k', model: 'gpt-4o', maxTokens: 100 },
        messages: [{ role: 'user', content: 'hi' }],
        tools: [],
      })) events.push(ev);
      return events.find((e) => e.type === 'usage');
    } finally { globalThis.fetch = realFetch; }
  };

  const cached = await drain({
    prompt_tokens: 22000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 20000 },
  });
  check('THE POINT: OpenAI counts cached tokens INSIDE prompt_tokens — they are split back out',
    cached.inputTokens === 2000 && cached.cacheReadTokens === 20000,
    `input=${cached.inputTokens} cacheRead=${cached.cacheReadTokens} (from prompt_tokens=22000)`);
  check('...and the two still add up to the occupancy the gauge has to show',
    cached.inputTokens + cached.cacheReadTokens === 22000);
  check('...and it is reported as measured, not estimated', cached.estimated === false);

  const plain = await drain({ prompt_tokens: 8000, completion_tokens: 40 });
  check('a server that reports no cache detail is unaffected',
    plain.inputTokens === 8000 && plain.cacheReadTokens === 0);

  // llama.cpp / some vLLM builds send prompt_tokens only. That must stay flagged.
  const partial = await drain({ prompt_tokens: 8000 });
  check('a partial usage block is still flagged as an estimate rather than passed off as measured',
    partial.estimated === true && partial.outputTokens > 0);
}

// ==================== an ATS iframe whose script is still loading gets a second chance
// Greenhouse/Lever/iCIMS insert their real form iframe with JS after the outer page
// renders. A read that arrives moments later found the frame, failed its ping, and
// dropped it silently — the model saw a shell page presented as the whole thing.
resetWorld();
{
  frames = [
    { frameId: 0, url: 'https://jobs.acme.com/apply' },
    { frameId: 7, url: 'https://boards.greenhouse.io/embed' },
  ];
  frameHandlers.set('1:0', () => ({ ok: true, result: 'No visible errors.' }));
  // The iframe's content script "finishes loading" 100ms in — after the first ping
  // pass has already failed, before the shared 250ms second chance.
  setTimeout(() => {
    frameHandlers.set('1:7', () => ({ ok: true, result: '- Field "Email" is marked invalid' }));
  }, 100);

  const res = await executeTool('read_errors', {}, getTabId);
  check('V4 §7 a frame whose script was still loading is retried, not silently dropped',
    res.ok && /FRAME f7/.test(res.result) && /marked invalid/.test(res.result),
    (res.result || res.error || '').replace(/\n/g, ' ').slice(0, 100));
}

// ======================= a blank freeform Location is synthesized from its parts
resetWorld();
{
  await storage.saveProfile({
    fullName: 'Jane Doe', email: 'jane@example.com',
    city: 'Bengaluru', state: 'Karnataka', country: 'India',
  });
  frameHandlers.set('1:0', () => ({ ok: true, result: 'Filled 3 fields.' }));
  await executeTool('autofill', {}, getTabId);
  const call = sent.find((s) => s.tool === 'autofill');
  check('V4 §7 a profile with structured city/state/country still fills a single Location box',
    Boolean(call) && call.args.fields.location === 'Bengaluru, Karnataka, India',
    JSON.stringify(call && call.args.fields.location));
}

// ============================================ ApplyPilot port — follow the new tab
// A plain "Apply" opens the real application in a NEW tab on most job boards, and a run
// pinned to the old tab then reads a page the flow has already left — a silent failed
// application every time. The run must follow the tab, and must SAY it followed, in the
// result of the tool that caused it. These run the WHOLE loop against a scripted SSE
// provider — the first tests to do so, because the behaviour lives in run()'s closure.

const sse = (lines) => new Response(
  new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(l)}\n`));
      c.enqueue(new TextEncoder().encode('data: [DONE]\n'));
      c.close();
    },
  }),
  { status: 200, headers: { 'content-type': 'text/event-stream' } },
);
const toolCallSse = (id, name, args) => sse([
  { choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: JSON.stringify(args) } }] } }] },
]);
/** Nudge waitForComplete along: fire 'complete' after its listener has had time to arm. */
const settleTab = (id) => {
  for (const ms of [30, 150, 400]) {
    setTimeout(() => chrome.tabs.onUpdated.fire(id, { status: 'complete' }), ms);
  }
};
const scriptedRun = async (rounds, onDone, opts = {}) => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => (rounds.shift())();
  const runner = new AgentRunner({
    getTabId, callbacks: cb(onDone ? { onDone } : {}), ...opts,
  });
  try {
    await runner.run('apply to this job');
  } finally { globalThis.fetch = realFetch; }
  return runner;
};

resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' });

  // --- the click itself opens the tab → its own result says so, next tool runs there.
  frameHandlers.set('1:0', (tool) => {
    if (tool === 'click') {
      chrome.tabs.onCreated.fire({ id: 42, openerTabId: 1 });
      settleTab(42);
      return { ok: true, result: 'Clicked "Apply".' };
    }
    return { ok: true, result: 'OLD TAB' };
  });
  frameHandlers.set('42:0', () => ({ ok: true, result: 'NEW TAB PAGE\nELEMENTS:\n(nothing interactive)' }));

  let doneArgs = null;
  const runner = await scriptedRun([
    () => toolCallSse('t1', 'click', { ref: 'e1' }),
    () => toolCallSse('t2', 'read_page', {}),
    () => toolCallSse('t3', 'done', { status: 'ready_for_review', summary: 'done' }),
  ], (d) => { doneArgs = d; });

  const clickResult = runner.messages.find((m) => m.role === 'tool' && /Clicked "Apply"/.test(m.content));
  check('V11 a click that opened a tab SAYS so in its own result',
    Boolean(clickResult) && /opened a NEW tab/.test(clickResult.content) && /read_page before acting/.test(clickResult.content),
    clickResult ? clickResult.content.replace(/\n/g, ' ').slice(-90) : '(no click result found)');
  const read = sent.find((s) => s.tool === 'read_page');
  check('THE POINT: the next tool runs in the NEW tab, not the one the flow left',
    Boolean(read) && read.tabId === 42, `read_page went to tab ${read && read.tabId}`);
  check('...and the run still finishes normally',
    Boolean(doneArgs) && doneArgs.status === 'ready_for_review', JSON.stringify(doneArgs));
}

// ============ a tab that opens LATE (window.open on a timer) is adopted at the next tool
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' });
  frameHandlers.set('1:0', () => ({ ok: true, result: 'Clicked "Apply".' }));
  frameHandlers.set('43:0', () => ({ ok: true, result: 'NEW TAB PAGE\nELEMENTS:\n(nothing interactive)' }));

  const runner = await scriptedRun([
    () => toolCallSse('t1', 'click', { ref: 'e1' }),
    () => {
      // The popup arrives while the model is thinking — after the click's result, within
      // the grace window. The next page tool must adopt it BEFORE it runs.
      chrome.tabs.onCreated.fire({ id: 43, openerTabId: 1 });
      settleTab(43);
      return toolCallSse('t2', 'read_page', {});
    },
    () => toolCallSse('t3', 'done', { status: 'ready_for_review', summary: 'done' }),
  ]);

  const readResult = runner.messages.find((m) => m.role === 'tool' && /NEW TAB PAGE/.test(m.content));
  check('V11 a late-spawned tab is adopted before the NEXT tool, which runs in it',
    Boolean(readResult) && /previous action opened a NEW tab/.test(readResult.content)
      && /already ran in the new tab/.test(readResult.content),
    readResult ? readResult.content.replace(/\n/g, ' ').slice(-90) : '(read_page never reached tab 43)');
  const read = sent.find((s) => s.tool === 'read_page');
  check('...really in the new tab', Boolean(read) && read.tabId === 43, `tab ${read && read.tabId}`);
}

// ======== a spawned tab that died, and one the working tab did not open, are NOT adopted
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' });
  frameHandlers.set('1:0', (tool) => {
    if (tool === 'click') {
      chrome.tabs.onCreated.fire({ id: 999, openerTabId: 1 }); // closes immediately (get throws)
      chrome.tabs.onCreated.fire({ id: 42, openerTabId: 7 });  // someone else's tab
      return { ok: true, result: 'Clicked "Apply".' };
    }
    return { ok: true, result: 'STILL THE WORKING TAB' };
  });

  const runner = await scriptedRun([
    () => toolCallSse('t1', 'click', { ref: 'e1' }),
    () => toolCallSse('t2', 'read_page', {}),
    () => toolCallSse('t3', 'done', { status: 'ready_for_review', summary: 'done' }),
  ]);

  const clickResult = runner.messages.find((m) => m.role === 'tool' && /Clicked "Apply"/.test(m.content));
  check('a dead popup and a foreign tab do NOT hijack the run',
    Boolean(clickResult) && !/NEW tab/.test(clickResult.content),
    clickResult ? clickResult.content.replace(/\n/g, ' ').slice(0, 90) : '(no click result)');
  const read = sent.find((s) => s.tool === 'read_page');
  check('...and the next tool still runs in the working tab',
    Boolean(read) && read.tabId === 1, `tab ${read && read.tabId}`);
}

// ====== two tabs from one click: the FIRST-created one is the application, later ones
// are popups/ads riding the click. Adopting newest-first once put a run on an ad
// interstitial while the SSO tab sat behind it.
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' });
  frameHandlers.set('1:0', (tool) => {
    if (tool === 'click') {
      chrome.tabs.onCreated.fire({ id: 50, openerTabId: 1 }); // the real application tab
      chrome.tabs.onCreated.fire({ id: 51, openerTabId: 1 }); // an ad popup, created second
      settleTab(50);
      return { ok: true, result: 'Clicked "Apply".' };
    }
    return { ok: true, result: 'OLD TAB' };
  });
  frameHandlers.set('50:0', () => ({ ok: true, result: 'APPLICATION PAGE\nELEMENTS:\n(nothing interactive)' }));

  const runner = await scriptedRun([
    () => toolCallSse('t1', 'click', { ref: 'e1' }),
    () => toolCallSse('t2', 'read_page', {}),
    () => toolCallSse('t3', 'done', { status: 'ready_for_review', summary: 'done' }),
  ]);

  const read = sent.find((s) => s.tool === 'read_page');
  check('two spawned tabs: the run adopts the FIRST-created one, not the popup',
    Boolean(read) && read.tabId === 50, `read_page went to tab ${read && read.tabId}`);
  const clickResult = runner.messages.find((m) => m.role === 'tool' && /Clicked "Apply"/.test(m.content));
  check('...and the note admits another tab also opened',
    Boolean(clickResult) && /1 more tab opened at the same time/.test(clickResult.content),
    clickResult ? clickResult.content.replace(/\n/g, ' ').slice(-110) : '(no click result)');
}

// ================================================ several applications at once
//
// The two ways one run could reach into another run's tab. Both used to be possible, and
// both are silent: two runs on one tab share the content script's single refMap, so the
// second run's "click e7" lands on whatever element the first run's read_page numbered 7.
// Nothing throws. The user finds out when the wrong answer is submitted.

// --- the closed-tab fallback must NOT grab whatever tab is in front
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' });
  // The working tab dies mid-run, and tab 2 — another application — is the active one.
  frameHandlers.set('1:0', (tool) => {
    if (tool === 'click') { deadTabs.add(1); return { ok: true, result: 'Clicked "Next".' }; }
    return { ok: true, result: 'STILL TAB 1' };
  });
  frameHandlers.set('2:0', () => ({ ok: true, result: "THE OTHER APPLICATION'S PAGE" }));

  const runner = await scriptedRun([
    () => toolCallSse('t1', 'click', { ref: 'e1' }),
    () => toolCallSse('t2', 'read_page', {}),
    () => toolCallSse('t3', 'done', { status: 'blocked', summary: 'tab gone' }),
  ]);

  const read = sent.find((s) => s.tool === 'read_page');
  check('THE POINT: a run whose tab closed does NOT retarget onto the active tab — that is ' +
    'very likely the tab another application is being filled in',
    !read || read.tabId !== 2, `read_page went to tab ${read && read.tabId}`);
  const err = runner.messages.find((m) => m.role === 'tool' && /working tab was closed/.test(m.content));
  check('...and the model is told plainly, rather than quietly acting somewhere else',
    Boolean(err) && /no other tab open/.test(err.content),
    err ? err.content.replace(/\n/g, ' ').slice(0, 100) : '(no closed-tab error)');
  check('...and it never touched the other application\'s page',
    !runner.messages.some((m) => /THE OTHER APPLICATION/.test(m.content || '')));
}

// --- a spawned tab another run already owns is declined, and SAID so
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' });
  frameHandlers.set('1:0', (tool) => {
    if (tool === 'click') {
      chrome.tabs.onCreated.fire({ id: 60, openerTabId: 1 });
      settleTab(60);
      return { ok: true, result: 'Clicked "Apply".' };
    }
    return { ok: true, result: 'STILL THE WORKING TAB' };
  });
  frameHandlers.set('60:0', () => ({ ok: true, result: 'THE OTHER RUN\'S PAGE' }));

  // Tab 60 belongs to a different application already.
  const tabsStub = { ownerOf: (id) => (id === 60 ? 'run-other' : null), claim: () => {}, release: () => {} };
  const runner = await scriptedRun([
    () => toolCallSse('t1', 'click', { ref: 'e1' }),
    () => toolCallSse('t2', 'read_page', {}),
    () => toolCallSse('t3', 'done', { status: 'ready_for_review', summary: 'done' }),
  ], null, { runId: 'run-mine', tabs: tabsStub });

  const read = sent.find((s) => s.tool === 'read_page');
  check('a tab another application is already driving is NOT adopted',
    Boolean(read) && read.tabId === 1, `read_page went to tab ${read && read.tabId}`);
  const clickResult = runner.messages.find((m) => m.role === 'tool' && /Clicked "Apply"/.test(m.content));
  check('THE OTHER POINT: it says so rather than declining silently — an unfollowed tab was ' +
    '"a failed application every time", which is why adoption exists at all',
    Boolean(clickResult) && /ANOTHER application/.test(clickResult.content),
    clickResult ? clickResult.content.replace(/\n/g, ' ').slice(-110) : '(no click result)');
}

// --- a tab the browser DISCARDED is reported, not silently acted on
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' });
  frameHandlers.set('1:0', (tool) => {
    if (tool === 'click') {
      // Memory Saver suspends a background tab. chrome.tabs.get still SUCCEEDS.
      discardedTabs.add(1);
      return { ok: true, result: 'Clicked "Next".' };
    }
    return { ok: true, result: 'STILL TAB 1' };
  });

  const runner = await scriptedRun([
    () => toolCallSse('t1', 'click', { ref: 'e1' }),
    () => toolCallSse('t2', 'read_page', {}),
    () => toolCallSse('t3', 'done', { status: 'blocked', summary: 'suspended' }),
  ]);

  const err = runner.messages.find((m) => m.role === 'tool' && /suspended by the browser/.test(m.content));
  check('a DISCARDED tab is reported — tabs.get still succeeds, so nothing else would notice ' +
    'that every ref the model holds is dead',
    Boolean(err) && /call read_page/.test(err.content),
    err ? err.content.replace(/\n/g, ' ').slice(0, 100) : '(discard went unreported)');
}

// ================================ ApplyPilot port — the prompt carries the craft
{
  const { buildSystemPrompt } = await import('../sidepanel/js/prompts.js');
  const p = buildSystemPrompt({
    profile: { fullName: 'Jane Doe', salary: '150000 USD' },
    documents: [], settings: {}, credentialHosts: [],
  });
  check('the prompt tells the model the run follows new tabs (rule 17)',
    /follows it automatically/.test(p) && /read_page before anything else/.test(p));
  check('...and that captchas belong to the user, including invisible ones (rule 18)',
    /CAPTCHAs are the user's job/.test(p) && /invisible captcha/.test(p));
  check('...and carries the application craft: salary midpoint, hourly ÷ 2080',
    /## Application craft/.test(p) && /midpoint/.test(p) && /2080/.test(p));
  check('...distrust of ATS parsing, and the pre-submit review pass',
    /Distrust everything an ATS parsed/.test(p) && /Before the final submit/.test(p));
  check('...and the give-up rule, so a stuck run stops instead of looping',
    /3 genuinely different approaches/.test(p));
  check('...and the already-applied rule, in MEANING not string-match — portals refuse in ' +
    'their own language, and the user hears the portal\'s answer instead of "Blocked"',
    /already_applied/.test(p) && /Sie haben sich bereits/.test(p) && /any language/.test(p));
  check('...which also forbids the tempting workaround: never a second account under a ' +
    'different email',
    /NEVER create a second account/.test(p));
}

// ==================================== "already applied" is an outcome, not an error
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm' });
  const doneDef = TOOL_DEFS.find((t) => t.function.name === 'done');
  check('the done tool offers already_applied, so the model can say it honestly',
    doneDef.function.parameters.properties.status.enum.includes('already_applied'),
    doneDef.function.parameters.properties.status.enum.join(','));

  let outcome = null;
  await scriptedRun([
    () => toolCallSse('t1', 'done', {
      status: 'already_applied',
      summary: 'Sie haben sich bereits für diese Stelle beworben.',
    }),
  ], (o) => { outcome = o; });
  check('...and the loop hands the status through to the UI untouched, with the portal\'s ' +
    'own words as the summary',
    Boolean(outcome) && outcome.status === 'already_applied'
    && /bereits/.test(outcome.summary), JSON.stringify(outcome));
}

// ==================================================== CONTRACT-V11 — plan mode
//
// One card per form page instead of an interruption per unknown. The parts worth testing
// are the ones where being wrong is silent: a value typed into a real job application that
// the user unticked, a value they corrected that got filled anyway, or a "worked out" row
// wearing the chip that says "this came from your profile, no need to look".

const plan = await import('../sidepanel/js/plan.js');
const modalQueue = await import('../sidepanel/react/modal-queue.js');

// --- normalizePlanFills: everything rejected says WHY
{
  const { fills, refused } = plan.normalizePlanFills([
    { ref: 'e1', label: 'First name', value: 'Nithya' },
    { ref: 'button.apply', label: 'Bad ref', value: 'x' },
    { ref: 'e2', label: 'Password', value: 'hunter2' },
    { ref: 'e3', label: 'Resume', value: 'cv.pdf', tool: 'upload_file' },
    { ref: 'e4', label: 'Empty', value: '   ' },
    'not an object',
  ]);
  check('V11 a plan keeps the entries it can use',
    fills.length === 1 && fills[0].ref === 'e1', JSON.stringify(fills));
  check('...and an unusable ref is refused with a reason, not dropped silently',
    refused.some((r) => /unusable ref/.test(r)), refused.join(' | '));
  check('THE POINT: a credential never reaches the card — a rendered password is a leaked ' +
    'one even if the fill downstream is refused',
    refused.some((r) => /credential/.test(r)) && !JSON.stringify(fills).includes('hunter2'),
    refused.join(' | '));
  check('...a plan carries VALUES, so upload_file is refused as a tool',
    refused.some((r) => /upload_file/.test(r)), refused.join(' | '));
  check('...and an entry with no value is named rather than padding the card with a blank row',
    refused.some((r) => /no value/.test(r)), refused.join(' | '));
}

// --- a repeated ref is the model correcting itself: the LATER value wins, and it fills once
{
  const { fills } = plan.normalizePlanFills([
    { ref: 'e7', label: 'Country', value: 'Indi' },
    { ref: 'e7', label: 'Country', value: 'India' },
  ]);
  check('V11 two entries for one ref fill ONCE, with the later value',
    fills.length === 1 && fills[0].value === 'India', JSON.stringify(fills));
}

// --- the cap counts what it dropped, so the model can plan the rest
{
  const many = Array.from({ length: plan.MAX_PLAN_FILLS + 5 }, (_, i) => ({
    ref: `e${i + 1}`, label: `F${i}`, value: `v${i}`,
  }));
  const { fills, dropped } = plan.normalizePlanFills(many);
  check('V11 a plan past the cap is truncated and the overflow is COUNTED',
    fills.length === plan.MAX_PLAN_FILLS && dropped === 5, `${fills.length} kept, ${dropped} dropped`);
}

// --- set_checkbox travels as Yes/No and arrives as a boolean
{
  const { fills } = plan.normalizePlanFills([
    { ref: 'e1', label: 'Agree', value: true, tool: 'set_checkbox' },
    { ref: 'e2', label: 'Subscribe', value: 'no', tool: 'set_checkbox' },
  ]);
  check('V11 a checkbox reads as Yes/No on the card, not as a bare `true`',
    fills[0].value === 'Yes' && fills[1].value === 'No', JSON.stringify(fills.map((f) => f.value)));
  check('...and converts back to a boolean for the tool',
    plan.planArgsFor(fills[0]).checked === true && plan.planArgsFor(fills[1]).checked === false);
  check('...while the other three tools carry their own argument name',
    plan.planArgsFor({ ref: 'e1', tool: 'fill', value: 'x' }).value === 'x'
    && plan.planArgsFor({ ref: 'e1', tool: 'choose_option', value: 'x' }).option === 'x'
    && plan.planArgsFor({ ref: 'e1', tool: 'select_option', value: 'x' }).option === 'x');
}

// --- provenance is COMPUTED. This is the chip the user decides what to read by.
{
  const profile = {
    fullName: 'Nithya Raman',
    phone: '555-0100',
    country: 'India',
    savedAnswers: [{ q: 'Why this company?', a: 'I admire the platform work.' }],
  };
  const src = (v) => plan.provenanceOf(v, profile);
  check('V11 a value that matches a profile field is traced to it BY NAME',
    src('555-0100').source === 'profile' && /Phone/i.test(src('555-0100').detail),
    JSON.stringify(src('555-0100')));
  check('...matching ignores presentation, so a form wanting INDIA still reads as the profile',
    src('  INDIA  ').source === 'profile', JSON.stringify(src('  INDIA  ')));
  check('...the first/last split rule 6 asks for is traced too, or the two most ordinary ' +
    'rows on every form would be badged "worked out" and the chip would cry wolf',
    src('Nithya').detail === 'first name' && src('Raman').detail === 'last name',
    `${src('Nithya').detail} / ${src('Raman').detail}`);
  check('...an earlier answer is marked as one',
    src('I admire the platform work.').source === 'saved', JSON.stringify(src('I admire the platform work.')));
  check('THE POINT: anything the profile does not back is "inferred" — and nothing is ' +
    'fuzzy-matched, so a value the model CHANGED is flagged rather than waved through',
    src('The model wrote this').source === 'inferred' && src('555-0101').source === 'inferred',
    JSON.stringify(src('555-0101')));
}

// --- the tool result has to countermand the model's instinct to refill
{
  const text = plan.formatPlanResult({
    results: [
      { entry: { ref: 'e1', label: 'First name', value: 'Nithya' }, status: 'ok' },
      { entry: { ref: 'e2', label: 'Salary' }, status: 'skipped' },
      { entry: { ref: 'e3', label: 'Country' }, status: 'failed', detail: 'Stale ref.\nFRESH PAGE: …' },
    ],
  });
  check('V11 the result names what was filled and forbids refilling it',
    /First name/.test(text) && /do NOT fill these again/i.test(text), text.slice(0, 80));
  check('THE POINT: an unticked field is reported as the USER\'S DECISION — the model\'s ' +
    'instinct on an empty field is to fill it, and here that instinct is wrong',
    /unticked these/.test(text) && /not an oversight/.test(text) && /do not fill them/i.test(text),
    text.replace(/\n/g, ' ').slice(-160));
  check('...and a failure carries only its first line, not the snapshot glued behind it',
    /Country.*Stale ref\./.test(text) && !/FRESH PAGE/.test(text));
}

// --- the modal's plan encoding round-trips values that contain commas and newlines
{
  const field = { name: 'plan', type: 'plan', rows: [{ value: 'a, b' }, { value: 'line1\nline2' }] };
  const initial = modalQueue.initialValues([field]).plan;
  check('V11 every plan row starts ticked — the card is an approval, not a selection',
    initial.length === 2 && initial.every((r) => r.include === true), JSON.stringify(initial));
  const encoded = modalQueue.fieldValueOf(field, [
    { include: true, value: 'a, b' },
    { include: false, value: 'line1\nline2' },
  ]);
  const back = modalQueue.decodePlanRows(encoded);
  check('...and a value carrying commas and newlines survives the encoding intact',
    back[0].value === 'a, b' && back[1].value === 'line1\nline2' && back[1].include === false,
    JSON.stringify(back));
  check('THE POINT: a malformed payload decodes to NOTHING approved, never to blanket approval',
    modalQueue.decodePlanRows('{{garbage').length === 0
    && modalQueue.decodePlanRows(undefined).length === 0);
}

// --- end to end: the approved plan is what reaches the page, and only that
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', planMode: 'ask' });
  frameHandlers.set('1:0', () => ({ ok: true, result: 'OK' }));

  let shown = null;
  const runner = await scriptedRun([
    () => toolCallSse('t1', 'propose_plan', {
      fills: [
        { ref: 'e1', label: 'First name', value: 'Nithya' },
        { ref: 'e2', label: 'Salary', value: '$150k' },
        { ref: 'e3', label: 'Country', value: 'Indi', tool: 'choose_option' },
      ],
      unknowns: [{ question: 'Why this company?' }],
    }),
    () => toolCallSse('t2', 'done', { status: 'ready_for_review', summary: 'filled' }),
  ], null, {
    callbacks: cb({
      onProposePlan: async (p) => {
        shown = p;
        return {
          // e1 approved as-is, e2 unticked, e3 corrected.
          fills: [
            { ...p.rows[0], include: true },
            { ...p.rows[1], include: false },
            { ...p.rows[2], include: true, value: 'India' },
          ],
          answers: ['Because of the platform work.'],
        };
      },
    }),
  });

  const fills = sent.filter((s) => s.tool === 'fill' || s.tool === 'choose_option');
  check('V11 the plan reaches the panel with its questions and its rows',
    Boolean(shown) && shown.rows.length === 3 && shown.unknowns.length === 1,
    shown ? `${shown.rows.length} rows, ${shown.unknowns.length} questions` : '(never shown)');
  check('THE POINT: an unticked row is never typed into the application',
    !fills.some((f) => f.args.ref === 'e2'), JSON.stringify(fills.map((f) => f.args.ref)));
  check('...and a value the user CORRECTED is the one that gets filled, not the model\'s',
    fills.some((f) => f.args.ref === 'e3' && f.args.option === 'India'),
    JSON.stringify(fills.map((f) => f.args)));
  check('...each entry goes out with the tool the plan named for it',
    fills.filter((f) => f.tool === 'choose_option').length === 1
    && fills.filter((f) => f.tool === 'fill').length === 1);

  const result = runner.messages.find((m) => m.role === 'tool' && /Plan approved/.test(m.content || ''));
  check('...the model is told the answers came back but are NOT yet filled',
    Boolean(result) && /platform work/.test(result.content) && /NOT filled yet/.test(result.content),
    result ? result.content.replace(/\n/g, ' ').slice(-120) : '(no plan result)');
}

// --- a dismissed plan must not become "fill them one at a time" instead
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', planMode: 'ask' });
  frameHandlers.set('1:0', () => ({ ok: true, result: 'OK' }));

  const runner = await scriptedRun([
    () => toolCallSse('t1', 'propose_plan', { fills: [{ ref: 'e1', label: 'First name', value: 'Nithya' }] }),
    () => toolCallSse('t2', 'done', { status: 'ready_for_review', summary: 'stopped' }),
  ], null, { callbacks: cb({ onProposePlan: async () => null }) });

  check('V11 a dismissed plan fills NOTHING',
    !sent.some((s) => s.tool === 'fill'), JSON.stringify(sent.map((s) => s.tool)));
  const msg = runner.messages.find((m) => m.role === 'tool' && /dismissed the plan/.test(m.content || ''));
  check('THE POINT: and the model is told not to route around the refusal field by field — ' +
    'every value it proposed is still one it believes in',
    Boolean(msg) && /do not fill these fields one at a time/i.test(msg.content),
    msg ? msg.content.replace(/\n/g, ' ').slice(-110) : '(no dismissal result)');
}

// --- the gate fires exactly once, then gets out of the way
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', planMode: 'ask' });
  frameHandlers.set('1:0', () => ({ ok: true, result: 'Filled e1.' }));

  const runner = await scriptedRun([
    () => toolCallSse('t1', 'fill', { ref: 'e1', value: 'Nithya' }),
    () => toolCallSse('t2', 'fill', { ref: 'e1', value: 'Nithya' }),
    () => toolCallSse('t3', 'done', { status: 'ready_for_review', summary: 'ok' }),
  ], null, { callbacks: cb({ onProposePlan: async () => null }) });

  const refusals = runner.messages.filter((m) => m.role === 'tool' && /Plan mode is on/.test(m.content || ''));
  check('V11 the first unplanned fill is refused and told to plan the page',
    refusals.length === 1, `${refusals.length} refusals`);
  check('THE POINT: the identical retry goes THROUGH — hard enforcement would kill a run on ' +
    'a page the model simply cannot plan, and a filled application beats an unfilled one',
    sent.filter((s) => s.tool === 'fill').length === 1,
    JSON.stringify(sent.map((s) => s.tool)));
}

// --- plan mode off: the tool is not offered at all
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', planMode: 'off' });
  frameHandlers.set('1:0', () => ({ ok: true, result: 'Filled e1.' }));

  const bodies = [];
  const realFetch = globalThis.fetch;
  const rounds = [
    () => toolCallSse('t1', 'fill', { ref: 'e1', value: 'Nithya' }),
    () => toolCallSse('t2', 'done', { status: 'ready_for_review', summary: 'ok' }),
  ];
  globalThis.fetch = async (_url, init) => { bodies.push(JSON.parse(init.body)); return (rounds.shift())(); };
  try {
    await new AgentRunner({ getTabId, callbacks: cb({ onProposePlan: async () => null }) }).run('apply');
  } finally { globalThis.fetch = realFetch; }

  const names = bodies[0].tools.map((t) => t.function.name);
  check('V11 with plan mode off the model is never SHOWN propose_plan — a tool it may not ' +
    'call would just occupy tokens in the schema block of every step',
    !names.includes('propose_plan'), `${names.length} tools offered`);
  check('...and no rule about it rides on the prompt either',
    !/PLAN MODE IS ON/.test(bodies[0].messages[0].content));
  check('...so an ordinary fill goes straight through, exactly as before plan mode existed',
    sent.filter((s) => s.tool === 'fill').length === 1);
}

// --- 'auto': the card appears only when there is something to decide
resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', planMode: 'auto' });
  await storage.saveProfile({ fullName: 'Nithya Raman', phone: '555-0100' });
  frameHandlers.set('1:0', () => ({ ok: true, result: 'OK' }));

  let cards = 0;
  await scriptedRun([
    () => toolCallSse('t1', 'propose_plan', {
      fills: [
        { ref: 'e1', label: 'First name', value: 'Nithya' },
        { ref: 'e2', label: 'Phone', value: '555-0100' },
      ],
    }),
    () => toolCallSse('t2', 'done', { status: 'ready_for_review', summary: 'ok' }),
  ], null, { callbacks: cb({ onProposePlan: async () => { cards++; return null; } }) });

  check('V11 in "auto" a page whose every value came from the profile is filled WITHOUT ' +
    'stopping the user — that is what makes later wizard pages invisible',
    cards === 0 && sent.filter((s) => s.tool === 'fill').length === 2,
    `${cards} cards, ${sent.filter((s) => s.tool === 'fill').length} fills`);
}

resetWorld();
{
  await storage.saveSettings({ provider: 'openai', baseUrl: 'https://llm.test/v1', apiKey: 'k', model: 'm', planMode: 'auto' });
  await storage.saveProfile({ fullName: 'Nithya Raman', phone: '555-0100' });
  frameHandlers.set('1:0', () => ({ ok: true, result: 'OK' }));

  let cards = 0;
  await scriptedRun([
    () => toolCallSse('t1', 'propose_plan', {
      fills: [
        { ref: 'e1', label: 'First name', value: 'Nithya' },
        { ref: 'e2', label: 'Why us?', value: 'A sentence the model composed.' },
      ],
    }),
    () => toolCallSse('t2', 'done', { status: 'ready_for_review', summary: 'ok' }),
  ], null, { callbacks: cb({ onProposePlan: async () => { cards++; return null; } }) });

  check('THE POINT: one value the profile does not back brings the card straight back — ' +
    '"auto" skips the review, never the judgement calls',
    cards === 1, `${cards} cards`);
}

// --- questions crammed into one string are unpacked here too
{
  const runner = new AgentRunner({ getTabId, callbacks: cb() });
  runner.promptInputs = { profile: {} };
  let seen = null;
  runner.cb = cb({ onProposePlan: async (p) => { seen = p; return null; } });
  await runner.handleProposePlan(
    { unknowns: [{ question: '1. Notice period? 2. Salary? 3. Visa?' }] },
    getTabId, undefined, 'ask',
  );
  check('V11 a plan\'s unknowns go through the SAME unpacking ask_user uses — one blob ' +
    'saved as one answer row is exactly as unmatchable whichever tool collected it',
    Boolean(seen) && seen.unknowns.length === 3, seen ? JSON.stringify(seen.unknowns.map((q) => q.question)) : '(not shown)');
}

// ============================================================== tool definitions
{
  const names = TOOL_DEFS.map((t) => t.function.name);
  check('every tool the loop dispatches has a definition the model can see',
    ['read_page', 'find', 'dom_act', 'run_macro', 'request_demo', 'remember', 'request_secret', 'propose_plan']
      .every((n) => names.includes(n)),
    `${names.length} tools`);
  assert.ok(names.length > 0);
}

console.log('');
if (failures.length) {
  console.log(`${failures.length} FAILING`);
  process.exit(1);
}
console.log(`all panel checks passed (${passed})`);
