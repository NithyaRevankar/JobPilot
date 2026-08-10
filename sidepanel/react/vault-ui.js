/**
 * vault-ui.js — vault POLICY that is not owned by any one screen.
 *
 * These three functions were ported independently, and identically, by both the ChatView
 * and the VaultView agent, because panel.js kept them in the same module scope as
 * everything else and their two call sites are on different tabs:
 *
 *   vaultUnlocked     panel.js:1553 — VaultView renders from it; ChatView's onRequestSecret
 *                     (panel.js:928) gates the "save this to the vault?" checkbox on it.
 *   normalizeHost     panel.js:1557 — VaultView keys an entry with it; it is also what makes
 *                     vault.findForHost's suffix matching work, so it must stay byte-identical
 *                     to the version the stored entries were written with.
 *   maybeUnlockVault  panel.js:1567 — CONTRACT §6.2 step 1. Only ChatView's onRequestSecret
 *                     (panel.js:924) calls it, but it is vault policy, not chat policy.
 *
 * They live here rather than in either view so there is exactly one definition. A
 * view→view import would have worked equally well at runtime, but it makes the chat screen
 * depend on the vault SCREEN in order to reach the vault's rules, and it means the next
 * person to edit the unlock modal has to know which of the two copies is the real one.
 *
 * No JSX and no React: this is imperative policy that agent.js's onRequestSecret callback
 * awaits, and agent.js is not React. Keeping it hook-free is what lets both a component
 * and a plain async callback call it.
 */

import * as vault from '../js/vault.js';

import { openAsk } from './components/Modal.jsx';
import { showToast } from './components/Toast.jsx';

// Every vault call is guarded: the panel must work when the vault module is
// uninitialized, locked, or missing DOM. isUnlocked() is synchronous per §3.
export function vaultUnlocked() {
  try { return vault.isUnlocked(); } catch { return false; }
}

export function normalizeHost(input) {
  return String(input || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

/**
 * §6.2 step 1 — a locked vault gets an unlock modal before we look up a value.
 * Cancelling (or a wrong passphrase) falls through to a manual prompt; it never
 * fails the run.
 *
 * panel.js:1581 also called refreshVaultView() here. It needs no equivalent: a successful
 * vault.unlock() fires notify(), and VaultView's onLockChange subscription re-reads the
 * screen on its own. That is also why this function needs no view context and can live
 * outside both components.
 */
export async function maybeUnlockVault() {
  let state;
  try { state = await vault.getState(); } catch { return; }
  if (state !== 'locked') return;
  const res = await openAsk({
    title: 'Unlock your vault',
    message: 'Enter your vault passphrase to use saved credentials.',
    fields: [{ name: 'pass', label: 'Passphrase', type: 'password', secret: true, required: true }],
    submitLabel: 'Unlock',
  });
  if (!res) return;
  try {
    const ok = await vault.unlock(res.values.pass);
    if (!ok) showToast('Wrong passphrase — you can still type the value manually', 'error');
  } catch { /* fall through to a manual prompt */ }
}
