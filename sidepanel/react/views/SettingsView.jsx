/**
 * SettingsView — LLM connection, behaviour toggles, stats/pricing overrides, danger zone.
 *
 * CONTRACT
 *   export default function SettingsView()  // NO PROPS. Everything comes from the store hooks.
 *
 * App.jsx already renders the wrapper:
 *     <section id="view-settings" class="view [active]"> <SettingsView/> </section>
 * so this component's ROOT element is <div className="scroll-area">.
 *
 * PORTED FROM  sidepanel/panel.html.orig lines 354-459 (markup) and sidepanel/js/panel.js:
 *   settingsFromForm (2379), maxStepsFromForm (2409), fieldOrBlank (2417),
 *   persistSettings (2428) -> useSettings().updateSettings,
 *   fillSettingsForm (2451), wireSettings (2469), wireDangerButton (2573).
 *
 * settingsFromForm() has no React counterpart and does not need one: updateSettings()
 * merges optimistically and SYNCHRONOUSLY, so the store's `settings` object always already
 * holds what the form shows. Wherever panel.js passed `settingsFromForm()` — listModels,
 * testConnection — this file passes `settings`.
 *
 * Two behaviours in here are load-bearing and easy to lose:
 *   - maxSteps 0 means UNLIMITED (CONTRACT-V4 §1). A blank box falls back to 48; a typed
 *     0 must survive. `|| 48` is the bug this comment exists to prevent.
 *   - contextWindow / priceIn / priceOut are '' when unset, NOT 0. '' means "use the
 *     built-in model table"; 0 would claim the model is free.
 *
 * "Clear ALL data" must cancel every pending debounced write first, or a save scheduled
 * 399ms ago re-writes the API key seconds after it was wiped. The store exposes
 * cancelSettingsSave() and cancelProfileSave() for exactly that; ChatView owns the
 * equivalent for the chat transcript and hands it over as chat.cancelChatSave().
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { listModels, testConnection } from '../../js/llm.js';
import { clearDetectionCache } from '../../js/platforms.js';
import {
  clearAllData, countChats, exportAllData, getSettings, importAllData, parseBackup,
} from '../../js/storage.js';
import * as vault from '../../js/vault.js';
import { openConfirm } from '../components/Modal.jsx';
import { showToast } from '../components/Toast.jsx';
import { useAppShell, useProfile, useSettings } from '../state/store.jsx';

/** CONTRACT-V4 §1 — 0 is a real value (unlimited); blank/garbage falls back to 48. */
function maxStepsFromDraft(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') return 48;
  const n = Number(text);
  return Number.isFinite(n) ? n : 48;
}

/** '' when the input is empty, so a blank price override stays "unset" not "free". */
function fieldOrBlank(raw) {
  const text = String(raw ?? '').trim();
  return text === '' ? '' : Number(text);
}

/** panel.js:2382 — a missing/garbage auto-lock means the 15-minute default, not 0. */
function autoLockFromDraft(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : (fallback ?? 15);
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What a backup file actually holds, in the user's words — "settings, profile (14 saved
 * answers), 2 documents, the vault".
 *
 * The confirm dialog is the last point at which a wrong file can be caught, and "Restore
 * this backup?" on its own gives the user nothing to catch it WITH. A file that turns out to
 * describe an empty install, or someone else's, reads very differently once it is spelled
 * out. Counts come from the raw bag, before normalization, because what matters here is
 * what the user is looking at rather than what will survive.
 */
function describeBackup(data) {
  const len = (v) => (Array.isArray(v) ? v.length : 0);
  const bits = [];
  if (data.settings) bits.push('settings');
  if (data.profile) {
    const answers = len(data.profile.savedAnswers);
    bits.push(answers ? `profile (${plural(answers, 'saved answer')})` : 'profile');
  }
  if (len(data.documents)) bits.push(plural(len(data.documents), 'document'));
  // Counted through storage.js because chatHistory is no longer a bare array — it holds one
  // transcript per run, and a backup may carry either shape.
  const chatCount = countChats(data.chatHistory);
  if (chatCount) bits.push(plural(chatCount, 'chat message'));
  if (len(data.playbooks)) bits.push(plural(len(data.playbooks), 'playbook'));
  if (len(data.siteNotes)) bits.push(plural(len(data.siteNotes), 'site note'));
  if (len(data.macros)) bits.push(plural(len(data.macros), 'macro'));
  if (data.vault) bits.push('the vault');
  return bits.length ? bits.join(', ') : 'no data at all';
}

export default function SettingsView() {
  const { settings, updateSettings, cancelSettingsSave } = useSettings();
  const { cancelProfileSave } = useProfile();
  const { chat, reloadAll, setPillState, refreshPill, resetMemoryUi } = useAppShell();

  // ------------------------------------------------------------------ drafts
  //
  // Every free-text and numeric box keeps a local draft string. This is the React half of
  // panel.js:2432-2442: storage.js clamps temperature/maxTokens/maxSteps/vaultAutoLock and
  // trims baseUrl/apiKey/model, and ~400ms after the last keystroke updateSettings()
  // replaces `settings` with that NORMALIZED object. Binding the inputs straight to
  // `settings` would therefore snap a half-typed "3" to the 64 minimum mid-keystroke.
  // The original solved it by writing the clamped value back into the DOM *unless the user
  // was focused in that box*; the store cannot see focus, so the guard lives here instead.
  //
  // Views only mount once `ready === true`, so `settings` is a real object on first render
  // and these lazy initialisers are the port of fillSettingsForm() (panel.js:2451).
  const [baseUrl, setBaseUrl] = useState(() => settings.baseUrl);
  const [apiKey, setApiKey] = useState(() => settings.apiKey);
  const [modelText, setModelText] = useState(() => settings.model);
  const [maxStepsDraft, setMaxStepsDraft] = useState(() => String(settings.maxSteps));
  const [temperatureDraft, setTemperatureDraft] = useState(() => String(settings.temperature));
  const [maxTokensDraft, setMaxTokensDraft] = useState(() => String(settings.maxTokens));
  const [autoLockDraft, setAutoLockDraft] = useState(() => String(settings.vaultAutoLockMinutes ?? 15));
  const [contextWindowDraft, setContextWindowDraft] = useState(() => String(settings.contextWindow ?? ''));
  const [priceInDraft, setPriceInDraft] = useState(() => String(settings.priceIn ?? ''));
  const [priceOutDraft, setPriceOutDraft] = useState(() => String(settings.priceOut ?? ''));

  // View-local UI, exactly as the shell contract files it: the key's masking, the fetched
  // model list, the dropdown's own selection, and the test-connection result. None of it
  // is persisted and nothing outside this screen reads it.
  const [keyVisible, setKeyVisible] = useState(false);
  const [models, setModels] = useState([]);
  const [modelSelect, setModelSelect] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState({ text: '', cls: '' });

  // '' | 'export' | 'import'. One flag rather than two booleans because the two buttons are
  // mutually exclusive: importing while an export is still serialising would race the write.
  const [backupBusy, setBackupBusy] = useState('');
  const backupInputRef = useRef(null);

  // The four boxes storage.js clamps are the only ones panel.js ever wrote back, so they
  // are the only ones that need a focus guard — hence refs to compare against
  // document.activeElement.
  const maxStepsRef = useRef(null);
  const temperatureRef = useRef(null);
  const maxTokensRef = useRef(null);
  const autoLockRef = useRef(null);

  /** fillSettingsForm (panel.js:2451) — push a whole stored settings object into the form. */
  const syncDrafts = useCallback((s) => {
    setBaseUrl(s.baseUrl);
    setApiKey(s.apiKey);
    setModelText(s.model);
    setMaxStepsDraft(String(s.maxSteps));
    setTemperatureDraft(String(s.temperature));
    setMaxTokensDraft(String(s.maxTokens));
    setAutoLockDraft(String(s.vaultAutoLockMinutes ?? 15));
    setContextWindowDraft(String(s.contextWindow ?? ''));
    setPriceInDraft(String(s.priceIn ?? ''));
    setPriceOutDraft(String(s.priceOut ?? ''));
  }, []);

  // panel.js:2434 — "reflect clamped/normalized values back into the form (skip a field the
  // user is still typing in) so the display never lies about what's stored."
  //
  // The dependency list is `[settings]` and ONLY `[settings]`, deliberately. Adding the
  // drafts would re-run this on every keystroke, and then a value typed into maxTokens and
  // blurred before its 400ms save landed would be overwritten by the still-old stored value
  // the moment the user touched any other box. It reads the drafts from the closure of the
  // render that carried the new settings, which is current by construction.
  useEffect(() => {
    const synced = [
      [maxStepsRef, maxStepsDraft, setMaxStepsDraft, settings.maxSteps],
      [temperatureRef, temperatureDraft, setTemperatureDraft, settings.temperature],
      [maxTokensRef, maxTokensDraft, setMaxTokensDraft, settings.maxTokens],
      [autoLockRef, autoLockDraft, setAutoLockDraft, settings.vaultAutoLockMinutes],
    ];
    for (const [ref, draft, setDraft, value] of synced) {
      if (document.activeElement === ref.current) continue;
      if (String(draft) !== String(value)) setDraft(String(value));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see the comment above
  }, [settings]);

  // ------------------------------------------------------------- field wiring
  //
  // panel.js listened for both 'input' and 'change' on every one of these and called the
  // same debounced save; React's onChange is that pair. Each handler applies the exact
  // coercion settingsFromForm() applied, at the moment the value changes rather than at
  // save time — same value, one less DOM read.

  const onModelTextChange = (v) => {
    setModelText(v);
    // settingsFromForm: `model: typed || selected` — the typed box wins, the dropdown is
    // the fallback for when it is empty.
    updateSettings({ model: v.trim() || modelSelect });
  };

  const onModelSelectChange = (v) => {
    setModelSelect(v);
    // panel.js:2482 — picking from the list writes the id into the text box, so the two
    // controls never disagree about which model is configured.
    if (v) setModelText(v);
    updateSettings({ model: v || modelText.trim() });
  };

  // ------------------------------------------------------------------ actions

  const onRefreshModels = async () => {
    setModelsLoading(true);
    try {
      const ids = await listModels(settings);
      setModels(ids);
      // The dropdown re-selects the configured model when the server actually offers it;
      // otherwise it falls back to the "— N models —" placeholder rather than silently
      // pointing at a model the user did not choose.
      const current = modelText.trim();
      setModelSelect(current && ids.includes(current) ? current : '');
      showToast(`Loaded ${ids.length} models`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setModelsLoading(false);
    }
  };

  const onTest = async () => {
    setTesting(true);
    setTestResult({ text: 'Testing…', cls: '' });
    // testConnection never throws — it returns {ok, message} for both outcomes.
    const outcome = await testConnection(settings);
    setTestResult({ text: outcome.message, cls: outcome.ok ? 'ok' : 'fail' });
    setTesting(false);
  };

  const onClearChat = async () => {
    await chat.newChat();
  };

  // ------------------------------------------------------------------- backup

  /**
   * Put everything JobPilot has stored into a file the user keeps.
   *
   * Deliberately does NOT cancel the pending debounced saves the way the import and the wipe
   * do. Those two are about to overwrite storage, so a save landing on top of them is a bug;
   * an export only reads, and a save scheduled 300ms ago carries an edit the user just made
   * — cancelling it would throw that edit away to make the backup very slightly more current.
   * The worst this costs is that the last few hundred milliseconds of typing miss the file.
   */
  const onExport = async () => {
    setBackupBusy('export');
    try {
      const bundle = await exportAllData();
      const json = JSON.stringify(bundle, null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      // Dated, because the first thing anyone with two backups needs to know is which is
      // which. toISOString is UTC and sorts lexicographically, which is what a filename wants.
      a.download = `jobpilot-backup-${new Date().toISOString().slice(0, 10)}.json`;
      // A detached anchor is enough for a download; it never enters the document, so there
      // is nothing to clean up but the object URL.
      a.click();
      // NOT revoked in this tick. Chrome starts the download during the click, but revoking
      // synchronously has raced it before; a minute is long past when it can matter and
      // still bounds how long a blob holding the API key stays reachable from this document.
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      showToast(`Backup saved — ${describeBackup(bundle.data)}`, 'success');
    } catch (err) {
      showToast(`Could not export: ${err.message}`, 'error');
    } finally {
      setBackupBusy('');
    }
  };

  const onImportPick = () => backupInputRef.current && backupInputRef.current.click();

  /**
   * Restore a backup file over the current data.
   *
   * The order here is the same one onClearAll established and for the same reason: every
   * pending debounced write is cancelled BEFORE storage is touched, or a settings save
   * scheduled 399ms ago lands on top of the restored settings a moment after they arrive.
   *
   * Afterwards the whole panel has to be told, because a restore changes every key at once
   * while five views are mounted and holding the old ones — the store's caches, the vault
   * module's derived key, the per-tab platform detection cache, the chat transcript and the
   * runner's copy of the conversation. Anything missed here shows up as a screen still
   * displaying pre-import data with no event coming to correct it.
   */
  const onImportFile = async (e) => {
    const file = (e.target.files || [])[0];
    // Reset the input NOW, while the File is already in hand: without this, picking the same
    // file again after a cancelled confirm fires no change event and the button looks dead.
    e.target.value = '';
    if (!file) return;

    setBackupBusy('import');
    try {
      const { data, meta } = parseBackup(await file.text());

      const when = meta.exportedAt ? `, saved ${new Date(meta.exportedAt).toLocaleString()}` : '';
      // A raw console dump is a legitimate input (see parseBackup) but it is also what a
      // wrong file looks like, so it is called out rather than accepted silently.
      const provenance = meta.bare ? ' It is a raw storage dump, not a JobPilot export file.' : '';
      const ok = await openConfirm({
        title: 'Restore this backup?',
        message: `${file.name} holds ${describeBackup(data)}${when}.${provenance} `
          + 'Restoring REPLACES everything JobPilot currently has — settings, profile, '
          + 'documents, chat, memory bank and vault. This cannot be undone, so export the '
          + 'current data first if you might want it back.',
        okLabel: 'Replace all data',
        danger: true,
      });
      if (!ok) return;

      cancelSettingsSave();
      cancelProfileSave();
      chat.cancelChatSave();

      const summary = await importAllData(data);

      // The vault's derived key and decrypted entries belong to the blob that was just
      // overwritten. reloadFromStorage drops them and re-reads what kind of vault now
      // exists, which is what makes VaultView repaint into "locked".
      await vault.reloadFromStorage();
      // reloadAll(): settings, profile, documents, the whole memory bank, then refreshPill.
      await reloadAll();
      // The drafts are seeded from `settings` once, at mount, so they do not follow a
      // wholesale replacement on their own. Re-read rather than trusting the closure —
      // reloadAll's state update has not been committed yet.
      syncDrafts(await getSettings());
      // Platform detection is cached per tab in platforms.js module memory and was decided
      // against the pre-import playbooks.
      clearDetectionCache();
      await chat.refreshPortalChip();
      // The session HUD counts THIS panel session, and the run it was counting belongs to
      // data that is gone.
      chat.resetStats();
      resetMemoryUi();
      // Last, because it is the one that repaints the screen the user is about to look at.
      await chat.reloadChat();
      // A sticky 'error' pill survives refreshPill by design; a restore is new activity and
      // whatever failed before it was about a configuration that no longer exists.
      setPillState('ready');
      refreshPill();

      const missed = summary.skipped.length
        ? ` (${summary.skipped.map((s) => `${s.key}: ${s.reason}`).join('; ')})`
        : '';
      showToast(`Restored ${describeBackup(data)}${missed}`, summary.skipped.length ? 'error' : 'success');
    } catch (err) {
      showToast(`Import failed: ${err.message}`, 'error');
    } finally {
      setBackupBusy('');
    }
  };

  const onClearAll = async () => {
    // A debounced save pending from a recent edit would silently re-write the just-cleared
    // data (API key included) — cancel them all first.
    cancelSettingsSave();
    cancelProfileSave();
    chat.cancelChatSave();
    // Wipe the vault (in-memory key + entries + stored blob) before the rest, so no
    // decrypted secret survives in module memory. resetVault() notifies its lock
    // subscribers, which is how VaultView repaints itself — panel.js called
    // refreshVaultView() by hand here.
    try {
      await vault.resetVault();
    } catch {
      /* nothing to reset */
    }
    await clearAllData();
    // reloadAll() is init()'s read half: settings, profile, documents and the whole memory
    // bank, then refreshPill(). The memory bank is user data too, and clearing it re-seeds
    // the shipped playbooks on the next read — the built-ins come back, everything learned
    // does not.
    await reloadAll();
    // fillSettingsForm(): the store now holds the defaults, so the form has to follow them
    // back. Re-read rather than trusting the closure — `settings` here is still the render's
    // stale object, reloadAll's state update has not been committed yet.
    syncDrafts(await getSettings());
    // Platform detection is cached per tab in platforms.js module memory; a wipe that left
    // it populated would keep answering with what it learned before the wipe. The chip in
    // the chat header is then re-detected from the now-empty bank (panel.js:2555) rather
    // than being left showing a playbook that no longer exists until the next 4s poll.
    clearDetectionCache();
    await chat.refreshPortalChip();
    // panel.js:2557-2558 — the session HUD is part of "all data". handleNewChat does not
    // touch it (a new chat deliberately keeps the running token/cost totals), so a wipe
    // that skipped this left the bar showing the pre-wipe session.
    chat.resetStats();
    // panel.js:2551's openPlaybooks.clear() — collapse every expanded playbook row, so the
    // re-seeded built-ins do not come back with pre-wipe rows still open.
    resetMemoryUi();
    // carryAnswers OFF: "Clear ALL data" means all of it. The transcript in memory still
    // holds this session's answers, and sweeping them into the profile here would put user
    // data back seconds after wiping it.
    await chat.newChat({ carryAnswers: false });
    // Bare `pillState = 'unconfigured'` + refreshPill() (panel.js:2562-2563). React batches
    // the pair, so the intermediate label is never painted.
    setPillState('unconfigured');
    refreshPill();
    showToast('All data cleared', 'success');
  };

  // --------------------------------------------------------------------- view

  return (
    <div className="scroll-area">

      <div className="section">
        <h3 className="section-title">LLM connection</h3>
        <label className="field field-wide"><span>Provider</span>
          <select
            id="st-provider"
            value={settings.provider}
            onChange={(e) => updateSettings({ provider: e.target.value })}
          >
            <option value="openai">OpenAI-compatible</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label className="field field-wide"><span>Base URL</span>
          <input
            type="url"
            id="st-baseUrl"
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
            spellCheck="false"
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); updateSettings({ baseUrl: e.target.value }); }}
          />
        </label>
        <p className="section-hint">Examples — OpenRouter: <code>https://openrouter.ai/api/v1</code> · Ollama: <code>http://localhost:11434/v1</code> · LM&nbsp;Studio: <code>http://localhost:1234/v1</code></p>
        <label className="field field-wide"><span>API key</span>
          <span className="input-with-btn">
            <input
              type={keyVisible ? 'text' : 'password'}
              id="st-apiKey"
              autoComplete="off"
              spellCheck="false"
              value={apiKey}
              onChange={(e) => { setApiKey(e.target.value); updateSettings({ apiKey: e.target.value }); }}
            />
            <button
              id="btn-toggle-key"
              className="btn-icon"
              title="Show / hide key"
              aria-label="Show or hide API key"
              onClick={() => setKeyVisible((v) => !v)}
            >
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" fill="none" stroke="currentColor" strokeWidth="1.4" /><circle cx="10" cy="10" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" /></svg>
            </button>
          </span>
        </label>
        <label className="field field-wide"><span>Model</span>
          <span className="input-with-btn">
            <select
              id="st-model-select"
              value={modelSelect}
              onChange={(e) => onModelSelectChange(e.target.value)}
            >
              <option value="">
                {models.length ? `— ${models.length} models —` : '— fetch models or type below —'}
              </option>
              {models.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
            <button
              id="btn-refresh-models"
              className="btn-icon"
              title="Fetch model list"
              aria-label="Refresh model list"
              disabled={modelsLoading}
              onClick={onRefreshModels}
            >
              <svg viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"><path d="M16.5 8A7 7 0 1 0 17 11" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /><path d="M17 4v4h-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </span>
        </label>
        <label className="field field-wide"><span>…or type a model id</span>
          <input
            type="text"
            id="st-model-text"
            placeholder="e.g. gpt-4o-mini, claude-sonnet-4-5"
            autoComplete="off"
            spellCheck="false"
            value={modelText}
            onChange={(e) => onModelTextChange(e.target.value)}
          />
        </label>
        <div className="test-row">
          <button id="btn-test" className="btn-primary btn-small" disabled={testing} onClick={onTest}>Test connection</button>
          <span id="test-result" className={testResult.cls ? `test-result ${testResult.cls}` : 'test-result'}>{testResult.text}</span>
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Behavior</h3>
        {/* CONTRACT-V11 §1. First in the section because it is the setting that decides
            how the whole application FEELS — whether you are asked fifteen times or once
            per page — and because the two below it are about the moment of submission,
            which comes after everything this one governs. */}
        <label className="field settings-plan-mode">
          <span>Review before filling</span>
          <select
            id="st-planMode"
            value={settings.planMode || 'ask'}
            onChange={(e) => updateSettings({ planMode: e.target.value })}
          >
            <option value="ask">Show me each page before it is filled</option>
            <option value="auto">Only when there is something to decide</option>
            <option value="off">Off — fill as it goes, ask when stuck</option>
          </select>
          <span className="field-hint">
            {settings.planMode === 'off'
              ? 'The agent fills fields as it works them out and interrupts you whenever it hits something it cannot answer — several times per page on a long form.'
              : settings.planMode === 'auto'
                ? 'One card per page, but only when there is a question to answer or a value the agent worked out rather than took from your profile. Pages it can answer entirely from your profile are filled without stopping you.'
                : 'The agent reads a whole page, then shows you every value it will enter and every question it cannot answer — in one card. You correct, untick, answer, approve, and the page is filled in one go.'}
          </span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            id="st-autoSubmit"
            checked={settings.autoSubmit}
            onChange={(e) => updateSettings({ autoSubmit: e.target.checked })}
          />
          <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb"></span></span>
          <span className="toggle-label">
            Auto-submit applications (skip confirmation)
            <span className="toggle-warn">⚠ The agent will click Submit without asking you first.</span>
          </span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            id="st-saveAnswers"
            checked={settings.saveAnswers}
            onChange={(e) => updateSettings({ saveAnswers: e.target.checked })}
          />
          <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb"></span></span>
          <span className="toggle-label">Offer to save my answers to the profile</span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            id="st-alwaysConfirmCreds"
            checked={settings.alwaysConfirmCredentials ?? true}
            onChange={(e) => updateSettings({ alwaysConfirmCredentials: e.target.checked })}
          />
          <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb"></span></span>
          <span className="toggle-label">
            Always confirm before filling a credential
            <span className="toggle-sub">Show the vault prompt every time, even when a saved value exists. Nothing is typed without your click.</span>
          </span>
        </label>
        <label className="toggle-row">
          <input
            type="checkbox"
            id="st-soundOnPrompt"
            checked={settings.soundOnPrompt ?? true}
            onChange={(e) => updateSettings({ soundOnPrompt: e.target.checked })}
          />
          <span className="toggle-track" aria-hidden="true"><span className="toggle-thumb"></span></span>
          <span className="toggle-label">
            Play a sound when JobPilot needs you
            <span className="toggle-sub">A short chime when it asks a question, needs a credential, wants you to show it something, or finishes while you are on another screen.</span>
          </span>
        </label>
        <div className="field-grid">
          <label className="field"><span>Max steps per run (0&nbsp;=&nbsp;unlimited)</span>
            <input
              type="number" id="st-maxSteps" min="0" max="10000" step="1"
              ref={maxStepsRef}
              value={maxStepsDraft}
              // CONTRACT-V4 §1: an explicit 0 means UNLIMITED and must survive — `|| 48`
              // would coerce it back to 48. Only a blank/invalid field falls back.
              onChange={(e) => { setMaxStepsDraft(e.target.value); updateSettings({ maxSteps: maxStepsFromDraft(e.target.value) }); }}
            />
          </label>
          <label className="field"><span>Applications at once</span>
            <input
              type="number" id="st-maxConcurrentRuns" min="1" max="8" step="1"
              value={settings.maxConcurrentRuns}
              // Each concurrent application is a live LLM stream you pay for and a tab
              // being driven, so this is a cost and rate-limit guard. storage.js clamps it
              // to 1–8; past a handful, provider rate limits and the fact that background
              // tabs do not render make more runs slower rather than faster.
              onChange={(e) => updateSettings({ maxConcurrentRuns: Number(e.target.value) || 1 })}
            />
          </label>
          <label className="field"><span>Temperature</span>
            <input
              type="number" id="st-temperature" min="0" max="2" step="0.1"
              ref={temperatureRef}
              value={temperatureDraft}
              onChange={(e) => { setTemperatureDraft(e.target.value); updateSettings({ temperature: Number(e.target.value) }); }}
            />
          </label>
          <label className="field"><span>Max output tokens</span>
            <input
              type="number" id="st-maxTokens" min="64" max="200000" step="64"
              ref={maxTokensRef}
              value={maxTokensDraft}
              onChange={(e) => { setMaxTokensDraft(e.target.value); updateSettings({ maxTokens: Number(e.target.value) || 2048 }); }}
            />
          </label>
          <label className="field"><span>Auto-lock vault (min)</span>
            <input
              type="number" id="st-vaultAutoLock" min="0" max="480" step="1"
              ref={autoLockRef}
              value={autoLockDraft}
              // A blank box is Number('') === 0, which is finite and means "never auto-lock".
              // Only genuinely unreadable input falls back to the stored 15.
              onChange={(e) => { setAutoLockDraft(e.target.value); updateSettings({ vaultAutoLockMinutes: autoLockFromDraft(e.target.value, settings.vaultAutoLockMinutes) }); }}
            />
          </label>
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Stats &amp; pricing</h3>
        <p className="section-hint">
          JobPilot knows the context window and price of most common models. Set these only if
          your model or proxy is not recognised, or its pricing differs — leave them blank to use
          the built-in table. Prices are USD per 1M tokens.
        </p>
        {/* Blank means "use the built-in table" — '' must survive, so these are NOT coerced to 0. */}
        <div className="field-grid">
          <label className="field"><span>Context window</span>
            <input
              type="number" id="st-contextWindow" min="0" step="1024" placeholder="auto"
              value={contextWindowDraft}
              onChange={(e) => { setContextWindowDraft(e.target.value); updateSettings({ contextWindow: fieldOrBlank(e.target.value) }); }}
            />
          </label>
          <label className="field"><span>Input $/1M</span>
            <input
              type="number" id="st-priceIn" min="0" step="0.01" placeholder="auto"
              value={priceInDraft}
              onChange={(e) => { setPriceInDraft(e.target.value); updateSettings({ priceIn: fieldOrBlank(e.target.value) }); }}
            />
          </label>
          <label className="field"><span>Output $/1M</span>
            <input
              type="number" id="st-priceOut" min="0" step="0.01" placeholder="auto"
              value={priceOutDraft}
              onChange={(e) => { setPriceOutDraft(e.target.value); updateSettings({ priceOut: fieldOrBlank(e.target.value) }); }}
            />
          </label>
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Backup</h3>
        <p className="section-hint">
          Everything JobPilot knows lives in this browser profile, under the folder Chrome
          loaded the extension from. Move the extension — to a new folder, a rebuilt
          <code> dist/</code>, or another machine — and Chrome treats it as a new install with
          empty storage. Export first, load the extension from its new home, then import.
        </p>
        <div className="button-row">
          <button
            id="btn-export-data"
            className="btn-primary btn-small"
            disabled={Boolean(backupBusy)}
            onClick={onExport}
          >
            {backupBusy === 'export' ? 'Exporting…' : 'Export backup'}
          </button>
          <button
            id="btn-import-data"
            className="btn-ghost btn-small"
            disabled={Boolean(backupBusy)}
            onClick={onImportPick}
          >
            {backupBusy === 'import' ? 'Importing…' : 'Import backup'}
          </button>
        </div>
        <input
          type="file"
          id="backup-file-input"
          ref={backupInputRef}
          accept="application/json,.json"
          hidden
          onChange={onImportFile}
        />
        <p className="section-hint">
          The file holds your profile, documents, chat, memory bank and the encrypted vault —
          and your <strong>API key in plain text</strong>. Keep it somewhere private. The
          vault stays encrypted and still needs its passphrase after a restore. Importing
          replaces everything currently stored.
        </p>
      </div>

      <div className="section section-danger">
        <h3 className="section-title">Danger zone</h3>
        <div className="danger-row">
          <DangerButton id="btn-clear-chat" label="Clear chat" onConfirm={onClearChat} />
          <DangerButton id="btn-clear-all" label="Clear ALL data" onConfirm={onClearAll} />
        </div>
        <p className="section-hint">Click a button twice to confirm. “Clear ALL data” removes settings, profile, documents and chat.</p>
      </div>

    </div>
  );
}

/**
 * Double-click confirm (§10) — panel.js:2573's wireDangerButton, no window.confirm.
 *
 * First click arms the button and relabels it; a second click within 3s runs the action;
 * otherwise it disarms itself and the original label comes back. panel.css styles the armed
 * look off `.btn-danger[data-armed="true"]`, so the attribute is part of the contract, not
 * decoration. `armed` is view-local state — the closure variable and the data- attribute the
 * original hand-maintained are the same one fact.
 */
function DangerButton({ id, label, onConfirm }) {
  const [armed, setArmed] = useState(false);
  const timer = useRef(null);

  // A pending disarm timer must not outlive the button. These views never unmount in this
  // app, but StrictMode's double-mount is exactly what exists to catch a missing cleanup.
  useEffect(() => () => clearTimeout(timer.current), []);

  const onClick = async () => {
    if (!armed) {
      setArmed(true);
      timer.current = setTimeout(() => setArmed(false), 3000);
      return;
    }
    clearTimeout(timer.current);
    setArmed(false);
    try {
      await onConfirm();
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    }
  };

  return (
    <button
      id={id}
      className="btn-danger btn-small"
      data-armed={armed ? 'true' : 'false'}
      onClick={onClick}
    >
      {armed ? 'Click again to confirm' : label}
    </button>
  );
}
