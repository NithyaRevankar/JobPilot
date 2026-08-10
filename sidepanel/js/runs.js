// runs.js — who is applying to what, and which tab belongs to which application.
//
// THE INVARIANT THIS FILE EXISTS FOR: at most one run per tab.
//
// It is not a tidiness rule. content-script.js keeps ONE refMap / lastInventory per frame
// (content-script.js:13-19), rebuilt wholesale on every read_page, and it does not look at
// who sent the message (content-script.js:4250). Two runs reading the same tab therefore
// invalidate each other's `eN` refs with no error anywhere — the second run's "click e7"
// lands on whatever element the first run's read happened to number 7. That is a wrong
// answer typed into a real job application, so the invariant is enforced rather than
// assumed, and `claim()` refuses rather than warns.
//
// SCOPE, honestly: this registry lives in the side panel, and Chrome gives one panel
// document per WINDOW. Tab ids are global. So this cannot, by itself, stop a panel in
// window 2 claiming a tab that window 1's panel is driving — drag a tab across and the id
// comes with it. The worker is the only thing both panels share, which is why claims are
// mirrored there (jobpilot:claim-*) and this Map is a cache in front of that answer, not
// the answer. Same reason the control indicator lives in the worker.
//
// Dependency-free and DOM-free, like the rest of sidepanel/js — so the node harness can
// drive it without a browser.

/** Chrome's own cap is far higher; this is about cost and rate limits, not about Chrome. */
export const MAX_CONCURRENT_RUNS = 3;

/** Run status, in the order a run moves through it. */
export const RUN_STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  BLOCKED: 'blocked',   // waiting on the user — a question, a captcha, a credential
  DONE: 'done',
  ERROR: 'error',
});

let seq = 0;

/** Ids only have to be unique within one panel session; they key storage and the worker. */
function nextRunId() {
  seq += 1;
  return `run-${seq}`;
}

export class RunRegistry {
  /**
   * @param {object} [opts]
   * @param {number} [opts.max]  concurrency cap; runs beyond it are refused, not queued
   * @param {(msg:object) => Promise<any>} [opts.send]  how to reach the worker. Injected so
   *   the node harness can drive this without a chrome runtime.
   */
  constructor({ max = MAX_CONCURRENT_RUNS, send } = {}) {
    this.max = max;
    this.runs = new Map();      // runId -> Run
    this.tabOwners = new Map(); // tabId -> runId  (the cache; the worker holds truth)
    this.send = send || ((msg) => chrome.runtime.sendMessage(msg).catch(() => null));
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of [...this.listeners]) fn();
  }

  list() {
    return [...this.runs.values()];
  }

  get(runId) {
    return this.runs.get(runId) || null;
  }

  /** Which run owns a tab, or null. The adoption guard in agent.js asks this. */
  ownerOf(tabId) {
    return this.tabOwners.get(tabId) || null;
  }

  /** How many runs are actually working. Blocked runs count — they hold a tab and a stream. */
  activeCount() {
    return this.list().filter(
      (r) => r.status === RUN_STATUS.RUNNING || r.status === RUN_STATUS.BLOCKED,
    ).length;
  }

  /**
   * Start tracking a run on a tab.
   *
   * Refuses — rather than stealing — when the tab is already being driven, and refuses when
   * the cap is full. Both refusals are things the UI says out loud: silently doing something
   * other than what the user asked for is how you end up with an application filled from
   * the wrong profile answers.
   *
   * @returns {Promise<{ok:true, run:object}|{ok:false, error:string}>}
   */
  async create({ tabId, title = '', host = '', windowId = null }) {
    if (typeof tabId !== 'number') {
      return { ok: false, error: 'No target tab. Open the job page in a normal browser tab, then try again.' };
    }
    const existing = this.ownerOf(tabId);
    if (existing) {
      return { ok: false, error: 'This tab already has an application running. Switch to it, or open the next job in a new tab.' };
    }
    if (this.activeCount() >= this.max) {
      return {
        ok: false,
        error: `${this.max} applications are already running. Wait for one to finish, or raise the limit in Settings.`,
      };
    }
    // The worker arbitrates across panel documents — see the header. A refusal here means
    // another WINDOW's panel is driving this tab.
    const claimed = await this.claim(tabId, null);
    if (!claimed.ok) return claimed;

    const run = {
      id: claimed.runId,
      tabId,
      windowId,
      title,
      host,
      status: RUN_STATUS.IDLE,
      createdAt: null, // stamped by the caller; this module has no clock of its own
    };
    this.runs.set(run.id, run);
    this.tabOwners.set(tabId, run.id);
    this.emit();
    return { ok: true, run };
  }

  /**
   * Record that a run owns a tab, asking the worker first.
   *
   * `runId` may be null, meaning "mint one" — that is how create() gets an id that the
   * worker has already agreed to.
   */
  async claim(tabId, runId) {
    const id = runId || nextRunId();
    const owner = this.ownerOf(tabId);
    if (owner && owner !== id) {
      return { ok: false, error: 'Another application in this panel is already driving that tab.' };
    }
    const reply = await this.send({ kind: 'jobpilot:claim-tab', runId: id, tabId });
    // A worker that did not answer is not a reason to refuse: the panel is the thing that
    // actually drives the tab, and refusing every run because the worker was asleep would
    // be worse than the cross-window race the claim protects against.
    if (reply && reply.ok === false) return { ok: false, error: reply.error || 'That tab is being driven by another window.' };
    this.tabOwners.set(tabId, id);
    return { ok: true, runId: id };
  }

  release(tabId, runId) {
    const owner = this.ownerOf(tabId);
    if (owner && runId && owner !== runId) return; // not ours to give away
    this.tabOwners.delete(tabId);
    this.send({ kind: 'jobpilot:release-tab', runId: owner || runId, tabId });
  }

  setStatus(runId, status) {
    const run = this.runs.get(runId);
    if (!run || run.status === status) return;
    run.status = status;
    this.emit();
  }

  /** Move a run onto a different tab — adoption, or an onReplaced id change. */
  retarget(runId, tabId) {
    const run = this.runs.get(runId);
    if (!run) return;
    if (run.tabId != null && this.tabOwners.get(run.tabId) === runId) {
      this.tabOwners.delete(run.tabId);
    }
    run.tabId = tabId;
    this.tabOwners.set(tabId, runId);
    this.emit();
  }

  remove(runId) {
    const run = this.runs.get(runId);
    if (!run) return;
    for (const [tabId, owner] of [...this.tabOwners]) {
      if (owner === runId) this.release(tabId, runId);
    }
    this.runs.delete(runId);
    this.emit();
  }

  /**
   * The collaborator AgentRunner takes. Bound to one run, so the runner cannot reach past
   * its own claims.
   */
  tabsFor(runId) {
    return {
      ownerOf: (tabId) => this.ownerOf(tabId),
      claim: (tabId) => {
        this.tabOwners.set(tabId, runId);
        this.send({ kind: 'jobpilot:claim-tab', runId, tabId });
        const run = this.runs.get(runId);
        if (run && run.tabId !== tabId) this.retarget(runId, tabId);
      },
      release: (tabId) => this.release(tabId, runId),
    };
  }

  /**
   * A tab closed. The run that owned it loses it; whether that ends the run is the caller's
   * call, because a run may legitimately own several tabs.
   *
   * @returns {string|null} the runId that owned it
   */
  forgetTab(tabId) {
    const owner = this.ownerOf(tabId);
    if (!owner) return null;
    this.tabOwners.delete(tabId);
    this.send({ kind: 'jobpilot:release-tab', runId: owner, tabId });
    this.emit();
    return owner;
  }

  /**
   * A tab id CHANGED under us — prerender activation and some discard/restore paths do
   * this (chrome.tabs.onReplaced). Nothing in the extension listened for it before, so a
   * run whose tab was replaced would have died on a page that was alive and well.
   */
  replaceTab(oldTabId, newTabId) {
    const owner = this.ownerOf(oldTabId);
    if (!owner) return null;
    this.tabOwners.delete(oldTabId);
    this.tabOwners.set(newTabId, owner);
    const run = this.runs.get(owner);
    if (run && run.tabId === oldTabId) run.tabId = newTabId;
    this.send({ kind: 'jobpilot:release-tab', runId: owner, tabId: oldTabId });
    this.send({ kind: 'jobpilot:claim-tab', runId: owner, tabId: newTabId });
    this.emit();
    return owner;
  }
}
