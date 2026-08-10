// vault.js — encrypted credential vault (CONTRACT-V2 §3).
// Secrets live here and in the fill path only. The derived key and the decrypted
// entries exist in module scope while unlocked; both are nulled on lock().
//
// Crypto: PBKDF2-SHA256 @ 600,000 iterations → AES-GCM-256. Fresh 12-byte IV per
// write. A GCM auth-tag failure on decrypt is how a wrong passphrase is detected —
// unlock() returns false, it does not throw.

import { getVaultBlob, setVaultBlob, clearVaultBlob } from './storage.js';

/** @typedef {{id:string, host:string, label:string, username:string,
 *             password:string, notes:string, updatedAt:number}} Entry */

const ITERATIONS = 600000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

// Module-scope secret state. Never persisted, never logged.
let moduleKey = /** @type {CryptoKey|null} */ (null);
let moduleEntries = /** @type {Entry[]|null} */ (null);
let moduleKdf = /** @type {{salt:Uint8Array, iterations:number}|null} */ (null);

// Cached metadata, refreshed from storage before each state decision.
let initializedFlag = false;
let protectedFlag = false;

// Idle auto-lock.
let autoLockMs = 15 * 60 * 1000;
let idleTimer = /** @type {ReturnType<typeof setTimeout>|null} */ (null);

const lockListeners = new Set();

// ── base64 <-> Uint8Array (chunked; spreading a large array blows the stack) ──

function u8ToB64(u8) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function b64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

// ── crypto helpers ──

async function deriveKey(passphrase, salt, iterations) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptEntries(key, entries) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new TextEncoder().encode(JSON.stringify(entries));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
  return { iv: u8ToB64(iv), ct: u8ToB64(new Uint8Array(ct)) };
}

async function decryptEntries(key, ivB64, ctB64) {
  // Throws a DOMException named 'OperationError' when the auth tag fails.
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64ToU8(ivB64) }, key, b64ToU8(ctB64),
  );
}

// ── entry / host normalization ──

function normHost(h) {
  return String(h || '').trim().toLowerCase().replace(/^www\./, '');
}

function normEntry(e) {
  return {
    id: e && e.id ? String(e.id) : crypto.randomUUID(),
    host: normHost(e && e.host),
    label: String((e && e.label) || ''),
    username: String((e && e.username) || ''),
    password: String((e && e.password) || ''),
    notes: String((e && e.notes) || ''),
    updatedAt: Number((e && e.updatedAt) || Date.now()),
  };
}

// ── state ──

async function refreshMeta() {
  const blob = await getVaultBlob();
  initializedFlag = !!blob;
  protectedFlag = !!(blob && blob.protected);
  return blob;
}

function computeState() {
  if (!initializedFlag) return 'uninitialized';
  if (!protectedFlag) return 'unlocked';
  return (moduleKey && moduleEntries) ? 'unlocked' : 'locked';
}

function notify() {
  const state = computeState();
  for (const cb of lockListeners) {
    try { cb(state); } catch { /* a listener must not break the vault */ }
  }
}

/** Load the in-memory entries, deriving from storage for an unprotected vault.
 *  Throws a clear Error when the vault is locked or missing. */
async function ensureAccessible() {
  await refreshMeta();
  if (!initializedFlag) {
    throw new Error('Vault is not initialized. Call initialize() first.');
  }
  if (!protectedFlag) {
    if (!moduleEntries) {
      const blob = await getVaultBlob();
      moduleEntries = Array.isArray(blob && blob.entries)
        ? blob.entries.map(normEntry) : [];
    }
    return moduleEntries;
  }
  if (!moduleKey || !moduleEntries) {
    throw new Error('Vault is locked. Call unlock(passphrase) first.');
  }
  return moduleEntries;
}

async function persist() {
  if (protectedFlag) {
    const { iv, ct } = await encryptEntries(moduleKey, moduleEntries);
    await setVaultBlob({
      v: 1,
      protected: true,
      kdf: { salt: u8ToB64(moduleKdf.salt), iterations: moduleKdf.iterations, hash: 'SHA-256' },
      iv,
      ct,
    });
  } else {
    await setVaultBlob({ v: 1, protected: false, entries: moduleEntries });
  }
}

// ── idle timer ──

function clearTimer() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
}

function resetTimer() {
  clearTimer();
  if (autoLockMs > 0 && protectedFlag && moduleKey) {
    idleTimer = setTimeout(() => { lock(); }, autoLockMs);
  }
}

// ── public API ──

/** @returns {Promise<'uninitialized'|'locked'|'unlocked'>} */
export async function getState() {
  await refreshMeta();
  return computeState();
}

/** @returns {Promise<boolean>} true when a passphrase guards the vault. */
export async function isProtected() {
  await refreshMeta();
  return protectedFlag;
}

/** Create a new vault. `passphrase===null` makes it unprotected. */
export async function initialize(passphrase) {
  if (passphrase == null) {
    moduleKey = null;
    moduleKdf = null;
    moduleEntries = [];
    initializedFlag = true;
    protectedFlag = false;
    await setVaultBlob({ v: 1, protected: false, entries: [] });
    clearTimer();
    notify();
    return;
  }
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  moduleKey = await deriveKey(String(passphrase), salt, ITERATIONS);
  moduleKdf = { salt, iterations: ITERATIONS };
  moduleEntries = [];
  initializedFlag = true;
  protectedFlag = true;
  await persist();
  resetTimer();
  notify();
}

/** @returns {Promise<boolean>} true on success, false on a wrong passphrase. */
export async function unlock(passphrase) {
  const blob = await refreshMeta();
  if (!blob) throw new Error('Vault is not initialized. Call initialize() first.');
  if (!blob.protected) {
    // Nothing to unlock; just load the plaintext entries into memory.
    moduleEntries = Array.isArray(blob.entries) ? blob.entries.map(normEntry) : [];
    notify();
    return true;
  }
  const salt = b64ToU8(blob.kdf.salt);
  const iterations = blob.kdf.iterations;
  const key = await deriveKey(String(passphrase), salt, iterations);
  let plainBuf;
  try {
    plainBuf = await decryptEntries(key, blob.iv, blob.ct);
  } catch (e) {
    if (e && e.name === 'OperationError') return false; // wrong passphrase
    throw e; // corrupt blob or anything else is a genuine bug
  }
  // A parse failure here is a real bug (successful decrypt, bad payload) — let it throw.
  const parsed = JSON.parse(new TextDecoder().decode(plainBuf));
  moduleKey = key;
  moduleKdf = { salt, iterations };
  moduleEntries = Array.isArray(parsed) ? parsed.map(normEntry) : [];
  initializedFlag = true;
  protectedFlag = true;
  resetTimer();
  notify();
  return true;
}

/** Wipe the derived key and the decrypted entries from memory. */
export function lock() {
  if (moduleEntries) moduleEntries.length = 0; // overwrite, don't just drop the ref
  moduleEntries = null;
  moduleKey = null;
  moduleKdf = null;
  clearTimer();
  if (protectedFlag) notify();
}

/**
 * The stored blob was replaced underneath this module — importAllData() is the only caller.
 *
 * lock() is not enough on its own for two reasons. It leaves `initializedFlag` and
 * `protectedFlag` holding what they knew about the OLD blob, so computeState() answers
 * about a vault that no longer exists until something happens to call refreshMeta(); and it
 * only notifies when the old vault was protected, so restoring a protected vault over an
 * unprotected one (or over none at all) would leave VaultView painting the pre-import state
 * with no event to correct it.
 *
 * Drops the derived key and decrypted entries the same way lock() does — they belong to the
 * blob that was just overwritten, and the restored one has its own salt.
 */
export async function reloadFromStorage() {
  if (moduleEntries) moduleEntries.length = 0; // overwrite, don't just drop the ref
  moduleEntries = null;
  moduleKey = null;
  moduleKdf = null;
  clearTimer();
  await refreshMeta();
  notify(); // unconditional: protectedFlag may have flipped in either direction
}

export function isUnlocked() {
  return computeState() === 'unlocked';
}

/** @returns {Promise<Entry[]>} throws if locked. */
export async function listEntries() {
  const entries = await ensureAccessible();
  return entries.map((e) => ({ ...e }));
}

/** @returns {Promise<Entry|null>} best host-suffix match (longest wins). */
export async function findForHost(host) {
  const entries = await ensureAccessible();
  const target = normHost(host);
  if (!target) return null;
  let best = null;
  let bestLen = -1;
  for (const e of entries) {
    const eh = normHost(e.host);
    if (!eh) continue;
    if (target === eh || target.endsWith('.' + eh)) {
      if (eh.length > bestLen) { best = e; bestLen = eh.length; }
    }
  }
  return best ? { ...best } : null;
}

/** Insert or replace an entry (assigns an id when absent). @returns {Promise<Entry>} */
export async function upsertEntry(entry) {
  const entries = await ensureAccessible();
  const e = normEntry(entry);
  e.updatedAt = Date.now();
  const idx = entries.findIndex((x) => x.id === e.id);
  if (idx >= 0) entries[idx] = e; else entries.push(e);
  await persist();
  return { ...e };
}

/** @returns {Promise<boolean>} true when an entry was removed. */
export async function deleteEntry(id) {
  const entries = await ensureAccessible();
  const idx = entries.findIndex((x) => x.id === id);
  if (idx >= 0) entries.splice(idx, 1);
  await persist();
  return idx >= 0;
}

/** Re-key the vault. `next===null` removes protection; `current` is verified first. */
export async function changePassphrase(current, next) {
  const blob = await refreshMeta();
  if (!blob) throw new Error('Vault is not initialized. Call initialize() first.');

  let entries;
  if (blob.protected) {
    const salt = b64ToU8(blob.kdf.salt);
    const key = await deriveKey(String(current ?? ''), salt, blob.kdf.iterations);
    let plainBuf;
    try {
      plainBuf = await decryptEntries(key, blob.iv, blob.ct);
    } catch (e) {
      if (e && e.name === 'OperationError') throw new Error('Current passphrase is incorrect.');
      throw e;
    }
    const parsed = JSON.parse(new TextDecoder().decode(plainBuf));
    entries = Array.isArray(parsed) ? parsed.map(normEntry) : [];
  } else {
    entries = Array.isArray(blob.entries) ? blob.entries.map(normEntry) : [];
  }

  if (next == null) {
    moduleKey = null;
    moduleKdf = null;
    moduleEntries = entries;
    initializedFlag = true;
    protectedFlag = false;
    await setVaultBlob({ v: 1, protected: false, entries });
    clearTimer();
    notify();
    return;
  }

  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  moduleKey = await deriveKey(String(next), salt, ITERATIONS);
  moduleKdf = { salt, iterations: ITERATIONS };
  moduleEntries = entries;
  initializedFlag = true;
  protectedFlag = true;
  await persist();
  resetTimer();
  notify();
}

/** Destroy everything — storage and memory. The "forgot passphrase" path. */
export async function resetVault() {
  if (moduleEntries) moduleEntries.length = 0;
  moduleEntries = null;
  moduleKey = null;
  moduleKdf = null;
  clearTimer();
  await clearVaultBlob();
  initializedFlag = false;
  protectedFlag = false;
  notify();
  return 'uninitialized';
}

/** @param {number} n minutes; 0 = never auto-lock. */
export function setAutoLockMinutes(n) {
  const mins = Number(n);
  autoLockMs = (Number.isFinite(mins) && mins > 0) ? mins * 60 * 1000 : 0;
  resetTimer();
}

/** Reset the idle auto-lock timer. */
export function touch() {
  resetTimer();
}

/** Register a callback fired with the current state on every lock/unlock.
 *  @returns {() => void} unsubscribe */
export function onLockChange(cb) {
  if (typeof cb === 'function') lockListeners.add(cb);
  return () => lockListeners.delete(cb);
}
