/**
 * runs-context.jsx — how many applications are in flight, and which one you are looking at.
 *
 * WHY THIS IS SEPARATE FROM store.jsx. The store holds things every screen reads (settings,
 * profile, the memory bank). This holds something only the Chat screen reads, and it changes
 * on a different clock: a run starting, blocking or finishing. Keeping it out of the store
 * means a run's status flipping does not re-render the Profile and Vault tabs.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not touch store.jsx's `running` flag or its
 * `registerChat` handle, both of which are singular and both of which several screens read.
 * Instead it feeds them: `running` is set to "is ANY run running", which is exactly what the
 * header pill wanted from it all along, and one aggregate chat handle is registered that
 * fans out to every mounted run. So Settings' "Clear chat", "Clear ALL data" and "Restore
 * backup" reach every run rather than whichever one happened to register last — which is
 * what they would have done, silently, if each run registered for itself.
 */

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';

import { MAX_CONCURRENT_RUNS, RUN_STATUS, RunRegistry } from '../../js/runs.js';
import { useAppShell, useSettings } from './store.jsx';

const RunsContext = createContext(null);

export function useRuns() {
  const ctx = useContext(RunsContext);
  if (!ctx) throw new Error('useRuns must be used inside a <RunsProvider>.');
  return ctx;
}

export { RUN_STATUS };

export function RunsProvider({ children }) {
  const { setRunning: shellSetRunning, registerChat } = useAppShell();
  const { settings } = useSettings();

  // One registry for the panel. It owns the tab↔run mapping and asks the worker before
  // claiming, so a tab another WINDOW's panel is driving is refused rather than stolen.
  const registryRef = useRef(null);
  if (registryRef.current === null) registryRef.current = new RunRegistry();
  const registry = registryRef.current;

  // The first run exists from the start, with no tab yet. That is what keeps the panel
  // behaving exactly as it always did for someone who never opens a second application:
  // open the panel, type, and it acts on the tab in front of you.
  const [runs, setRuns] = useState(() => [{
    id: 'run-1', tabId: null, title: '', host: '', status: RUN_STATUS.IDLE, running: false,
  }]);
  const [selectedId, setSelectedId] = useState('run-1');
  // Settings owns the cap; storage.js clamps it. `settings` is null until the store has
  // read from disk, which is before any view mounts — the fallback is only for that gap.
  const max = (settings && settings.maxConcurrentRuns) || MAX_CONCURRENT_RUNS;
  useEffect(() => { registry.max = max; }, [max, registry]);

  const runsRef = useRef(runs);
  runsRef.current = runs;

  const patch = useCallback((runId, fields) => {
    setRuns((list) => {
      const idx = list.findIndex((r) => r.id === runId);
      if (idx < 0) return list;
      const next = { ...list[idx], ...fields };
      // Same values, same array — a 4s poll that re-reports the same title must not
      // re-render every mounted run.
      if (Object.keys(fields).every((k) => list[idx][k] === next[k])) return list;
      const copy = list.slice();
      copy[idx] = next;
      return copy;
    });
  }, []);

  // ------------------------------------------------------------------ running

  const setRunRunning = useCallback((runId, on) => {
    patch(runId, { running: on, status: on ? RUN_STATUS.RUNNING : RUN_STATUS.IDLE });
    registry.setStatus(runId, on ? RUN_STATUS.RUNNING : RUN_STATUS.IDLE);
  }, [patch, registry]);

  // The shell's single flag becomes "any application is working", which is what the header
  // pill needs. Runs themselves read their OWN flag — a global one would hide every
  // composer and refuse Send in every run the moment one of them started.
  const anyRunning = runs.some((r) => r.running);
  useEffect(() => { shellSetRunning(anyRunning); }, [anyRunning, shellSetRunning]);

  // ------------------------------------------------------------- open / close

  const openRun = useCallback(async () => {
    const live = runsRef.current;
    if (live.length >= max) {
      return { ok: false, error: `You can run ${max} applications at once. Finish one, or raise the limit in Settings.` };
    }
    // Deliberately NOT bound to a tab yet. A run pins its tab when it starts, the same way
    // the single run always did — binding at creation would claim whatever happened to be
    // in front when you pressed +, which is usually the job you are still reading.
    const id = `run-${Date.now().toString(36)}-${live.length + 1}`;
    setRuns((list) => [...list, {
      id, tabId: null, title: '', host: '', status: RUN_STATUS.IDLE, running: false,
    }]);
    setSelectedId(id);
    return { ok: true, id };
  }, [max]);

  const closeRun = useCallback((runId) => {
    const live = runsRef.current;
    if (live.length <= 1) return; // never leave the Chat tab with nothing in it
    registry.remove(runId);
    setRuns((list) => list.filter((r) => r.id !== runId));
    setSelectedId((cur) => {
      if (cur !== runId) return cur;
      const rest = runsRef.current.filter((r) => r.id !== runId);
      return rest.length ? rest[0].id : cur;
    });
  }, [registry]);

  // ------------------------------------------------------------- tab binding

  /**
   * Claim a tab for a run and remember it. Called when a run STARTS, not when it is
   * created, and it is the only place a run acquires its tab.
   */
  const bindTab = useCallback(async (runId, tabId, meta = {}) => {
    const owner = registry.ownerOf(tabId);
    if (owner && owner !== runId) {
      return { ok: false, error: 'Another application in this panel is already running in that tab. Open this job in a new tab, or switch to that application.' };
    }
    const claimed = await registry.claim(tabId, runId);
    if (!claimed.ok) return claimed;
    if (!registry.get(runId)) {
      // Mirror the run into the registry the first time it takes a tab, so ownerOf() and
      // the cap see it.
      registry.runs.set(runId, {
        id: runId, tabId, windowId: meta.windowId ?? null, title: meta.title || '',
        host: meta.host || '', status: RUN_STATUS.RUNNING, createdAt: null,
      });
    } else {
      registry.retarget(runId, tabId);
    }
    patch(runId, { tabId, ...meta });
    return { ok: true };
  }, [patch, registry]);

  /** The collaborator AgentRunner takes, bound to one run. */
  const tabsFor = useCallback((runId) => {
    const inner = registry.tabsFor(runId);
    return {
      ownerOf: inner.ownerOf,
      claim: (tabId) => { inner.claim(tabId); patch(runId, { tabId }); },
      release: inner.release,
    };
  }, [patch, registry]);

  // The two tab events nothing in this extension listened for before. Without onRemoved a
  // run whose tab closes while it waits on a question waits for ever, holding the modal
  // queue's only slot; without onReplaced a prerender activation changes the tab id and the
  // run dies on a page that is alive and well.
  useEffect(() => {
    const onRemoved = (tabId) => {
      const owner = registry.forgetTab(tabId);
      if (owner) patch(owner, { tabId: null });
    };
    const onReplaced = (addedTabId, removedTabId) => {
      const owner = registry.replaceTab(removedTabId, addedTabId);
      if (owner) patch(owner, { tabId: addedTabId });
    };
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onReplaced.addListener(onReplaced);
    return () => {
      chrome.tabs.onRemoved.removeListener(onRemoved);
      chrome.tabs.onReplaced.removeListener(onReplaced);
    };
  }, [patch, registry]);

  // ------------------------------------------------------- the chat handles

  // Each run registers here; ONE aggregate goes to the store. See the header.
  const chatApis = useRef(new Map());
  const registerRunChat = useCallback((runId, api) => {
    chatApis.current.set(runId, api);
    return () => {
      if (chatApis.current.get(runId) === api) chatApis.current.delete(runId);
    };
  }, []);

  useEffect(() => registerChat({
    // Settings' "Clear chat" means the one you are looking at.
    newChat: (opts) => {
      const api = chatApis.current.get(selectedId);
      return api ? api.newChat(opts) : undefined;
    },
    stop: () => { for (const api of chatApis.current.values()) api.stop(); },
    cancelChatSave: () => { for (const api of chatApis.current.values()) api.cancelChatSave(); },
    resetStats: () => { for (const api of chatApis.current.values()) api.resetStats(); },
    refreshPortalChip: async () => {
      await Promise.all([...chatApis.current.values()].map((api) => api.refreshPortalChip()));
    },
    // A restore replaces chatHistory under EVERY mounted run, and each one holds its own
    // copy of the conversation inside its AgentRunner. Reloading only the visible one would
    // leave the others writing their pre-import transcripts back over the restored file.
    reloadChat: async () => {
      await Promise.all([...chatApis.current.values()].map((api) => api.reloadChat()));
    },
  }), [registerChat, selectedId]);

  const value = useMemo(() => ({
    runs,
    selectedId,
    select: setSelectedId,
    openRun,
    closeRun,
    setRunRunning,
    setRunStatus: (runId, status) => { patch(runId, { status }); registry.setStatus(runId, status); },
    patchRun: patch,
    bindTab,
    tabsFor,
    registerRunChat,
    ownerOf: (tabId) => registry.ownerOf(tabId),
    max,
    anyRunning,
  }), [
    runs, selectedId, openRun, closeRun, setRunRunning, patch, bindTab, tabsFor,
    registerRunChat, registry, max, anyRunning,
  ]);

  return <RunsContext.Provider value={value}>{children}</RunsContext.Provider>;
}
