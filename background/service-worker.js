// JobPilot background worker. Deliberately minimal: the agent loop lives in the
// side panel page (persistent while open), which sidesteps MV3 service-worker
// idle termination entirely. This worker wires up panel opening, and owns the
// recording session (CONTRACT-V6 §8).

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error('[jobpilot] setPanelBehavior failed:', err));

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    console.debug('[jobpilot] installed');
  }
});

// ------------------------------------------------------- recording session
// CONTRACT-V6 §8. The session lives HERE, not in the page.
//
// The first cut of this feature kept the steps in the content script's module
// scope and armed only the top frame. But a demonstration is *precisely* the
// thing that navigates, opens a tab, or happens inside an embedded ATS iframe —
// the user is showing us how to get past an obstacle, and getting past it moves
// them. All three of those destroy page-scoped state, so the recorder captured
// nothing and the panel then told the user *they* had done nothing.
//
// Storage: chrome.storage.session is memory-only and never touches disk. A
// half-finished demonstration must not survive the browser closing.

const REC_KEY = 'recSession';
const STEP_CAP = 30; // CONTRACT-V6 §2 — the worker owns it: it is the only place that sees every frame

// §6 asks: how do we know the user still wants this recording? The honest answer is "the
// panel is still there asking for it" — NOT "it has been under N minutes". A wall-clock
// deadline sounds safe and is not: a real demonstration waits for an OTP, uploads a file,
// or is simply read slowly, and a deadline would then destroy a recording the user was in
// the middle of and blame them for it. So the panel says "still here" while its Recording
// dialog is up, and the session dies when that stops — which is exactly the condition §6
// cares about (the panel is gone and nobody owns the recorder any more).
const REC_IDLE_MS = 90 * 1000;       // no word from the panel for this long → it is gone
const REC_MAX_MS = 60 * 60 * 1000;   // absolute runaway backstop, never reached in practice
const TOMBSTONE_TTL_MS = 10 * 60 * 1000; // an unclaimed expiry tombstone stops mattering

// The session stays at the DEFAULT access level: trusted contexts only, so a content
// script cannot read it.
//
// An earlier cut opened it to untrusted contexts so every frame could check "am I
// recording?" without a message — cheap, and on an ad-heavy page that is thirty messages
// saved. But the value under this key is the live demonstration: every step, with the
// LABELS and VALUES the user typed. Opening it made all of that readable from our content
// script in every frame of every tab, including third-party iframes we inject into by
// `<all_urls>`. That is the wrong shape for the one feature that watches the user type,
// and V2 §0's discipline — a credential exists in exactly the places that must hold it —
// applies to what surrounds a credential too.
//
// So the frames ask over messaging instead (greetRecorder → rec-hello). One extra message
// per frame on load, in exchange for the recording never being legible from a page's frame.

/**
 * Frames post steps concurrently, and every post is a read-modify-write of one
 * storage key. Without a queue two frames racing lose a step, which would show
 * up as the recorder silently dropping half a demonstration.
 */
let queue = Promise.resolve();
function serial(fn) {
  const run = queue.then(fn, fn);
  queue = run.catch(() => {});
  return run;
}

async function readSession() {
  const got = await chrome.storage.session.get(REC_KEY);
  return got[REC_KEY] || null;
}

function writeSession(session) {
  return session
    ? chrome.storage.session.set({ [REC_KEY]: session })
    : chrome.storage.session.remove(REC_KEY);
}

/**
 * Is this tab part of a LIVE recording?
 *
 * The expiry is not housekeeping, it is the §6 guarantee. Close the side panel
 * mid-demonstration and rec-close never runs — the session would sit here, and every page
 * loaded afterwards would ask, be told yes, and arm a recorder that nobody is ever going to
 * stop. That is a background keylogger, which is the one thing this feature must never be.
 *
 * So the test is "is the panel still asking for this?", not "has it been under N minutes?".
 * The panel heartbeats while its Recording dialog is up; the session dies when that stops.
 * That kills the orphan without ever killing a slow demonstration.
 */
async function isRecording(tabId) {
  const session = await readSession();
  if (session && session.expired) {
    // The tombstone exists so the panel can explain what happened. Once nobody has come
    // back for it, it is just a stale record of a demonstration sitting in storage.
    if (Date.now() - (session.expiredAt || 0) > TOMBSTONE_TTL_MS) await writeSession(null);
    return false;
  }
  if (!session) return false;

  const orphaned = Date.now() - session.aliveAt > REC_IDLE_MS;
  const runaway = Date.now() - session.startedAt > REC_MAX_MS;
  if (orphaned || runaway) {
    // Do not just delete it. The user may still click Done, and if the session has silently
    // vanished the panel would report "nothing was captured" — destroying the recording AND
    // blaming the user for it, which is the precise failure this whole rewrite exists to
    // kill. Keep a tombstone so the panel can say what actually happened. The steps go now,
    // though: a recording nobody owns must not sit around holding what the user typed.
    session.expired = orphaned ? 'panel' : 'timeout';
    session.expiredAt = Date.now();
    session.steps = [];
    await writeSession(session);
    badge(false);
    // Clearing OUR record of the session is not the same as stopping the RECORDERS. The
    // frames are still armed and still listening; the only page-side teardown is pagehide,
    // and that is deliberately skipped for bfcache. Without this the listeners outlive the
    // session they belonged to and keep firing on the user's real application for the rest
    // of the tab's life — a background keylogger, which §6 says this must never become.
    disarm(session.tabIds);
    return false;
  }
  return tabId != null && session.tabIds.includes(tabId);
}

/**
 * Tell every frame of every tab in a session to stand down.
 *
 * Omitting `frameId` broadcasts to all frames in the tab, which is what we want: the
 * session spans frames, so the teardown has to as well. Best-effort by design — a tab that
 * has closed, or a frame with no content script, simply has nothing to disarm.
 */
function disarm(tabIds) {
  for (const tabId of tabIds || []) {
    chrome.tabs.sendMessage(tabId, { kind: 'jobpilot:rec-stop' }).catch(() => {});
  }
}

/** The panel saying "I am still here, and the user is still demonstrating." */
async function touchSession() {
  const session = await readSession();
  if (!session || session.expired) return { ok: false };
  session.aliveAt = Date.now();
  await writeSession(session);
  return { ok: true };
}

/**
 * The one signal that survives the panel. The panel's own "Recording…" dialog vanishes the
 * moment the panel is closed or crashes, and until the session expires the recorder in the
 * page is still armed — so the toolbar has to say so, in the one place the user can always
 * see, whatever happened to the panel.
 */
function badge(on) {
  chrome.action.setBadgeText({ text: on ? 'REC' : '' }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ color: '#c0392b' }).catch(() => {});
}

async function hostOf(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return new URL(tab.url || '').hostname;
  } catch {
    return '';
  }
}

/**
 * Open the recording session — refusing if one is already live.
 *
 * There is deliberately still only ONE recorder, because a demonstration is the user
 * physically doing something in a page and they can only be in one place at a time. What
 * changed with concurrent runs is that a second run can now ASK, and this used to overwrite
 * without looking: the first run's half-finished demonstration was destroyed, and its
 * rec-close then handed it the second run's steps. So the session names its owner, and
 * everyone else is told no.
 */
async function openSession(runId, tabId) {
  const live = await readSession();
  if (live && !live.expired && Date.now() - live.aliveAt <= REC_IDLE_MS) {
    if ((live.ownerRunId || DEFAULT_RUN_ID) !== (runId || DEFAULT_RUN_ID)) {
      return {
        ok: false,
        error: 'Another application is already recording a demonstration. Finish that one first.',
      };
    }
  }
  const now = Date.now();
  await writeSession({
    ownerRunId: runId || DEFAULT_RUN_ID,
    tabIds: [tabId],
    steps: [],
    dropped: [],
    // Steps that arrived from a tab this session is NOT watching. They are still
    // discarded — the session watches the tab the user pointed it at, and adopting
    // whatever tab happens to post is how a demonstration quietly starts recording
    // somebody's mail. But they are COUNTED, because "the user did nothing" and "the
    // user did six things somewhere we were not looking" are opposite problems with
    // opposite fixes, and the panel used to report them with the same sentence.
    refused: [],
    host: await hostOf(tabId), // where the user meant to demonstrate
    startedAt: now,
    aliveAt: now,
  });
  badge(true);
  return { ok: true };
}

/**
 * Refuse a recording message from a run that does not own the session — `null` when it
 * does (or when there is no session to own, so the caller's own not-recording handling
 * runs unchanged).
 */
async function refuseIfNotOwner(runId) {
  const session = await readSession();
  if (!session || session.expired) return null;
  const owner = session.ownerRunId || DEFAULT_RUN_ID;
  if (owner === (runId || DEFAULT_RUN_ID)) return null;
  return { ok: false, error: 'Another application owns the demonstration in progress.' };
}

const REFUSED_CAP = 50;

/**
 * Note a step we are throwing away, and say where it came from.
 *
 * The host, not just the tab id: by the time the panel reports this the tab may be
 * closed, and "tab 47" tells the user nothing they can act on. "myworkdayjobs.com"
 * tells them exactly which window to start the demonstration in.
 */
async function noteRefused(session, tabId, url) {
  let host = '';
  try { host = new URL(url || '').hostname; } catch { /* opaque origin — the tab id still helps */ }
  // A session opened by an older build of the worker (extension reloaded mid-recording)
  // has no `refused` list. Losing the count is fine; throwing here would lose the step's
  // ANSWER too, and the frame would then count a refusal as a dropped step.
  if (!Array.isArray(session.refused)) session.refused = [];
  if (session.refused.length < REFUSED_CAP) {
    session.refused.push({ tabId: tabId == null ? null : tabId, host });
    await writeSession(session);
  }
  // `recording:true` on purpose. The frame must NOT stand down: the panel is about to tell
  // the user which tab this was, and a recorder that has already torn itself down cannot
  // pick the demonstration back up.
  return { ok: false, refused: true, recording: true };
}

/**
 * Every step id is `frame:n` with n counted up from zero in that frame, and every n is
 * posted exactly once (a revision re-posts the SAME id). So a missing number is not a
 * quirk — it is a step the user performed that never reached us, and the user is about
 * to approve a demonstration with a hole in it.
 *
 * Returns the missing IDs rather than a count, because a frame that is still alive reports
 * its own unacked ids too, and the same lost step must not be counted twice.
 */
function lostSteps(session) {
  const highest = new Map();
  const lowest = new Map();
  const seen = new Set();
  for (const id of [...session.steps.map((s) => s.id), ...session.dropped]) {
    const at = id.lastIndexOf(':');
    const frame = id.slice(0, at);
    const n = Number(id.slice(at + 1));
    if (!Number.isInteger(n)) continue;
    seen.add(id);
    highest.set(frame, Math.max(highest.get(frame) ?? -1, n));
    lowest.set(frame, Math.min(lowest.get(frame) ?? Infinity, n));
  }
  const lost = [];
  for (const [frame, top] of highest) {
    // Count holes from the LOWEST id this frame actually posted, not from zero. A frame
    // whose recorder survived a previous session keeps its token and its counter, so its
    // first step here might be n=47 — and reading that as "steps 0–46 were lost" told the
    // user their demonstration had a 47-step hole in it when nothing at all was lost.
    // A genuine mid-demonstration gap still shows, which is the case this exists for.
    for (let n = lowest.get(frame); n < top; n++) {
      if (!seen.has(`${frame}:${n}`)) lost.push(`${frame}:${n}`);
    }
  }
  return lost;
}

async function closeSession() {
  const session = await readSession();
  await writeSession(null);
  badge(false);
  if (!session) {
    return { ok: true, steps: [], dropped: 0, lost: [], refused: 0, refusedHosts: [], host: '', expired: '' };
  }
  // The panel normally flushes each frame over the exec channel before it gets here, but
  // that only reaches the tabs and frames it could enumerate. This is the backstop that
  // makes "the session ended" and "the recorders stopped" the same event, whichever path
  // ended it.
  disarm(session.tabIds);
  const refused = Array.isArray(session.refused) ? session.refused : [];
  return {
    ok: true,
    steps: session.steps,
    dropped: session.dropped.length,
    lost: lostSteps(session),
    refused: refused.length,
    refusedHosts: [...new Set(refused.map((r) => r.host).filter(Boolean))],
    host: session.host || '',
    expired: session.expired || '',
  };
}

/**
 * Append a step, or replace one already banked under the same id.
 *
 * Upsert, not append, because the page coalesces as it records: a field typed
 * into twice is one fill with the final value, and "open the dropdown, click an
 * option" is one choose_option that REPLACES the trigger's click. Re-posting
 * under the same id lets a frame revise a step it already sent, in place, so the
 * step order the user sees is the order they acted in.
 */
async function addStep(step) {
  const session = await readSession();
  if (!session || !step || typeof step.id !== 'string') return { ok: false };
  const at = session.steps.findIndex((s) => s.id === step.id);
  if (at >= 0) {
    session.steps[at] = step; // a revision of a step we already hold
  } else if (session.steps.length < STEP_CAP) {
    session.steps.push(step);
  } else if (!session.dropped.includes(step.id) && session.dropped.length < 200) {
    // A demonstration longer than the cap must not quietly become a macro that does most
    // of it: the user would approve 30 steps believing that was the whole thing. Count
    // what fell off (by id, so a revision of a dropped step is not counted twice) and let
    // the panel say so.
    session.dropped.push(step.id);
  } else {
    return { ok: true };
  }
  await writeSession(session);
  return { ok: true };
}

/**
 * A demonstration that opens a new tab — "Apply" so often does — must keep
 * recording in the tab it opened. Adoption happens on creation, long before that
 * tab's content script loads and says hello, so the new frame arms itself.
 */
chrome.tabs.onCreated.addListener((tab) => {
  serial(async () => {
    const session = await readSession();
    if (!session || session.expired || tab.openerTabId == null) return;
    if (!session.tabIds.includes(tab.openerTabId) || session.tabIds.includes(tab.id)) return;
    session.tabIds.push(tab.id);
    await writeSession(session);
    // The new tab's own content script greets us independently, and it may well get there
    // first. It retries, which is what closes that race — see greetRecorder().
  }).catch((err) => console.error('[jobpilot] could not follow the new tab:', err));
});

/**
 * A driven tab closed. Nothing depends on hearing this — every entry expires on its own —
 * but with several runs at once the map would otherwise carry up to CTRL_IDLE_MS of dead
 * entries, and controlState() would keep trying to paint tabs that are gone.
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    await controlForgetTab(tabId);
    await forgetTabClaim(tabId);
  }).catch((err) => console.error('[jobpilot] could not forget the closed tab:', err));
});

// --------------------------------------------------- "controlled by JobPilot"
// The tab the agent is driving says so, IN the tab.
//
// Everything JobPilot does to a page happens with no cursor moving and no window
// focused: fields fill themselves, dropdowns open and close, a wizard advances. The only
// place that was ever explained was the side panel — which the user may have collapsed,
// or be looking away from, or have opened on a different window entirely. So the page
// changed under them with nothing on it to say why. The indicator is the answer to
// "why did that just happen", placed where the thing happened.
//
// WHY THE WORKER OWNS THIS AND NOT THE PANEL. The one thing the agent does constantly is
// navigate. Every navigation destroys the page and its content script, so an indicator the
// panel had switched on would vanish exactly when the run got interesting, and the page
// that replaced it would be driven in silence. The session lives here, in memory-only
// storage, and a fresh content script asks for it on load (ctrl-hello) — the same shape
// the recorder uses, for the same reason.
//
// Storage: chrome.storage.session at the DEFAULT access level, so a page's own frames
// cannot read which tab we are driving or what step we are on.

// ONE key holding a map of runId → session, because several runs are driving several tabs
// at once and each needs its own indicator.
//
// KEYED BY runId, NOT BY tabId, and that is the whole design. A run legitimately MOVES
// between tabs — "Apply" opens the application in a new tab and agent.js follows it — so a
// tabId is not a stable identity for "this run's indicator". Keyed by tabId, the entry for
// the tab the run left would have no owner, and nothing could know to take it down; the
// user would go back to that tab and find it still claiming to be driven. Keyed by runId,
// moving is just a field change, and the retarget below stays exactly as correct as it was
// when there was one session.
//
// It is a map under one key rather than one key per run so this stays a single get/set
// pair. Every handler runs inside serial() (below), so the read-modify-write cannot
// interleave; at three runs beating every four seconds the cost is not worth a second
// storage shape.
const CTRL_KEY = 'ctrlSessions';

/** The run a control message belongs to when it does not say — matches storage.js. */
const DEFAULT_RUN_ID = 'run-1';

// The panel beats every few seconds while a run is alive. This is the slack before an
// unheard-from session counts as abandoned — generous, because the beat competes with a
// streaming LLM response on the same thread, and the cost of being wrong in this direction
// is one late indicator rather than a page that lies about being driven.
const CTRL_IDLE_MS = 30 * 1000;

/** The whole map, always an object. */
function readControls() {
  return chrome.storage.session.get(CTRL_KEY).then((got) => {
    const map = got[CTRL_KEY];
    return map && typeof map === 'object' ? map : {};
  });
}

function writeControls(map) {
  return Object.keys(map).length
    ? chrome.storage.session.set({ [CTRL_KEY]: map })
    : chrome.storage.session.remove(CTRL_KEY);
}

/**
 * Tell one tab's TOP frame to show, or drop, the indicator.
 *
 * Frame 0 only. Every frame of the page runs our content script, and a Workday application
 * is three nested iframes deep — broadcasting would stack three indicators, two of them
 * clipped inside boxes in the middle of the form.
 *
 * Best-effort: a restricted page, a tab that has closed, or a frame that has not finished
 * loading has no content script to answer, and none of those are worth failing a run over.
 */
function paint(tabId, message) {
  if (typeof tabId !== 'number') return;
  chrome.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => {});
}

const showIn = (tabId, mode, status) =>
  paint(tabId, { kind: 'jobpilot:ctrl-show', mode, status });
const hideIn = (tabId) => paint(tabId, { kind: 'jobpilot:ctrl-hide' });

/**
 * The live control session, or null — expiring an abandoned one on the way past.
 *
 * The page tears its own indicator down when the beats stop, so this is not what protects
 * the user from a crashed panel. What it protects is the NEXT page: without it, a session
 * left behind by a panel that died would arm every page the user afterwards loaded in that
 * tab, and each one would announce it was being driven by something that no longer exists.
 */
async function controlState(tabId) {
  const map = await readControls();
  const now = Date.now();
  let expired = false;
  let live = null;
  for (const [runId, session] of Object.entries(map)) {
    if (!session || now - session.aliveAt > CTRL_IDLE_MS) {
      delete map[runId];
      expired = true;
      if (session) hideIn(session.tabId);
      continue;
    }
    // Which run owns this tab. Runs never share a tab (the panel's registry enforces it),
    // so the first match is the only match.
    if (session.tabId === tabId) live = session;
  }
  if (expired) await writeControls(map);
  return live;
}

/**
 * Open, refresh, or move the control session. The panel calls this on a timer, so it is
 * also the heartbeat — one message doing both means the indicator can never be showing
 * for a run whose panel has stopped saying it is there.
 */
async function controlOn(runId, tabId, mode, status) {
  if (typeof tabId !== 'number') return { ok: false, error: 'A control indicator needs a tab id.' };
  const id = runId || DEFAULT_RUN_ID;
  const map = await readControls();
  const prev = map[id];
  // THIS RUN's previous tab. A run that follows "Apply" into a new tab, or whose working
  // tab closed, re-targets (agent.js §10) — and the tab it LEFT must stop claiming to be
  // driven, or the indicator outlives the only thing that made it true, on a tab the user
  // has gone back to using themselves.
  //
  // Scoped to this run's own entry, which is the difference concurrency makes: a DIFFERENT
  // run naming a different tab is not a retarget, it is simply another application being
  // filled. Comparing against "whatever session was last written" would make three runs
  // beating every four seconds tear down each other's indicators in turn.
  if (prev && prev.tabId !== tabId) hideIn(prev.tabId);
  const next = {
    runId: id,
    tabId,
    mode: mode === 'watching' ? 'watching' : 'acting',
    status: typeof status === 'string' ? status.slice(0, 120) : '',
    aliveAt: Date.now(),
  };
  map[id] = next;
  await writeControls(map);
  // The beat doubles as the tab claim's heartbeat. Without this a claim would go stale
  // after CTRL_IDLE_MS in the middle of a perfectly healthy run, and another window's panel
  // could take the tab out from under it — which is the exact thing the claim exists to stop.
  await claimTab(id, tabId);
  showIn(tabId, next.mode, next.status);
  return { ok: true };
}

/**
 * End ONE run's indicator.
 *
 * The runId is what makes this safe to call from a run that is ending while others are
 * still going. It used to take no argument at all and clear the single session, which with
 * concurrent runs means the first run to finish takes down every other run's indicator —
 * on tabs that are still, visibly, being typed into.
 */
async function controlOff(runId) {
  const id = runId || DEFAULT_RUN_ID;
  const map = await readControls();
  const session = map[id];
  if (!session) return { ok: true };
  delete map[id];
  await writeControls(map);
  hideIn(session.tabId);
  return { ok: true };
}

// ----------------------------------------------------------------- tab claims
//
// Which run is driving which tab, across every panel document.
//
// The panel has its own registry (sidepanel/js/runs.js) and that is enough for runs inside
// ONE window. It is not enough in general: Chrome gives one panel per window, tab ids are
// global, and dragging a tab from window 1 to window 2 carries its id along — so window 2's
// panel would happily start a second run on a tab window 1 is already filling. Two runs on
// one tab silently corrupt each other's element refs (see runs.js). The worker is the only
// thing both panels share, so it is where the answer has to live.
//
// Claims expire on the same idle window as the control indicator, and for the same reason:
// a panel that crashed must not lock a tab out forever.
const CLAIM_KEY = 'tabClaims';

function readClaims() {
  return chrome.storage.session.get(CLAIM_KEY).then((got) => {
    const map = got[CLAIM_KEY];
    return map && typeof map === 'object' ? map : {};
  });
}

function writeClaims(map) {
  return Object.keys(map).length
    ? chrome.storage.session.set({ [CLAIM_KEY]: map })
    : chrome.storage.session.remove(CLAIM_KEY);
}

async function claimTab(runId, tabId) {
  if (typeof tabId !== 'number' || !runId) {
    return { ok: false, error: 'A claim needs a run id and a tab id.' };
  }
  const map = await readClaims();
  const now = Date.now();
  const held = map[tabId];
  if (held && held.runId !== runId && now - held.aliveAt <= CTRL_IDLE_MS) {
    return { ok: false, error: 'That tab is already being driven by another JobPilot window.' };
  }
  map[tabId] = { runId, aliveAt: now };
  await writeClaims(map);
  return { ok: true };
}

async function releaseTab(runId, tabId) {
  const map = await readClaims();
  const held = map[tabId];
  // Only the holder may release. A stale release from a run that lost the tab must not
  // unlock it under whoever holds it now.
  if (!held || (runId && held.runId !== runId)) return { ok: true };
  delete map[tabId];
  await writeClaims(map);
  return { ok: true };
}

async function forgetTabClaim(tabId) {
  const map = await readClaims();
  if (!map[tabId]) return;
  delete map[tabId];
  await writeClaims(map);
}

/** A closed tab's entry is dead weight until it expires — drop it as soon as we hear. */
async function controlForgetTab(tabId) {
  const map = await readControls();
  let changed = false;
  for (const [runId, session] of Object.entries(map)) {
    if (session && session.tabId === tabId) { delete map[runId]; changed = true; }
  }
  if (changed) await writeControls(map);
}

// A run that follows "Apply" into a new tab keeps driving there, and agent.js re-targets on
// its own. Nothing to adopt here — the next beat names the new tab and controlOn moves the
// indicator across.

// ------------------------------------------------------------------ messaging

/**
 * The two questions a CONTENT SCRIPT is allowed to ask. Everything else in the rec-/ctrl-
 * families is the panel's alone: a page may not open a session, may not end one, and above
 * all may not read one back (rec-close returns every value the user typed).
 */
const FROM_CONTENT = new Set([
  'jobpilot:rec-hello',
  'jobpilot:rec-step',
  'jobpilot:ctrl-hello',
]);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.kind !== 'string') return;
  if (!msg.kind.startsWith('jobpilot:rec-')
    && !msg.kind.startsWith('jobpilot:ctrl-')
    && msg.kind !== 'jobpilot:claim-tab'
    && msg.kind !== 'jobpilot:release-tab') return;

  // onMessage only ever fires for our OWN contexts — a web page cannot reach it (it has no
  // chrome.runtime, and we declare no externally_connectable), and another extension would
  // arrive at onMessageExternal, which we do not implement. So the senders are: our panel,
  // and our content scripts. Only a content script has sender.tab.
  //
  // Identify the panel by its URL, not by the absence of sender.tab: an extension page's
  // sender.url is always chrome-extension://<our id>/…, which a content script's never is.
  const fromPanel = typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
  if (!FROM_CONTENT.has(msg.kind) && !fromPanel) {
    sendResponse({
      ok: false,
      error: msg.kind.startsWith('jobpilot:ctrl-')
        ? 'Only the side panel drives the control indicator.'
        : 'Only the side panel controls a recording.',
    });
    return true;
  }

  // Every branch answers, so neither the panel nor a content script ever hangs.
  serial(async () => {
    switch (msg.kind) {
      // Panel: begin. Existing frames are armed by the panel over the exec
      // channel; frames that load later arm themselves via rec-hello.
      case 'jobpilot:rec-open':
        return openSession(msg.runId, msg.tabId);

      // Panel: end. Returns everything every frame of every tab banked — which is exactly
      // why the other three carry a runId too. Refusing only a second rec-OPEN would leave
      // close/alive/tabs unscoped, and a non-owner calling close would be handed the
      // owner's recorded steps, labels and typed values.
      case 'jobpilot:rec-close': {
        const refusal = await refuseIfNotOwner(msg.runId);
        return refusal || closeSession();
      }

      // Panel: "still here, the user is still demonstrating." This, not a wall clock,
      // is what keeps the session alive (§6).
      case 'jobpilot:rec-alive': {
        const refusal = await refuseIfNotOwner(msg.runId);
        return refusal || touchSession();
      }

      // Panel: which tabs is this session watching? (New tabs get adopted, so
      // the panel cannot know this from the tab it started on.)
      case 'jobpilot:rec-tabs': {
        const refusal = await refuseIfNotOwner(msg.runId);
        if (refusal) return refusal;
        const session = await readSession();
        return { ok: true, tabIds: session ? session.tabIds : [] };
      }

      // Content script, on load: "am I inside a recording?" This is what makes
      // the recorder survive a navigation — the fresh page asks, and re-arms.
      case 'jobpilot:rec-hello':
        return { ok: true, recording: await isRecording(sender.tab && sender.tab.id) };

      // Content script: a step the user just performed.
      // `recording:false` is the frame's cue to stand down. A bfcache-restored frame never
      // re-runs its content script, so it never greets and never learns the session it
      // belonged to is over — this is the only thing that reaches it.
      case 'jobpilot:rec-step': {
        const from = sender.tab && sender.tab.id;
        if (await isRecording(from)) return addStep(msg.step);
        // isRecording may have just expired the session and written the tombstone, so read
        // AFTER it rather than before.
        const session = await readSession();
        // No session, or a dead one: the frame is orphaned and must stand down.
        if (!session || session.expired) return { ok: false, recording: false };
        // A LIVE session that does not watch this tab. The user really did perform this
        // step; we are choosing not to bank it. Say `recording:true` — telling the frame to
        // stand down here would silence a tab the user may be about to be told to use.
        return noteRefused(session, from, sender.url);
      }

      // Panel: "I am driving this tab, and here is what I am doing." Open, refresh and
      // re-target are all the same message — see controlOn.
      // Panel: "this run is driving this tab." The cross-window half of the one-run-per-tab
      // invariant — see the tab claims section.
      case 'jobpilot:claim-tab':
        return claimTab(msg.runId, msg.tabId);

      case 'jobpilot:release-tab':
        return releaseTab(msg.runId, msg.tabId);

      case 'jobpilot:ctrl-on':
        return controlOn(msg.runId, msg.tabId, msg.mode, msg.status);

      // Panel: THIS run is over. Scoped by runId so one application finishing does not
      // clear the indicator off the tabs the other applications are still filling.
      case 'jobpilot:ctrl-off':
        return controlOff(msg.runId);

      // Content script, on load: "is this tab being driven?" This is what carries the
      // indicator across the navigations the agent itself causes.
      case 'jobpilot:ctrl-hello': {
        // Frame 0 only. An embedded ATS iframe asking must be told no — the top frame is
        // already showing it, and a second copy would be drawn clipped inside the middle
        // of the form.
        if (sender.frameId !== 0 || !sender.tab) return { ok: true, controlled: false };
        // Whichever run owns THIS tab, if any. With one session this was an equality test
        // against the single record; now it is a lookup, because the answer for tab A must
        // not depend on which run happened to beat most recently.
        const session = await controlState(sender.tab.id);
        if (!session) return { ok: true, controlled: false };
        return { ok: true, controlled: true, mode: session.mode, status: session.status };
      }

      default:
        return { ok: false, error: `Unknown message ${msg.kind}.` };
    }
  })
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err && err.message ? err.message : String(err) }));

  return true; // async response
});
