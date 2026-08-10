/**
 * ChatView — the chat screen. Port of panel.html.orig lines 50-130 and the ~1,200 lines of
 * panel.js that drove them.
 *
 * PORTED FROM sidepanel/js/panel.js:
 *   scroll        isNearBottom (261), appendToList (266), scrollIfSticky (273),
 *                 updateEmptyState (278)
 *   rendering     renderUserMessage (284), addUserMessage (291), renderAssistantBubble
 *                 (299), ensureStreamingBubble (307), appendAssistantText (318),
 *                 finalizeAssistantBubble (326)
 *   activity      renderActivityCard (345), renderToolStep (355), applyStepOutcome (383),
 *                 ensureActivityCard (410), closeActivityCard (433), settleOrphanStep
 *                 (446), onToolStart (452), onToolEnd (463)
 *   transcript    renderNotice (489), addNotice (496), renderSecret (513),
 *                 addSecretRecord (527), renderQuestionCard (540), recordQuestion (562)
 *   agent flows   chime (579), onRequestDemo (615), suggestMacroName (815), platformName
 *                 (820), onAskUser (837), onRequestSecret (906), saveAnswersToProfile
 *                 (1008), maybeUnlockVault (1567)
 *   header        refreshPortalChip (1393) with the chipGeneration race guard (1390)
 *   run control   resolveTargetTab (1875), getTabIdForRun (1888), refreshTargetTab (1896),
 *                 setRunning (1928), makeRunner (1941), handleSend (2004), handleStop
 *                 (2032), handleNewChat (2041), carryAnswersToProfile (2068), restoreChat
 *                 (2085), wireComposer (2107)
 *
 * WHAT STAYS LOCAL AND WHY. The transcript, the AgentRunner, the SessionStats instance, the
 * streaming bubble, the open activity card, `stopRequested`, `detection` and the 4s
 * target-tab poll are all RunView's. That is not tidiness: onText fires once per streamed
 * token, and a store update per token would re-render the header, the tab bar and all five
 * view slots for every character the model emits.
 *
 * ONE RUN PER RunView. Everything named above is per-instance, so it is also per-RUN — mount
 * two and their transcripts, streams and stats do not touch. What is NOT per-run is anything
 * global: the active tab, the one chatHistory key, the one control-indicator session, the
 * modal queue's force-close, the shell's `running` flag. Those all go through `useRun()`
 * (../state/run-context.jsx) rather than a module import, which is what lets a second
 * concurrent run be a second provider instead of a rewrite of the streaming path below.
 * <ChatView/> at the bottom of this file is the single place that knows how many runs exist.
 *
 * THE STREAMING PATH, in one paragraph, because it is the only genuinely hard thing here.
 * `rows` is the render list — one wrapper {id, rev, record, live} per transcript record.
 * It changes when a message is APPENDED or SETTLED, a handful of times per run. <MessageList>
 * is memoized on it and every <MessageItem> under it is memoized on its own wrapper, so a
 * stream re-renders none of them. The growing assistant text lives in <StreamingBubble>, a
 * leaf holding its own state, painting PLAIN TEXT (panel.js's fast path at 321); only when
 * finalizeAssistantBubble settles the record does the same text get re-rendered through
 * <Markdown>. `rowsRef` mirrors `rows` synchronously because the ported code reads the
 * transcript immediately after appending to it, exactly as panel.js read its `uiMessages`
 * global, and because that is what persistChats writes to storage.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { AgentRunner } from '../../js/agent.js';
import { PLATFORMS, detectPlatform } from '../../js/platforms.js';
import { SessionStats, modelInfo } from '../../js/stats.js';
import {
  answerKey,
  getPlaybooks, saveMacro,
} from '../../js/storage.js';
import { bindStepsToProfile } from '../../js/tools.js';
import * as vault from '../../js/vault.js';

import { showToast } from '../components/Toast.jsx';
import ChatToolbar from '../components/chat/ChatToolbar.jsx';
import Composer from '../components/chat/Composer.jsx';
import MessageList from '../components/chat/MessageList.jsx';
import PortalChip from '../components/chat/PortalChip.jsx';
import RunStrip from '../components/chat/RunStrip.jsx';
import RunTabs from '../components/chat/RunTabs.jsx';
import StatsSlot from '../components/chat/StatsSlot.jsx';
import { SECRET_KIND_NOUN } from '../components/chat/MessageItem.jsx';
import { chime as playChime } from '../components/chat/chime.js';
// The `plan` field's encoding lives with the rest of the modal's field-value helpers, so
// there is one definition of it and node can test the round trip without a browser.
import { decodePlanRows } from '../modal-queue.js';
import { debounce, useAppShell, useMemoryBank, useProfile, useSettings } from '../state/store.jsx';
// Everything a run touches OUTSIDE itself — its tab, its transcript, its indicator, its
// dialogs, its running flag — comes through here rather than from a module import, so a
// second concurrent run is a second provider rather than a rewrite of this file. See the
// header of run-context.jsx for why the seam is drawn exactly there.
import { RunProvider, useRun, useRunApi } from '../state/run-context.jsx';
// How many applications are in flight, which one is on screen, and who owns which tab.
import { useRuns } from '../state/runs-context.jsx';
// Vault policy shared with VaultView — one definition, in ../vault-ui.js. maybeUnlockVault
// is a plain async function rather than a useCallback because nothing here closes over
// render state; that also keeps it callable from agent.js's onRequestSecret, which is not
// React. Being module-scope, it is stable, so it needs no dependency-array entry.
import { maybeUnlockVault, vaultUnlocked } from '../vault-ui.js';

// ----------------------------------------------------------------- module helpers
//
// Pure functions with no state of their own. They were module-level in panel.js for the
// same reason they are module-level here: re-creating them per render buys nothing.

/** Hostname, `www.` stripped — matches how platforms.js keys a detection. (panel.js:116) */
function hostOfUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

// §10: active tab of the last focused window; skip our own pages / browser UI
// where possible. tools.js still hard-refuses restricted URLs at execution time.
async function resolveTargetTab() {
  const ownOrigin = chrome.runtime.getURL('');
  const isOwn = (tab) => tab.url && tab.url.startsWith(ownOrigin);
  const isInternal = (tab) => /^(chrome|edge|devtools|about|view-source):/i.test(tab.url || tab.pendingUrl || '');

  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab || isOwn(tab) || isInternal(tab)) {
    const [fallback] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (fallback && !isOwn(fallback)) tab = fallback;
  }
  return tab || null;
}

/** panel.js:820 — the human label for a portal key, falling back to the key itself. */
function platformName(platform) {
  const p = PLATFORMS.find((x) => x.key === platform);
  return p ? p.label : platform;
}

/** panel.js:815 */
function suggestMacroName(goal) {
  const words = String(goal || 'demonstration').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/);
  return words.slice(0, 5).join(' ') || 'demonstration';
}

const DONE_LABELS = {
  submitted: { text: 'Application submitted', variant: 'notice-ok' },
  ready_for_review: { text: 'Ready for your review', variant: 'notice-ok' },
  // A normal terminal outcome, deliberately NOT the error red: the portal answered, and
  // the answer is "nothing to do here". The summary carries the portal's own wording.
  already_applied: { text: 'You have already applied to this job', variant: 'notice-info' },
  blocked: { text: 'Blocked', variant: 'notice-error' },
  answered: { text: 'Done', variant: '' },
};

// Row ids only need to be unique within one panel session — they are React keys, never
// persisted. The records themselves are stored exactly as panel.js wrote them, with no id
// field added, so an existing chatHistory keeps loading and keeps round-tripping.
let rowSeq = 0;
const nextRowId = () => (rowSeq += 1);

// ------------------------------------------------------------------------ view

/**
 * @param {{running: boolean}} props  THIS run's flag, not the shell's. The shell still has
 *   one, but it now means "any application is working" and drives the header pill; reading
 *   it here would hide every composer and refuse Send in every run the moment one started.
 */
function RunView({ running }) {
  const {
    tab, setTab, setPill, setPillState,
    isConfigured, revealPlaybook,
  } = useAppShell();
  // The run this view renders. Every global reach in the body below goes through it.
  const run = useRun();
  /**
   * The same api, readable from callbacks that must NOT re-create when its identity does.
   *
   * The api object is rebuilt whenever anything in the runs context changes — another
   * application starting, a status flip, a title refresh — but a RunView is bound to ONE
   * runId for its whole life, so the functions inside are always equivalent for us. Effects
   * keyed on the api object itself re-fire on every one of those churns; the restore effect
   * below did exactly that, and each re-fire replaced the LIVE transcript with whatever the
   * debounced writer had managed to put on disk — usually nothing. Three concurrent runs
   * churn constantly, so transcripts were wiped mid-run and the wipe was then persisted.
   * Callbacks read through this ref instead, and key on `run.runId`, which never changes.
   */
  const runApiRef = useRef(run);
  runApiRef.current = run;
  const { settings } = useSettings();
  const { profile, appendAnswersNow } = useProfile();
  const { reloadMemory } = useMemoryBank();

  // ---------------------------------------------------------------- transcript

  const [rows, setRowsState] = useState([]);
  const rowsRef = useRef(rows);
  /**
   * The one writer for the transcript. The ref is updated SYNCHRONOUSLY because the ported
   * code reads the transcript in the same statement that appended to it (panel.js pushed
   * onto a plain array and read it back immediately), and because persistChats has to be
   * able to serialise the current transcript from a debounced timer.
   */
  const setRows = useCallback((updater) => {
    const next = typeof updater === 'function' ? updater(rowsRef.current) : updater;
    rowsRef.current = next;
    setRowsState(next);
  }, []);

  /** Bump a row's `rev` so React.memo re-renders it after its record was mutated in place. */
  const bumpRow = useCallback((id) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, rev: r.rev + 1 } : r)));
  }, [setRows]);

  const pushRow = useCallback((record, live = false) => {
    const row = { id: nextRowId(), rev: 0, record, live };
    setRows((rs) => [...rs, row]);
    return row;
  }, [setRows]);

  // panel.js:255 — the transcript is written 300ms after the last change, and the cap is
  // enforced inside storage.js. ONE debounce for the life of the view (hence the ref, not
  // `run`): re-creating it on api churn silently dropped whatever write was pending.
  const persistChats = useMemo(
    () => debounce(() => {
      runApiRef.current.saveChats(rowsRef.current.map((r) => r.record))
        .catch((err) => showToast(`Could not save chat: ${err.message}`, 'error'));
    }, 300),
    [],
  );

  // ------------------------------------------------------------------- scroll
  //
  // panel.js read isNearBottom() immediately BEFORE appending, then scrolled if it had been
  // true. React cannot do that: by the time a layout effect runs, the new node is already in
  // the list and scrollHeight has grown, so the same measurement answers the wrong question.
  // Instead stickiness is tracked as the user scrolls, which is the value panel.js was
  // really after — "was the user reading the bottom of the transcript".

  const listRef = useRef(null);
  const stickyRef = useRef(true);

  const onListScroll = useCallback(() => {
    const list = listRef.current;
    if (!list) return;
    stickyRef.current = list.scrollTop + list.clientHeight >= list.scrollHeight - 48;
  }, []);

  const scrollIfSticky = useCallback(() => {
    const list = listRef.current;
    if (list && stickyRef.current) list.scrollTop = list.scrollHeight;
  }, []);

  // Appending a row is the React equivalent of appendToList(); the scroll has to wait for
  // the node to exist, so it happens here rather than at the call site.
  useLayoutEffect(() => {
    scrollIfSticky();
  }, [rows, scrollIfSticky]);

  // ------------------------------------------------------- live-message pointers
  //
  // The three `let`s panel.js kept at module scope (currentAssistant:36, currentActivity:37,
  // orphanStep:431). They stay refs rather than state: they are pointers the callbacks read
  // and write synchronously, and nothing renders from them directly — what renders is
  // `runningStep` below.

  const liveAssistantRef = useRef(null);  // {id, record}
  const liveActivityRef = useRef(null);   // {id, record, step, stepIndex}
  const orphanRef = useRef(null);         // {rowId, index, record}
  const streamRef = useRef(null);         // imperative handle on <StreamingBubble>

  // Which tool step shows the spinner. State, because the card renders from it.
  //
  // There is no `waitingStep` counterpart: "this step is waiting on the user" is a property
  // OF THE STEP (`step.waiting`, set alongside `ok` and `result`), not a pointer held beside
  // the transcript. A single pointer could only ever mark one step at a time, so a run that
  // asks for a username and then a password would silently strip the "— waiting for you…"
  // suffix off the first one when the second arrived; it also never got cleared, so it went
  // on referring to a dead row for the rest of the session. panel.js:913-916 wrote the text
  // into that step's own DOM node, which is per-step by construction — the record is how
  // React says the same thing, and it survives a reload, which the DOM write did not.
  const [runningStep, setRunningStep] = useState(null);

  /**
   * A step whose activity card was closed while it was still running.
   *
   * request_secret closes the card to put its modal up, and the tool's REAL outcome — the
   * user declined, or fillSecret was refused by the page — arrives afterwards. Without this,
   * onToolEnd found no live card and dropped that outcome on the floor, so a failed
   * credential fill was left on screen as whatever the card said before the modal opened.
   *
   * Note what this deliberately does NOT do: clear `runningStep`. The step keeps spinning
   * until its outcome lands or settleOrphanStep gives up on it, exactly as the original's
   * DOM did.
   */
  const closeActivityCard = useCallback(() => {
    const cur = liveActivityRef.current;
    if (cur && cur.step) {
      orphanRef.current = { rowId: cur.id, index: cur.stepIndex, record: cur.step };
    }
    liveActivityRef.current = null;
  }, []);

  /**
   * The run is over and a step never reported. Settle it as unknown rather than leaving the
   * spinner turning: an outcome that is still arriving and one that never will look
   * identical on screen otherwise, and only one of them is worth waiting for. Its `ok` stays
   * null, so a reload renders it the same way.
   */
  const settleOrphanStep = useCallback(() => {
    const orphan = orphanRef.current;
    if (!orphan) return;
    orphanRef.current = null;
    setRunningStep((s) => (s && s.rowId === orphan.rowId && s.index === orphan.index ? null : s));
    bumpRow(orphan.rowId);
  }, [bumpRow]);

  const ensureStreamingBubble = useCallback(() => {
    if (liveAssistantRef.current) return liveAssistantRef.current;
    closeActivityCard();
    const record = { type: 'assistant', text: '' };
    const row = pushRow(record, true);
    liveAssistantRef.current = { id: row.id, record };
    return liveAssistantRef.current;
  }, [closeActivityCard, pushRow]);

  const appendAssistantText = useCallback((delta) => {
    const cur = ensureStreamingBubble();
    cur.record.text += delta;
    // The fast path (panel.js:321). The bubble may not have mounted yet when the first
    // delta lands — it initialises itself from record.text, so nothing is lost.
    if (streamRef.current) streamRef.current.sync();
    scrollIfSticky();
    persistChats();
  }, [ensureStreamingBubble, persistChats, scrollIfSticky]);

  const finalizeAssistantBubble = useCallback(() => {
    const cur = liveAssistantRef.current;
    if (!cur) return;
    liveAssistantRef.current = null;
    streamRef.current = null;
    if (cur.record.text.trim()) {
      // Settle it: `live` goes false, so the same record re-renders through <Markdown>.
      setRows((rs) => rs.map((r) => (r.id === cur.id ? { ...r, live: false, rev: r.rev + 1 } : r)));
    } else {
      // Model produced no visible text this iteration — drop the empty bubble.
      setRows((rs) => rs.filter((r) => r.id !== cur.id));
    }
    persistChats();
  }, [persistChats, setRows]);

  // --------------------------------------------------------------- activity card

  const ensureActivityCard = useCallback(() => {
    finalizeAssistantBubble();
    if (liveActivityRef.current) return liveActivityRef.current;
    const record = { type: 'activity', steps: [] };
    const row = pushRow(record);
    liveActivityRef.current = { id: row.id, record, step: null, stepIndex: -1 };
    return liveActivityRef.current;
  }, [finalizeAssistantBubble, pushRow]);

  const onToolStart = useCallback(({ name, label }) => {
    const card = ensureActivityCard();
    const stepRecord = { name, label, ok: null, result: '' };
    card.record.steps.push(stepRecord);
    card.step = stepRecord;
    card.stepIndex = card.record.steps.length - 1;
    setRunningStep({ rowId: card.id, index: card.stepIndex });
    bumpRow(card.id);
    scrollIfSticky();
    persistChats();
  }, [bumpRow, ensureActivityCard, persistChats, scrollIfSticky]);

  const onToolEnd = useCallback(({ ok, result }) => {
    const cur = liveActivityRef.current;
    const target = (cur && cur.step)
      ? { rowId: cur.id, index: cur.stepIndex, record: cur.step }
      : orphanRef.current;
    if (!target || !target.record) return;
    orphanRef.current = null;
    target.record.ok = ok;
    target.record.result = result;
    if (cur) {
      cur.step = null;
      cur.stepIndex = -1;
    }
    setRunningStep((s) => (s && s.rowId === target.rowId && s.index === target.index ? null : s));
    bumpRow(target.rowId);
    scrollIfSticky();
    persistChats();
  }, [bumpRow, persistChats, scrollIfSticky]);

  // ------------------------------------------------------------ record appenders

  const addUserMessage = useCallback((text) => {
    pushRow({ type: 'user', text });
    persistChats();
  }, [persistChats, pushRow]);

  const addNotice = useCallback((text, variant = '') => {
    pushRow({ type: 'notice', text, variant });
    persistChats();
  }, [persistChats, pushRow]);

  const addSecretRecord = useCallback((kind, host) => {
    pushRow({ type: 'secret', kind, host: host || '' });
    persistChats();
  }, [persistChats, pushRow]);

  // `saved` is what stops the New Chat sweep from overruling the user: false means the
  // save box was there and they cleared it. Undefined (an older record) stays sweepable.
  const recordQuestion = useCallback((question, options, answer, saved) => {
    const record = { type: 'question', question, options: options || null, answer: answer ?? null };
    if (saved !== undefined) record.saved = Boolean(saved);
    pushRow(record);
    persistChats();
  }, [persistChats, pushRow]);

  // ---------------------------------------------------------------- live refs
  //
  // The agent callbacks below have to be STABLE — they are handed to an AgentRunner that
  // outlives any single render — so everything they read that changes goes through a ref.

  const settingsRef = useRef(settings);
  const profileRef = useRef(profile);
  const tabRef = useRef(tab);
  const runningRef = useRef(running);
  const stopRequestedRef = useRef(false); // set by Stop; lets multi-modal flows bail between prompts
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  useEffect(() => { profileRef.current = profile; }, [profile]);
  useEffect(() => { tabRef.current = tab; }, [tab]);
  // `running` gets the same treatment as the three above even though setRunning() below
  // already writes the ref on the way past. The store exports setRunning through
  // useAppShell() to all five views; the day anything other than this component flips it,
  // handleSend's "already running" guard and handleNewChat's stop check would go stale with
  // no visible symptom — a Send accepted mid-run, or a New Chat that does not stop one.
  // Mirroring the state is what makes the ref true by construction rather than by audit.
  useEffect(() => { runningRef.current = running; }, [running]);

  const chime = useCallback(() => playChime(settingsRef.current), []);

  // ------------------------------------------------------------- session stats
  //
  // The instance is ours for the life of the panel. `renderStats()` was called once per
  // streamed token in panel.js:1950; here it notifies <StatsSlot> and nothing else, so the
  // transcript above it never re-renders for a token.

  const statsRef = useRef(null);
  if (statsRef.current === null) statsRef.current = new SessionStats();
  const statsListenersRef = useRef(new Set());

  const subscribeStats = useCallback((cb) => {
    const listeners = statsListenersRef.current;
    listeners.add(cb);
    return () => { listeners.delete(cb); };
  }, []);

  // panel.js called renderStats() once per streamed token (1950) and got away with it
  // because it wrote eight text nodes by hand. Here it re-renders a component, so the calls
  // are coalesced to one per animation frame: the HUD still moves in real time, and a fast
  // stream cannot make the stats bar the bottleneck. A pending frame is never cancelled, so
  // the final state of a stream always paints.
  const statsFrameRef = useRef(0);
  const renderStats = useCallback(() => {
    if (statsFrameRef.current) return;
    statsFrameRef.current = requestAnimationFrame(() => {
      statsFrameRef.current = 0;
      for (const cb of statsListenersRef.current) cb();
    });
  }, []);
  useEffect(() => () => {
    if (statsFrameRef.current) cancelAnimationFrame(statsFrameRef.current);
  }, []);

  // ---------------------------------------------------------------- target tab

  const [target, setTarget] = useState({ title: 'No target tab', favIconUrl: '' });
  const [chip, setChip] = useState(null);
  const displayedTabIdRef = useRef(null);
  const detectionRef = useRef(null); // last detectPlatform() for the target tab

  // refreshPortalChip is called, unawaited, from the 4s tab timer, from onMemory on every
  // agent step, from mount, and from the Memory tab's save/delete handlers — so several can
  // be in flight at once, each doing its own async detect → storage lookup. Without a
  // generation guard, a slow older call can resolve last and paint "no playbook yet" over
  // the fresh "playbook ✓" the user was just told about. Only the newest call may render.
  const chipGenRef = useRef(0);

  const applyChip = useCallback((next) => {
    // Same chip, same object — a 4s poll must not re-render the header for nothing.
    setChip((prev) => {
      if (prev === next) return prev;
      if (prev && next && prev.text === next.text && prev.cold === next.cold) return prev;
      return next;
    });
  }, []);

  /** Detect the portal for the target tab and reflect it in the chat header (§6.3). */
  const refreshPortalChip = useCallback(async () => {
    const gen = ++chipGenRef.current;
    const stale = () => gen !== chipGenRef.current;

    let tabInfo;
    try {
      tabInfo = await run.resolveTab();
    } catch {
      tabInfo = null;
    }
    if (stale()) return;
    if (!tabInfo || !tabInfo.id) { applyChip(null); return; }

    let found = null;
    try {
      found = await detectPlatform(tabInfo.id);
    } catch {
      found = null;
    }
    if (stale()) return;

    detectionRef.current = found;

    if (found && found.error) {
      // Detection could not run (blocked probe, restricted origin). Say so — otherwise a
      // permanently broken detector is indistinguishable from an ordinary page, and the user
      // just quietly never gets a playbook with no way to know why.
      applyChip({ text: 'Portal detection unavailable on this page', cold: true });
      return;
    }

    if (!found || !found.platform) { applyChip(null); return; }

    // Read straight from storage rather than the store's `playbooks` array: the agent may
    // have written one via `remember` since the Memory tab was last rendered.
    let pb = null;
    try {
      const all = await getPlaybooks();
      pb = all.find((p) => p.platform === found.platform) || null;
    } catch { pb = null; }
    if (stale()) return;

    const has = Boolean(pb && (pb.procedure.length || pb.tips.length));
    applyChip({
      text: has
        ? `${found.label} · playbook ✓${pb.useCount ? ` (used ${pb.useCount}×)` : ''}`
        : `${found.label} · no playbook yet — the agent will write one`,
      cold: !has,
    });
  }, [applyChip, run]);

  const refreshTargetTab = useCallback(async () => {
    try {
      const tabInfo = await run.resolveTab();
      if (!tabInfo) {
        setTarget((prev) => (prev.title === 'No target tab' && !prev.favIconUrl
          ? prev
          : { title: 'No target tab', favIconUrl: '' }));
        displayedTabIdRef.current = null;
        applyChip(null);
        return;
      }
      // Re-detect only when the tab actually changed. This runs on a 4s timer, and
      // detectPlatform caches on tabId+URL — but skipping the call entirely keeps the
      // common idle case free.
      const tabChanged = displayedTabIdRef.current !== tabInfo.id;
      displayedTabIdRef.current = tabInfo.id;
      const title = `Acting on: ${tabInfo.title || tabInfo.url || 'Untitled'}`;
      const favIconUrl = (tabInfo.favIconUrl && /^https?:/.test(tabInfo.favIconUrl))
        ? tabInfo.favIconUrl
        : '';
      setTarget((prev) => (prev.title === title && prev.favIconUrl === favIconUrl
        ? prev
        : { title, favIconUrl }));
      const det = detectionRef.current;
      if (tabChanged || !det || det.host !== hostOfUrl(tabInfo.url)) refreshPortalChip();
    } catch {
      // tabs API hiccup — leave the previous value; next tick will retry.
    }
  }, [applyChip, refreshPortalChip, run]);

  // The tab this run drives. It is the run's to decide, not this view's — today it
  // resolves the active tab exactly as before; once runs are bound to a tab it is a
  // constant, and that is the whole of the change.
  const getTabIdForRun = run.getTabId;

  // ------------------------------------------------------------ answer keeping

  /**
   * Save answers one row at a time, replacing rather than appending when the same
   * question comes back (the merge itself lives in storage.js and is unit-tested there).
   */
  const saveAnswersToProfile = useCallback(async (pairs) => {
    const incoming = Array.isArray(pairs) ? pairs.filter((p) => p && p.q && p.a) : [];
    if (!incoming.length) return;
    try {
      // appendAnswersNow merges inside storage.js's write lock, against the profile as it
      // is ON DISK. Merging against profileRef here instead — the obvious thing, and what
      // this did — is last-write-wins: two runs answering screening questions at the same
      // moment each start from a snapshot taken before the other landed, and one set of
      // answers is silently lost. The only symptom is the agent asking again later.
      // It deliberately does not toast, so the summary below is the only thing the user
      // sees — which is the point.
      const { added, updated, skipped, evicted } = await appendAnswersNow(incoming);
      // Say what did NOT get saved. A silent skip reads as "saved" and the user only finds
      // out when the agent asks the same thing again.
      const parts = [];
      if (added) parts.push(`${added} saved`);
      if (updated) parts.push(`${updated} updated`);
      if (skipped) parts.push(`${skipped} too long to reuse — kept in this chat only`);
      if (evicted) parts.push(`${evicted} oldest dropped`);
      // A partial save gets the neutral toast, not the green one: something was left out.
      showToast(parts.length ? `Answers: ${parts.join(', ')}` : 'Answers already saved',
        skipped || evicted ? '' : 'success');
    } catch (err) {
      showToast(`Could not save answer: ${err.message}`, 'error');
    }
  }, [appendAnswersNow]);

  /** Sweep this chat's answered questions into the profile before the transcript goes. */
  const carryAnswersToProfile = useCallback(async () => {
    if (!settingsRef.current || !settingsRef.current.saveAnswers) return; // answer-keeping is off
    // Keyed, so a question answered twice in one chat carries over ONCE — and as the
    // later answer, which is the correction the user went back and made.
    const byKey = new Map();
    for (const row of rowsRef.current) {
      const rec = row.record;
      if (!rec || rec.type !== 'question' || rec.saved === false) continue;
      const q = String(rec.question || '').trim();
      const a = String(rec.answer || '').trim();
      if (!q || !a) continue;
      byKey.set(answerKey(q), { q, a });
    }
    if (byKey.size) await saveAnswersToProfile([...byKey.values()]);
  }, [saveAnswersToProfile]);

  // ------------------------------------------------------------- agent callbacks

  /**
   * One modal, one box per question (CONTRACT-V10 §2).
   *
   * The agent batches: a page with five unknown fields arrives here as five questions in
   * one call, and the user fills them in one sitting instead of being interrupted five
   * times. Each answer is then saved on its OWN — one savedAnswers row per question, so
   * the next run can match them one at a time instead of re-asking a whole page to get
   * one value back.
   *
   * @param {{question:string, options?:string[], long?:boolean}[]} questions
   * @returns {Promise<string[]|null>} one answer per question, or null if dismissed
   */
  const onAskUser = useCallback(async (questions) => {
    const asked = Array.isArray(questions) ? questions : [];
    if (!asked.length) return null;
    const single = asked.length === 1;

    chime();
    finalizeAssistantBubble();
    // Settle the activity row now — the modal replaces the old inline card, and the
    // spinner would otherwise run forever once the modal closes.
    if (liveActivityRef.current && liveActivityRef.current.step) {
      onToolEnd({ ok: true, result: asked.map((q) => q.question).join(' · ') });
    }
    closeActivityCard();

    const saveOption = (settingsRef.current && settingsRef.current.saveAnswers)
      ? { label: single ? 'Save answer to profile' : 'Save these answers to my profile', checked: true }
      : undefined;

    // Only the single-question form requires its box: in a batch, a blank is a real
    // answer ("I'm not telling you that"), and a required field would trap the user in
    // a modal over one question they cannot answer.
    const fields = asked.map((q, i) => ({
      name: `q${i}`,
      label: single ? 'Your answer' : q.question,
      type: q.long ? 'textarea' : (q.options && q.options.length ? 'choice' : 'text'),
      options: q.options,
      required: single,
      prose: !single, // the label is a whole question, not a one-word field name
    }));

    const result = await run.openAsk({
      title: single ? 'JobPilot needs an answer' : `JobPilot needs ${asked.length} answers`,
      message: single
        ? asked[0].question
        : 'Fill in what you can — anything left blank is treated as "no answer", not as a reason to ask again.',
      // Quick replies belong to the single-question form only; in a batch each question
      // renders its own picker (see Modal.jsx).
      options: single && asked[0].options ? asked[0].options.map(String) : undefined,
      fields,
      saveOption,
    });

    if (!result) {
      // Cancelled (Esc / Cancel / Stop). Record them as unanswered; the agent treats
      // a null return as "user did not answer".
      for (const q of asked) recordQuestion(q.question, q.options, null);
      return null;
    }

    const answers = asked.map((q, i) => {
      const v = result.values[`q${i}`];
      return v != null ? String(v) : '';
    });
    // One transcript record and one profile row PER question — never one blob. A blob
    // would be unmatchable next time and would carry four irrelevant answers into the
    // prompt to deliver the one that matched.
    asked.forEach((q, i) => recordQuestion(q.question, q.options, answers[i] || null, Boolean(result.save && answers[i])));
    if (result.save) {
      const pairs = asked
        .map((q, i) => ({ q: q.question, a: answers[i] }))
        .filter((p) => p.a.trim());
      if (pairs.length) saveAnswersToProfile(pairs);
    }
    return answers;
  }, [chime, closeActivityCard, finalizeAssistantBubble, onToolEnd, recordQuestion, saveAnswersToProfile]);

  /**
   * CONTRACT-V11 §4 — the plan card. One interruption for a whole form page.
   *
   * Two lists in one dialog: the values the agent intends to enter (ticked, editable, each
   * carrying where it came from) and the questions it could not answer. The user corrects,
   * unticks, answers, approves — and agent.js then fills the approved rows itself.
   *
   * The answers are saved to the profile on exactly the same terms as onAskUser's, through
   * the same recordQuestion / saveAnswersToProfile pair. That is not code-sharing for its
   * own sake: an answer given here has to be reusable next time, and an answer that lands
   * in a different shape depending on which dialog collected it is an answer that will not
   * match. The FILLS are deliberately NOT saved as answers — a value the agent derived for
   * one form's phrasing of a box is not a screening answer, and storing it would fill the
   * profile with a hundred rows nothing ever matches.
   *
   * @param {{rows: object[], unknowns: object[]}} plan
   * @returns {Promise<{fills: object[], answers: string[]}|null>} null if dismissed
   */
  const onProposePlan = useCallback(async ({ rows, unknowns }) => {
    const fills = Array.isArray(rows) ? rows : [];
    const asked = Array.isArray(unknowns) ? unknowns : [];
    if (!fills.length && !asked.length) return null;

    chime();
    finalizeAssistantBubble();
    // Settle the live activity row before the dialog replaces it — same reason as
    // onAskUser: the spinner would otherwise run forever once the modal closes.
    if (liveActivityRef.current && liveActivityRef.current.step) {
      onToolEnd({ ok: true, result: `plan: ${fills.length} fields, ${asked.length} questions` });
    }
    closeActivityCard();

    const saveOption = (settingsRef.current && settingsRef.current.saveAnswers) && asked.length
      ? { label: asked.length === 1 ? 'Save answer to profile' : 'Save these answers to my profile', checked: true }
      : undefined;

    const fields = [];
    if (fills.length) fields.push({ name: 'plan', type: 'plan', label: 'Fields', rows: fills });
    // Never `required`, for the same reason a batched ask_user is not: a blank is a real
    // answer ("I am not telling you that"), and a required box would trap the user in a
    // dialog over one question they cannot answer while nineteen approved fields wait.
    asked.forEach((q, i) => fields.push({
      name: `q${i}`,
      label: q.question,
      type: q.long ? 'textarea' : (q.options && q.options.length ? 'choice' : 'text'),
      options: q.options,
      prose: true,
    }));

    const inferred = fills.filter((r) => r.source === 'inferred').length;
    const messageParts = [];
    if (fills.length) {
      messageParts.push(
        inferred
          ? `${inferred} value${inferred === 1 ? ' was' : 's were'} worked out rather than taken from your profile — those are marked. Correct anything, untick what should stay empty.`
          : 'Every value below came from your profile or an answer you gave before. Correct anything, untick what should stay empty.'
      );
    }
    if (asked.length) messageParts.push('Anything you leave blank is treated as "no answer", not as a reason to ask again.');

    const result = await run.openAsk({
      title: fills.length ? 'Review this page before it is filled' : `JobPilot needs ${asked.length} answer${asked.length === 1 ? '' : 's'}`,
      message: messageParts.join(' '),
      fields,
      saveOption,
      submitLabel: fills.length ? `Fill ${fills.length} field${fills.length === 1 ? '' : 's'}` : 'Answer',
    });

    if (!result) {
      for (const q of asked) recordQuestion(q.question, q.options, null);
      addNotice('Plan dismissed — nothing was filled.', 'notice-error');
      return null;
    }

    // decodePlanRows returns [] on anything malformed, and the pairing below is positional,
    // so a short list leaves the tail unticked. That is the safe direction: the failure mode
    // of a corrupt payload is "filled less than you approved", never "filled things you did
    // not see".
    const decoded = decodePlanRows(result.values.plan);
    const approved = fills.map((row, i) => {
      const d = decoded[i];
      return { ...row, include: Boolean(d && d.include), value: d ? d.value : row.value };
    });

    const answers = asked.map((q, i) => {
      const v = result.values[`q${i}`];
      return v != null ? String(v) : '';
    });
    asked.forEach((q, i) => recordQuestion(q.question, q.options, answers[i] || null, Boolean(result.save && answers[i])));
    if (result.save) {
      const pairs = asked
        .map((q, i) => ({ q: q.question, a: answers[i] }))
        .filter((p) => p.a.trim());
      if (pairs.length) saveAnswersToProfile(pairs);
    }

    // The transcript keeps a plain-language record of what was agreed, so scrolling back
    // through a finished application answers "what did I approve on page 3" without
    // expanding a tool result. A notice rather than a new record type: it persists,
    // restores and renders through machinery that already exists.
    const kept = approved.filter((r) => r.include).length;
    const changed = approved.filter((r, i) => r.include && r.value !== fills[i].value).length;
    const parts = [`Plan approved — ${kept} of ${fills.length} field${fills.length === 1 ? '' : 's'}`];
    if (fills.length - kept) parts.push(`${fills.length - kept} left empty`);
    if (changed) parts.push(`${changed} corrected by you`);
    if (fills.length) addNotice(parts.join(', '), 'notice-ok');

    return { fills: approved, answers: asked.length ? answers : null };
  }, [
    addNotice, chime, closeActivityCard, finalizeAssistantBubble, onToolEnd,
    recordQuestion, run, saveAnswersToProfile,
  ]);

  // §6.2 onRequestSecret — the ONLY place a secret is collected in the panel. The
  // value returned here goes straight back to agent.js → fillSecret. It is NEVER
  // written into the transcript / persistChats, never into React state, never into a
  // toast or a log — only a masked {type:'secret'} record.
  const onRequestSecret = useCallback(async ({ kind, label, host, topHost, crossFrame }) => {
    chime();
    finalizeAssistantBubble();
    // NOT onToolEnd. Marking this ✓ here closed the step before the user had answered, and
    // the tool's real verdict — declined, or a fill the page refused — then had nowhere to
    // land. Say what is true right now (we are waiting) and let the real outcome finish it;
    // closeActivityCard hands the step to the orphan pointer so it still can.
    if (liveActivityRef.current && liveActivityRef.current.step) {
      const cur = liveActivityRef.current;
      // Mutate the record and bump the row, exactly as onToolStart/onToolEnd do. Persisted
      // with the rest of the step, so the restored transcript still says what this stopped
      // for instead of quietly reverting to the bare label.
      cur.step.waiting = true;
      bumpRow(cur.id);
      persistChats();
    }
    closeActivityCard();

    const isOtp = kind === 'otp';
    const noun = SECRET_KIND_NOUN[kind] || 'credential';

    // 1. Locked vault → offer to unlock first (OTP never touches the vault).
    //    Stop can fire while that modal is open; don't march on to a second prompt.
    if (!isOtp) await maybeUnlockVault();
    if (stopRequestedRef.current) return null;

    // 2/3. Look up a stored value (never for OTP). findForHost throws if locked.
    let prefill = '';
    let hadStored = false;
    if (!isOtp && vaultUnlocked()) {
      try {
        const entry = await vault.findForHost(host);
        if (entry) {
          hadStored = true;
          prefill = kind === 'username' ? (entry.username || '') : (entry.password || '');
        }
      } catch { /* locked / uninitialized — no prefill */ }
    }

    // 4. alwaysConfirmCredentials (default true): a pre-filled value still needs a
    //    click. Only when it is explicitly false do we auto-fill a stored value.
    const alwaysConfirm = !(settingsRef.current && settingsRef.current.alwaysConfirmCredentials === false);
    if (!isOtp && hadStored && prefill && !alwaysConfirm) {
      addSecretRecord(kind, host);
      return prefill;
    }

    // 5. Offer to save only for a new, non-OTP value into a writable (unlocked) vault.
    const saveOption = (!isOtp && host && vaultUnlocked())
      ? { label: `Save to vault for ${host}`, checked: !hadStored }
      : undefined;

    // A credential field inside an embedded frame from another origin is the shape
    // of a phishing attempt. Name the origin that will actually receive the value.
    const warning = crossFrame
      ? `This field is inside an embedded frame from ${host}, not ${topHost}. Only continue if you trust ${host} with your ${noun}.`
      : '';

    const fieldType = isOtp ? 'otp' : (kind === 'username' ? 'text' : 'password');
    const result = await run.openAsk({
      title: `Enter your ${noun}`,
      warning: warning || undefined,
      message: label || undefined,
      host: host || undefined,
      fields: [{
        name: 'secret',
        label: label || `${noun.charAt(0).toUpperCase() + noun.slice(1)}`,
        type: fieldType,
        value: prefill || undefined,
        secret: true,
        required: true,
        autocomplete: isOtp ? 'one-time-code' : 'off',
      }],
      saveOption,
      submitLabel: 'Fill',
    });

    // 7. Cancelled → null; the run continues or blocks honestly.
    if (!result) return null;
    const value = result.values.secret != null ? String(result.values.secret) : '';
    if (!value) return null;

    // 5 (cont.) Persist to the vault when asked and the value is actually new.
    if (result.save && !isOtp && host && vaultUnlocked()) {
      try {
        const existing = await vault.findForHost(host).catch(() => null);
        const entry = existing
          ? { ...existing }
          : { host, label: host, username: '', password: '', notes: '' };
        if (kind === 'username') entry.username = value;
        else entry.password = value;
        await vault.upsertEntry(entry);
      } catch (err) {
        showToast(`Could not save to vault: ${err.message}`, 'error');
      }
    }

    // 6. Masked transcript record only — the value is not in it.
    addSecretRecord(kind, host);
    // The raw value is returned to agent.js and never stored here.
    return value;
  }, [addSecretRecord, bumpRow, chime, closeActivityCard, finalizeAssistantBubble, persistChats]);

  const [runStatus, setRunStatusState] = useState('Working…');
  /**
   * The same string, readable synchronously. The "controlled by JobPilot" beat runs off a
   * timer and needs whatever the status is at that instant, and the beat must not be a
   * dependency of every status change — this pill re-words itself once per step, and a
   * re-created interval per step is how a heartbeat drifts.
   */
  const runStatusRef = useRef('Working…');
  /** Stable for the life of the component, so the deps arrays below need no entry for it. */
  const setRunStatus = useCallback((text) => {
    const next = text || 'Working…';
    runStatusRef.current = next;
    setRunStatusState(next);
  }, []);

  /**
   * What the indicator in the page currently claims. 'acting' is the agent driving;
   * 'watching' is request_demo, where the run is live but the USER is doing it and we are
   * recording — see onRequestDemo, which flips this and flips it back.
   */
  const ctrlModeRef = useRef('acting');

  /**
   * The agent is stuck. Pause, let the user do it by hand, watch, save it for the portal.
   * (CONTRACT-V6 §1)
   *
   * The modal lives in the SIDE PANEL, so it never blocks the page — the user works in the
   * tab while it is open, which is the whole point. The recording is NOT replayed here: the
   * user just performed the action, and replaying it would perform it twice (and the step
   * they demonstrated may well have been "Submit application").
   */
  const onRequestDemo = useCallback(async ({ goal, platform }) => {
    finalizeAssistantBubble();
    if (liveActivityRef.current && liveActivityRef.current.step) onToolEnd({ ok: true, result: goal });
    closeActivityCard();
    chime();

    const start = await run.openConfirm({
      title: 'JobPilot is stuck — show it how?',
      message: `${goal}\n\nClick "Show me how", then do it yourself in the page. JobPilot will watch and remember it for next time.`,
      okLabel: 'Show me how',
    });
    if (!start) {
      addNotice('You skipped the demonstration.');
      return { cancelled: true };
    }

    const tabId = await getTabIdForRun();
    const started = await run.startRecording(tabId);
    if (!started.ok) {
      addNotice(`Could not start recording: ${started.error}`);
      return { cancelled: true };
    }
    const armedFrames = started.frames || 0;
    // Which tab is being watched, before the demonstration rather than after it. A recording
    // aimed at one tab while the user works in another produces a perfect demonstration and
    // an empty macro, and until now the first they heard of it was "nothing was captured".
    let watching = '';
    try {
      const t = await chrome.tabs.get(tabId);
      watching = new URL(t.url || '').hostname || '';
    } catch { /* the tab went away; the dialog just omits the name */ }

    // The panel is the only thing that owns a recording, so it has to keep saying so: the
    // worker ends the session when this heartbeat stops (CONTRACT-V6 §6). A wall-clock
    // deadline would have been simpler and wrong — it would kill a demonstration that merely
    // waits on an OTP or a slow upload. Take as long as you like; just don't close the panel.
    const beat = setInterval(
      () => { run.recordingAlive(); },
      30_000);
    const abandon = () => { run.recordingAbandon(); };
    window.addEventListener('pagehide', abandon);

    setRunStatus('Recording — do it in the page, then click Done.');
    // The run is still live, so the indicator is still up — but the agent has stopped and
    // the USER is about to type into that page. Leaving it saying "JobPilot is controlling
    // this tab" over someone filling in their own application would simply be false, and
    // the one thing an indicator like this cannot afford to be is wrong. Sent directly
    // rather than left to the next beat: the user is being sent to the page right now.
    ctrlModeRef.current = 'watching';
    run.showControl(tabId, 'watching', 'do it in the page, then click Done');

    const done = await run.openConfirm({
      title: 'Recording…',
      message: `Go to the page and perform the action yourself — take as long as you need. ` +
        `Passwords are never recorded. When you are finished, click Done.\n\n` +
        `Watching ${watching ? watching : 'the target tab'}${armedFrames > 1 ? ` (${armedFrames} frames)` : ''}. ` +
        'Anything you do in a different tab is not recorded.',
      okLabel: 'Done',
    });
    clearInterval(beat);
    window.removeEventListener('pagehide', abandon);
    // Back to the agent. Every path out of here returns into the run, including the
    // cancelled ones, so this belongs with the recording teardown rather than in any one
    // of the branches below.
    ctrlModeRef.current = 'acting';

    const { ok, steps, dropped, lost, refused, refusedHosts, expired, tabs, host, frameHosts, error } =
      await run.stopRecording(tabId);
    if (!ok) {
      addNotice(`The recording failed: ${error}`);
      return { cancelled: true };
    }
    if (!done) {
      addNotice('Recording discarded.');
      return { cancelled: true };
    }
    // An expired session is NOT an empty one, and must never be reported as though the user
    // did nothing: something was recorded and then thrown away, and only we know that.
    if (expired) {
      addNotice(expired === 'panel'
        ? 'The recording was discarded because the side panel closed while it was running. ' +
          'JobPilot only records while the panel is open — reopen it and ask to try again.'
        : 'The recording ran for over an hour and was discarded. Start it again and demonstrate ' +
          'just the step JobPilot is stuck on.');
      return { cancelled: true };
    }

    if (!steps.length) {
      // Nothing SURVIVED is not the same as nothing HAPPENED, and this branch used to say the
      // second when it only knew the first — it returned here before ever looking at `lost` or
      // `refused`. A user who had just demonstrated six actions was told the page was to blame
      // and that JobPilot had watched them do nothing. Report what actually became of them.
      if (refused) {
        const where = refusedHosts.length ? refusedHosts.join(', ') : 'another tab';
        addNotice(
          `You performed ${refused} action${refused === 1 ? '' : 's'}, but ${refused === 1 ? 'it was' : 'they were'} ` +
          `in a tab JobPilot is not watching (${where}). JobPilot only records the tab shown at the top of this ` +
          `panel — right now that is ${host || 'the target tab'}. Switch to that tab, or point JobPilot at the tab ` +
          'you want to demonstrate in, and ask it to try again.');
      } else if (lost) {
        addNotice(
          `You performed ${lost} action${lost === 1 ? '' : 's'} and JobPilot could not save ` +
          `${lost === 1 ? 'it' : 'them'} — the page went away before the step reached the background worker, or the ` +
          'extension was reloaded mid-recording. Nothing was saved. Try the demonstration again.');
      } else {
        // Genuinely nothing arrived. Now — and only now — the recorder's blind spots are the
        // honest explanation.
        addNotice(
          `Nothing was captured. JobPilot watched every frame of ${tabs === 1 ? 'the tab' : `all ${tabs} tabs`} ` +
          `(${armedFrames} frame${armedFrames === 1 ? '' : 's'} armed) for the whole recording, including after the ` +
          'page changed. If you did act, the control was one it cannot see — a canvas, a native browser dialog, or ' +
          'a frame that blocks extensions.');
      }
      return { cancelled: true };
    }

    const bound = await bindStepsToProfile(steps);
    if (!platform) {
      // No portal, no macro: a macro is keyed by portal and there is nothing to key it to.
      // The action still happened — the agent is told so and carries on.
      addNotice(`Recorded ${bound.length} step${bound.length === 1 ? '' : 's'}, but no job portal was detected here, so there is nothing to save it against.`);
      return { cancelled: false, saved: null, performed: true, reason: 'no job portal was detected here' };
    }

    // The user is about to approve something that will be REPLAYED later, unattended. Three
    // things they must not be surprised by: a step that submits the form, a step that will
    // re-type a literal value, and — loudest of all — a demonstration we could not keep all
    // of. Approving 30 of 34 steps while believing you approved the whole thing is how a
    // macro ends up stopping halfway through an application.
    const submits = bound.some((s) => s.irreversible);
    const warnings = [];

    // A demonstration can legitimately cross hosts — a portal bounces you through SSO. But
    // while you are recording, the page can also open a tab, and whatever you then do in it
    // lands in the demonstration. You cannot consent to what you were not shown, so any host
    // that is not the one you started on gets named here, before anything is saved.
    // Compared against the tab's whole host set, not just the one it started on. An embedded
    // ATS form is a different host BY DESIGN — greenhouse/lever/workday inside the employer's
    // careers page — so keying this on the top host alone fired the warning on essentially
    // every demonstration, and a warning that always fires is one nobody reads by the time it
    // matters. What deserves the alarm is a host the DEMONSTRATION visited that the page's
    // own frames did not: a tab the page opened while recording.
    const knownHosts = new Set([host, ...(frameHosts || [])].filter(Boolean));
    const strays = [...new Set(bound.map((s) => s.host).filter((h) => h && !knownHosts.has(h)))];
    if (strays.length) {
      warnings.push(`This demonstration includes steps from ${strays.join(', ')}, which is not ` +
        `the page you started on (${host}) or any frame inside it. That is normal for a single ` +
        'sign-on redirect — but untick anything you did not mean to demonstrate.');
    }

    if (dropped) {
      warnings.push(`Your demonstration was longer than JobPilot can save. Only the first ` +
        `${bound.length} steps were kept — the last ${dropped} were dropped, so this macro will ` +
        `stop partway. Save it only if the first ${bound.length} steps are useful on their own.`);
    }
    // A hole in the middle of a macro is worse than a short one: it replays every step around
    // the gap and reports full success. The worker detects it from the gaps in each frame's
    // step sequence, which is the only way to know — the frame that lost it is long gone.
    if (lost) {
      warnings.push(`${lost} step${lost === 1 ? '' : 's'} JobPilot saw you perform never reached it ` +
        '— the list below has a hole in it. Re-record rather than saving this.');
    }
    if (submits) warnings.push('One step submits the form. It will only run unattended if you turn Auto-submit on.');

    const review = await run.openAsk({
      title: 'Save this demonstration?',
      message: 'JobPilot watched you do this and will repeat it next time. Untick anything it should not.',
      warning: warnings.length ? warnings.join(' ') : undefined,
      fields: [
        { name: 'name', label: 'Name it', type: 'text', required: true, value: suggestMacroName(goal) },
        {
          name: 'keep',
          label: 'Steps',
          type: 'checklist',
          items: bound.map((s) => ({
            label: s.irreversible ? `⚠ submits — ${s.label}` : s.label,
          })),
        },
      ],
      submitLabel: 'Save',
    });
    if (!review) {
      addNotice('Demonstration not saved.');
      return { cancelled: false, saved: null, performed: true, reason: 'the user chose not to save it' };
    }

    const keep = String(review.values.keep || '')
      .split(',')
      .filter((s) => s !== '')
      .map(Number);
    const chosen = bound.filter((_, i) => keep.includes(i));
    if (!chosen.length) {
      addNotice('Every step was unticked, so nothing was saved.');
      return { cancelled: false, saved: null, performed: true, reason: 'the user unticked every step' };
    }

    try {
      const macro = await saveMacro({
        platform,
        name: String(review.values.name || '').trim(),
        goal,
        steps: chosen,
      });
      addNotice(`Saved "${macro.name}" (${macro.steps.length} steps) for ${platformName(platform)}. JobPilot will use it next time.`);
      reloadMemory();
      return { cancelled: false, saved: macro.name };
    } catch (err) {
      addNotice(`Could not save the demonstration: ${err.message || err}`);
      return { cancelled: false, saved: null, performed: true, reason: `saving failed: ${err.message || err}` };
    }
  }, [addNotice, chime, closeActivityCard, finalizeAssistantBubble, getTabIdForRun, onToolEnd, reloadMemory, run]);

  // ------------------------------------------------------------- run lifecycle

  /**
   * panel.js:1928, minus its DOM half. The store owns the shared flag and the header pill;
   * hiding the composer and showing the run strip fall out of `running` in the JSX, and
   * `stopRequested` is ours.
   */
  const setRunning = useCallback((on) => {
    runningRef.current = on;
    if (on) stopRequestedRef.current = false;
    else setRunStatus('Working…'); // reset the label so the next run does not start mid-sentence
    run.setRunning(on);
  }, [run]);

  const makeRunner = useCallback(() => new AgentRunner({
    getTabId: getTabIdForRun,
    // Who this run is, and the registry it answers to. Without these the runner falls back
    // to the default id and a permissive tab stub — every concurrent runner then claims as
    // 'run-1' and the one-run-per-tab adoption guard never fires.
    runId: run.runId,
    tabs: run.tabs,
    callbacks: {
      onText: (delta) => {
        appendAssistantText(delta);
        // Live tokens/sec: estimated from characters, because the provider does not send
        // a token count until the stream ends. endStream replaces it with the exact rate.
        statsRef.current.onDelta(delta);
        renderStats();
      },
      onToolStart,
      onToolEnd,
      onStreamStart: () => { statsRef.current.beginStream(); renderStats(); },
      onStreamEnd: () => {
        // Fires in agent.js's finally, so it runs on abort too. If onUsage already landed,
        // stats.streaming is false and this is a no-op; if the user pressed Stop, no usage
        // event was ever emitted and this is what stops the HUD showing a frozen live rate
        // forever and silently losing that request's tokens.
        statsRef.current.abandonStream();
        renderStats();
      },
      onUsage: (usage) => {
        const s = settingsRef.current;
        statsRef.current.endStream(usage, modelInfo(s && s.model, s || {}));
        renderStats();
      },
      onMemory: ({ label, saved }) => {
        // The chip is the standing indicator of which playbook is live; a notice fires
        // only when the agent actually WROTE something, which is the event worth calling out.
        refreshPortalChip();
        if (saved) {
          addNotice(`Updated the ${label} playbook — the next application on ${label} will use it.`, 'notice-ok');
          // panel.js asked the DOM whether #view-memory was `.active`; the store knows.
          if (tabRef.current === 'memory') reloadMemory();
        }
      },
      onAskUser,
      onProposePlan,
      onRequestSecret,
      onRequestDemo,
      onStatus: (text) => {
        setRunStatus(text || 'Working…');
      },
      onDone: ({ status, summary }) => {
        finalizeAssistantBubble();
        closeActivityCard();
        const meta = DONE_LABELS[status] || DONE_LABELS.answered;
        addNotice(summary ? `${meta.text} — ${summary}` : meta.text, meta.variant);
        // §6: the run has ended. If the user stepped away, tell them — but only if
        // they are not already looking at the panel.
        if (!document.hasFocus()) chime();
      },
      onError: (err) => {
        finalizeAssistantBubble();
        closeActivityCard();
        const msg = err && err.message ? err.message : String(err);
        addNotice(msg, 'notice-error');
        setPill('error', 'Error');
        showToast('Agent stopped on an error', 'error');
        if (!document.hasFocus()) chime();
      },
    },
  }), [
    addNotice, appendAssistantText, chime, closeActivityCard, finalizeAssistantBubble,
    getTabIdForRun, onAskUser, onProposePlan, onRequestDemo, onRequestSecret, onToolEnd,
    onToolStart, refreshPortalChip, reloadMemory, renderStats, setPill,
  ]);

  // The runner is created lazily and replaced only by New Chat, exactly as panel.js's
  // module-level `runner` was. It is NOT re-created when makeRunner's identity changes:
  // a live run must survive that, and every callback above reads through refs anyway.
  const runnerRef = useRef(null);
  const makeRunnerRef = useRef(makeRunner);
  useEffect(() => { makeRunnerRef.current = makeRunner; }, [makeRunner]);

  const getRunner = useCallback(() => {
    if (!runnerRef.current) runnerRef.current = makeRunnerRef.current();
    return runnerRef.current;
  }, []);

  // StrictMode remounts effects in a development build, and an AgentRunner left streaming
  // into a component that is being torn down is the exact bug that guard exists to find.
  useEffect(() => {
    getRunner();
    return () => {
      try { runnerRef.current && runnerRef.current.stop(); } catch { /* already stopped */ }
    };
  }, [getRunner]);

  const handleStop = useCallback(() => {
    // Resolve THIS run's open modals (ask_user, request_secret, unlock…) with null so the
    // agent's pending await settles and the run halts cleanly. Scoped to the run because
    // stopping one application must never cancel the question another one is waiting on.
    stopRequestedRef.current = true;
    run.closeModals();
    getRunner().stop();
    setRunStatus('Stopping…');
  }, [getRunner, run]);

  /**
   * Returns TRUE when the message was accepted, so <Composer> knows whether to clear its
   * box. panel.js returned early — before touching the input — in both refusal branches.
   */
  const handleSend = useCallback((raw) => {
    const text = String(raw || '').trim();
    if (!text || runningRef.current) return false;

    if (!isConfigured()) {
      showToast('Configure your LLM in Settings first', 'error');
      setTab('settings');
      return false;
    }

    setPillState('ready'); // clear a sticky error state on new activity
    addUserMessage(text);
    setRunning(true);
    // Fire and forget, exactly as the click handler did: agent.js routes every real failure
    // to onError, and the finally below is what puts the composer back either way.
    (async () => {
      try {
        await getRunner().run(text);
      } finally {
        finalizeAssistantBubble();
        closeActivityCard();
        settleOrphanStep();
        setRunning(false);
      }
    })();
    return true;
  }, [
    addUserMessage, closeActivityCard, finalizeAssistantBubble, getRunner, isConfigured,
    setPillState, setRunning, setTab, settleOrphanStep,
  ]);

  const handleNewChat = useCallback(async ({ carryAnswers = true } = {}) => {
    if (runningRef.current) handleStop();
    // The answers you gave in THIS chat travel to the next one. New Chat throws away the
    // message history, and an answer that lived only in that history was gone with it —
    // so the next chat asked the same question again. Anything answered here and not yet
    // in the profile is carried over first (the profile is what every future run's system
    // prompt is built from), skipping only the ones whose save box was deliberately cleared.
    if (carryAnswers) await carryAnswersToProfile();
    getRunner().reset();
    runnerRef.current = makeRunnerRef.current();
    setRows([]);
    liveAssistantRef.current = null;
    liveActivityRef.current = null;
    orphanRef.current = null;
    streamRef.current = null;
    setRunningStep(null);
    // The stats describe the conversation that just ended, so they go with it. Without
    // this the HUD read as a contradiction: "Context" is scoped to the live conversation
    // and had just dropped to zero, while Requests / Input / Output / Session went on
    // accumulating across every chat since the panel was opened — lifetime totals sitting
    // in the same grid as a current-conversation gauge, with nothing saying they were
    // measuring different things.
    statsRef.current.reset();
    renderStats();
    try {
      await run.clearChats();
    } catch (err) {
      showToast(`Could not clear stored chat: ${err.message}`, 'error');
    }
    showToast('New chat started', 'success');
  }, [carryAnswersToProfile, getRunner, handleStop, renderStats, run, setRows]);

  // ------------------------------------------------------------------- restore

  /**
   * The stored transcript, as view rows. Returns them rather than setting them so the mount
   * effect below can keep its cancelled-guard around the state update, and reloadChat can
   * apply them directly.
   */
  // Through the ref, keyed on the runId string — NOT on the api object. The api's identity
  // churns with the runs context, and the mount effect below re-fires when this re-creates;
  // each re-fire REPLACED the live transcript with the disk copy, which mid-run is stale or
  // empty. That, with three applications churning each other, was transcripts vanishing
  // while their runs kept going. `run.runId` is constant for a mounted view, so this is
  // created once and the effect genuinely runs once.
  const storedRows = useCallback(async () => {
    const records = await runApiRef.current.getChats();
    return (Array.isArray(records) ? records : []).map((record) => ({
      id: nextRowId(), rev: 0, record, live: false,
    }));
  }, [run.runId]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * Replace the live transcript with whatever is in storage NOW. Restoring a backup is the
   * only caller (SettingsView), and it is the mount restore plus a teardown.
   *
   * The teardown is the part that is easy to miss: the AgentRunner holds its own copy of the
   * conversation, built from the transcript that has just been overwritten. Reloading the
   * rows without resetting the runner would show the restored chat while the next message
   * was sent with the PRE-import conversation still prepended — the model answering about a
   * transcript the user can no longer see. Same reset handleNewChat does, and for the same
   * reason.
   */
  const reloadChat = useCallback(async () => {
    if (runningRef.current) handleStop();
    getRunner().reset();
    runnerRef.current = makeRunnerRef.current();
    liveAssistantRef.current = null;
    liveActivityRef.current = null;
    orphanRef.current = null;
    streamRef.current = null;
    setRunningStep(null);
    setRows(await storedRows());
    stickyRef.current = true;
  }, [getRunner, handleStop, setRows, storedRows]);

  // The Danger Zone and the Backup section in SettingsView reach the transcript through
  // these handles (panel.js:2530-2565 wired "Clear chat" and "Clear ALL data" to
  // handleNewChat, and cancelled the pending chat write before wiping storage).
  //
  // resetStats and refreshPortalChip are here for the same reason: clearAllData called
  // stats.reset() + renderStats() (panel.js:2557-2558) and refreshPortalChip() (2555)
  // directly, because in the vanilla panel they shared one module scope. Both are
  // chat-local now, so the wipe reaches them the same way it reaches the transcript.
  // Note handleNewChat deliberately does NOT reset stats — a new chat keeps the session's
  // token and cost totals (panel.js:2041-2065 never touched them); only a full wipe does.
  useEffect(() => run.registerChat({
    newChat: handleNewChat,
    stop: handleStop,
    cancelChatSave: () => persistChats.cancel(),
    resetStats: () => { statsRef.current.reset(); renderStats(); },
    refreshPortalChip,
    reloadChat,
  }), [
    handleNewChat, handleStop, persistChats, run,
    renderStats, refreshPortalChip, reloadChat,
  ]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await storedRows();
        if (cancelled) return;
        // SET, never append. StrictMode runs this effect twice in a development build and
        // an append-based restore would show the whole transcript twice.
        setRows(rows);
        // panel.js:2097 pinned the restored transcript to the bottom unconditionally.
        stickyRef.current = true;
      } catch (err) {
        showToast(`Could not restore chat: ${err.message}`, 'error');
      }
    })();
    return () => { cancelled = true; };
  }, [setRows, storedRows]);

  // --------------------------------------------------------------- target poll

  useEffect(() => {
    refreshTargetTab();
    refreshPortalChip();
    const timer = setInterval(refreshTargetTab, 4000);
    window.addEventListener('focus', refreshTargetTab);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refreshTargetTab);
    };
  }, [refreshPortalChip, refreshTargetTab]);

  // switchTab (panel.js:248) refreshed the target tab whenever the user came back to Chat.
  // setTab is pure state now, so the on-activate refresh is this view's job. It also fires
  // once on mount alongside the effect above; one extra chrome.tabs.query at startup is
  // cheaper than tracking the previous tab to suppress it.
  useEffect(() => {
    if (tab === 'chat') refreshTargetTab();
  }, [tab, refreshTargetTab]);

  // ------------------------------------------------- "controlled by JobPilot"
  //
  // While a run is live, the tab being driven says so — in the tab, where the user is
  // looking when a field fills itself with no cursor in it.
  //
  // The whole thing hangs off `running`, which is what makes it come DOWN reliably: the
  // cleanup fires on every way a run can end (done, error, Stop, New Chat, unmount), so
  // there is no exit path that has to remember to switch it off. Three further backstops
  // exist because "the indicator is still up" and "the agent is still typing into your
  // application" must never be able to disagree:
  //   · closing the side panel kills this page without running cleanup — pagehide catches it
  //   · a panel that CRASHES sends nothing at all — the page takes the indicator down
  //     itself once the beats stop (content-script.js, checkIndicator)
  //   · a run whose working tab closed re-targets — the beat follows runner.tabId, and the
  //     worker clears the tab it left
  useEffect(() => {
    if (!running) return undefined;

    let stopped = false;
    // Nothing in here may throw into the timer. The indicator is a courtesy, and a run must
    // never end because one could not be delivered.
    const beat = async () => {
      try {
        // The runner pins its working tab a moment after the run starts. Until it has, use
        // the same §10 resolution the run itself is about to use, so the indicator is up
        // from the first step rather than four seconds into it.
        let tabId = runnerRef.current && runnerRef.current.tabId;
        if (typeof tabId !== 'number') tabId = await getTabIdForRun(); // throws on a restricted page
        if (stopped) return; // the run ended while we resolved; do not re-arm what cleanup just cleared
        run.showControl(tabId, ctrlModeRef.current, runStatusRef.current);
      } catch { /* no tab to mark, or no worker to tell */ }
    };

    beat();
    const timer = setInterval(beat, 4000);
    const drop = () => run.hideControl();
    window.addEventListener('pagehide', drop);
    return () => {
      stopped = true;
      clearInterval(timer);
      window.removeEventListener('pagehide', drop);
      drop();
    };
  }, [running, getTabIdForRun, run]);

  // ---------------------------------------------------------------- callbacks

  const onNewChat = useCallback(() => { handleNewChat(); }, [handleNewChat]);
  // wireMemory (panel.js:1333) did `openPlaybooks.add(detection.platform)` and THEN
  // switchTab('memory'), so clicking the chip landed on the Memory tab with that portal's
  // row already expanded — the whole point of the chip being a link rather than a label.
  // `openPlaybooks` is MemoryView's state now, so the platform goes through the store's
  // one-shot reveal channel and MemoryView expands it on activate.
  const onChipClick = useCallback(() => {
    const det = detectionRef.current;
    if (det && det.platform) revealPlaybook(det.platform);
    setTab('memory');
  }, [revealPlaybook, setTab]);
  const onOpenSettings = useCallback(() => { setTab('settings'); }, [setTab]);
  const onOpenProfile = useCallback(() => { setTab('profile'); }, [setTab]);

  // Starting another application, from the toolbar of this one.
  const allRuns = useRuns();
  const canOpenRun = allRuns.runs.length < allRuns.max;
  const newRunHint = canOpenRun
    ? 'Apply to another job at the same time — open it in a new tab first'
    : `${allRuns.max} applications at once is the limit — raise it in Settings`;
  const onNewRun = useCallback(async () => {
    const res = await allRuns.openRun();
    if (!res.ok) showToast(res.error, 'error');
  }, [allRuns]);

  return (
    <>
      <ChatToolbar
        title={target.title}
        favIconUrl={target.favIconUrl}
        onNewChat={onNewChat}
        onNewRun={onNewRun}
        canOpenRun={canOpenRun}
        newRunHint={newRunHint}
      />

      {/* Detected ATS portal for the target tab (CONTRACT-V3 §6.3). Absent when none. */}
      <PortalChip chip={chip} onClick={onChipClick} />

      <MessageList
        rows={rows}
        runningStep={runningStep}
        streamRef={streamRef}
        onPaint={scrollIfSticky}
        listRef={listRef}
        onScroll={onListScroll}
        // Read at render, not from the ref: settings changes re-render this component via
        // useSettings, so the empty state flips the moment the LLM is connected.
        configured={isConfigured()}
        onOpenSettings={onOpenSettings}
        onOpenProfile={onOpenProfile}
      />

      {running ? <RunStrip status={runStatus} onStop={handleStop} /> : null}

      <Composer hidden={running} onSend={handleSend} />

      {/* Session stats: live tokens/sec, context-window occupancy, cumulative cost.
          Isolated behind StatsSlot so a per-token tick cannot reach this component. */}
      <StatsSlot stats={statsRef.current} subscribe={subscribeStats} />
    </>
  );
}

/**
 * One application: its RunApi, and the slot it renders in.
 *
 * THE TAB IS PINNED ON FIRST USE, not at creation. A run with no tab yet resolves the
 * active one, claims it, and keeps it — which is exactly what the single run always did,
 * so someone applying to one job at a time sees no change. Binding at creation instead
 * would claim whatever was in front when you pressed +, which is usually the job you are
 * still reading rather than the one you want filled.
 */
function RunHost({ run, active }) {
  // The individual functions, NOT the context object. The object's identity changes on
  // every runs update — a status flip anywhere, a title refresh — while these functions
  // are stable useCallbacks. Depending on the object made every callback below churn per
  // update, which cascaded into a new RunApi identity per update, which re-fired every
  // effect in RunView keyed on it. The visible symptom was the restore effect replacing
  // live transcripts mid-run (see RunView); the cure for the whole class is here.
  const { bindTab, setRunRunning, registerRunChat, tabsFor } = useRuns();
  const boundTabIdRef = useRef(run.tabId);
  boundTabIdRef.current = run.tabId;

  const resolveTab = useCallback(async () => {
    const pinned = boundTabIdRef.current;
    if (typeof pinned === 'number') {
      try { return await chrome.tabs.get(pinned); } catch { /* closed — fall through */ }
    }
    // Not pinned yet: show the tab this run WOULD take, so the header is honest before
    // the first message rather than saying "No target tab" at the moment you are deciding.
    return active ? resolveTargetTab() : null;
  }, [active]);

  const getTabId = useCallback(async () => {
    const pinned = boundTabIdRef.current;
    if (typeof pinned === 'number') {
      try { await chrome.tabs.get(pinned); return pinned; } catch { /* closed — re-pin */ }
    }
    const tabInfo = await resolveTargetTab();
    if (!tabInfo) {
      throw new Error('No target tab found. Open the job page in a normal browser tab, then try again.');
    }
    const bound = await bindTab(run.id, tabInfo.id, {
      title: tabInfo.title || '',
      host: hostOfUrl(tabInfo.url),
      windowId: tabInfo.windowId ?? null,
    });
    if (!bound.ok) throw new Error(bound.error);
    boundTabIdRef.current = tabInfo.id;
    return tabInfo.id;
  }, [run.id, bindTab]);

  const setRunning = useCallback((on) => {
    setRunRunning(run.id, on);
  }, [run.id, setRunRunning]);

  const registerChat = useCallback(
    (api) => registerRunChat(run.id, api),
    [run.id, registerRunChat],
  );

  // The registry collaborator the AgentRunner enforces one-run-per-tab with: ownerOf is
  // its adoption guard, claim/release keep the registry honest about adopted tabs.
  const tabs = useMemo(() => tabsFor(run.id), [run.id, tabsFor]);

  const api = useRunApi({ runId: run.id, resolveTab, getTabId, setRunning, registerChat, tabs });

  return (
    <div className={`run-slot${active ? ' active' : ''}`}>
      <RunProvider value={api}>
        <RunView running={run.running} />
      </RunProvider>
    </div>
  );
}

/**
 * The Chat screen: every application in flight, one of them visible.
 *
 * All runs stay MOUNTED. That is the same reason App.jsx keeps all five views mounted —
 * a RunView owns its AgentRunner and its live transcript, so unmounting the one you
 * switched away from would abandon an application halfway through a form.
 */
export default function ChatView() {
  const { runs, selectedId, select, openRun, closeRun, max } = useRuns();

  const onOpen = useCallback(async () => {
    const res = await openRun();
    if (!res.ok) showToast(res.error, 'error');
  }, [openRun]);

  return (
    <>
      <RunTabs
        runs={runs}
        selectedId={selectedId}
        onSelect={select}
        onClose={closeRun}
        onOpen={onOpen}
        canOpen={runs.length < max}
        openHint={runs.length < max
          ? 'Open the next job in another tab, then start it here'
          : `${max} at once is the limit — raise it in Settings`}
      />
      {runs.map((run) => (
        <RunHost key={run.id} run={run} active={run.id === selectedId} />
      ))}
    </>
  );
}
