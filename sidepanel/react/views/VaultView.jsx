/**
 * VaultView — the encrypted credential vault (CONTRACT-V2 §3, CONTRACT-V3 §6.2).
 *
 * Ported from sidepanel/panel.html.orig lines 288-351 (markup) and sidepanel/js/panel.js:
 *   refreshVaultView (1585), renderVaultList (1607), renderVaultRow (1618),
 *   vaultEntryFields (1683), addVaultEntry (1693), editVaultEntry (1703),
 *   upsertFromForm (1726), setVaultError (1753), handleVaultSetup (1759),
 *   handleVaultUnlock (1782), handleVaultForgot (1796), handleChangePassphrase (1812),
 *   wireVault (1839), wireVaultTouch (1857).
 *
 * The vault module IS the store for this screen: sidepanel/js/vault.js holds the derived
 * key and the decrypted entries in module memory and nulls both on lock(). Nothing here
 * copies a secret into state/store.jsx, into chrome.storage, or into the transcript.
 * vault.onLockChange(cb) is how this view learns the idle timer fired — subscribed in an
 * effect, unsubscribed in its cleanup.
 *
 * vaultUnlocked (panel.js:1553), normalizeHost (1557) and maybeUnlockVault (1567) are NOT
 * here — they are shared with ChatView's onRequestSecret and live in ../vault-ui.js so
 * there is one definition rather than two that can drift apart.
 *
 * The three states of panel.html.orig (#vault-setup / #vault-locked / #vault-unlocked,
 * toggled with `hidden`) are conditional rendering here. That is not just tidier: the
 * passphrase boxes live in the child that owns them, so the draft passphrase dies with
 * the form instead of outliving it in a parent that never unmounts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import * as vault from '../../js/vault.js';
import { useAppShell, useSettings } from '../state/store.jsx';
import { showToast } from '../components/Toast.jsx';
import { openAsk, openConfirm } from '../components/Modal.jsx';
import { normalizeHost } from '../vault-ui.js';

function vaultEntryFields(entry) {
  return [
    { name: 'host', label: 'Site (host)', type: 'text', placeholder: 'cisco.com', value: entry ? entry.host : undefined, required: true },
    { name: 'label', label: 'Label', type: 'text', value: entry ? (entry.label || '') : undefined },
    { name: 'username', label: 'Username', type: 'text', value: entry ? (entry.username || '') : undefined },
    { name: 'password', label: 'Password', type: 'password', secret: true, value: entry ? (entry.password || '') : undefined },
    { name: 'notes', label: 'Notes', type: 'textarea', value: entry ? (entry.notes || '') : undefined },
  ];
}

// The setup and locked screens share this hero. Copied verbatim from panel.html.orig
// (kebab attrs → camelCase); it is a one-off, so it does not belong in Icon.jsx.
function VaultHeroIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" className="vault-hero-icon">
      <rect x="4" y="10.5" width="16" height="10" rx="2.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M7.5 10.5V7.5a4.5 4.5 0 0 1 9 0v3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <circle cx="12" cy="15" r="1.4" fill="currentColor" />
    </svg>
  );
}

/**
 * Show or clear a vault error.
 *
 * The two <p class="vault-error"> elements shipped with the `hidden` attribute and nothing
 * ever removed it, so every setup and unlock failure — wrong passphrase, mismatched
 * confirmation, a crypto error — was written into an element the user could not see. The
 * form simply appeared to do nothing. Rendering the paragraph only when there is a message
 * is the React shape of setVaultError (panel.js:1753); the bug cannot come back.
 */
function VaultError({ message }) {
  if (!message) return null;
  return <p className="vault-error">{message}</p>;
}

// ------------------------------------------------------------------ setup

function VaultSetup({ autoLockMinutes, onRefresh }) {
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [error, setError] = useState('');

  async function handleVaultSetup(protect) {
    setError('');
    let passphrase = null;
    if (protect) {
      if (!pass) { setError('Enter a passphrase, or choose “Skip”.'); return; }
      if (pass !== pass2) { setError('The passphrases do not match.'); return; }
      passphrase = pass;
    }
    try {
      await vault.initialize(passphrase);
      // Drop the drafts the moment the key exists; this component is about to unmount
      // anyway, but do not leave a passphrase sitting in state waiting for that.
      setPass('');
      setPass2('');
      try { vault.setAutoLockMinutes(autoLockMinutes); } catch { /* not ready */ }
      await onRefresh();
      showToast(protect ? 'Vault created' : 'Vault created (no passphrase)', 'success');
    } catch (e) {
      setError(`Could not create the vault: ${e.message}`);
    }
  }

  return (
    <div className="section vault-state">
      <div className="vault-hero">
        <VaultHeroIcon />
        <h3 className="section-title">Set up your credential vault</h3>
        <p className="section-hint">
          Store logins so the agent can fill password and OTP fields for you. A passphrase
          encrypts everything on this device. Nothing is ever sent to the AI.
        </p>
      </div>
      <label className="field field-wide"><span>Passphrase</span>
        <input
          type="password"
          id="vlt-setup-pass"
          autoComplete="new-password"
          spellCheck="false"
          placeholder="Choose a strong passphrase"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
        />
      </label>
      <label className="field field-wide"><span>Confirm passphrase</span>
        <input
          type="password"
          id="vlt-setup-pass2"
          autoComplete="new-password"
          spellCheck="false"
          placeholder="Repeat it"
          value={pass2}
          onChange={(e) => setPass2(e.target.value)}
        />
      </label>
      <VaultError message={error} />
      <div className="vault-setup-actions">
        <button id="vlt-setup-save" className="btn-primary btn-small" onClick={() => handleVaultSetup(true)}>Create vault</button>
        <button id="vlt-setup-skip" className="btn-ghost btn-small" onClick={() => handleVaultSetup(false)}>Skip — no passphrase</button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------- locked

function VaultLocked({ onRefresh }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');

  async function handleVaultUnlock() {
    setError('');
    try {
      const ok = await vault.unlock(pass);
      if (!ok) { setError('Wrong passphrase. Try again.'); return; }
      setPass('');
      await onRefresh();
    } catch (e) {
      setError(`Could not unlock: ${e.message}`);
    }
  }

  // The one path that destroys data. It is deliberately a danger confirm with an explicit
  // "cannot be undone" — a forgotten passphrase is unrecoverable by design, so the only
  // way forward is to throw the ciphertext away.
  async function handleVaultForgot() {
    const ok = await openConfirm({
      title: 'Reset the vault?',
      message: 'This permanently deletes every saved credential and cannot be undone.',
      okLabel: 'Delete everything',
      danger: true,
    });
    if (!ok) return;
    try {
      await vault.resetVault();
      await onRefresh();
      showToast('Vault reset', 'success');
    } catch (e) {
      showToast(`Could not reset vault: ${e.message}`, 'error');
    }
  }

  return (
    <div className="section vault-state">
      <div className="vault-hero">
        <VaultHeroIcon />
        <h3 className="section-title">Vault locked</h3>
        <p className="section-hint">Enter your passphrase to unlock saved credentials.</p>
      </div>
      <label className="field field-wide"><span>Passphrase</span>
        <input
          type="password"
          id="vlt-unlock-pass"
          autoComplete="off"
          spellCheck="false"
          placeholder="Your passphrase"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          onKeyDown={(e) => {
            // An IME candidate window swallows Enter; committing a composition must not
            // submit the form (panel.js:1845).
            if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            handleVaultUnlock();
          }}
        />
      </label>
      <VaultError message={error} />
      <div className="vault-setup-actions">
        <button id="vlt-unlock-btn" className="btn-primary btn-small" onClick={handleVaultUnlock}>Unlock</button>
        <button id="vlt-forgot" className="btn-link" onClick={handleVaultForgot}>Forgot passphrase?</button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------- unlocked

function VaultRow({ entry, onEdit }) {
  const [shown, setShown] = useState(false);

  // Reveal auto-re-hides after 15 s (§6.2). The plaintext exists only in this component's
  // render output for those 15 seconds — it never reaches uiMessages / persistChats.
  useEffect(() => {
    if (!shown) return undefined;
    const timer = setTimeout(() => setShown(false), 15000);
    return () => clearTimeout(timer);
  }, [shown]);

  return (
    <div className="vault-row">
      <div className="vault-meta">
        <div className="vault-host">{entry.label || entry.host}</div>
        <div className="vault-sub">
          {entry.username ? `${entry.host} · ${entry.username}` : entry.host}
        </div>
      </div>
      <span className={shown ? 'vault-dots shown' : 'vault-dots'}>
        {shown ? (entry.password || '') : '••••••••'}
      </span>
      <button className="vault-reveal" onClick={() => setShown((on) => !on)}>
        {shown ? 'Hide' : 'Reveal'}
      </button>
      <button
        className="vault-copy"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(entry.password || '');
            showToast('Password copied', 'success');
          } catch {
            showToast('Could not copy — clipboard is blocked', 'error');
          }
        }}
      >
        Copy
      </button>
      <button className="vault-edit" onClick={() => onEdit(entry)}>Edit</button>
    </div>
  );
}

function VaultUnlockedPanel({ entries, onRenderList, onRefresh }) {
  async function upsertFromForm(values, entry) {
    const host = normalizeHost(values.host);
    if (!host) { showToast('Enter a site host, e.g. cisco.com', 'error'); return; }
    try {
      await vault.upsertEntry({
        ...(entry ? { id: entry.id } : {}),
        host,
        label: values.label || host,
        username: values.username || '',
        password: values.password || '',
        notes: values.notes || '',
      });
      showToast('Credential saved', 'success');
    } catch (err) {
      showToast(`Could not save: ${err.message}`, 'error');
    }
    await onRenderList();
  }

  async function addVaultEntry() {
    const res = await openAsk({
      title: 'Add credential',
      fields: vaultEntryFields(null),
      submitLabel: 'Save',
    });
    if (!res) return;
    await upsertFromForm(res.values, null);
  }

  async function editVaultEntry(entry) {
    const res = await openAsk({
      title: 'Edit credential',
      fields: vaultEntryFields(entry),
      extraButtons: [{ id: 'delete', label: 'Delete', danger: true }],
      submitLabel: 'Save',
    });
    if (!res) return;
    if (res.action === 'delete') {
      const ok = await openConfirm({
        title: 'Delete credential',
        message: `Delete the saved credential for ${entry.host}?`,
        okLabel: 'Delete',
        danger: true,
      });
      if (!ok) return;
      try { await vault.deleteEntry(entry.id); showToast('Credential deleted', 'success'); }
      catch (err) { showToast(`Could not delete: ${err.message}`, 'error'); }
      await onRenderList();
      return;
    }
    await upsertFromForm(res.values, entry);
  }

  async function handleChangePassphrase() {
    let protectedNow = false;
    try { protectedNow = await vault.isProtected(); } catch { protectedNow = false; }
    const fields = [];
    if (protectedNow) {
      fields.push({ name: 'current', label: 'Current passphrase', type: 'password', secret: true, required: true });
    }
    fields.push({ name: 'next', label: 'New passphrase (leave blank for none)', type: 'password', secret: true });
    fields.push({ name: 'next2', label: 'Confirm new passphrase', type: 'password', secret: true });
    const res = await openAsk({ title: 'Change passphrase', fields, submitLabel: 'Change' });
    if (!res) return;
    if ((res.values.next || '') !== (res.values.next2 || '')) {
      showToast('The new passphrases do not match', 'error');
      return;
    }
    try {
      await vault.changePassphrase(
        protectedNow ? res.values.current : null,
        res.values.next ? res.values.next : null,
      );
      showToast('Passphrase changed', 'success');
      await onRefresh();
    } catch (e) {
      showToast(`Could not change passphrase: ${e.message}`, 'error');
    }
  }

  return (
    <div className="section vault-state">
      <div className="vault-head">
        <h3 className="section-title">Saved credentials</h3>
        <div className="vault-head-actions">
          <button id="vlt-add" className="btn-ghost btn-small" title="Add a credential" onClick={addVaultEntry}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            Add
          </button>
          <button
            id="vlt-lock"
            className="btn-ghost btn-small"
            title="Lock the vault now"
            onClick={async () => {
              try { vault.lock(); } catch { /* nothing to lock */ }
              await onRefresh();
            }}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <rect x="3" y="7" width="10" height="7" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <path d="M5.2 7V5.4a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
            </svg>
            Lock
          </button>
        </div>
      </div>
      <div id="vlt-list" className="vault-list">
        {entries.map((entry) => (
          <VaultRow key={entry.id} entry={entry} onEdit={editVaultEntry} />
        ))}
      </div>
      {entries.length === 0 && (
        <p id="vlt-empty" className="vault-empty">
          No credentials saved yet. Add one, or the agent will offer to save a login the
          next time it hits a wall.
        </p>
      )}
      <div className="vault-foot">
        <button id="vlt-change-pass" className="btn-link" onClick={handleChangePassphrase}>Change passphrase</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ view

export default function VaultView() {
  const { tab } = useAppShell();
  const { settings } = useSettings();
  const [state, setState] = useState('uninitialized');
  const [entries, setEntries] = useState([]);

  // Every read of the vault bumps this token. A read that started before a lock landed
  // must not write its plaintext into state afterwards — panel.js got the same protection
  // for free because it rebuilt the DOM synchronously inside one turn; here the await
  // between getState() and listEntries() is a real window.
  const readToken = useRef(0);

  const renderVaultList = useCallback(async () => {
    const token = ++readToken.current;
    let list = [];
    try { list = await vault.listEntries(); } catch { list = []; }
    if (token !== readToken.current) return;
    setEntries(list);
  }, []);

  const refreshVaultView = useCallback(async () => {
    const token = ++readToken.current;
    let next = 'uninitialized';
    try { next = await vault.getState(); } catch { next = 'uninitialized'; }
    if (token !== readToken.current) return;
    setState(next);
    if (next === 'unlocked') {
      let list = [];
      try { list = await vault.listEntries(); } catch { list = []; }
      if (token !== readToken.current) return;
      setEntries(list);
      return;
    }
    // Locking has to EMPTY the list, not just stop rendering it. Keeping the decrypted
    // entries in state would leave every plaintext password alive in the component tree
    // and in the handler closures bound to those rows, so "locked" would mean locked to
    // the eye while the plaintext sat one devtools inspection away — the opposite of what
    // vault.lock() spends effort on when it drops the key.
    setEntries([]);
  }, []);

  // wireVault's subscription (panel.js:1852) plus init's first read (panel.js:2628).
  // onLockChange fires for the idle auto-lock too, which can land while the user is
  // reading another tab — the screen must already be correct when they come back.
  useEffect(() => {
    let unsubscribe = () => {};
    try { unsubscribe = vault.onLockChange(() => { refreshVaultView(); }); }
    catch { /* module not ready */ }
    refreshVaultView();
    return () => { try { unsubscribe(); } catch { /* already gone */ } };
  }, [refreshVaultView]);

  // switchTab (panel.js:249) refreshed this screen on activation. setTab is pure state
  // now, so the on-activate read is ours. Note this view never unmounts, so a vault that
  // auto-locked while the user was in Settings is re-read on the way back in.
  useEffect(() => {
    if (tab === 'vault') refreshVaultView();
  }, [tab, refreshVaultView]);

  // Defer auto-lock on real interaction. One delegated listener per event, throttled
  // to ≤1 call/sec so we never spam vault.touch() (§6.2). This is document-wide on
  // purpose — activity anywhere in the panel counts — and it can live here because
  // App.jsx mounts every view once and never unmounts it.
  useEffect(() => {
    let last = 0;
    const touch = () => {
      const now = Date.now();
      if (now - last < 1000) return;
      last = now;
      try { vault.touch(); } catch { /* vault not ready */ }
    };
    document.addEventListener('click', touch, true);
    document.addEventListener('keydown', touch, true);
    return () => {
      document.removeEventListener('click', touch, true);
      document.removeEventListener('keydown', touch, true);
    };
  }, []);

  // handleVaultSetup re-asserts the auto-lock interval after initialize(), because a vault
  // created mid-session has never been handed the user's setting (panel.js:1774).
  const autoLockMinutes = settings && Number.isFinite(settings.vaultAutoLockMinutes)
    ? settings.vaultAutoLockMinutes
    : 15;

  return (
    <div className="scroll-area">
      {state === 'uninitialized' && (
        <VaultSetup autoLockMinutes={autoLockMinutes} onRefresh={refreshVaultView} />
      )}
      {state === 'locked' && <VaultLocked onRefresh={refreshVaultView} />}
      {state === 'unlocked' && (
        <VaultUnlockedPanel
          entries={entries}
          onRenderList={renderVaultList}
          onRefresh={refreshVaultView}
        />
      )}
    </div>
  );
}
