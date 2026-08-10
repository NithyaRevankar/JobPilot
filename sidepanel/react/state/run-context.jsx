/**
 * run-context.jsx — the seam a run reaches the outside world through.
 *
 * WHY THIS EXISTS. RunView (formerly ChatView) is ~1,375 lines whose *component* state —
 * the transcript, the streaming bubble, the open activity card, the AgentRunner, the
 * SessionStats — is already per-instance and already correct if you mount two of them.
 * What is not correct is every line where it reaches for something GLOBAL: the active
 * tab, the one chatHistory key, the one control-indicator session, the modal queue's
 * force-close, the shell's single `running` flag. Those are what make a second
 * concurrent run impossible, and they are what this context owns.
 *
 * THE POINT OF THE INDIRECTION. Introducing it is a mechanical change with NO behaviour
 * change: the implementations below are exactly what RunView called directly before, so
 * all ten harnesses must pass untouched after the redirect. Concurrency then arrives by
 * swapping what the provider supplies — a bound tab id instead of "the active tab", a
 * runId-scoped transcript instead of the one key, a runId-scoped indicator instead of the
 * one session — without reopening the streaming path, which is the part that is genuinely
 * hard to get right and the part a stale closure breaks silently.
 *
 * So: everything here is per-run by construction, even while there is only one run.
 */

import { createContext, useContext, useMemo } from 'react';

import { DEFAULT_RUN_ID, clearChats, getChats, saveChats } from '../../js/storage.js';
import { hideControl, showControl, startRecording, stopRecording } from '../../js/tools.js';
import { closeModalsFor, openAsk, openConfirm } from '../components/Modal.jsx';

/**
 * @typedef {object} RunApi
 * @property {string}   runId        stable for the life of the run; the key everything scopes by
 * @property {() => Promise<number>} getTabId  the tab this run drives. THROWS when there is none —
 *                                   that throw is a message for the model, not for the UI.
 * @property {() => Promise<object|null>} resolveTab  full tab record, for the header title/favicon
 * @property {() => Promise<Array>} getChats
 * @property {(records: Array) => Promise<Array>} saveChats
 * @property {() => Promise<void>} clearChats
 * @property {(tabId: number, mode: string, status: string) => Promise<void>} showControl
 * @property {() => Promise<void>} hideControl
 * @property {() => void} closeModals   force-close THIS run's dialogs, never anyone else's
 * @property {(on: boolean) => void} setRunning
 * @property {(api: object) => (() => void)} registerChat
 */

/** @type {import('react').Context<RunApi|null>} */
const RunContext = createContext(null);

/**
 * The id used while exactly one run exists. It is storage.js's DEFAULT_RUN_ID, which is
 * also the run a pre-multi-run `chatHistory` array migrates into — so an existing install
 * opens the panel and finds its transcript exactly where it left it.
 */
export const SOLE_RUN_ID = DEFAULT_RUN_ID;

export function RunProvider({ value, children }) {
  return <RunContext.Provider value={value}>{children}</RunContext.Provider>;
}

/** Every per-run service RunView is allowed to touch. Throws if used outside a provider. */
export function useRun() {
  const ctx = useContext(RunContext);
  if (!ctx) throw new Error('useRun must be used inside a <RunProvider>.');
  return ctx;
}

/**
 * Build the RunApi for a single run.
 *
 * `deps` carries the things that come from React and therefore cannot be imported here:
 * the shell's setRunning/registerChat, and resolveTargetTab (which is RunView's, because
 * it is the thing Phase 2 replaces with a bound tab id).
 *
 * Memoized on its inputs so the identity is stable across renders — RunView hands pieces
 * of this to an AgentRunner whose callbacks must not be rebuilt mid-stream.
 */
export function useRunApi({ runId, resolveTab, getTabId, setRunning, registerChat, tabs }) {
  return useMemo(() => ({
    runId,

    // The registry collaborator for this run — handed to its AgentRunner so the loop's
    // tab adoption honours other runs' claims. Optional: absent (single-run harnesses),
    // the runner's own permissive default applies.
    tabs,

    // The tab this run is looking at, for the header title and the portal chip. Once the
    // run has pinned a tab this is THAT tab, not whatever is in front — otherwise every
    // mounted run's header would report the same page regardless of which one it drives.
    resolveTab,

    getTabId,

    // Transcript. One run, one transcript, keyed by runId inside the single `chatHistory`
    // key — see the transcripts section of storage.js for why it is one key and not one
    // key per run.
    getChats: () => getChats(runId),
    saveChats: (records) => saveChats(runId, records),
    clearChats: () => clearChats(runId),

    // "Controlled by JobPilot", scoped to this run — the worker keys its sessions by runId,
    // so one run ending cannot take the indicator off another run's tab.
    showControl: (tabId, mode, status) => showControl(runId, tabId, mode, status),
    hideControl: () => hideControl(runId),

    // The demonstration recorder. There is still exactly one, because the user can only be
    // in one place at a time — these carry the runId so the worker can tell the owner from
    // everyone else and refuse the rest, rather than silently handing over their steps.
    startRecording: (tabId) => startRecording(runId, tabId),
    stopRecording: (tabId) => stopRecording(runId, tabId),
    recordingAlive: () => chrome.runtime
      .sendMessage({ kind: 'jobpilot:rec-alive', runId }).catch(() => {}),
    recordingAbandon: () => chrome.runtime
      .sendMessage({ kind: 'jobpilot:rec-close', runId }).catch(() => {}),

    // Dialogs this run raised, tagged with it. The tag is what lets Stop cancel only this
    // run's questions — answering `null` to another run's ask_user reads to that run as
    // "the user declined", and it abandons a form it was halfway through.
    openAsk: (spec) => openAsk(spec, runId),
    openConfirm: (spec) => openConfirm(spec, runId),
    closeModals: () => closeModalsFor(runId),

    setRunning,
    registerChat,
  }), [runId, resolveTab, getTabId, setRunning, registerChat, tabs]);
}
