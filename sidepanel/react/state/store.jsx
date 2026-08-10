/**
 * store.jsx — the app-wide state panel.js kept in module-level `let`s (panel.js:30-46).
 *
 * WHAT LIVES HERE, and why: settings, profile, documents, playbooks, siteNotes and macros
 * are each read from chrome.storage by more than one screen and written by more than one
 * screen. In panel.js they were module globals plus a hand-written re-render call after
 * every mutation (`renderDocuments()`, `refreshMemoryView()`, `renderSavedAnswers()`);
 * here a mutation updates state and React re-renders whoever is reading it. Those manual
 * refresh calls are the bookkeeping this migration exists to delete.
 *
 * WHAT DELIBERATELY DOES NOT LIVE HERE:
 *
 *   - Chat messages and streaming state. They are ChatView-local, and that is not a
 *     stylistic preference: onText fires once per streamed token, and a global store
 *     update per token would re-render the header, the tab bar and all five view slots
 *     for every character the model emits. The panel would stutter. ChatView owns
 *     `uiMessages`, the AgentRunner, SessionStats, `stopRequested` and the target-tab
 *     poll; nothing else needs them.
 *   - Vault entries and lock state. sidepanel/js/vault.js already IS that store, it holds
 *     the decrypted key in module memory, and copying secrets into React state would only
 *     widen where they live. VaultView talks to vault.js directly.
 *   - Which playbook rows are expanded, which danger button is armed, model lists fetched
 *     for the Settings dropdown. All view-local.
 *
 * Every mutation here follows the same shape: call the storage.js function, await it, put
 * what storage returned into state. storage.js is the one that clamps, dedupes and
 * normalizes, so state always holds the value that is actually on disk — never an
 * optimistic guess of it.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import {
  DEFAULT_SETTINGS,
  DEFAULT_PROFILE,
  getSettings,
  saveSettings as storageSaveSettings,
  getProfile,
  saveProfile as storageSaveProfile,
  appendSavedAnswers as storageAppendSavedAnswers,
  getDocuments,
  saveDocument as storageSaveDocument,
  deleteDocument as storageDeleteDocument,
  setDefaultDocument as storageSetDefaultDocument,
  getPlaybooks,
  savePlaybook as storageSavePlaybook,
  deletePlaybook as storageDeletePlaybook,
  resetPlaybook as storageResetPlaybook,
  getSiteNotes,
  deleteSiteNote as storageDeleteSiteNote,
  getMacros,
  deleteMacro as storageDeleteMacro,
} from '../../js/storage.js';
import * as vault from '../../js/vault.js';
import { showToast } from '../components/Toast.jsx';

/** panel.js:52. Kept here rather than imported: panel.js does not export it. */
export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** panel.js:2140 / 2428 — both editors saved 400ms after the last keystroke. */
const SAVE_DEBOUNCE_MS = 400;

/** The five tab keys. Order is the tab bar's order. */
export const TABS = ['chat', 'profile', 'memory', 'vault', 'settings'];

const StoreContext = createContext(null);

export function StoreProvider({ children }) {
  // `ready` gates the views: App does not mount a screen until settings and profile are
  // real objects, so no view has to defend against a null profile on its first render.
  const [ready, setReady] = useState(false);

  const [settings, setSettingsState] = useState(null);
  const [profile, setProfileState] = useState(null);
  const [documents, setDocumentsState] = useState([]);
  const [playbooks, setPlaybooks] = useState([]);
  const [siteNotes, setSiteNotes] = useState([]);
  const [macros, setMacros] = useState([]);

  const [tab, setTab] = useState('chat');
  const [running, setRunningState] = useState(false);
  // panel.js:38 — 'ready' | 'working' | 'error' | 'unconfigured', plus the label that
  // goes with it. The initial value matches the markup panel.html shipped.
  const [pill, setPillObj] = useState({ state: 'unconfigured', label: 'Not configured' });

  // Refs shadow the state that stable callbacks need to read. Without them every
  // callback below would have to be re-created on each change, and a view that put one
  // in a useEffect dependency array would re-run its effect constantly.
  const settingsRef = useRef(null);
  const profileRef = useRef(null);
  const runningRef = useRef(false);
  const pillRef = useRef(pill);

  const applySettings = useCallback((next) => {
    settingsRef.current = next;
    setSettingsState(next);
  }, []);

  const applyProfile = useCallback((next) => {
    profileRef.current = next;
    setProfileState(next);
  }, []);

  /**
   * Bumped by every USER edit — updateSettings and updateProfile, nothing else.
   *
   * The four storage writers below hand storage.js an object snapshotted BEFORE their
   * `await`, and storage.js's single await is a real cross-process chrome.storage.local.set,
   * during which the renderer keeps dispatching input events. A keystroke that lands inside
   * that window is already in settingsRef/profileRef and already has its own save scheduled;
   * writing the pre-await snapshot back over it would silently revert that character and
   * then persist the reverted value on the next tick — with the <input> still showing the
   * character, because SettingsView keeps apiKey as a local draft. So each writer snapshots
   * this counter before its await and only writes storage's normalized result back into
   * state if the counter has not moved.
   *
   * applySettings/applyProfile deliberately do NOT bump it: the writers themselves call
   * those, and a writer must not invalidate its own guard. debounce().cancel() cannot cover
   * this — it clears a pending timer, it cannot un-start a body that is already awaiting.
   */
  const editGenRef = useRef(0);

  // ------------------------------------------------------------- status pill

  const isConfigured = useCallback(() => {
    const s = settingsRef.current;
    if (!s || !s.baseUrl || !s.model) return false;
    // Key-less local servers (Ollama, LM Studio) are valid on the OpenAI path.
    if (s.provider === 'anthropic' && !s.apiKey) return false;
    return true;
  }, []);

  const setPill = useCallback((state, label) => {
    pillRef.current = { state, label };
    setPillObj({ state, label });
  }, []);

  /**
   * Set the pill's state WITHOUT touching its label — the analogue of panel.js's bare
   * `pillState = 'ready'` assignments (panel.js:2018, 2562). Both of those are followed
   * by setRunning() or refreshPill() in the same handler, so React batches them and the
   * intermediate label is never painted.
   */
  const setPillState = useCallback((state) => {
    pillRef.current = { ...pillRef.current, state };
    setPillObj((p) => ({ ...p, state }));
  }, []);

  const refreshPill = useCallback(() => {
    if (runningRef.current) {
      setPill('working', 'Working…');
      return;
    }
    if (pillRef.current.state === 'error') return; // sticky until next action clears it
    if (isConfigured()) setPill('ready', 'Ready');
    else setPill('unconfigured', 'Not configured');
  }, [isConfigured, setPill]);

  /**
   * panel.js:1928. The DOM half of the original (hiding the composer, showing the run
   * strip) is ChatView's business now; what is shared is the flag itself, because the
   * header pill reads it. It flips twice per run, not per token, so it is cheap here.
   */
  const setRunning = useCallback(
    (on) => {
      runningRef.current = on;
      setRunningState(on);
      if (on) setPill('working', 'Working…');
      else refreshPill();
    },
    [refreshPill, setPill],
  );

  // ---------------------------------------------------------------- settings

  const persistSettings = useMemo(
    () =>
      debounce(async () => {
        try {
          const gen = editGenRef.current;
          const saved = await storageSaveSettings(settingsRef.current);
          // storage.js clamps and trims. Putting its return value back into state is what
          // keeps the form from lying about what is actually stored — but only while it is
          // still the newest thing the user asked for (see editGenRef).
          if (gen === editGenRef.current) applySettings(saved);
          try {
            // settingsRef.current, not `saved`: identical when the write-back applied, and
            // the fresher of the two when an edit landed mid-write.
            vault.setAutoLockMinutes(vaultAutoLockOf(settingsRef.current));
          } catch {
            /* vault module not ready */
          }
          refreshPill();
          showToast('Saved ✓', 'success');
        } catch (err) {
          showToast(`Could not save settings: ${err.message}`, 'error');
        }
      }, SAVE_DEBOUNCE_MS),
    [applySettings, refreshPill],
  );

  const updateSettings = useCallback(
    (patch) => {
      editGenRef.current += 1;
      applySettings({ ...settingsRef.current, ...patch });
      persistSettings();
    },
    [applySettings, persistSettings],
  );

  const saveSettingsNow = useCallback(
    async (patch) => {
      persistSettings.cancel();
      const merged = patch ? { ...settingsRef.current, ...patch } : settingsRef.current;
      // Land the patch in state BEFORE the await as well as after. A user edit arriving
      // mid-write drops the write-back below (see editGenRef) and merges onto whatever the
      // ref holds — which, without this line, would be a ref that never saw `patch`.
      if (merged !== settingsRef.current) applySettings(merged);
      const gen = editGenRef.current;
      const saved = await storageSaveSettings(merged);
      if (gen === editGenRef.current) applySettings(saved);
      try {
        vault.setAutoLockMinutes(vaultAutoLockOf(settingsRef.current));
      } catch {
        /* vault module not ready */
      }
      refreshPill();
      return saved;
    },
    [applySettings, persistSettings, refreshPill],
  );

  const reloadSettings = useCallback(async () => {
    applySettings(await getSettings());
  }, [applySettings]);

  // ----------------------------------------------------------------- profile

  const persistProfile = useMemo(
    () =>
      debounce(async () => {
        try {
          const gen = editGenRef.current;
          const saved = await storageSaveProfile(profileRef.current);
          // Dropped when a keystroke landed during the write: ProfileView's inputs are
          // controlled straight off `profile`, so a blind write-back makes the character
          // visibly disappear from the box and then persists it away.
          if (gen === editGenRef.current) applyProfile(saved);
          showToast('Saved ✓', 'success');
        } catch (err) {
          showToast(`Could not save profile: ${err.message}`, 'error');
        }
      }, SAVE_DEBOUNCE_MS),
    [applyProfile],
  );

  const updateProfile = useCallback(
    (patch) => {
      editGenRef.current += 1;
      applyProfile({ ...profileRef.current, ...patch });
      persistProfile();
    },
    [applyProfile, persistProfile],
  );

  const saveProfileNow = useCallback(
    async (patch) => {
      persistProfile.cancel();
      const merged = patch ? { ...profileRef.current, ...patch } : profileRef.current;
      // Same reason as saveSettingsNow: the agent calls this (ChatView's
      // saveAnswersToProfile) while the user may be typing on the still-mounted Profile tab.
      if (merged !== profileRef.current) applyProfile(merged);
      const gen = editGenRef.current;
      const saved = await storageSaveProfile(merged);
      if (gen === editGenRef.current) applyProfile(saved);
      return saved;
    },
    [applyProfile, persistProfile],
  );

  /**
   * Merge answered screening questions into the profile, for the agent rather than the user.
   *
   * NOT saveProfileNow. That one merges a patch onto the profile held in React state and
   * writes the whole object, which is last-write-wins — fine when one run answers questions,
   * silently lossy when several do, because each one's merge starts from a snapshot taken
   * before the others landed. storage.appendSavedAnswers re-reads inside the write lock, so
   * concurrent merges compose. The write-back is what stops the Profile editor's next
   * debounced save from putting the pre-merge copy back — cancel it first for the same
   * reason, and honour editGenRef so a keystroke mid-write is not clobbered.
   */
  const appendAnswersNow = useCallback(
    async (pairs) => {
      persistProfile.cancel();
      const gen = editGenRef.current;
      const result = await storageAppendSavedAnswers(pairs);
      if (gen === editGenRef.current) applyProfile(result.profile);
      return result;
    },
    [applyProfile, persistProfile],
  );

  const reloadProfile = useCallback(async () => {
    applyProfile(await getProfile());
  }, [applyProfile]);

  // --------------------------------------------------------------- documents

  const reloadDocuments = useCallback(async () => {
    // panel.js:2162 toasts and gives up rather than throwing — a document list that could
    // not be read is not a reason to take the Profile tab down.
    try {
      setDocumentsState(await getDocuments());
    } catch (err) {
      showToast(`Could not load documents: ${err.message}`, 'error');
    }
  }, []);

  const addDocument = useCallback(
    async (doc) => {
      const entry = await storageSaveDocument(doc);
      setDocumentsState(await getDocuments());
      return entry;
    },
    [],
  );

  const removeDocument = useCallback(async (id) => {
    setDocumentsState(await storageDeleteDocument(id));
  }, []);

  const makeDefaultDocument = useCallback(async (id) => {
    setDocumentsState(await storageSetDefaultDocument(id));
  }, []);

  // ------------------------------------------------------- memory bank (V3 §6)

  const reloadMemory = useCallback(async () => {
    // panel.js:1036 — one toast, then give up. Same policy.
    try {
      const [p, n, m] = await Promise.all([getPlaybooks(), getSiteNotes(), getMacros()]);
      setPlaybooks(p);
      setSiteNotes(n);
      setMacros(m);
    } catch (err) {
      showToast(`Could not load playbooks: ${err.message}`, 'error');
    }
  }, []);

  const savePlaybook = useCallback(
    async (input, by = 'user') => {
      const saved = await storageSavePlaybook(input, by);
      await reloadMemory();
      return saved;
    },
    [reloadMemory],
  );

  const deletePlaybook = useCallback(
    async (platform) => {
      await storageDeletePlaybook(platform);
      await reloadMemory();
    },
    [reloadMemory],
  );

  const resetPlaybook = useCallback(
    async (platform) => {
      const fresh = await storageResetPlaybook(platform);
      await reloadMemory();
      return fresh;
    },
    [reloadMemory],
  );

  const deleteSiteNote = useCallback(
    async (host) => {
      await storageDeleteSiteNote(host);
      await reloadMemory();
    },
    [reloadMemory],
  );

  const deleteMacro = useCallback(
    async (platform, name) => {
      await storageDeleteMacro(platform, name);
      await reloadMemory();
    },
    [reloadMemory],
  );

  // ------------------------------------------------------- the chat controller
  //
  // The Danger Zone lives in SettingsView but "Clear chat" and "Clear ALL data" have to
  // reach into ChatView — panel.js:2530 wired both to handleNewChat, and clearAllData
  // additionally cancelled the pending chat write (panel.js:2538) so a save scheduled
  // 300ms ago could not re-write the transcript seconds after it was wiped.
  //
  // The transcript itself stays out of this store (see the file header), so instead
  // ChatView registers a few imperative handles on mount and SettingsView calls them.
  // Nothing else about the chat is exposed.
  //
  // `resetStats` and `refreshPortalChip` are here for the same reason as the other three:
  // panel.js's clearAllData called stats.reset() + renderStats() (2557-2558) and
  // refreshPortalChip() (2555) directly, because in the vanilla panel every one of those
  // lived in the same module scope. Both now belong to ChatView — the SessionStats
  // instance and the header chip are chat-local by design (see the file header) — so the
  // wipe reaches them through the same registration channel rather than through five
  // local work-arounds. Without these two, a full wipe left the stats HUD showing the
  // pre-wipe session and the portal chip showing a detection from cleared storage until
  // the next 4s poll happened to correct it.

  /**
   * @type {{current: null | {
   *   newChat:Function, stop:Function, cancelChatSave:Function,
   *   resetStats:Function, refreshPortalChip:Function, reloadChat:Function,
   * }}}
   */
  const chatRef = useRef(null);

  /**
   * ChatView calls this in an effect and returns the result as the cleanup:
   *   useEffect(() => registerChat({
   *     newChat, stop, cancelChatSave, resetStats, refreshPortalChip, reloadChat,
   *   }), [...]);
   */
  const registerChat = useCallback((api) => {
    chatRef.current = api;
    return () => {
      if (chatRef.current === api) chatRef.current = null;
    };
  }, []);

  // Stable identity, so a view can put it in a dependency array. Every call is a no-op
  // until ChatView has registered — which is only ever true before the first paint.
  const chat = useMemo(
    () => ({
      newChat: async (opts) => (chatRef.current ? chatRef.current.newChat(opts) : undefined),
      stop: () => (chatRef.current ? chatRef.current.stop() : undefined),
      cancelChatSave: () => (chatRef.current ? chatRef.current.cancelChatSave() : undefined),
      resetStats: () => (chatRef.current ? chatRef.current.resetStats() : undefined),
      refreshPortalChip: async () => (
        chatRef.current ? chatRef.current.refreshPortalChip() : undefined
      ),
      // Restoring a backup replaces chatHistory under a mounted ChatView, so the transcript
      // it is showing — and the runner's copy of the conversation — have to be re-read.
      reloadChat: async () => (chatRef.current ? chatRef.current.reloadChat() : undefined),
    }),
    [],
  );

  // ------------------------------------------------- the memory UI channel
  //
  // Two pieces of MemoryView's LOCAL ui state have to be driveable from another screen,
  // and only these two. Both were trivial in panel.js because `openPlaybooks` was a
  // module-level Set every function could touch (panel.js:44); moving it into the view —
  // which is the point of this migration — is what created the need for a channel.
  //
  //   revealPlaybook   panel.js:1333, the chat header's portal chip: wireMemory did
  //                    `openPlaybooks.add(detection.platform)` and THEN switchTab('memory'),
  //                    so clicking the chip landed on the Memory tab with that portal's row
  //                    already expanded. ChatView announces the platform here; MemoryView
  //                    consumes it on activate. It is a one-shot request, not shared state,
  //                    so the consumer clears it — otherwise the row would re-expand every
  //                    time the user returned to the tab.
  //
  //   memoryEpoch      panel.js:2551, clearAllData did `openPlaybooks.clear()` so a wipe
  //                    did not leave rows expanded from before it. A counter rather than a
  //                    reset callback because MemoryView must not be forced to register a
  //                    handle just to be collapsible: it watches the number and collapses
  //                    when it changes.

  const [pendingPlaybook, setPendingPlaybook] = useState(null);
  const [memoryEpoch, setMemoryEpoch] = useState(0);

  const revealPlaybook = useCallback((platform) => {
    if (platform) setPendingPlaybook(platform);
  }, []);

  const consumePendingPlaybook = useCallback(() => setPendingPlaybook(null), []);

  const resetMemoryUi = useCallback(() => {
    setPendingPlaybook(null);
    setMemoryEpoch((n) => n + 1);
  }, []);

  // -------------------------------------------------------------------- load

  /** Everything init() (panel.js:2598) read before the panel was usable. */
  const reloadAll = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([getSettings(), getProfile()]);
      applySettings(s);
      applyProfile(p);
    } catch (err) {
      showToast(`Could not load stored data: ${err.message}`, 'error');
      // Retry once, and fall back to the DEFAULTS — not to `{}`.
      //
      // `ready` flips true either way, so whatever lands here is what every screen renders
      // against. An empty object has the wrong SHAPE: SettingsView seeds its drafts with
      // `useState(() => settings.baseUrl)`, so `{}` gives `<input value={undefined}>` —
      // an UNCONTROLLED input, which React warns about and which then stops tracking state
      // — and `String(settings.maxSteps)` puts the literal text "undefined" in a number
      // box. A storage read failing is not a reason to hand the UI a different type than
      // it gets on every other boot.
      applySettings(await getSettings().catch(() => ({ ...DEFAULT_SETTINGS })));
      applyProfile(await getProfile().catch(() => ({ ...DEFAULT_PROFILE, savedAnswers: [] })));
    }
    try {
      vault.setAutoLockMinutes(vaultAutoLockOf(settingsRef.current));
    } catch {
      /* vault module not ready */
    }
    await Promise.all([reloadDocuments(), reloadMemory()]);
    refreshPill();
  }, [applyProfile, applySettings, refreshPill, reloadDocuments, reloadMemory]);

  useEffect(() => {
    let cancelled = false;
    reloadAll().finally(() => {
      // StrictMode mounts effects twice in a development build. Both passes only READ,
      // and the second overwrites the first with the same bytes, so this is idempotent —
      // but the `cancelled` guard keeps the unmounted pass from flipping `ready`.
      if (!cancelled) setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadAll]);

  // Cancel in-flight debounced writes when the panel goes away, so a save scheduled
  // 399ms ago cannot fire against a torn-down document.
  useEffect(
    () => () => {
      persistSettings.cancel();
      persistProfile.cancel();
    },
    [persistProfile, persistSettings],
  );

  const value = useMemo(
    () => ({
      ready,
      settings,
      profile,
      documents,
      playbooks,
      siteNotes,
      macros,
      tab,
      setTab,
      pill,
      setPill,
      setPillState,
      refreshPill,
      running,
      setRunning,
      isConfigured,
      updateSettings,
      saveSettingsNow,
      cancelSettingsSave: persistSettings.cancel,
      reloadSettings,
      updateProfile,
      saveProfileNow,
      appendAnswersNow,
      cancelProfileSave: persistProfile.cancel,
      reloadProfile,
      reloadDocuments,
      addDocument,
      removeDocument,
      makeDefaultDocument,
      reloadMemory,
      savePlaybook,
      deletePlaybook,
      resetPlaybook,
      deleteSiteNote,
      deleteMacro,
      registerChat,
      chat,
      reloadAll,
      pendingPlaybook,
      revealPlaybook,
      consumePendingPlaybook,
      memoryEpoch,
      resetMemoryUi,
    }),
    [
      ready, settings, profile, documents, playbooks, siteNotes, macros,
      tab, pill, running,
      setPill, setPillState, refreshPill, setRunning, isConfigured,
      updateSettings, saveSettingsNow, persistSettings.cancel, reloadSettings,
      updateProfile, saveProfileNow, appendAnswersNow, persistProfile.cancel, reloadProfile,
      reloadDocuments, addDocument, removeDocument, makeDefaultDocument,
      reloadMemory, savePlaybook, deletePlaybook, resetPlaybook, deleteSiteNote,
      deleteMacro, registerChat, chat, reloadAll,
      pendingPlaybook, revealPlaybook, consumePendingPlaybook,
      memoryEpoch, resetMemoryUi,
    ],
  );

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

/** panel.js:2424 — a missing/garbage value means the 15-minute default, not 0. */
function vaultAutoLockOf(settings) {
  return settings && Number.isFinite(settings.vaultAutoLockMinutes) ? settings.vaultAutoLockMinutes : 15;
}

// ------------------------------------------------------------------- hooks
//
// One context, several narrow views onto it. They all read the same object, so a screen
// can use as many as it needs without extra cost.

export function useStore() {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error('[jobpilot] useStore() outside <StoreProvider> — App.jsx mounts it');
  return ctx;
}

/** Tabs, the header pill, the run flag, and whether an LLM is configured. */
export function useAppShell() {
  const s = useStore();
  return {
    ready: s.ready,
    tab: s.tab,
    setTab: s.setTab,
    pill: s.pill,
    setPill: s.setPill,
    setPillState: s.setPillState,
    refreshPill: s.refreshPill,
    running: s.running,
    setRunning: s.setRunning,
    isConfigured: s.isConfigured,
    registerChat: s.registerChat,
    chat: s.chat,
    reloadAll: s.reloadAll,
    // ChatView's portal chip announces a platform here on its way to the Memory tab;
    // SettingsView's wipe collapses every expanded row. Both are consumed by MemoryView.
    revealPlaybook: s.revealPlaybook,
    resetMemoryUi: s.resetMemoryUi,
  };
}

export function useSettings() {
  const s = useStore();
  return {
    settings: s.settings,
    updateSettings: s.updateSettings,
    saveSettingsNow: s.saveSettingsNow,
    cancelSettingsSave: s.cancelSettingsSave,
    reloadSettings: s.reloadSettings,
  };
}

export function useProfile() {
  const s = useStore();
  return {
    profile: s.profile,
    updateProfile: s.updateProfile,
    saveProfileNow: s.saveProfileNow,
    appendAnswersNow: s.appendAnswersNow,
    cancelProfileSave: s.cancelProfileSave,
    reloadProfile: s.reloadProfile,
  };
}

export function useDocuments() {
  const s = useStore();
  return {
    documents: s.documents,
    reloadDocuments: s.reloadDocuments,
    addDocument: s.addDocument,
    removeDocument: s.removeDocument,
    makeDefaultDocument: s.makeDefaultDocument,
  };
}

export function useMemoryBank() {
  const s = useStore();
  return {
    playbooks: s.playbooks,
    siteNotes: s.siteNotes,
    macros: s.macros,
    reloadMemory: s.reloadMemory,
    savePlaybook: s.savePlaybook,
    deletePlaybook: s.deletePlaybook,
    resetPlaybook: s.resetPlaybook,
    deleteSiteNote: s.deleteSiteNote,
    deleteMacro: s.deleteMacro,
    // The one-shot "expand this row on arrival" request from the chat header's portal
    // chip, and the counter a full wipe bumps to collapse every row. See the memory UI
    // channel comment in StoreProvider for why these exist at all.
    pendingPlaybook: s.pendingPlaybook,
    consumePendingPlaybook: s.consumePendingPlaybook,
    memoryEpoch: s.memoryEpoch,
  };
}
