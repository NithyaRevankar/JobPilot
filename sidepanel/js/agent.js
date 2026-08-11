// agent.js — AgentRunner (contract §8): streaming agentic loop with sequential
// tool execution, ask_user pause, done handling, context pruning, maxSteps guard.

import { chatStream } from './llm.js';
import {
  TOOL_DEFS, executeTool, toolLabel, fillSecret, getTabHost, getRefHost, runMacro,
  showCaptchaInTab,
  waitForComplete, needsAttachment, visibleErrorText,
} from './tools.js';
import { buildSystemPrompt } from './prompts.js';
import {
  PLAN_FILL_TOOLS, PLAN_GATE_MESSAGE,
  formatPlanResult, inferredCount, normalizePlanFills, planArgsFor, provenanceOf,
} from './plan.js';
import {
  getSettings, getProfile, getDocuments,
  getPlaybook, savePlaybook, getSiteNote, saveSiteNote, bumpPlaybookUse,
  getMacrosFor, markMacroResult,
  APPLICATION_STATUSES, logApplication,
} from './storage.js';
import { detectPlatform, platformLabel, PLATFORMS } from './platforms.js';
import * as vault from './vault.js';

// A URL, a bare domain, or a protocol-relative link anywhere in a playbook line.
// Deliberately broad: a legitimate portal tip never needs to name an address, so a false
// positive costs one rejected line, while a false negative persists an exfiltration
// instruction that fires on every future application on that portal.
const URL_IN_TEXT = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\/\/)\S|\b[a-z0-9-]+\.(?:com|net|org|io|co|ai|dev|app|xyz|ru|cn|info|biz|to|me|link|site)\b(?!\.)/i;

const KEEP_RECENT = 6;         // messages exempt from pruning
const PRUNE_OVER = 400;        // tool results longer than this get truncated…
const PRUNE_TO = 300;          // …to this many chars
const PRUNE_SUFFIX = '…[truncated — call read_page again if needed]';
// Long string arguments in OLD assistant tool calls collapse to this. A dom_act value can
// be 500 characters and there can be twelve per call; refs, tool names, keys and flags are
// all far shorter than the threshold and pass through untouched.
const PRUNE_ARG_OVER = 120;
const PRUNE_ARG_TO = 80;
const SUPERSEDED = '(superseded — a later read_page replaced this page inventory. Work from the most ' +
  'recent read_page result; the refs listed here may no longer resolve.)';
// A batched ask_user is one form the user has to fill before the run continues. Past
// roughly this many boxes it stops being a convenience and becomes a wall, so the tail
// is dropped and the model asks for the rest next round.
const MAX_QUESTIONS = 8;

// Tools the loop answers without touching the page. Everything else can navigate, click,
// or replay a demonstration — i.e. can be the reason a NEW tab just opened — so tab
// adoption (below) brackets exactly the complement of this set.
//
// `propose_plan` is NOT here, and that is deliberate rather than an oversight: it fills
// fields, so it touches the page like any other tool and must sit inside the same
// adoption bracket. A plan whose first entry navigates the page (a country picker that
// reloads the form is the common case) has to be able to report that it did.
const LOOP_LOCAL_TOOLS = new Set(['ask_user', 'done', 'remember']);

/** The value-writing tools the plan gate intercepts. A Set for the per-call lookup. */
const PLAN_GATED_TOOLS = new Set(PLAN_FILL_TOOLS);

/**
 * How long to let a page paint its validation before deciding whether a submit landed.
 *
 * Long enough for the synchronous re-render every ATS does, short enough not to feel like a
 * hang at the exact moment the user is watching for an answer. Too short is the dangerous
 * direction: a read taken before the error appears reads as "submitted".
 */
const SUBMIT_SETTLE_S = 1.2;
// A click's window.open often fires a beat AFTER the click's tool result has returned
// (analytics first, popup second). A tab created within this many ms of the last page
// tool still counts as caused by it; anything later is the user browsing and is not ours
// to hijack the run onto.
const SPAWN_GRACE_MS = 2000;
// How long to give an adopted tab to finish loading before the next tool acts in it.
const SPAWN_LOAD_MS = 15000;

export class AgentRunner {
  /**
   * @param {object} opts
   * @param {() => Promise<number>} opts.getTabId  resolves the working tab id
   * @param {object} opts.callbacks  onText, onToolStart, onToolEnd, onAskUser,
   *                                 onRequestSecret, onStatus, onDone, onError.
   *   onRequestSecret({kind, label, host, ref}) resolves to a SECRET string (or
   *   null if declined). That value is handed straight to fillSecret and MUST
   *   never be pushed into this.messages — not in a result, error, or log.
   */
  constructor({ getTabId, callbacks, runId, tabs }) {
    /**
     * Which run this is. The worker keys the control indicator and the recording session by
     * it, and the tab registry keys ownership by it.
     */
    this.runId = runId || 'run-1';
    /**
     * The tab registry, or a permissive stand-in when there is nobody to ask.
     *
     * `ownerOf` is what stops this run adopting a tab another application is already
     * filling — two runs on one tab silently corrupt each other's element refs, because the
     * content script rebuilds its ref map per read_page and has no idea who is asking. The
     * default says "nobody owns anything", which is exactly right for a single run and for
     * the node harness.
     */
    this.tabs = tabs || { ownerOf: () => null, claim: () => {}, release: () => {} };
    this.getTabIdFresh = getTabId;
    // The RUN-SCOPED resolver, installed by run() and cleared when it ends. Tool handlers
    // that live on the instance (run_macro, request_demo) need the §10 tab pinning that
    // `getTabIdFresh` deliberately does not have — reaching for the raw resolver instead
    // would silently retarget whatever tab happens to be active.
    this.getTabId = null;
    // The tab this run is actually driving, readable without calling anything. The panel
    // needs it to keep the "controlled by JobPilot" indicator on the right tab, and asking
    // through getTabId would be wrong twice over: it THROWS when the working tab closed
    // (that throw is a message for the model, not for the indicator), and it is null
    // between runs, when the answer is simply "no tab".
    this.tabId = null;
    this.cb = callbacks;
    this.messages = [];          // neutral format, without system prompt
    this.running = false;
    this.abortController = null;
    this.stopped = false;
    // CONTRACT-V3 §5 — the portal memory live for this run. `systemPrompt` is rebuilt
    // whenever this changes, which is why it is not a const.
    this.memory = null;
    this.systemPrompt = '';
    this.promptInputs = null;    // {profile, documents, settings, credentialHosts}
    // CONTRACT-V11 §3. Armed at run start when plan mode is on; spent by the first
    // value-writing tool call made without a plan, or by the first propose_plan. See
    // PLAN_GATE_MESSAGE for why it fires at most once.
    this.planGate = false;
    // CONTRACT-V11 §6. Spent by the first confirm_submit that finds the page already
    // complaining — so the user is not asked to approve a submit that cannot land.
    this.submitPreflight = true;
  }

  get isRunning() {
    return this.running;
  }

  reset() {
    this.stop();
    this.messages = [];
  }

  stop() {
    this.stopped = true;
    if (this.abortController) {
      try { this.abortController.abort(); } catch { /* already aborted */ }
    }
  }

  async run(userText) {
    if (this.running) throw new Error('Agent is already running.');
    this.running = true;
    this.stopped = false;

    // Declared out here so the finally can always take it down: a const inside the try
    // is invisible to the finally, and a throw before the listener existed must not
    // become a ReferenceError that shadows the real error. `ownedTabs` is out here for
    // exactly the same reason — the finally has to hand every claimed tab back even when
    // the run threw before it had driven any of them.
    let onTabCreated = null;
    const ownedTabs = [];

    try {
      const [settings, profile, documents] = await Promise.all([
        getSettings(), getProfile(), getDocuments(),
      ]);
      // Tell the model which hosts have saved credentials (hosts only — never
      // usernames or values). Only when the vault is unlocked; locked or
      // uninitialized vaults contribute nothing.
      let credentialHosts = [];
      try {
        if (vault.isUnlocked()) {
          const entries = await vault.listEntries();
          credentialHosts = [...new Set(entries.map((e) => e.host).filter(Boolean))];
        }
      } catch { credentialHosts = []; }
      this.promptInputs = { profile, documents, settings, credentialHosts };
      this.memory = null;
      this.systemPrompt = buildSystemPrompt({ ...this.promptInputs, memory: null });

      // CONTRACT-V11 §1. With plan mode off the model is not offered propose_plan at all,
      // so the tool list — and therefore every request of this run — is byte-identical to
      // what it was before plan mode existed. A tool the model may not call has no business
      // occupying tokens in the schema block on every single step.
      const planMode = (settings && settings.planMode) || 'ask';
      const planning = planMode !== 'off' && typeof this.cb.onProposePlan === 'function';
      const tools = planning ? TOOL_DEFS : TOOL_DEFS.filter((t) => t.function.name !== 'propose_plan');
      this.planGate = planning;
      this.submitPreflight = true;

      // Within one run, keep acting on the tab captured at run start (§10);
      // if that tab closes, re-target the active tab but surface it as a tool
      // error so the model never acts on an unrelated tab unknowingly.
      let runTabId = await this.getTabIdFresh();
      this.tabId = runTabId;
      // Every tab THIS run has driven: the one it started on plus any it adopted. It is
      // what the closed-tab fallback below falls back TO, and what the run releases when
      // it ends.
      ownedTabs.push(runTabId);
      this.tabs.claim(runTabId, this.runId);

      const getTabId = async () => {
        try {
          const tab = await chrome.tabs.get(runTabId);
          // A DISCARDED tab is a failure mode concurrency invents. With one run the driven
          // tab is the active one and Chrome never discards it; with three, two are in the
          // background and Memory Saver will. chrome.tabs.get still SUCCEEDS on a discarded
          // tab, so the closed-tab branch below never fires — but the content script is
          // gone and every eN ref with it. Silence here means the model acts on refs that
          // no longer address anything.
          if (tab && tab.discarded) {
            throw new Error(
              'The working tab was suspended by the browser to save memory and has been reloaded. ' +
              'Every ref you hold is dead — call read_page before acting.'
            );
          }
          return runTabId;
        } catch (err) {
          if (/suspended by the browser/.test(err.message || '')) throw err;
          // The working tab closed. Fall back to another tab THIS run owns — never to the
          // active tab: with several applications running, the active tab is very likely
          // the one the user is watching another run fill, and retargeting onto it would
          // put two runs on one tab. Ending the run is the honest outcome when there is
          // nothing of ours left to drive.
          let next = null;
          while (ownedTabs.length) {
            const candidate = ownedTabs[ownedTabs.length - 1];
            if (candidate === runTabId) { ownedTabs.pop(); continue; }
            try { await chrome.tabs.get(candidate); next = candidate; break; } catch { ownedTabs.pop(); }
          }
          this.tabs.release(runTabId, this.runId);
          if (next == null) {
            this.tabId = null;
            throw new Error(
              'The working tab was closed and this run has no other tab open. ' +
              'Reopen the job page and start again — I will not take over whatever tab happens to be in front, ' +
              'because another application may be running there.'
            );
          }
          runTabId = next;
          this.tabId = next; // the indicator moves with the run, off the tab that closed
          throw new Error(
            'The working tab was closed. Now targeting another tab this run opened — ' +
            'call read_page to see where you are.'
          );
        }
      };
      this.getTabId = getTabId;

      // ---- Follow the application when it leaves the tab (the ApplyPilot rule:
      // "ALWAYS check for new tabs after clicking apply/login"). Job boards constantly
      // open the real application in a NEW tab — LinkedIn's plain "Apply", most careers
      // pages, every SSO popup — and a run pinned to the old tab then reads a page the
      // flow has already left. That, silently, was a failed application every time.
      //
      // The recorder already adopts tabs its demonstration opens (service-worker
      // onCreated); this is the same idea for the run itself. Only tabs opened BY the
      // working tab count (openerTabId), and only when a page tool was in flight or has
      // just finished — a tab the user opens by hand mid-run is theirs, not ours.
      const spawnedTabs = [];
      let pageToolInFlight = false;
      let lastPageToolEnd = 0;
      // Tabs a spawn produced that belong to ANOTHER run. Kept so the note below can say so
      // — a silent decline would be the exact failure this whole mechanism exists to stop
      // (see the comment above: an unfollowed tab was "a failed application every time").
      const contestedTabs = [];
      onTabCreated = (tab) => {
        if (!tab || typeof tab.id !== 'number' || tab.openerTabId !== runTabId) return;
        if (!pageToolInFlight && Date.now() - lastPageToolEnd > SPAWN_GRACE_MS) return;
        const owner = this.tabs.ownerOf(tab.id);
        if (owner && owner !== this.runId) { contestedTabs.push(tab.id); return; }
        spawnedTabs.push(tab.id);
      };
      chrome.tabs.onCreated.addListener(onTabCreated);

      /**
       * Switch the run onto the newest still-open spawned tab, wait for it to load, and
       * return the note the model must see — or '' when there is nothing to adopt. The
       * note is appended to the tool result it belongs to: a silent switch would leave
       * the model holding refs from a page it is no longer driving, believing they work.
       */
      const adoptSpawnedTab = async (when) => {
        // Oldest first: the tab the click opened is the one created first — later ones
        // are ads, trackers, or secondary popups riding the same click. (Adopting the
        // newest once put a run on an ad interstitial while the SSO tab sat behind it.)
        const seen = spawnedTabs.length;
        let adopted = null;
        while (spawnedTabs.length) {
          const id = spawnedTabs.shift();
          try { adopted = await chrome.tabs.get(id); break; } catch { /* already closed — try the next */ }
        }
        spawnedTabs.length = 0;
        if (!adopted) {
          // Nothing to adopt because another application already owns what opened. Say it:
          // the model would otherwise read an ordinary result and carry on filling a page
          // the flow has left, which is indistinguishable from the silent failure adoption
          // was written to prevent.
          if (contestedTabs.length) {
            contestedTabs.length = 0;
            return '\n\nNOTE: that action opened a new tab, but ANOTHER application already running in ' +
              'this panel is driving it, so this run did not follow. Two runs cannot share a tab. ' +
              'If this application should have continued there, stop the other run and try again.';
          }
          return '';
        }
        contestedTabs.length = 0;
        ownedTabs.push(adopted.id);
        this.tabs.claim(adopted.id, this.runId);
        const others = seen > 1
          ? ` (${seen - 1} more tab${seen > 2 ? 's' : ''} opened at the same time — likely popups; ask the user if the page looks wrong)`
          : '';
        runTabId = adopted.id;
        this.tabId = adopted.id; // the "controlled by JobPilot" indicator follows the run
        const signal = this.abortController ? this.abortController.signal : undefined;
        // The timeout verdict must reach the model (navigateTool does the same): a heavy
        // ATS bundle can take longer than this to render, and without the caveat a
        // half-loaded page reads as a broken site instead of a slow one.
        const timedOut = await waitForComplete(adopted.id, SPAWN_LOAD_MS, signal);
        let url = adopted.pendingUrl || adopted.url || '';
        try { url = (await chrome.tabs.get(adopted.id)).url || url; } catch { /* closed again; report what we know */ }
        const where = url ? ` (${url.slice(0, 120)})` : '';
        const loading = timedOut
          ? ` The new tab had NOT finished loading after ${Math.round(SPAWN_LOAD_MS / 1000)}s — if the page looks empty or half-rendered, wait, then read_page again.`
          : '';
        return (when === 'before'
          ? `\n\nNOTE: your previous action opened a NEW tab${where}${others} and the run switched to it — THIS tool call already ran in the new tab. Refs from the old page are dead; if this result does not show the new page, call read_page.`
          : `\n\nNOTE: that action opened a NEW tab${where}${others}. The run now drives the new tab — the old one stays open behind it. Every ref you hold belongs to the OLD page: call read_page before acting.`) + loading;
      };

      this.messages.push({ role: 'user', content: userText });

      // CONTRACT-V4 §1: 0 = unlimited. `|| 48` would swallow the 0, so test explicitly.
      const configured = Number.isFinite(settings.maxSteps) ? settings.maxSteps : 48;
      const maxSteps = configured === 0 ? Infinity : configured;
      let step = 0;
      let finished = false;
      const stepLabel = () => (maxSteps === Infinity ? `step ${step}` : `step ${step}/${maxSteps}`);

      while (!finished && !this.stopped) {
        step++;

        // Re-resolve the portal every step (cached, so ≈free). This is what handles the
        // agent following a LinkedIn posting out to an external Workday portal mid-run:
        // the playbook swaps under it without the run restarting.
        await this.refreshMemory(runTabId);

        if (step > maxSteps) {
          this.messages.push({
            role: 'user',
            content: `You have reached the step limit (${maxSteps}). Stop using tools and summarize the current state: what was completed, what remains, and what the user should do next.`,
          });
          this.status(`Step limit reached — asking model to summarize`);
          // Keep the tool defs in the request: Anthropic rejects histories that
          // contain tool_use/tool_result blocks unless tools are defined. Any
          // tool calls in the reply are discarded (only summary.text is kept).
          const summary = await this.streamOnce({ settings, tools });
          if (summary.text) this.messages.push({ role: 'assistant', content: summary.text });
          break;
        }

        this.status(`Thinking… (${stepLabel()})`);
        const { text, toolCalls } = await this.streamOnce({
          settings, tools,
        });
        if (this.stopped) {
          // Drop unexecuted tool calls so the conversation never carries
          // assistant tool_calls without matching results (providers reject that).
          if (text) this.messages.push({ role: 'assistant', content: text });
          break;
        }

        // Never store an empty assistant turn — both providers reject it on
        // the next request (empty text block / null content without tool_calls).
        if (text || toolCalls.length) {
          this.messages.push({
            role: 'assistant',
            content: text,
            ...(toolCalls.length ? { toolCalls } : {}),
          });
        }

        if (!toolCalls.length) break; // plain answer — turn over

        const answeredIds = new Set();
        // The backfill below is what guarantees "every assistant tool_call has a matching
        // tool message". It has to run even when a tool branch THROWS, or the history is
        // left permanently unbalanced and every subsequent request to the provider is
        // rejected outright — turning one tool bug into a dead conversation.
        try {
          for (const tc of toolCalls) {
            if (this.stopped) break;
            const args = parseArgs(tc.argsJson);
            // The model is told to omit `platform` on remember, so fall back to the DETECTED
            // portal for the activity row — otherwise the one row meant to prove the memory
            // bank works would read "remember → this portal".
            const labelArgs = (tc.name === 'remember' && !args.platform && this.memory)
              ? { ...args, platform: this.memory.platform }
              : args;
            const label = toolLabel(tc.name, labelArgs);
            this.cb.onToolStart({ name: tc.name, args, label });
            this.status(`${label} (${stepLabel()})`);

            let resultText;
            let ok = true;
            const signal = this.abortController ? this.abortController.signal : undefined;

            // Page tools act where the flow went: a tab opened by an EARLIER action is
            // adopted before this tool runs (the note rides on this tool's result), and
            // one opened by THIS tool is adopted right after it.
            const touchesPage = !LOOP_LOCAL_TOOLS.has(tc.name);
            let tabNote = '';
            if (touchesPage) {
              pageToolInFlight = true;
              tabNote = await adoptSpawnedTab('before');
              // Adoption can block up to SPAWN_LOAD_MS waiting for the tab to load. A
              // Stop pressed during that wait must not buy the page one more action —
              // the finally's backfill answers the skipped tool call.
              if (this.stopped) break;
            }

            if (tc.name === 'ask_user') {
              // One call, one form, N answers. `question`/`options` remain valid for the
              // genuinely-single case and are normalized into the same list, so there is
              // only ever one shape below here.
              const { questions: asked, dropped, unpacked } = normalizeQuestions(args);
              if (!asked.length) {
                ok = false;
                resultText = 'ask_user needs at least one question: pass questions:[{question:"…"}, …] with everything you need for this page.';
              } else {
                this.status(asked.length > 1 ? `Waiting for your ${asked.length} answers…` : 'Waiting for your answer…');
                let answers;
                try {
                  answers = await this.cb.onAskUser(asked);
                } catch {
                  answers = null;
                }
                if (this.stopped) break;
                if (!Array.isArray(answers)) {
                  // Not stopped — the user dismissed the modal. Saying "the run was
                  // stopped" here would make the model narrate a stop that never happened.
                  ok = false;
                  resultText = asked.length > 1
                    ? 'User dismissed the questions without answering any of them. Do not ask them again — continue if you can, otherwise call done with status "blocked".'
                    : 'User dismissed the question without answering. Do not ask it again — continue if you can, otherwise call done with status "blocked".';
                } else {
                  resultText = formatAnswers(asked, answers, dropped, unpacked);
                }
              }
            } else if (tc.name === 'done') {
              resultText = 'Acknowledged.';
              this.messages.push({
                role: 'tool', toolCallId: tc.id, content: resultText,
              });
              answeredIds.add(tc.id);
              this.cb.onToolEnd({ name: tc.name, ok: true, result: `${args.status || 'done'} — ${args.summary || ''}` });
              // The application log (the tracker). Captured HERE because this is the one
              // moment everything is in hand: the outcome, the model's clean job_title /
              // company from the posting, the tab's real URL, and the detected portal.
              // Await-ed so a panel closing right after done cannot lose the record;
              // failures are swallowed — the tracker is a courtesy, never a run-killer.
              await this.logOutcome(args).catch(() => {});
              this.cb.onDone({
                status: args.status || 'answered',
                summary: String(args.summary || ''),
              });
              finished = true;
              break;
            } else if (tc.name === 'remember') {
              // CONTRACT-V3 §4. Panel-side data, never dispatched to the page.
              const res = await this.handleRemember(args);
              ok = res.ok;
              resultText = res.ok ? res.result : res.error;
            } else if (tc.name === 'propose_plan') {
              // CONTRACT-V11 §2. The card, then the fills. Takes getTabId because it
              // re-enters executeTool once per approved entry — the run-scoped resolver,
              // never the raw one, so the fills land on the tab this run pinned.
              this.planGate = false;
              const res = await this.handleProposePlan(args, getTabId, signal, planMode);
              ok = res.ok;
              resultText = res.ok ? res.result : res.error;
              if (this.stopped) break;
            } else if (tc.name === 'confirm_submit') {
              // CONTRACT-V11 §5. Two buttons, then the click. Page-touching (submitting is
              // the navigation), so it sits inside the adoption bracket like any other.
              const res = await this.handleConfirmSubmit(args, getTabId, signal, settings);
              ok = res.ok;
              resultText = res.ok ? res.result : res.error;
              if (this.stopped) break;
            } else if (tc.name === 'request_demo') {
              // CONTRACT-V6 §5.1. The run pauses; the user does it by hand; we watch.
              const res = await this.handleRequestDemo(args);
              ok = res.ok;
              resultText = res.ok ? res.result : res.error;
              if (this.stopped) break;
            } else if (tc.name === 'request_captcha') {
              // The one human handoff with nothing to type: focus the tab, spotlight the
              // widget, one-button dialog. Never a free-text question.
              const res = await this.handleRequestCaptcha(args);
              ok = res.ok;
              resultText = res.ok ? res.result : res.error;
              if (this.stopped) break;
            } else if (tc.name === 'run_macro') {
              const res = await this.handleRunMacro(args);
              ok = res.ok;
              resultText = res.ok ? res.result : res.error;
            } else if (tc.name === 'request_secret') {
              // The value never enters this.messages: it is collected by the panel,
              // handed to fillSecret, and goes out of scope. Only the kind/ref/host
              // (never the value) appear in any string here.
              const kind = ['username', 'password', 'otp', 'other'].includes(args.kind) ? args.kind : 'other';
              this.status('Waiting for your credentials…');
              // The credential is looked up, shown, and typed under the host of the
              // frame the ref lives in — never the top frame's. A page that embeds a
              // hostile iframe must not be able to aim request_secret at it and
              // collect the top origin's password.
              let host = '';
              let topHost = '';
              try { host = await getRefHost(getTabId, args.ref); } catch { /* restricted page */ }
              try { topHost = await getTabHost(getTabId); } catch { /* restricted page */ }

              // An unresolved origin is UNKNOWN, not safe. fillSecret refuses to type into an
              // origin it cannot verify, so prompting here would ask the user to hand over a
              // password that is already doomed to be discarded — and the cross-origin warning
              // would have been silently suppressed on the way (crossFrame would be false).
              // Bail before the modal, and tell the model something it can act on.
              if (!host) {
                ok = false;
                resultText = `Could not resolve which origin ${args.ref || 'that field'} belongs to, so a credential cannot be typed into it safely. Call read_page and target the field on the real login form.`;
                this.messages.push({ role: 'tool', toolCallId: tc.id, content: resultText });
                answeredIds.add(tc.id);
                this.cb.onToolEnd({ name: tc.name, ok: false, result: resultText });
                // This continue skips the shared tail below, so the adoption flags must
                // come down here or every later user-opened tab reads as tool-caused.
                pageToolInFlight = false;
                lastPageToolEnd = Date.now();
                continue;
              }

              let secret = null;
              try {
                secret = await this.cb.onRequestSecret({
                  kind,
                  label: String(args.label || ''),
                  host,
                  topHost,
                  crossFrame: Boolean(topHost && host !== topHost),
                  ref: String(args.ref || ''),
                });
              } catch { secret = null; }
              if (this.stopped) break;
              if (secret == null) {
                ok = false;
                resultText = `User declined to provide the ${kind}. Do not retry unless they ask.`;
              } else {
                const res = await fillSecret(getTabId, args.ref, secret, signal, host);
                ok = res.ok;
                resultText = res.ok
                  ? `Filled the ${kind} into ${args.ref}. The value is hidden from you.`
                  : String(res.error);
              }
              // `secret` goes out of scope here. It is never pushed to this.messages.
            } else if (this.planGate && PLAN_GATED_TOOLS.has(tc.name)) {
              // CONTRACT-V11 §3 — the one-shot nudge. The model reached for a fill without
              // planning the page; send it back once, and never again this run. Spending the
              // gate BEFORE the refusal is what makes it one-shot even if the model ignores
              // the message and repeats the identical call.
              this.planGate = false;
              ok = false;
              resultText = PLAN_GATE_MESSAGE;
            } else {
              const res = await executeTool(tc.name, args, getTabId, signal);
              ok = res.ok;
              resultText = res.ok ? String(res.result ?? 'OK') : String(res.error ?? 'Unknown error');
            }

            if (touchesPage) {
              pageToolInFlight = false;
              lastPageToolEnd = Date.now();
              const afterNote = this.stopped ? '' : await adoptSpawnedTab('after');
              // The note rides on the SAME tool result that caused (or ran after) the
              // switch — a separate message could be pruned away from its cause.
              if (tabNote || afterNote) resultText = `${String(resultText ?? '')}${tabNote}${afterNote}`;
            }

            this.messages.push({ role: 'tool', toolCallId: tc.id, content: resultText });
            answeredIds.add(tc.id);
            this.cb.onToolEnd({ name: tc.name, ok, result: resultText });
          }
        } finally {
          // Backfill results for tool calls skipped by done/stop so every
          // assistant tool_call has a matching tool message next turn.
          for (const tc of toolCalls) {
            if (!answeredIds.has(tc.id)) {
              this.messages.push({
                role: 'tool', toolCallId: tc.id,
                content: 'Skipped — the run ended before this tool executed.',
              });
            }
          }
        }
      }
    } catch (err) {
      if (!isAbort(err)) this.cb.onError(err);
    } finally {
      // Guarded like stop()'s abort(): if the extension context was invalidated mid-run
      // (an MV3 auto-update), removeListener throws — and a throw from a finally would
      // replace the already-reported error, skip the resets below, and leave `running`
      // stuck true, refusing every future run until the panel is reloaded.
      try { if (onTabCreated) chrome.tabs.onCreated.removeListener(onTabCreated); } catch { /* context gone */ }
      // Hand the tabs back, or the next run to be pointed at one of them would be refused
      // by a claim nobody holds any more.
      try { for (const id of ownedTabs) this.tabs.release(id, this.runId); } catch { /* registry gone */ }
      this.running = false;
      this.abortController = null;
      this.getTabId = null;
      this.tabId = null;
      this.status(null);
    }
  }

  /**
   * One streamed model call. Returns {text, toolCalls}.
   *
   * Reads `this.systemPrompt` rather than taking it as an argument: refreshMemory() can
   * rebuild it between steps (a mid-run portal switch), and the next request must carry
   * the new one. The system prompt is also the only place a playbook can live and still
   * survive pruneMessages() — see CONTRACT-V3 §5.
   */
  async streamOnce({ settings, tools }) {
    this.abortController = new AbortController();
    const messages = [
      { role: 'system', content: this.systemPrompt },
      ...pruneMessages(this.messages),
    ];

    let text = '';
    const toolCalls = [];
    if (this.cb.onStreamStart) { try { this.cb.onStreamStart(); } catch { /* UI only */ } }
    try {
      for await (const ev of chatStream({
        settings, messages, tools, signal: this.abortController.signal,
      })) {
        if (this.stopped) break;
        if (ev.type === 'text') {
          text += ev.delta;
          this.cb.onText(ev.delta);
        } else if (ev.type === 'tool_call') {
          toolCalls.push({ id: ev.id, name: ev.name, argsJson: ev.argsJson });
        } else if (ev.type === 'usage' && this.cb.onUsage) {
          try { this.cb.onUsage(ev); } catch { /* stats must never break a run */ }
        }
      }
    } catch (err) {
      if (!isAbort(err)) throw err;
    } finally {
      if (this.cb.onStreamEnd) { try { this.cb.onStreamEnd(); } catch { /* UI only */ } }
    }
    return { text, toolCalls };
  }

  /**
   * Re-resolve the portal for the working tab and, when it CHANGED, reload its playbook
   * and rebuild the system prompt (CONTRACT-V3 §5).
   *
   * Runs once per step. detectPlatform caches on tabId+URL, so an unchanged page costs one
   * getAllFrames() and no DOM probe. Best-effort throughout: a detection failure means "no
   * playbook", never a failed run.
   */
  async refreshMemory(tabId) {
    if (!this.promptInputs) return;
    let detection;
    try {
      detection = await detectPlatform(tabId);
    } catch {
      return; // detection is never worth breaking a run over
    }

    // A BLOCKED probe is not an answer. Treating it as "no portal here" drops a live
    // playbook mid-run and makes `remember` refuse with a claim ("no job portal was
    // detected") that the failed probe never established (V6 §8).
    if (detection.error) return;

    const prevPlatform = this.memory && this.memory.platform;
    const prevHost = this.memory && this.memory.host;
    if (!detection.platform) {
      // Left a known portal for an ordinary page — drop the playbook rather than keep
      // advising Workday steps on a page that is not Workday.
      if (prevPlatform) {
        this.memory = null;
        this.rebuildPrompt();
        this.emitMemory();
      }
      return;
    }
    if (detection.platform === prevPlatform && detection.host === prevHost) return;

    await this.loadMemory(detection);
    if (this.memory && this.memory.playbook) bumpPlaybookUse(detection.platform);
    this.emitMemory();
  }

  /** Load the playbook + site note for a detection and rebuild the prompt. */
  async loadMemory(detection) {
    let playbook = null;
    let siteNote = null;
    // A failed READ is not the same as "no playbook exists". Collapsing the two would make
    // the prompt say "You are the first run on this portal" when a rich playbook is sitting
    // right there — so the model re-derives what it already knew and re-remembers it.
    let readFailed = false;
    try {
      playbook = await getPlaybook(detection.platform);
    } catch (err) {
      console.debug('[JobPilot] could not read the playbook for', detection.platform, err);
      playbook = null;
      readFailed = true;
    }
    try {
      siteNote = await getSiteNote(detection.host);
    } catch { siteNote = null; }

    // CONTRACT-V6 §5.2: the portal's recorded demonstrations, so the model can reach for
    // one instead of getting stuck on the control it got stuck on last time.
    let macros = [];
    try {
      macros = (await getMacrosFor(detection.platform)).filter((m) => m.status !== 'broken');
    } catch { macros = []; }

    this.memory = {
      platform: detection.platform,
      label: detection.label || platformLabel(detection.platform),
      host: detection.host,
      playbook,
      siteNote,
      macros,
      readFailed,
    };
    this.rebuildPrompt();
  }

  rebuildPrompt() {
    this.systemPrompt = buildSystemPrompt({ ...this.promptInputs, memory: this.memory });
  }

  /**
   * Re-read just the macro list for the portal already in memory.
   *
   * Deliberately NOT refreshMemory(): that re-detects, and it early-returns when the
   * platform and host are unchanged — which they always are here — so a macro saved
   * seconds ago would stay invisible for the rest of the run. Worse, if the demonstration
   * navigated the tab (an SSO redirect is the common case), detection comes back empty and
   * the whole playbook is dropped for a portal the user just demonstrated on.
   */
  async reloadMacros() {
    if (!this.memory || !this.memory.platform) return;
    try {
      const macros = (await getMacrosFor(this.memory.platform)).filter((m) => m.status !== 'broken');
      this.memory = { ...this.memory, macros };
      this.rebuildPrompt();
    } catch { /* the run continues on the macro list it already had */ }
  }

  emitMemory(saved = false) {
    if (!this.cb.onMemory) return;
    const m = this.memory;
    try {
      this.cb.onMemory({
        platform: m ? m.platform : null,
        label: m ? m.label : '',
        host: m ? m.host : '',
        hasPlaybook: Boolean(m && m.playbook && (m.playbook.procedure.length || m.playbook.tips.length)),
        saved,
      });
    } catch { /* a UI callback must never break the loop */ }
  }

  /**
   * `propose_plan` (CONTRACT-V11 §2). One card for the whole page, then the fills.
   *
   * THE ORDER MATTERS AND IS NOT OBVIOUS. Normalize → trace provenance → review → execute.
   * Provenance is computed BEFORE the card because it is what the card is for: the chips are
   * how the user knows which of twenty rows deserve a second look. Execution happens AFTER
   * the card and inside this call because the alternative — handing an approved plan back and
   * letting the model re-issue it — costs a step and a round-trip per field, which is most of
   * the saving the feature exists for.
   *
   * EVERY entry is executed through executeTool, one at a time. Not through a new page-side
   * batch endpoint, and not concurrently. Sequential because a form is stateful — a country
   * choice repopulates the state list, and two fills racing on a re-rendering section is how
   * you get a value written into the field that took the other one's place. Through
   * executeTool because every guard that makes a fill safe already lives on that path.
   *
   * @param {object} args        the model's raw arguments
   * @param {() => Promise<number>} getTabId  the RUN-SCOPED resolver (§10 tab pinning)
   * @param {AbortSignal} [signal]
   * @param {string} planMode    'ask' | 'auto' — 'off' never reaches here
   */
  async handleProposePlan(args, getTabId, signal, planMode) {
    const { fills, dropped: fillsDropped, refused } = normalizePlanFills(args && args.fills);
    // Unknowns are ordinary ask_user questions that happen to arrive in a plan, so they go
    // through the SAME normalizer — including the "1. … 2. … 3. …" unpacking. A model that
    // crams six questions into one string does it here too, and one blob saved as one
    // savedAnswers row is exactly as useless whichever tool collected it.
    const { questions: unknowns, dropped: askDropped, unpacked } = normalizeQuestions({
      questions: (args && args.unknowns) || [],
    });

    if (!fills.length && !unknowns.length) {
      return {
        ok: false,
        error: refused.length
          ? `Nothing in that plan could be used (${refused.join('; ')}). Call read_page, then send fills with real refs from it.`
          : 'A plan needs something in it: fills:[{ref,label,value}] for what you will enter, unknowns:[{question}] for what you cannot answer. ' +
            'If the page needs neither, do not call propose_plan — just carry on.',
      };
    }

    const profile = (this.promptInputs && this.promptInputs.profile) || {};
    const rows = fills.map((f) => ({ ...f, ...provenanceOf(f.value, profile) }));

    // 'auto' shows the card only when there is something to DECIDE. A wizard page whose
    // every value came out of the profile and which asks nothing is a page the user has
    // already answered — stopping them on it teaches them to approve without reading, which
    // costs exactly the attention the inferred rows need. A single inferred value or a
    // single question brings the card straight back.
    const nothingToDecide = !unknowns.length && inferredCount(rows) === 0;
    const autoApproved = planMode === 'auto' && nothingToDecide;

    let approved = rows.map((r) => ({ ...r, include: true }));
    let answers = null;

    if (!autoApproved) {
      this.status(`Waiting for you to review ${rows.length} field${rows.length === 1 ? '' : 's'}…`);
      let review = null;
      try {
        review = await this.cb.onProposePlan({ rows, unknowns, unpacked });
      } catch {
        review = null;
      }
      if (this.stopped) return { ok: false, error: 'Stopped.' };
      if (!review) {
        // Dismissed. Identical in spirit to a dismissed ask_user (§8): nothing was entered,
        // and the model must not read that as permission to go and enter it field by field —
        // which is precisely what it would do, since every value it proposed is still one it
        // believes in. This is the one refusal in the file that has to close a door rather
        // than open one.
        return {
          ok: false,
          error: 'The user dismissed the plan without approving it. NOTHING was filled, and nothing on this page ' +
            'has your approval — do not fill these fields one at a time instead. Ask what they want changed with ' +
            'ask_user, or call done with status "ready_for_review".',
        };
      }
      approved = review.fills;
      answers = review.answers;
    }

    // Execute. A stale ref, an obstructed control or a refused credential comes back as an
    // ordinary tool error with a fresh snapshot attached, and it stops THAT entry only: one
    // control the page re-rendered under us must not abandon the other nineteen.
    const results = [];
    let stoppedEarly = false;
    const total = approved.filter((r) => r.include).length;
    let done = 0;
    for (const entry of approved) {
      if (!entry.include) { results.push({ entry, status: 'skipped' }); continue; }
      if (this.stopped) { stoppedEarly = true; break; }
      done++;
      this.status(`Filling ${entry.label} (${done}/${total})…`);
      let res;
      try {
        res = await executeTool(entry.tool, planArgsFor(entry), getTabId, signal);
      } catch (err) {
        // executeTool is documented not to throw, so this is a programmer error rather than
        // a page failure. It still must not take the remaining entries down with it.
        res = { ok: false, error: `Internal error filling this field: ${err && err.message ? err.message : String(err)}` };
      }
      results.push({
        entry,
        status: res.ok ? 'ok' : 'failed',
        detail: res.ok ? '' : String(res.error ?? 'Unknown error'),
      });
    }

    return {
      ok: true,
      result: formatPlanResult({
        results,
        answers,
        unknowns,
        dropped: fillsDropped + askDropped,
        refused,
        autoApproved,
        stopped: stoppedEarly,
        unpacked,
      }),
    };
  }

  /**
   * `confirm_submit` (CONTRACT-V11 §5). The go-ahead for the final submit — one dialog,
   * two buttons — and then the click.
   *
   * WHY IT CLICKS. The confirmation used to be an ask_user: a text box, into which the user
   * typed "yes", followed by a second press on the dialog's own Submit button. Two actions
   * and a guess at the magic word, for the most consequential moment in a run. Worse, the
   * word only ever told the MODEL it had permission — the actual click came later, as a
   * separate step that could error, land on a different control, or never happen because
   * the run was stopped in between. A dialog whose button says Submit and which does not
   * submit is a dialog that lies. So approval and click are one thing here.
   *
   * WHY autoSubmit STILL SHORT-CIRCUITS. With auto-submit on, rule 8 tells the model it may
   * click without asking, so a model calling this anyway has simply been careful. Popping a
   * confirmation the user explicitly turned off would be the extension overriding a setting
   * because it disapproved of it; clicking and saying so is the honest reading.
   */
  async handleConfirmSubmit(args, getTabId, signal, settings) {
    const ref = String((args && args.ref) || '').trim();
    if (!ref) {
      return { ok: false, error: 'confirm_submit needs the ref of the submit button. Call read_page (or find "Submit") and pass it.' };
    }
    const label = String((args && args.label) || '').trim();
    const summary = String((args && args.summary) || '').trim();

    const readErrors = async () => {
      try {
        return visibleErrorText(await executeTool('read_errors', {}, getTabId, signal));
      } catch {
        return ''; // never let the check itself break a submit
      }
    };

    const click = async (note) => {
      const res = await executeTool('click', { ref }, getTabId, signal);
      if (!res.ok) {
        // The click failing is NOT the user declining, and the difference matters: a
        // cookie banner over the button (which `click` refuses by design) must send the
        // model back to clear it, not make it report the application as awaiting review.
        return {
          ok: false,
          error: `${note} But the click FAILED: ${String(res.error)}\nThe application was NOT submitted. ` +
            'Fix what the error describes and call confirm_submit again — do not tell the user it was submitted, and do not call done with status "submitted".',
        };
      }

      // CONTRACT-V11 §6 — did the form actually take it?
      //
      // THE FAILURE THIS EXISTS FOR. A portal refuses the submit and paints its own reason
      // ("Final certificate - Attachment is required"). The click itself SUCCEEDED — the
      // button was there and it was pressed — so nothing in the result said otherwise, and
      // the only thing standing between that and "Application submitted ✓" in the chat was
      // the model remembering to verify. Rule 9 asks it to; a rule is not a guarantee, and
      // being wrong here means telling someone they applied for a job when they did not.
      // So the panel checks, every time, and the check is not the model's to skip.
      //
      // The pause is because validation renders a beat after the click, and a read taken
      // too early sees a clean page and calls it submitted.
      await executeTool('wait', { seconds: SUBMIT_SETTLE_S }, getTabId, signal);
      const errors = await readErrors();
      if (errors) {
        // Tell the USER, not only the model. This is the moment they were waiting on —
        // they approved a submit and it did not happen — and it must not be something they
        // have to expand a tool result to discover.
        if (typeof this.cb.onSubmitBlocked === 'function') {
          try { this.cb.onSubmitBlocked({ errors, label, attachment: needsAttachment(errors) }); } catch { /* UI only */ }
        }
        const fileHint = needsAttachment(errors)
          ? ' This one is asking for a FILE: attach it with upload_file if a stored document fits. ' +
            'If none does, the user has to add it in the Profile tab first — ask_user for it and say so plainly, ' +
            'because this is a blocker you cannot clear on your own.'
          : '';
        return {
          ok: false,
          error: `${note} The button was clicked, but the form REFUSED the submission and is showing:\n${errors}\n\n` +
            `The application was NOT submitted.${fileHint} Fix what is listed, then call confirm_submit again. ` +
            'Do NOT call done with status "submitted", and do not tell the user it went through.',
        };
      }

      return {
        ok: true,
        result: `${note} ${String(res.result ?? 'Clicked.')}\nNo validation errors are showing afterwards. ` +
          'Now confirm it actually went through (rule 9): read_page for the confirmation message or reference number, then call done with the true outcome.',
      };
    };

    if (settings && settings.autoSubmit) {
      return click('Auto-submit is ON, so the user was not asked.');
    }

    // Do not spend the user's one click on a submit the page is ALREADY refusing. Fires at
    // most once per run for the same reason the plan gate does: a page that keeps a
    // harmless notice permanently on screen would otherwise never be submittable at all,
    // and a form the user cannot submit is worse than a wasted click.
    if (this.submitPreflight) {
      this.submitPreflight = false;
      const pre = await readErrors();
      if (pre) {
        return {
          ok: false,
          error: 'Not asking the user yet — the page is ALREADY showing unresolved problems, so a submit now ' +
            `would just bounce:\n${pre}\n\n` +
            (needsAttachment(pre)
              ? 'This includes a required FILE — use upload_file, or ask_user for a document the profile does not have. '
              : '') +
            'Clear these first, then call confirm_submit again and it will go through to the user. ' +
            'If you have judged them irrelevant, calling again is enough — this check happens once.',
        };
      }
    }
    if (typeof this.cb.onConfirmSubmit !== 'function') {
      return { ok: false, error: 'This build cannot show a submit confirmation. Call done with status "ready_for_review" and let the user submit.' };
    }

    this.status('Waiting for you to approve the submit…');
    let approved = false;
    try {
      approved = await this.cb.onConfirmSubmit({ ref, label, summary });
    } catch {
      approved = false;
    }
    if (this.stopped) return { ok: false, error: 'Stopped.' };
    if (!approved) {
      return {
        ok: false,
        error: 'The user did NOT approve the submit. Nothing was clicked and the form is left filled exactly as it is. ' +
          'Do not try to submit another way and do not ask again — call done with status "ready_for_review" so they can look it over themselves.',
      };
    }
    return click('The user approved the submit.');
  }

  /**
   * `request_demo` (CONTRACT-V6 §5.1). Pauses the run, asks the user to perform the
   * action by hand, records it, and saves it against the DETECTED portal.
   *
   * Two things the model is told very plainly on the way back, because getting either
   * wrong undoes the whole feature:
   *   - the action is ALREADY DONE (the user just did it) — do not repeat it;
   *   - the macro is saved for the portal, so next time call run_macro instead.
   */
  /**
   * `request_captcha` — the captcha handoff.
   *
   * This replaced the model calling ask_user with prose like "please check the box and
   * let me know", which rendered as a QUESTION dialog: a text field the user had to type
   * something into before Submit would engage. There is nothing to type about a captcha.
   * Now: the tab comes to the front, the content script scrolls the widget to center and
   * spotlights it, and the panel shows a single Continue button.
   */
  /**
   * Write the application-log record for a finished run. Only outcomes that ARE an
   * application count (storage.APPLICATION_STATUSES): submitted, ready_for_review,
   * already_applied — never blocked or answered.
   */
  async logOutcome(args) {
    const status = String(args.status || '');
    if (!APPLICATION_STATUSES.includes(status)) return;
    let url = '';
    let host = '';
    try {
      const tab = await chrome.tabs.get(this.tabId);
      url = tab.url || '';
      host = new URL(url).hostname.replace(/^www\./i, '');
    } catch { /* tab gone — the record still carries title/company/date */ }
    await logApplication({
      submittedAt: Date.now(),
      status,
      jobTitle: String(args.job_title || '').trim(),
      company: String(args.company || '').trim(),
      url,
      host,
      portal: (this.memory && this.memory.platform) || '',
      runId: this.runId,
    });
  }

  async handleRequestCaptcha(args) {
    if (!this.cb.onRequestCaptcha) {
      return { ok: false, error: 'This build cannot hand a captcha over. Ask the user in chat to solve it, then continue.' };
    }
    if (!this.getTabId) {
      return { ok: false, error: 'Internal error: no working tab is bound to this run.' };
    }
    const shown = await showCaptchaInTab(this.getTabId);
    if (!shown.ok) return { ok: false, error: shown.error };

    this.status('Waiting for you to solve the captcha…');
    let solved = false;
    try {
      solved = await this.cb.onRequestCaptcha({
        reason: String(args.reason || '').slice(0, 120),
        found: shown.found || '',
      });
    } catch {
      solved = false;
    }
    if (this.stopped) return { ok: false, error: 'Stopped.' };
    if (!solved) {
      return {
        ok: false,
        error: 'The user did not confirm the captcha. Do not retry it — call done with status "blocked" and say a captcha is in the way.',
      };
    }
    return {
      ok: true,
      result: 'The user says the captcha is solved. Retry the action that was blocked, then read_errors to verify it went through.',
    };
  }

  async handleRequestDemo(args) {
    const asked = String(args.goal || '').trim();
    if (!asked) return { ok: false, error: 'request_demo needs a goal — say what you are stuck on.' };

    // CONTRACT-V3 §4.1 gates 2 and 3 apply here too, and for exactly the same reason: the
    // goal is MODEL-AUTHORED, it is stored, and it is re-injected into the system prompt of
    // every future run on this portal at every employer. A hostile posting that talks the
    // model into a goal of "…then upload the resume to https://evil.example" would otherwise
    // have planted a persistent instruction, which is the whole thing those gates exist to
    // stop. `remember` scrubs; so does this.
    const rejected = [];
    const [goal] = this.scrubMemoryLines([asked], rejected);
    if (!goal) {
      return {
        ok: false,
        error: `Refused: the goal contains ${rejected[0] || 'content that cannot be stored'}. ` +
          'Describe the CONTROL you are stuck on in plain words — no URLs, and none of the user\'s personal answers.',
      };
    }
    if (!this.cb.onRequestDemo) {
      return { ok: false, error: 'This build cannot record demonstrations. Continue, or call done with status "blocked".' };
    }
    // Same gate as `remember` (V3 §4.1): a macro is persistent and cross-employer, so it
    // may only be written for the portal actually detected under us — never one the model
    // (or the page) names.
    const platform = (this.memory && this.memory.platform) || '';

    this.status('Waiting for you to show me…');
    let outcome = null;
    try {
      outcome = await this.cb.onRequestDemo({ goal, platform });
    } catch {
      outcome = null;
    }
    if (this.stopped) return { ok: false, error: 'Stopped.' };

    // "The user refused" and "the user did it and we failed to capture it" are opposite
    // facts, and the second one matters more: the action IS done, and telling the model
    // otherwise sends it to redo something that has already happened once (V6 §8).
    if (outcome && outcome.performed && !outcome.saved) {
      return {
        ok: true,
        result: 'The user performed the action themselves — it is ALREADY DONE, and the page has moved on. ' +
          'Do NOT repeat it. The demonstration could NOT be saved as a macro' +
          `${outcome.reason ? ` (${outcome.reason})` : ''}, so you will have to manage without it next time. ` +
          'Call read_page to see the new state, then carry on from there.',
      };
    }
    if (!outcome || outcome.cancelled) {
      return {
        ok: false,
        error: 'The user did not record a demonstration. Do not call request_demo for this again — ' +
          'try a different approach, ask the user with ask_user, or call done with status "blocked".',
      };
    }

    await this.reloadMacros(); // a saved macro must be visible to the rest of THIS run

    const saved = outcome.saved
      ? ` It is saved as the macro "${outcome.saved}"${platform ? ` for ${platformLabel(platform)}` : ''}, so next time call run_macro instead of getting stuck.`
      : ' It was not saved, so you will have to manage without it next time.';
    return {
      ok: true,
      result: `The user has performed the action themselves — it is ALREADY DONE, and the page has moved on. ` +
        `Do NOT repeat it.${saved} Call read_page to see the new state, then carry on from there.`,
    };
  }

  /** `run_macro` (CONTRACT-V6 §5.2). Replays a saved demonstration for the detected portal. */
  async handleRunMacro(args) {
    const name = String(args.name || '').trim();
    const platform = (this.memory && this.memory.platform) || '';
    if (!platform) {
      return { ok: false, error: 'No portal is detected on this page, so there are no macros to run.' };
    }
    const macros = await getMacrosFor(platform);
    const macro = macros.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (!macro) {
      const names = macros.map((m) => `"${m.name}"`).join(', ');
      return {
        ok: false,
        error: `No macro named "${name}" for ${platformLabel(platform)}.` +
          (names ? ` Available: ${names}.` : ' There are none — call request_demo to have the user show you.'),
      };
    }
    if (macro.status === 'broken') {
      return {
        ok: false,
        error: `The macro "${macro.name}" is marked broken (${macro.lastError || 'it failed last time'}). ` +
          'Do not run it. Call request_demo to have the user show you again.',
      };
    }

    if (!this.getTabId) {
      // Never reachable from the loop, which installs it before the first tool runs. If it
      // ever is, refuse LOUDLY rather than let the TypeError below be scored as the macro's
      // fault and retire a demonstration that was never given a chance to run.
      return { ok: false, error: 'Internal error: no working tab is bound to this run. Ask the user to start the run again.' };
    }

    this.status(`Running macro "${macro.name}"…`);
    const settings = await getSettings();
    const res = await runMacro(this.getTabId, macro, {
      autoSubmit: Boolean(settings.autoSubmit),
      onSecret: (step) => this.replaySecretStep(macro, step),
    });
    // §7.1: the macro's own verdict is recorded, so a macro that failed is not offered
    // again — but only for failures that say something about the MACRO. A by-design stop
    // (a credential step, or an irreversible step with Auto-submit off) is the macro
    // working correctly, and marking it broken would retire it for doing its job.
    if (!res.byDesign) {
      await markMacroResult(platform, macro.name, res.ok, res.error || '');
    }
    return res.ok ? { ok: true, result: res.result } : { ok: false, error: res.error };
  }

  /**
   * A `request_secret` step inside a macro (CONTRACT-V6 §4). A macro does NOT type
   * credentials: it stops here and hands the field back to the model, which collects it
   * through the ordinary `request_secret` tool. That keeps the credential path to exactly
   * the one CONTRACT-V2 §0 already audited (vault → fillSecret → page), with no second
   * entrance built beside it. A recorded login is still worth having — the macro carries
   * the user to the password field and stops.
   */
  async replaySecretStep(macro, step) {
    return {
      ok: false,
      error: `This step needs the ${step.secretKind || 'credential'} for ${step.label}. ` +
        'Macros never type credentials. Call read_page, then request_secret for that field yourself.',
    };
  }

  /**
   * The `remember` tool (CONTRACT-V3 §4). Writes the portal playbook and/or a site note,
   * then rebuilds the system prompt so the CURRENT run immediately benefits from what it
   * just learned — not only the next one.
   *
   * SECURITY: everything here is model-authored, and a playbook is *persistent* and
   * *cross-employer* — it is re-injected into the system prompt on every future run on
   * that portal, at every company. That makes `remember` the highest-value target on the
   * page: a hostile posting only has to talk the model into writing one poisoned line once.
   * Hence the three gates below (§4.1): the platform must be the DETECTED one, the content
   * may not carry the user's private answers, and it may not carry a URL.
   */
  async handleRemember(args) {
    const detected = (this.memory && this.memory.platform) || '';
    const asked = String(args.platform || '').trim().toLowerCase();

    // GATE 1 — the model does not get to name the portal it is writing to.
    // Without this, a page that is not Workday (any blog, any hostile posting) can have
    // the model call remember(platform:"workday", …) and poison the playbook that then
    // loads at every real Workday employer the user ever applies to.
    if (!detected) {
      // No detected portal means no legitimate target. Honouring `asked` here would leave
      // the whole hole open: a page that is not a job portal at all could still name
      // "workday" and write the playbook that loads at every real Workday employer.
      return {
        ok: false,
        error: 'Refused: no job portal was detected on this page, so there is nothing to write a playbook for. A playbook may only be written while you are actually on the portal it describes.',
      };
    }
    if (asked && asked !== detected) {
      return {
        ok: false,
        error: `Refused: this page was detected as "${detected}", not "${asked}". A playbook may only be written for the portal you are actually on — it is shared across every company that uses that portal.`,
      };
    }
    const platform = detected;
    const host = this.memory.host || '';
    const label = this.memory.label || platformLabel(platform);

    let procedure = Array.isArray(args.procedure) ? args.procedure : undefined;
    let tips = Array.isArray(args.tips) ? args.tips : undefined;
    let siteNotes = Array.isArray(args.site_notes) ? args.site_notes : undefined;

    if (procedure === undefined && tips === undefined && !(siteNotes && siteNotes.length)) {
      return { ok: false, error: 'remember needs at least one of: procedure, tips, site_notes.' };
    }

    // GATES 2 + 3 — scrub the content itself before it can be persisted.
    //
    // An array that scrubs down to EMPTY becomes `undefined`, not `[]`. savePlaybook treats
    // a supplied list as a full REPLACE, so `procedure: []` is not "save nothing" — it is
    // "delete everything this portal knows". A single rejected line alongside one surviving
    // tip was enough to wipe the whole procedure and report the write as a success.
    const rejected = [];
    const wipedOut = [];
    const scrub = (lines, what) => {
      if (lines === undefined) return undefined;
      const kept = this.scrubMemoryLines(lines, rejected);
      if (kept.length) return kept;
      if (lines.length) wipedOut.push(what);
      return undefined;
    };
    procedure = scrub(procedure, 'procedure');
    tips = scrub(tips, 'tips');
    siteNotes = scrub(siteNotes, 'site notes');

    if (!hasAny(procedure) && !hasAny(tips) && !hasAny(siteNotes)) {
      return {
        ok: false,
        error: `Nothing was saved — every line was rejected (${rejected.join('; ')}). A playbook describes how the PORTAL works. It must not contain the user's personal answers or any URL.`,
      };
    }

    // Playbook and site note are saved INDEPENDENTLY: one failing must not be reported as
    // the other failing, and a successful playbook write must not be rolled back in the
    // model's mind because a site note blew up.
    //
    // `persisted` tracks whether ANYTHING actually reached storage. Without it, a call
    // carrying only site_notes that then get refused (aggregator host, unresolved host)
    // would fall through and report "Saved to the Workday playbook — site notes
    // skipped …" — ok:true for a write of zero bytes.
    const parts = [];
    const failures = [];
    let persisted = false;

    if (procedure !== undefined || tips !== undefined) {
      try {
        const saved = await savePlaybook({
          platform,
          label,
          ...(procedure !== undefined ? { procedure } : {}),
          ...(tips !== undefined ? { tips } : {}),
        }, 'agent');
        persisted = true;
        parts.push(`${saved.procedure.length} steps, ${saved.tips.length} tips`);
        // Tell the model what did NOT survive the caps. "14 tips" alone reads as
        // "all of them landed", which is how a saturated playbook quietly stops learning.
        if (saved.dropped.procedure) parts.push(`steps: ${saved.dropped.procedure}`);
        if (saved.dropped.tips) parts.push(`tips: ${saved.dropped.tips}`);
      } catch (err) {
        failures.push(`playbook not saved (${err.message})`);
      }
    }

    if (hasAny(siteNotes)) {
      const siteErr = this.siteNoteRefusal(platform, host);
      if (siteErr) {
        parts.push(`site notes skipped — ${siteErr}`);
      } else {
        try {
          const note = await saveSiteNote(host, platform, siteNotes);
          if (note) persisted = true;
          parts.push(`${note ? note.notes.length : 0} site notes for ${host}`);
          if (note && note.dropped) parts.push(`site notes: ${note.dropped}`);
        } catch (err) {
          failures.push(`site notes not saved (${err.message})`);
        }
      }
    }

    if (!persisted) {
      const why = [...failures, ...parts].join('; ') || 'nothing to write';
      return { ok: false, error: `Nothing was saved — ${why}.` };
    }

    // Reload so the rest of THIS run reads what was just written.
    if (this.memory && this.memory.platform === platform) {
      try { await this.loadMemory({ platform, label, host }); } catch { /* keep the old prompt */ }
    }
    this.emitMemory(true);

    if (rejected.length) parts.push(`rejected: ${rejected.join('; ')}`);
    // Saying "rejected: a line containing a URL" without this reads as "one line was
    // dropped" when in fact the whole list was, and what is stored is still the OLD one.
    if (wipedOut.length) {
      parts.push(`every ${wipedOut.join(' and ')} line was rejected, so the stored ${wipedOut.join(' and ')} ` +
        'was left UNCHANGED — rewrite it without the rejected content if you meant to replace it');
    }
    const tail = failures.length ? ` BUT ${failures.join('; ')}.` : '';
    return { ok: true, result: `Saved to the ${label} playbook — ${parts.join('; ')}.${tail}` };
  }

  /**
   * Drop lines a playbook must never carry, and say why. Playbooks are persistent and
   * shared across every employer on a portal, so two classes of content are refused:
   *
   *  - The user's private answers (salary, work authorization, notice period, saved
   *    screening answers). Those are in the model's context legitimately, which is exactly
   *    why prose alone cannot be the only thing stopping them being copied into a
   *    cross-employer playbook. Saved answers already have a home: profile.savedAnswers.
   *  - URLs. A playbook describes portal mechanics; it never needs to send the agent to an
   *    address. A single persisted "…then upload the resume at https://evil.example" would
   *    fire on every future application on that portal, long after the page that planted
   *    it is gone. `navigate` accepts any absolute URL, so this is the cheap structural cut.
   */
  scrubMemoryLines(lines, rejected) {
    const profile = (this.promptInputs && this.promptInputs.profile) || {};
    const secrets = [
      profile.salary, profile.workAuth, profile.noticePeriod,
      // The address and the voluntary self-identification answers belong to the person,
      // not to the portal — and a playbook is shown at every employer on that portal.
      profile.addressLine1, profile.addressLine2, profile.postalCode,
      profile.gender, profile.ethnicity, profile.veteranStatus, profile.disabilityStatus,
      ...((Array.isArray(profile.savedAnswers) ? profile.savedAnswers : []).map((a) => a && a.a)),
    ]
      .map((v) => String(v || '').trim())
      .filter((v) => v.length >= 4); // shorter than this and a substring match is just noise

    const out = [];
    for (const raw of lines) {
      const line = String(raw ?? '');
      if (URL_IN_TEXT.test(line)) {
        rejected.push('a line containing a URL');
        continue;
      }
      const hay = line.toLowerCase();
      if (secrets.some((s) => hay.includes(s.toLowerCase()))) {
        rejected.push('a line containing the user\'s personal answers');
        continue;
      }
      out.push(line);
    }
    return out;
  }

  /**
   * Why a site note must not be written, or '' when it may be.
   *
   * A site note is keyed on the TOP frame's host, which is right when the ATS owns the
   * page or sits in an iframe. It is wrong on an aggregator: a LinkedIn Easy Apply never
   * leaves linkedin.com, so a note "learned" at company A would be keyed to `linkedin.com`
   * and then shown on every future Easy Apply at every unrelated company — the exact
   * portal-vs-employer confusion this whole feature exists to avoid.
   */
  siteNoteRefusal(platform, host) {
    if (!host) return 'no host could be resolved for this page';
    const entry = PLATFORMS.find((p) => p.key === platform);
    if (entry && entry.rank < 10) {
      return `${entry.label} is an aggregator, so this host is not one employer — put portal-level lessons in tips instead`;
    }
    return '';
  }

  status(text) {
    this.cb.onStatus(text);
  }
}

/**
 * Shrink the conversation on its way to the provider so small-context models survive long
 * runs (§8). Three passes, in this order:
 *
 *   1. SUPERSEDE — every read_page inventory except the newest becomes a one-line marker,
 *      at ANY age. A read → act → read → verify loop otherwise parks three near-identical
 *      page dumps inside KEEP_RECENT, and on a multi-frame portal each one is thousands of
 *      tokens. Only the newest is even true: the older ones list refs the page has since
 *      re-rendered, so this removes tokens and stale refs in the same move.
 *   2. TRUNCATE — old bulky tool results, unchanged from before.
 *   3. COLLAPSE — long string arguments in OLD assistant tool calls. This pass used to be
 *      missing entirely: pruning rewrote `role: 'tool'` and nothing else, so every argument
 *      the model ever sent stayed in the history verbatim and forever. Forty-eight steps of
 *      dom_act is ~33k tokens that nothing could ever shrink.
 *
 * Pure — `messages` is the runner's live history and is never mutated.
 *
 * Exported for the harness: the balance rule it has to preserve (every assistant tool_call
 * keeps a matching tool message) is the kind of thing that breaks silently and then gets
 * every subsequent request rejected outright.
 */
export function pruneMessages(messages) {
  // tool messages carry a toolCallId but not the tool's NAME, so recover it from the
  // assistant turn that made the call.
  const nameOf = new Map();
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.toolCalls)) {
      for (const tc of m.toolCalls) nameOf.set(tc.id, tc.name);
    }
  }
  const isInventory = (m, i) =>
    m.role === 'tool' &&
    nameOf.get(m.toolCallId) === 'read_page' &&
    typeof m.content === 'string' &&
    // Small results are change-reports ("No changes since the last read"), which are a
    // record of what an action did rather than an inventory that a later read replaces —
    // and swapping one for the marker would make the message LONGER, not shorter.
    m.content.length > PRUNE_OVER;

  let newestRead = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isInventory(messages[i], i)) { newestRead = i; break; }
  }

  const cutoff = messages.length - KEEP_RECENT;
  return messages.map((m, i) => {
    if (m.role === 'tool') {
      if (i !== newestRead && isInventory(m, i)) return { ...m, content: SUPERSEDED };
      if (i < cutoff && typeof m.content === 'string' && m.content.length > PRUNE_OVER) {
        return { ...m, content: m.content.slice(0, PRUNE_TO) + PRUNE_SUFFIX };
      }
      return m;
    }
    if (i < cutoff && m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
      return { ...m, toolCalls: m.toolCalls.map(collapseArgs) };
    }
    return m;
  });
}

/**
 * One tool call with its long string arguments cut down, still valid JSON.
 *
 * The Anthropic path parses argsJson back into an object (llm.js safeJson) and swallows a
 * parse failure as `{}` — so truncating this as a plain string would turn a tool call the
 * model made into one with no arguments at all, silently. Parse, collapse, re-stringify;
 * anything that will not parse is left exactly as it was.
 */
function collapseArgs(tc) {
  if (!tc || typeof tc.argsJson !== 'string' || tc.argsJson.length <= PRUNE_ARG_OVER) return tc;
  let parsed;
  try { parsed = JSON.parse(tc.argsJson); } catch { return tc; }
  return { ...tc, argsJson: JSON.stringify(collapseValue(parsed)) };
}

/** Recursive: a dom_act batch hides its long values in args.actions[].value. */
function collapseValue(v) {
  if (typeof v === 'string') {
    return v.length > PRUNE_ARG_OVER ? `${v.slice(0, PRUNE_ARG_TO)}…[cut]` : v;
  }
  if (Array.isArray(v)) return v.map(collapseValue);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = collapseValue(val);
    return out;
  }
  return v;
}

function hasAny(lines) {
  return Array.isArray(lines) && lines.length > 0;
}

/**
 * "1. … 2. … 3. …" crammed into one question, taken apart into the questions it is.
 *
 * Told to batch, a model will often batch into the STRING instead of into the array:
 * one box holding six numbered questions, ending in a helpful "you can answer like:
 * 1. Senior Engineer 2. Acme 3. Yes". That is worse than not batching at all. The user
 * gets one box and has to hand-number their reply, and — the part that actually costs
 * them — the whole blob is saved to the profile as ONE savedAnswers row keyed on all six
 * questions at once. Next application words it slightly differently, nothing matches,
 * and they are asked all six again. "It asks me the same things every time" is this.
 *
 * Conservative on purpose: the run must start at 1 and count up by one, so prose that
 * merely contains a digit and a full stop is left alone.
 *
 * @returns {string[]|null} the questions, or null when this is genuinely one question.
 */
export function splitEnumerated(text) {
  const marks = [];
  // A marker is a small number followed by . ) or : — at the start, or after whitespace
  // or an opening bracket, so "v1.2" and "Rs.1,20,000" cannot open an item.
  const re = /(?:^|[\s(])(\d{1,2})\s*[.):]\s+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    marks.push({ n: Number(m[1]), from: m.index + m[0].length, mark: m.index + m[0].indexOf(m[1]) });
    re.lastIndex = m.index + m[0].length; // overlapping runs must not skip a marker
  }
  // The longest run that starts at 1 and ascends. Anything else is prose.
  const start = marks.findIndex((x) => x.n === 1);
  if (start < 0) return null;
  const run = [marks[start]];
  for (let i = start + 1; i < marks.length && marks[i].n === run[run.length - 1].n + 1; i++) run.push(marks[i]);
  if (run.length < 2) return null;

  const out = [];
  for (let i = 0; i < run.length; i++) {
    const end = i + 1 < run.length ? run[i + 1].mark : text.length;
    out.push(text.slice(run[i].from, end).trim());
  }
  // The model's own worked example rides on the last item ("You can answer like: …") and
  // would otherwise become part of the last question's label.
  const last = out.length - 1;
  out[last] = out[last]
    .replace(/\s*(?:you\s+can\s+answer|answer\s+(?:like|as|in)|reply\s+(?:like|with)|respond\s+(?:like|with)|format\s+your\s+answer)\b[\s\S]*$/i, '')
    .trim();

  const clean = out.map((s) => s.replace(/^[-–—:,\s]+/, '').trim()).filter(Boolean);
  return clean.length >= 2 ? clean : null;
}

/**
 * ask_user args → one list of {question, options, long}, whichever shape the model used.
 *
 * Both shapes stay legal because models mix them, and a rejected ask_user costs the user
 * a whole extra round-trip to be told off. Blank questions are dropped rather than shown:
 * an unlabelled box is a box nobody can answer.
 *
 * @returns {{questions:object[], dropped:number, unpacked:number}} `unpacked` counts the
 *   questions that arrived crammed into one string and had to be taken apart — the model
 *   is told, so it stops doing it for the rest of the run.
 */
export function normalizeQuestions(args) {
  const raw = Array.isArray(args.questions) && args.questions.length
    ? args.questions
    : (args.question ? [{ question: args.question, options: args.options }] : []);
  const questions = [];
  let dropped = 0;
  let unpacked = 0;
  for (const q of raw) {
    // A bare string in `questions` is a shape the model reaches for often enough to accept.
    let text = String((q && typeof q === 'object' ? q.question : q) || '').trim();
    if (!text) continue;

    // One box holding several questions is taken apart into one box each. Only when the
    // model offered no options for it: an option list belongs to a single question, and
    // splitting would attach the same choices to every part.
    const opts0 = (q && typeof q === 'object' && Array.isArray(q.options)) ? q.options : [];
    if (!opts0.length) {
      const parts = splitEnumerated(text);
      if (parts) {
        for (const part of parts) {
          if (questions.length >= MAX_QUESTIONS) { dropped++; continue; }
          questions.push({ question: part, options: undefined, long: false });
          unpacked++;
        }
        continue;
      }
    }
    // Over the cap the question is COUNTED, not silently discarded — the model is told
    // in the tool result, so it can ask for the rest instead of assuming all were shown.
    if (questions.length >= MAX_QUESTIONS) { dropped++; continue; }
    const opts = (q && typeof q === 'object' && Array.isArray(q.options))
      ? q.options.map((o) => String(o)).filter(Boolean) : [];
    questions.push({
      question: text,
      options: opts.length ? opts : undefined,
      long: Boolean(q && typeof q === 'object' && q.long),
    });
  }
  return { questions, dropped, unpacked };
}

/**
 * The tool result for an answered ask_user.
 *
 * Every question is echoed next to its answer: with several boxes in one form, "User
 * answered: 6" cannot be matched back to the question that earned it. A blank is stated
 * as a decision — otherwise it reads as an oversight and the model asks it again, which
 * is the whole thing this batching exists to stop.
 */
export function formatAnswers(asked, answers, dropped = 0, unpacked = 0) {
  let tail = dropped > 0
    ? `\nThe other ${dropped} question(s) were NOT shown to the user — only ${MAX_QUESTIONS} fit in one form. Ask for those in a second ask_user call.`
    : '';
  // Correct it in the run, not just in the prompt. A model that numbered its questions into
  // one string will keep doing it on the next page unless it is told what happened.
  if (unpacked > 1) {
    tail += `\nNOTE: you put ${unpacked} questions inside ONE question string. JobPilot split them into ` +
      `${unpacked} separate boxes and saved each answer under its own question, which is the only way ` +
      'they can be reused on the next application. Pass questions:[{question:"…"},{question:"…"}] — one ' +
      'entry per question, never numbered inside one string.';
  }
  if (asked.length === 1) {
    const only = String(answers[0] ?? '').trim();
    return (only
      ? `User answered: "${only}"`
      : 'User left the question blank — treat it as "no answer given", do not ask again.') + tail;
  }
  const lines = ['User answered:'];
  const blanks = [];
  asked.forEach((q, i) => {
    const a = String(answers[i] ?? '').trim();
    lines.push(`${i + 1}. ${q.question} → ${a ? `"${a}"` : '(left blank)'}`);
    if (!a) blanks.push(i + 1);
  });
  if (blanks.length) {
    lines.push(
      `Blank (${blanks.join(', ')}) means the user chose not to answer: leave that field empty or use the ` +
      'form\'s skip/decline option, and do NOT ask again.'
    );
  }
  return lines.join('\n') + tail;
}

function parseArgs(argsJson) {
  try {
    const v = JSON.parse(argsJson);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

function isAbort(err) {
  return err && (err.name === 'AbortError' || /aborted/i.test(err.message || ''));
}
