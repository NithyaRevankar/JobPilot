// ============================================================================
//  DEAD CODE. NOTHING LOADS THIS FILE. DO NOT EDIT IT TO FIX A BUG.
//
//  Superseded by sidepanel/react/. panel.html mounts sidepanel/react/main.jsx and
//  imports nothing from here; the only remaining reference to this file anywhere in
//  the repo is the `panel.js:NNNN` line citations in the React sources.
//
//  That is why it is still here: those citations are the map from each React
//  component back to the code it replaced, and they only resolve while the file
//  does. It is a REFERENCE, not a fallback — there is no build in which it runs.
//
//  Editing it changes nothing the user sees. The live equivalents are:
//      panel.js chat / transcript / agent wiring  ->  react/views/ChatView.jsx
//      panel.js profile editor + documents        ->  react/views/ProfileView.jsx
//      panel.js memory bank                       ->  react/views/MemoryView.jsx
//      panel.js vault screen                      ->  react/views/VaultView.jsx
//      panel.js settings + danger zone            ->  react/views/SettingsView.jsx
//      panel.js showToast                         ->  react/components/Toast.jsx
//      panel.js renderMarkdown / icon             ->  react/components/{Markdown,Icon}.jsx
//      panel.js renderStats                       ->  react/components/StatsBar.jsx
//      panel.js module-level state                ->  react/state/store.jsx
//
//  Delete it once nothing cites it. `git show ccb146a:sidepanel/js/panel.js` is the
//  last commit in which it was live.
// ============================================================================

// panel.js — UI controller (contract §10). Entry module: tabs, chat rendering,
// AgentRunner wiring, profile editor, settings editor. All DOM built via
// createElement/textContent — no innerHTML of untrusted strings.

import { AgentRunner } from './agent.js';
import { listModels, testConnection } from './llm.js';
import {
  getSettings, saveSettings, getProfile, saveProfile,
  answerKey, mergeSavedAnswers,
  getDocuments, saveDocument, deleteDocument, setDefaultDocument,
  getChats, saveChats, clearChats, clearAllData,
  getPlaybooks, savePlaybook, deletePlaybook, resetPlaybook,
  getSiteNotes, deleteSiteNote,
  getMacros, getMacrosFor, saveMacro, deleteMacro,
} from './storage.js';
import { startRecording, stopRecording, bindStepsToProfile } from './tools.js';
import { PLATFORMS, detectPlatform, clearDetectionCache } from './platforms.js';
import { seedFor } from './playbook-seeds.js';
import {
  SessionStats, modelInfo, formatTokens, formatCost, formatRate, formatDuration,
} from './stats.js';
import { openAsk, openConfirm, closeAllModals } from './modal.js';
import { extractDocumentText } from './doctext.js';
import * as vault from './vault.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------- state

let settings = null;
let profile = null;
let uiMessages = [];            // persisted chat records (cap enforced in storage.js)
let runner = null;
let running = false;
let stopRequested = false;     // set by Stop; lets multi-modal flows bail between prompts
let currentAssistant = null;    // {el, record} streaming bubble
let currentActivity = null;     // {el, record, stepEl, stepRecord} open tool card
let pillState = 'unconfigured'; // 'ready' | 'working' | 'error' | 'unconfigured'

// Memory bank (CONTRACT-V3 §6) + session stats.
let playbooks = [];
let siteNotes = [];
let macros = [];            // CONTRACT-V6 — recorded demonstrations, per portal
let openPlaybooks = new Set();  // which rows are expanded — survives a re-render
let detection = null;           // last detectPlatform() for the target tab
const stats = new SessionStats();

const MAX_DOC_BYTES = 8 * 1024 * 1024;

// ----------------------------------------------------------------- helpers

function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

function showToast(text, variant = '') {
  const el = document.createElement('div');
  el.className = `toast ${variant}`.trim();
  el.textContent = text;
  $('toast-container').appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 220);
  }, 2500);
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = {
  gear: [
    { tag: 'circle', cx: '10', cy: '10', r: '2.4', fill: 'none', 'stroke-width': '1.5' },
    { tag: 'path', d: 'M10 3.2v2M10 14.8v2M3.2 10h2M14.8 10h2M5.2 5.2l1.4 1.4M13.4 13.4l1.4 1.4M14.8 5.2l-1.4 1.4M6.6 13.4l-1.4 1.4', fill: 'none', 'stroke-width': '1.5', 'stroke-linecap': 'round' },
  ],
  question: [
    { tag: 'circle', cx: '10', cy: '10', r: '8', fill: 'none', 'stroke-width': '1.5' },
    { tag: 'path', d: 'M7.8 7.7a2.3 2.3 0 1 1 3.3 2.1c-.7.3-1.1.8-1.1 1.5v.3', fill: 'none', 'stroke-width': '1.5', 'stroke-linecap': 'round' },
    { tag: 'circle', cx: '10', cy: '14.3', r: '0.9', fill: 'currentColor', stroke: 'none' },
  ],
  file: [
    { tag: 'path', d: 'M5.5 2.5h6l3.5 3.5v11.5h-9.5Z', fill: 'none', 'stroke-width': '1.5', 'stroke-linejoin': 'round' },
    { tag: 'path', d: 'M11.5 2.5v3.5h3.5', fill: 'none', 'stroke-width': '1.5', 'stroke-linejoin': 'round' },
  ],
  star: [
    { tag: 'path', d: 'M10 2.5l2.3 4.7 5.2.8-3.8 3.6.9 5.2L10 14.3l-4.6 2.5.9-5.2-3.8-3.6 5.2-.8Z', fill: 'none', 'stroke-width': '1.4', 'stroke-linejoin': 'round' },
  ],
  trash: [
    { tag: 'path', d: 'M4 5.5h12M8 5.5V3.8h4v1.7M6 5.5l.8 11h6.4l.8-11', fill: 'none', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
    { tag: 'path', d: 'M8.5 8.5v5M11.5 8.5v5', fill: 'none', 'stroke-width': '1.4', 'stroke-linecap': 'round' },
  ],
  lock: [
    { tag: 'rect', x: '4.5', y: '9', width: '11', height: '8', rx: '1.6', fill: 'none', 'stroke-width': '1.5' },
    { tag: 'path', d: 'M7 9V6.6a3 3 0 0 1 6 0V9', fill: 'none', 'stroke-width': '1.5', 'stroke-linecap': 'round' },
  ],
  caret: [
    { tag: 'path', d: 'M6 8.5 10 12.5 14 8.5', fill: 'none', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' },
  ],
  brain: [
    { tag: 'path', d: 'M5 4.5h8.5a1.5 1.5 0 0 1 1.5 1.5v10.5H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5z', fill: 'none', 'stroke-width': '1.5', 'stroke-linejoin': 'round' },
    { tag: 'path', d: 'M7 8h5M7 11h5', fill: 'none', 'stroke-width': '1.5', 'stroke-linecap': 'round' },
  ],
};

/** Hostname, `www.` stripped — matches how platforms.js keys a detection. */
function hostOfUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

/** "3m ago" / "2d ago" — for playbook last-updated stamps. */
function relativeTime(ts) {
  const secs = Math.max(0, (Date.now() - Number(ts || 0)) / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(Number(ts)).toLocaleDateString();
}

function icon(name, size = 14) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  for (const spec of ICON_PATHS[name]) {
    const { tag, ...attrs } = spec;
    const el = document.createElementNS(SVG_NS, tag);
    if (!attrs.stroke) el.setAttribute('stroke', 'currentColor');
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.appendChild(el);
  }
  return svg;
}

// ------------------------------------------------------ safe mini-markdown

// Supports **bold**, *italic*, `code`, fenced blocks, [t](url), line breaks.
// Builds DOM nodes only; never assigns untrusted strings to innerHTML.
function renderMarkdown(text) {
  const frag = document.createDocumentFragment();
  const parts = String(text).split(/```/);
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      // Fenced code block; first line may be a language tag — drop it.
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = part.replace(/^[\w-]*\n/, '').replace(/\n$/, '');
      pre.appendChild(code);
      frag.appendChild(pre);
    } else if (part) {
      for (const para of part.split(/\n{2,}/)) {
        if (!para.trim()) continue;
        const p = document.createElement('p');
        const lines = para.split('\n');
        lines.forEach((line, li) => {
          if (li > 0) p.appendChild(document.createElement('br'));
          appendInline(p, line);
        });
        frag.appendChild(p);
      }
    }
  });
  return frag;
}

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

function appendInline(parent, text) {
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    if (m[1]) {
      const code = document.createElement('code');
      code.textContent = m[1].slice(1, -1);
      parent.appendChild(code);
    } else if (m[2]) {
      const b = document.createElement('strong');
      b.textContent = m[2].slice(2, -2);
      parent.appendChild(b);
    } else if (m[3]) {
      const em = document.createElement('em');
      em.textContent = m[3].slice(1, -1);
      parent.appendChild(em);
    } else {
      const a = document.createElement('a');
      a.textContent = m[4];
      a.href = m[5];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      parent.appendChild(a);
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

// -------------------------------------------------------------- status pill

function setPill(state, label) {
  pillState = state;
  const pill = $('status-pill');
  pill.className = `status-pill status-${state}`;
  $('status-text').textContent = label;
}

function refreshPill() {
  if (running) { setPill('working', 'Working…'); return; }
  if (pillState === 'error') return; // sticky until next action clears it
  if (isConfigured()) setPill('ready', 'Ready');
  else setPill('unconfigured', 'Not configured');
}

function isConfigured() {
  if (!settings || !settings.baseUrl || !settings.model) return false;
  // Key-less local servers (Ollama, LM Studio) are valid on the OpenAI path.
  if (settings.provider === 'anthropic' && !settings.apiKey) return false;
  return true;
}

// ---------------------------------------------------------------- tabs

function switchTab(view) {
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
  $(`view-${view}`).classList.add('active');
  if (view === 'chat') refreshTargetTab();
  if (view === 'vault') refreshVaultView();
  if (view === 'memory') refreshMemoryView();
}

// -------------------------------------------------------- chat persistence

const persistChats = debounce(() => {
  saveChats(uiMessages).catch((err) => showToast(`Could not save chat: ${err.message}`, 'error'));
}, 300);

// ------------------------------------------------------------ chat scroll

function isNearBottom() {
  const list = $('message-list');
  return list.scrollTop + list.clientHeight >= list.scrollHeight - 48;
}

function appendToList(el) {
  const list = $('message-list');
  const stick = isNearBottom();
  list.appendChild(el);
  if (stick) list.scrollTop = list.scrollHeight;
}

function scrollIfSticky() {
  const list = $('message-list');
  if (isNearBottom()) list.scrollTop = list.scrollHeight;
}

function updateEmptyState() {
  $('empty-state').hidden = uiMessages.length > 0;
}

// -------------------------------------------------------- chat: rendering

function renderUserMessage(record) {
  const el = document.createElement('div');
  el.className = 'msg msg-user';
  el.textContent = record.text;
  appendToList(el);
}

function addUserMessage(text) {
  const record = { type: 'user', text };
  uiMessages.push(record);
  renderUserMessage(record);
  updateEmptyState();
  persistChats();
}

function renderAssistantBubble(record, streaming) {
  const el = document.createElement('div');
  el.className = 'msg msg-assistant' + (streaming ? ' streaming' : '');
  if (!streaming) el.appendChild(renderMarkdown(record.text));
  appendToList(el);
  return el;
}

function ensureStreamingBubble() {
  if (currentAssistant) return currentAssistant;
  closeActivityCard();
  const record = { type: 'assistant', text: '' };
  uiMessages.push(record);
  const el = renderAssistantBubble(record, true);
  currentAssistant = { el, record };
  updateEmptyState();
  return currentAssistant;
}

function appendAssistantText(delta) {
  const cur = ensureStreamingBubble();
  cur.record.text += delta;
  cur.el.textContent = cur.record.text; // fast path while streaming
  scrollIfSticky();
  persistChats();
}

function finalizeAssistantBubble() {
  if (!currentAssistant) return;
  const { el, record } = currentAssistant;
  el.classList.remove('streaming');
  if (record.text.trim()) {
    el.textContent = '';
    el.appendChild(renderMarkdown(record.text));
  } else {
    // Model produced no visible text this iteration — drop the empty bubble.
    el.remove();
    const idx = uiMessages.indexOf(record);
    if (idx >= 0) uiMessages.splice(idx, 1);
  }
  currentAssistant = null;
  persistChats();
}

// ---------------------------------------------------- chat: activity cards

function renderActivityCard(record) {
  const el = document.createElement('div');
  el.className = 'activity-card';
  for (const step of record.steps) {
    el.appendChild(renderToolStep(step, false));
  }
  appendToList(el);
  return el;
}

function renderToolStep(stepRecord, live) {
  const details = document.createElement('details');
  details.className = 'tool-step';
  const summary = document.createElement('summary');

  const gear = icon('gear', 13);
  gear.classList.add('gear');
  summary.appendChild(gear);

  const label = document.createElement('span');
  label.className = 'tool-label';
  label.textContent = stepRecord.label;
  summary.appendChild(label);

  const outcome = document.createElement('span');
  outcome.className = 'tool-outcome';
  summary.appendChild(outcome);
  details.appendChild(summary);

  if (live) {
    details.classList.add('running');
    outcome.textContent = '…';
  } else {
    applyStepOutcome(details, stepRecord);
  }
  return details;
}

function applyStepOutcome(stepEl, stepRecord) {
  stepEl.classList.remove('running');
  // `ok` is null for a step that was still in flight when the panel closed — the run ended
  // without an outcome, so there is nothing to report either way. Painting that as a red ✗
  // told the user an action had FAILED when it may well have completed on the page, which
  // is the CONTRACT-V3 §7.1 lie in its other direction.
  if (stepRecord.ok == null) {
    stepEl.classList.add('unknown');
    stepEl.querySelector('.tool-outcome').textContent = '–';
    stepEl.querySelector('.tool-label').textContent =
      `${stepRecord.label} — outcome unknown (the panel closed while this was running)`;
    return;
  }
  stepEl.classList.add(stepRecord.ok ? 'ok' : 'fail');
  stepEl.querySelector('.tool-outcome').textContent = stepRecord.ok ? '✓' : '✗';
  if (!stepRecord.ok) {
    const label = stepEl.querySelector('.tool-label');
    label.textContent = `${stepRecord.label} — ${String(stepRecord.result).slice(0, 80)}`;
  }
  if (stepRecord.result) {
    const detail = document.createElement('div');
    detail.className = 'tool-detail';
    detail.textContent = stepRecord.result;
    stepEl.appendChild(detail);
  }
}

function ensureActivityCard() {
  finalizeAssistantBubble();
  if (currentActivity) return currentActivity;
  const record = { type: 'activity', steps: [] };
  uiMessages.push(record);
  const el = document.createElement('div');
  el.className = 'activity-card';
  appendToList(el);
  currentActivity = { el, record, stepEl: null, stepRecord: null };
  updateEmptyState();
  return currentActivity;
}

/**
 * A step whose activity card was closed while it was still running.
 *
 * request_secret closes the card to put its modal up, and the tool's REAL outcome — the
 * user declined, or fillSecret was refused by the page — arrives afterwards. Without this,
 * onToolEnd found no currentActivity and dropped that outcome on the floor, so a failed
 * credential fill was left on screen as whatever the card said before the modal opened.
 */
let orphanStep = null;

function closeActivityCard() {
  if (currentActivity && currentActivity.stepRecord) {
    orphanStep = { el: currentActivity.stepEl, record: currentActivity.stepRecord };
  }
  currentActivity = null;
}

/**
 * The run is over and a step never reported. Settle it as unknown rather than leaving the
 * spinner turning: an outcome that is still arriving and one that never will look
 * identical on screen otherwise, and only one of them is worth waiting for. Its `ok` stays
 * null, so a reload renders it the same way.
 */
function settleOrphanStep() {
  if (!orphanStep) return;
  applyStepOutcome(orphanStep.el, orphanStep.record);
  orphanStep = null;
}

function onToolStart({ name, label }) {
  const card = ensureActivityCard();
  const stepRecord = { name, label, ok: null, result: '' };
  card.record.steps.push(stepRecord);
  card.stepRecord = stepRecord;
  card.stepEl = renderToolStep(stepRecord, true);
  card.el.appendChild(card.stepEl);
  scrollIfSticky();
  persistChats();
}

function onToolEnd({ ok, result }) {
  const target = (currentActivity && currentActivity.stepRecord)
    ? { el: currentActivity.stepEl, record: currentActivity.stepRecord }
    : orphanStep;
  if (!target || !target.record) return;
  orphanStep = null;
  target.record.ok = ok;
  target.record.result = result;
  applyStepOutcome(target.el, target.record);
  if (currentActivity) {
    currentActivity.stepEl = null;
    currentActivity.stepRecord = null;
  }
  scrollIfSticky();
  persistChats();
}

// ------------------------------------------------------------ chat: notices

const DONE_LABELS = {
  submitted: { text: 'Application submitted', variant: 'notice-ok' },
  ready_for_review: { text: 'Ready for your review', variant: 'notice-ok' },
  blocked: { text: 'Blocked', variant: 'notice-error' },
  answered: { text: 'Done', variant: '' },
};

function renderNotice(record) {
  const el = document.createElement('div');
  el.className = `msg-notice ${record.variant || ''}`.trim();
  el.textContent = record.text;
  appendToList(el);
}

function addNotice(text, variant = '') {
  const record = { type: 'notice', text, variant };
  uiMessages.push(record);
  renderNotice(record);
  updateEmptyState();
  persistChats();
}

// -------------------------------------------------------- chat: secret record

// A masked record only — never carries the value. `{type:'secret', kind, host}`
// renders as "🔒 Provided password for cisco.com" and round-trips through
// persistChats() with nothing sensitive in it.
const SECRET_KIND_NOUN = {
  password: 'password', username: 'username', otp: 'one-time code', other: 'value',
};

function renderSecret(record) {
  const el = document.createElement('div');
  el.className = 'msg-secret';
  const lock = icon('lock', 13);
  lock.classList.add('secret-lock');
  el.appendChild(lock);
  const span = document.createElement('span');
  const noun = SECRET_KIND_NOUN[record.kind] || 'value';
  span.textContent = record.host ? `Provided ${noun} for ${record.host}` : `Provided ${noun}`;
  el.appendChild(span);
  appendToList(el);
  return el;
}

function addSecretRecord(kind, host) {
  const record = { type: 'secret', kind, host: host || '' };
  uiMessages.push(record);
  renderSecret(record);
  updateEmptyState();
  persistChats();
}

// ------------------------------------------------------ chat: question card

// A live question is a modal now (see onAskUser). This renderer stays ONLY to
// paint already-answered questions in the restored transcript / after the modal
// resolves — never an interactive card.
function renderQuestionCard(record) {
  const card = document.createElement('div');
  card.className = 'question-card answered';

  const title = document.createElement('div');
  title.className = 'question-title';
  title.appendChild(icon('question', 16));
  const qText = document.createElement('span');
  qText.textContent = record.question;
  title.appendChild(qText);
  card.appendChild(title);

  const note = document.createElement('div');
  note.className = 'question-answer-note';
  note.textContent = record.answer != null ? `You answered: ${record.answer}` : 'Not answered.';
  card.appendChild(note);
  appendToList(card);
  return card;
}

// `saved` is what stops the New Chat sweep from overruling the user: false means the
// save box was there and they cleared it. Undefined (an older record) stays sweepable.
function recordQuestion(question, options, answer, saved) {
  const record = { type: 'question', question, options: options || null, answer: answer ?? null };
  if (saved !== undefined) record.saved = Boolean(saved);
  uiMessages.push(record);
  renderQuestionCard(record);
  updateEmptyState();
  persistChats();
}

// ------------------------------------------------------- the attention chime
// CONTRACT-V6 §6. A run that stops to ask is a run doing nothing until the user
// notices. Synthesized, not a bundled asset: no new permission, no file, works
// offline. Only ever for a stop that WAITS ON A HUMAN — a chime on ordinary
// progress is noise the user learns to ignore, which defeats the point.

let audioCtx = null;

function chime() {
  if (!settings || !settings.soundOnPrompt) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const now = audioCtx.currentTime;
    // Two rising notes — distinct from a system alert, and short enough not to nag.
    [[880, 0], [1174.7, 0.14]].forEach(([freq, at]) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, now + at);
      gain.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.22);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + at);
      osc.stop(now + at + 0.24);
    });
  } catch {
    // Audio is a nicety. It must never take a run down.
  }
}

// ------------------------------------------------------ show-me-how (V6 §1)

/**
 * The agent is stuck. Pause, let the user do it by hand, watch, save it for the portal.
 *
 * The modal lives in the SIDE PANEL, so it never blocks the page — the user works in the
 * tab while it is open, which is the whole point. The recording is NOT replayed here: the
 * user just performed the action, and replaying it would perform it twice (and the step
 * they demonstrated may well have been "Submit application").
 */
async function onRequestDemo({ goal, platform }) {
  finalizeAssistantBubble();
  if (currentActivity && currentActivity.stepRecord) onToolEnd({ ok: true, result: goal });
  closeActivityCard();
  chime();

  const start = await openConfirm({
    title: 'JobPilot is stuck — show it how?',
    message: `${goal}\n\nClick "Show me how", then do it yourself in the page. JobPilot will watch and remember it for next time.`,
    okLabel: 'Show me how',
  });
  if (!start) {
    addNotice('You skipped the demonstration.');
    return { cancelled: true };
  }

  const tabId = await getTabIdForRun();
  const started = await startRecording(tabId);
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
    const tab = await chrome.tabs.get(tabId);
    watching = new URL(tab.url || '').hostname || '';
  } catch { /* the tab went away; the dialog just omits the name */ }

  // The panel is the only thing that owns a recording, so it has to keep saying so: the
  // worker ends the session when this heartbeat stops (CONTRACT-V6 §6). A wall-clock
  // deadline would have been simpler and wrong — it would kill a demonstration that merely
  // waits on an OTP or a slow upload. Take as long as you like; just don't close the panel.
  const beat = setInterval(
    () => { chrome.runtime.sendMessage({ kind: 'jobpilot:rec-alive' }).catch(() => {}); },
    30_000);
  const abandon = () => { chrome.runtime.sendMessage({ kind: 'jobpilot:rec-close' }).catch(() => {}); };
  window.addEventListener('pagehide', abandon);

  $('run-status').textContent = 'Recording — do it in the page, then click Done.';
  const done = await openConfirm({
    title: 'Recording…',
    message: `Go to the page and perform the action yourself — take as long as you need. ` +
      `Passwords are never recorded. When you are finished, click Done.\n\n` +
      `Watching ${watching ? watching : 'the target tab'}${armedFrames > 1 ? ` (${armedFrames} frames)` : ''}. ` +
      'Anything you do in a different tab is not recorded.',
    okLabel: 'Done',
  });
  clearInterval(beat);
  window.removeEventListener('pagehide', abandon);

  const { ok, steps, dropped, lost, refused, refusedHosts, expired, tabs, host, frameHosts, error } =
    await stopRecording(tabId);
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

  const review = await openAsk({
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
    refreshMemoryView();
    return { cancelled: false, saved: macro.name };
  } catch (err) {
    addNotice(`Could not save the demonstration: ${err.message || err}`);
    return { cancelled: false, saved: null, performed: true, reason: `saving failed: ${err.message || err}` };
  }
}

function suggestMacroName(goal) {
  const words = String(goal || 'demonstration').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(/\s+/);
  return words.slice(0, 5).join(' ') || 'demonstration';
}

function platformName(platform) {
  const p = PLATFORMS.find((x) => x.key === platform);
  return p ? p.label : platform;
}

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
async function onAskUser(questions) {
  const asked = Array.isArray(questions) ? questions : [];
  if (!asked.length) return null;
  const single = asked.length === 1;

  chime();
  finalizeAssistantBubble();
  // Settle the activity row now — the modal replaces the old inline card, and the
  // spinner would otherwise run forever once the modal closes.
  if (currentActivity && currentActivity.stepRecord) {
    onToolEnd({ ok: true, result: asked.map((q) => q.question).join(' · ') });
  }
  closeActivityCard();

  const saveOption = (settings && settings.saveAnswers)
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

  const result = await openAsk({
    title: single ? 'JobPilot needs an answer' : `JobPilot needs ${asked.length} answers`,
    message: single
      ? asked[0].question
      : 'Fill in what you can — anything left blank is treated as "no answer", not as a reason to ask again.',
    // Quick replies belong to the single-question form only; in a batch each question
    // renders its own picker (see modal.js).
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
}

// §6.2 onRequestSecret — the ONLY place a secret is collected in the panel. The
// value returned here goes straight back to agent.js → fillSecret. It is NEVER
// written into uiMessages / persistChats — only a masked {type:'secret'} record.
async function onRequestSecret({ kind, label, host, topHost, crossFrame, ref }) {
  chime();
  finalizeAssistantBubble();
  // NOT onToolEnd. Marking this ✓ here closed the step before the user had answered, and
  // the tool's real verdict — declined, or a fill the page refused — then had nowhere to
  // land. Say what is true right now (we are waiting) and let the real outcome finish it;
  // closeActivityCard hands the step to `orphanStep` so it still can.
  if (currentActivity && currentActivity.stepEl && currentActivity.stepRecord) {
    const labelEl = currentActivity.stepEl.querySelector('.tool-label');
    if (labelEl) labelEl.textContent = `${currentActivity.stepRecord.label} — waiting for you…`;
  }
  closeActivityCard();

  const isOtp = kind === 'otp';
  const noun = SECRET_KIND_NOUN[kind] || 'credential';

  // 1. Locked vault → offer to unlock first (OTP never touches the vault).
  //    Stop can fire while that modal is open; don't march on to a second prompt.
  if (!isOtp) await maybeUnlockVault();
  if (stopRequested) return null;

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
  const alwaysConfirm = !(settings && settings.alwaysConfirmCredentials === false);
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
  const result = await openAsk({
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
}

/**
 * Save answers one row at a time, replacing rather than appending when the same
 * question comes back (the merge itself lives in storage.js and is unit-tested there).
 */
async function saveAnswersToProfile(pairs) {
  const incoming = Array.isArray(pairs) ? pairs.filter((p) => p && p.q && p.a) : [];
  if (!incoming.length) return;
  try {
    const { list, added, updated, skipped, evicted } = mergeSavedAnswers(profile.savedAnswers, incoming);
    profile.savedAnswers = list;
    await saveProfile(profile);
    renderSavedAnswers();
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
}

// --------------------------------------------------------------- memory tab
//
// Playbooks are keyed by PORTAL, not employer (CONTRACT-V3 §0). Rows follow the
// renderSavedAnswers pattern — full re-render, createElement + textContent, no innerHTML.

async function refreshMemoryView() {
  try {
    [playbooks, siteNotes, macros] = await Promise.all([getPlaybooks(), getSiteNotes(), getMacros()]);
  } catch (err) {
    showToast(`Could not load playbooks: ${err.message}`, 'error');
    return;
  }
  renderMemoryList();
  renderSiteNotes();
  renderMacros();
}

// CONTRACT-V6 §7.5 — the demonstrations the user recorded, per portal. Visible and
// deletable: a macro that replays a wrong action must be easy to get rid of.
function renderMacros() {
  const section = $('mem-macros-section');
  const wrap = $('mem-macros-list');
  if (!section || !wrap) return;
  section.hidden = macros.length === 0;
  wrap.textContent = '';

  for (const macro of macros) {
    const row = document.createElement('div');
    row.className = 'mem-note-row';

    const main = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'mem-note-host';
    title.textContent = `${macro.name} — ${platformName(macro.platform)}`;
    main.appendChild(title);

    const sub = document.createElement('div');
    sub.className = 'mem-sub';
    const state = macro.status === 'broken'
      ? `broken: ${macro.lastError || 'it failed last time'}`
      : macro.status === 'working' ? `worked ${macro.useCount}×` : 'not replayed yet';
    sub.textContent = `${macro.steps.length} step${macro.steps.length === 1 ? '' : 's'} · ${state}`;
    main.appendChild(sub);

    const list = document.createElement('ul');
    list.className = 'mem-note-list';
    for (const step of macro.steps) {
      const li = document.createElement('li');
      li.textContent = step.label;
      list.appendChild(li);
    }
    main.appendChild(list);
    row.appendChild(main);

    const del = document.createElement('button');
    del.className = 'answer-delete';
    del.title = `Delete the macro "${macro.name}"`;
    del.appendChild(icon('trash', 14));
    del.addEventListener('click', async () => {
      try {
        await deleteMacro(macro.platform, macro.name);
        showToast('Macro deleted', 'success');
        await refreshMemoryView();
      } catch (err) {
        showToast(`Could not delete: ${err.message}`, 'error');
      }
    });
    row.appendChild(del);
    wrap.appendChild(row);
  }
}

function renderMemoryList() {
  const wrap = $('mem-list');
  if (!wrap) return;
  wrap.textContent = '';
  $('mem-empty').hidden = playbooks.length > 0;
  for (const pb of playbooks) wrap.appendChild(renderPlaybookRow(pb));
}

function renderPlaybookRow(pb) {
  const row = document.createElement('div');
  row.className = 'mem-row';
  const isOpen = openPlaybooks.has(pb.platform);
  if (isOpen) row.classList.add('open');

  // --- head (click to expand)
  const head = document.createElement('button');
  head.className = 'mem-row-head';
  head.setAttribute('aria-expanded', String(isOpen));

  const titleWrap = document.createElement('div');
  const title = document.createElement('div');
  title.className = 'mem-title';
  const name = document.createElement('span');
  name.className = 'mem-name';
  name.textContent = pb.label;
  title.appendChild(name);

  const badge = document.createElement('span');
  const kind = pb.source === 'builtin' ? 'builtin' : (pb.source === 'learned' ? 'learned' : 'user');
  badge.className = `mem-badge mem-badge-${kind}`;
  badge.textContent = pb.source === 'builtin' ? 'built-in' : (pb.source === 'learned' ? 'learned' : 'edited');
  title.appendChild(badge);
  titleWrap.appendChild(title);

  const sub = document.createElement('div');
  sub.className = 'mem-sub';
  sub.textContent = memorySubtitle(pb);
  titleWrap.appendChild(sub);
  head.appendChild(titleWrap);

  const caret = document.createElement('span');
  caret.className = 'mem-caret';
  caret.appendChild(icon('caret', 12));
  head.appendChild(caret);
  row.appendChild(head);

  // --- body (textareas + actions)
  const body = document.createElement('div');
  body.className = 'mem-body';
  body.hidden = !isOpen;

  const procField = textareaField(
    'Procedure', pb.procedure.join('\n'),
    'One step per line, in order. Max 15.'
  );
  const tipsField = textareaField(
    'Tips', pb.tips.join('\n'),
    'One per line: selectors, control labels, traps. Max 20.'
  );
  body.appendChild(procField.wrap);
  body.appendChild(tipsField.wrap);

  const actions = document.createElement('div');
  actions.className = 'mem-actions';

  const save = document.createElement('button');
  save.className = 'btn-primary btn-small';
  save.textContent = 'Save';
  save.addEventListener('click', async () => {
    try {
      await savePlaybook({
        platform: pb.platform,
        label: pb.label,
        // A hand-edit REPLACES tips wholesale. savePlaybook merges tips by design (so the
        // agent can add one without restating the rest), which would make deleting a line
        // in this textarea silently impossible. Clearing first is what makes the edit honest.
        procedure: splitLines(procField.input.value),
        tips: [],
      }, 'user');
      await savePlaybook({ platform: pb.platform, tips: splitLines(tipsField.input.value) }, 'user');
      showToast(`${pb.label} playbook saved`, 'success');
      await refreshMemoryView();
      refreshPortalChip();
    } catch (err) {
      showToast(`Could not save: ${err.message}`, 'error');
    }
  });
  actions.appendChild(save);

  if (seedFor(pb.platform)) {
    const reset = document.createElement('button');
    reset.className = 'btn-ghost btn-small';
    reset.textContent = 'Reset to default';
    reset.addEventListener('click', async () => {
      const ok = await openConfirm({
        title: `Reset the ${pb.label} playbook?`,
        message: 'This restores the shipped version and discards everything you and the agent have learned for this portal.',
        okLabel: 'Reset',
        danger: true,
      });
      if (!ok) return;
      try {
        await resetPlaybook(pb.platform);
        showToast(`${pb.label} reset to default`, 'success');
        await refreshMemoryView();
      } catch (err) {
        showToast(`Could not reset: ${err.message}`, 'error');
      }
    });
    actions.appendChild(reset);
  }

  const del = document.createElement('button');
  del.className = 'btn-link';
  del.textContent = 'Delete';
  del.addEventListener('click', async () => {
    const ok = await openConfirm({
      title: `Delete the ${pb.label} playbook?`,
      message: 'The agent will have to work this portal out from scratch on the next application.',
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deletePlaybook(pb.platform);
      openPlaybooks.delete(pb.platform);
      showToast(`${pb.label} playbook deleted`, 'success');
      await refreshMemoryView();
      refreshPortalChip();
    } catch (err) {
      showToast(`Could not delete: ${err.message}`, 'error');
    }
  });
  actions.appendChild(del);
  body.appendChild(actions);
  row.appendChild(body);

  head.addEventListener('click', () => {
    const nowOpen = !openPlaybooks.has(pb.platform);
    if (nowOpen) openPlaybooks.add(pb.platform);
    else openPlaybooks.delete(pb.platform);
    row.classList.toggle('open', nowOpen);
    head.setAttribute('aria-expanded', String(nowOpen));
    body.hidden = !nowOpen;
  });

  return row;
}

function memorySubtitle(pb) {
  const bits = [`${pb.procedure.length} steps`, `${pb.tips.length} tips`];
  if (pb.useCount > 0) bits.push(`used ${pb.useCount}×`);
  if (pb.updatedAt && pb.source !== 'builtin') bits.push(relativeTime(pb.updatedAt));
  return bits.join(' · ');
}

function textareaField(label, value, hint) {
  const wrap = document.createElement('label');
  wrap.className = 'mem-field';
  const span = document.createElement('span');
  span.textContent = label;
  wrap.appendChild(span);
  const input = document.createElement('textarea');
  input.className = 'textarea';
  input.value = value;
  wrap.appendChild(input);
  if (hint) {
    const h = document.createElement('div');
    h.className = 'mem-hint';
    h.textContent = hint;
    wrap.appendChild(h);
  }
  return { wrap, input };
}

function splitLines(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

function renderSiteNotes() {
  const section = $('mem-notes-section');
  const wrap = $('mem-notes-list');
  if (!section || !wrap) return;
  section.hidden = siteNotes.length === 0;
  wrap.textContent = '';
  $('mem-notes-empty').hidden = siteNotes.length > 0;

  for (const note of siteNotes) {
    const row = document.createElement('div');
    row.className = 'mem-note-row';

    const main = document.createElement('div');
    const host = document.createElement('div');
    host.className = 'mem-note-host';
    host.textContent = note.host;
    main.appendChild(host);

    const list = document.createElement('ul');
    list.className = 'mem-note-list';
    for (const n of note.notes) {
      const li = document.createElement('li');
      li.textContent = n;
      list.appendChild(li);
    }
    main.appendChild(list);
    row.appendChild(main);

    const del = document.createElement('button');
    del.className = 'answer-delete';
    del.title = `Delete the notes for ${note.host}`;
    del.appendChild(icon('trash', 14));
    del.addEventListener('click', async () => {
      try {
        await deleteSiteNote(note.host);
        showToast('Company notes deleted', 'success');
        await refreshMemoryView();
      } catch (err) {
        showToast(`Could not delete: ${err.message}`, 'error');
      }
    });
    row.appendChild(del);

    wrap.appendChild(row);
  }
}

function wireMemory() {
  const chip = $('portal-chip');
  if (chip) {
    chip.addEventListener('click', () => {
      if (detection && detection.platform) openPlaybooks.add(detection.platform);
      switchTab('memory');
    });
  }

  const add = $('mem-add');
  if (!add) return;
  add.addEventListener('click', async () => {
    const known = PLATFORMS.map((p) => p.label);
    const res = await openAsk({
      title: 'Add a portal playbook',
      message: 'Which job portal is this for? Playbooks are shared across every company using that portal.',
      fields: [
        { name: 'platform', label: 'Portal', type: 'text', required: true, placeholder: known.slice(0, 4).join(', ') + '…' },
      ],
      submitLabel: 'Create',
    });
    if (!res || res.action !== 'submit') return;

    const typed = String(res.values.platform || '').trim();
    if (!typed) return;
    // Accept either the label ("Workday") or the key ("workday").
    const match = PLATFORMS.find(
      (p) => p.key === typed.toLowerCase() || p.label.toLowerCase() === typed.toLowerCase()
    );
    const key = match ? match.key : typed.toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!key) return;
    if (playbooks.some((p) => p.platform === key)) {
      showToast('That portal already has a playbook', 'error');
      openPlaybooks.add(key);
      await refreshMemoryView();
      return;
    }

    try {
      await savePlaybook({
        platform: key,
        label: match ? match.label : typed,
        procedure: [],
        tips: [],
      }, 'user');
      openPlaybooks.add(key);
      await refreshMemoryView();
      showToast(`${match ? match.label : typed} playbook created — add the steps`, 'success');
    } catch (err) {
      showToast(`Could not create the playbook: ${err.message}`, 'error');
    }
  });
}

// ------------------------------------------------------------- portal chip

// refreshPortalChip is called, unawaited, from the 4s tab timer, from onMemory on every
// agent step, from init, and from the Memory tab's save/delete handlers — so several can
// be in flight at once, each doing its own async detect → storage lookup. Without a
// generation guard, a slow older call can resolve last and paint "no playbook yet" over
// the fresh "playbook ✓" the user was just told about. Only the newest call may render.
let chipGeneration = 0;

/** Detect the portal for the target tab and reflect it in the chat header (§6.3). */
async function refreshPortalChip() {
  const chip = $('portal-chip');
  if (!chip) return;
  const gen = ++chipGeneration;
  const stale = () => gen !== chipGeneration;

  let tab;
  try {
    tab = await resolveTargetTab();
  } catch {
    tab = null;
  }
  if (stale()) return;
  if (!tab || !tab.id) { chip.hidden = true; return; }

  let found = null;
  try {
    found = await detectPlatform(tab.id);
  } catch {
    found = null;
  }
  if (stale()) return;

  detection = found;

  if (found && found.error) {
    // Detection could not run (blocked probe, restricted origin). Say so — otherwise a
    // permanently broken detector is indistinguishable from an ordinary page, and the user
    // just quietly never gets a playbook with no way to know why.
    chip.textContent = '';
    const dot = document.createElement('span');
    dot.className = 'portal-dot';
    chip.appendChild(dot);
    const text = document.createElement('span');
    text.textContent = 'Portal detection unavailable on this page';
    chip.appendChild(text);
    chip.classList.add('cold');
    chip.hidden = false;
    return;
  }

  if (!found || !found.platform) {
    chip.hidden = true;
    return;
  }

  // Read straight from storage rather than the cached `playbooks` array: the agent may
  // have written one via `remember` since the Memory tab was last rendered.
  let pb = null;
  try {
    const all = await getPlaybooks();
    pb = all.find((p) => p.platform === found.platform) || null;
  } catch { pb = null; }
  if (stale()) return;

  const has = Boolean(pb && (pb.procedure.length || pb.tips.length));

  chip.textContent = '';
  const dot = document.createElement('span');
  dot.className = 'portal-dot';
  chip.appendChild(dot);
  const text = document.createElement('span');
  text.textContent = has
    ? `${found.label} · playbook ✓${pb.useCount ? ` (used ${pb.useCount}×)` : ''}`
    : `${found.label} · no playbook yet — the agent will write one`;
  chip.appendChild(text);
  chip.classList.toggle('cold', !has);
  chip.hidden = false;
}

// ------------------------------------------------------------- session stats

function renderStats() {
  const bar = $('stats-bar');
  if (!bar) return;
  // Nothing measured yet — an empty stats bar is just noise.
  if (stats.requests === 0 && !stats.streaming) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;

  const info = modelInfo(settings && settings.model, settings || {});
  const frac = stats.contextFraction(info);

  const fill = $('stats-ctx-fill');
  const ctx = $('stats-ctx');
  if (frac == null) {
    fill.style.width = '0%';
    fill.className = 'ctx-fill';
    ctx.textContent = stats.contextTokens ? formatTokens(stats.contextTokens) : '—';
  } else {
    const pct = Math.round(frac * 100);
    fill.style.width = `${Math.max(2, pct)}%`;
    fill.className = `ctx-fill${frac >= 0.9 ? ' danger' : frac >= 0.7 ? ' warn' : ''}`;
    ctx.textContent = `${formatTokens(stats.contextTokens)}/${formatTokens(info.context)}`;
  }

  $('stats-rate').textContent = formatRate(stats.streaming ? stats.liveTokensPerSec : stats.avgTokensPerSec);
  // "~" whenever a rate had to be substituted or a count was estimated. A number the user
  // reads as exact, when it isn't, is the failure mode this whole module is built against.
  const costPrefix = (stats.costApprox || stats.estimated) ? '~' : '';
  $('stats-cost').textContent = stats.costKnown ? costPrefix + formatCost(stats.cost) : '—';

  // detail
  $('sd-context').textContent = frac == null
    ? formatTokens(stats.contextTokens)
    : `${formatTokens(stats.contextTokens)} / ${formatTokens(info.context)} (${Math.round(frac * 100)}%)`;
  $('sd-model').textContent = (settings && settings.model) || '—';
  $('sd-input').textContent = formatTokens(stats.inputTokens);
  $('sd-output').textContent = formatTokens(stats.outputTokens);
  $('sd-requests').textContent = String(stats.requests);
  $('sd-avg').textContent = formatRate(stats.avgTokensPerSec);
  $('sd-elapsed').textContent = formatDuration(Date.now() - stats.startedAt);
  $('sd-cost').textContent = stats.costKnown ? costPrefix + formatCost(stats.cost) : 'unknown';

  // Say plainly when a number is a guess rather than a measurement.
  const notes = [];
  if (!stats.costKnown) {
    notes.push(`No price known for "${(settings && settings.model) || 'this model'}". Set Input/Output $/1M in Settings to see cost.`);
  }
  if (info.context == null) {
    notes.push('Context window unknown for this model — set it in Settings to see how full it is.');
  }
  if (stats.estimated) {
    notes.push('Your endpoint did not report token usage, so some counts are estimated from text length (~4 chars/token).');
  }
  if (stats.costApprox) {
    notes.push('This model returned cached tokens but has no known cache price, so they are billed here at the full input rate — the real cost is likely lower.');
  }
  const note = $('sd-note');
  note.textContent = notes.join(' ');
  note.hidden = notes.length === 0;
}

function wireStats() {
  const summary = $('stats-summary');
  const detail = $('stats-detail');
  if (summary && detail) {
    summary.addEventListener('click', () => {
      const open = detail.hidden;
      detail.hidden = !open;
      summary.setAttribute('aria-expanded', String(open));
      if (open) renderStats();
    });
  }
  const reset = $('stats-reset');
  if (reset) {
    reset.addEventListener('click', () => {
      stats.reset();
      renderStats();
      showToast('Session stats reset', 'success');
    });
  }
}

// ---------------------------------------------------------------- vault tab

// Every vault call is guarded: the panel must work when the vault module is
// uninitialized, locked, or missing DOM. isUnlocked() is synchronous per §3.
function vaultUnlocked() {
  try { return vault.isUnlocked(); } catch { return false; }
}

function normalizeHost(input) {
  return String(input || '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

// §6.2 step 1 — a locked vault gets an unlock modal before we look up a value.
// Cancelling (or a wrong passphrase) falls through to a manual prompt; it never
// fails the run.
async function maybeUnlockVault() {
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
    else refreshVaultView();
  } catch { /* fall through to a manual prompt */ }
}

async function refreshVaultView() {
  const setup = $('vault-setup');
  const locked = $('vault-locked');
  const unlocked = $('vault-unlocked');
  if (!setup || !locked || !unlocked) return; // vault UI not present yet — guard
  let state = 'uninitialized';
  try { state = await vault.getState(); } catch { state = 'uninitialized'; }
  setup.hidden = state !== 'uninitialized';
  locked.hidden = state !== 'locked';
  unlocked.hidden = state !== 'unlocked';
  if (state === 'unlocked') {
    await renderVaultList();
    return;
  }
  // Locking has to EMPTY the list, not just hide it. Hiding leaves every decrypted entry
  // alive in the DOM and in the event-handler closures bound to those rows, so "locked"
  // meant locked to the eye while the plaintext sat one devtools inspection away — the
  // opposite of what vault.lock() spends effort on when it drops the key.
  const list = $('vlt-list');
  if (list) list.replaceChildren();
}

async function renderVaultList() {
  const list = $('vlt-list');
  if (!list) return;
  let entries = [];
  try { entries = await vault.listEntries(); } catch { entries = []; }
  list.textContent = '';
  const empty = $('vlt-empty');
  if (empty) empty.hidden = entries.length > 0;
  for (const entry of entries) list.appendChild(renderVaultRow(entry));
}

function renderVaultRow(entry) {
  const row = document.createElement('div');
  row.className = 'vault-row';

  const meta = document.createElement('div');
  meta.className = 'vault-meta';
  const host = document.createElement('div');
  host.className = 'vault-host';
  host.textContent = entry.label || entry.host;
  const sub = document.createElement('div');
  sub.className = 'vault-sub';
  sub.textContent = entry.username ? `${entry.host} · ${entry.username}` : entry.host;
  meta.appendChild(host);
  meta.appendChild(sub);
  row.appendChild(meta);

  const dots = document.createElement('span');
  dots.className = 'vault-dots';
  dots.textContent = '••••••••';
  row.appendChild(dots);

  // Reveal auto-re-hides after 15 s (§6.2). Revealed text lives only in this DOM
  // node — it never touches uiMessages / persistChats.
  let hideTimer = null;
  const hide = () => {
    clearTimeout(hideTimer);
    dots.textContent = '••••••••';
    dots.classList.remove('shown');
    reveal.textContent = 'Reveal';
  };
  const reveal = document.createElement('button');
  reveal.className = 'vault-reveal';
  reveal.textContent = 'Reveal';
  reveal.addEventListener('click', () => {
    if (dots.classList.contains('shown')) { hide(); return; }
    dots.textContent = entry.password || '';
    dots.classList.add('shown');
    reveal.textContent = 'Hide';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, 15000);
  });
  row.appendChild(reveal);

  const copy = document.createElement('button');
  copy.className = 'vault-copy';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(entry.password || '');
      showToast('Password copied', 'success');
    } catch {
      showToast('Could not copy — clipboard is blocked', 'error');
    }
  });
  row.appendChild(copy);

  const edit = document.createElement('button');
  edit.className = 'vault-edit';
  edit.textContent = 'Edit';
  edit.addEventListener('click', () => editVaultEntry(entry));
  row.appendChild(edit);

  return row;
}

function vaultEntryFields(entry) {
  return [
    { name: 'host', label: 'Site (host)', type: 'text', placeholder: 'cisco.com', value: entry ? entry.host : undefined, required: true },
    { name: 'label', label: 'Label', type: 'text', value: entry ? (entry.label || '') : undefined },
    { name: 'username', label: 'Username', type: 'text', value: entry ? (entry.username || '') : undefined },
    { name: 'password', label: 'Password', type: 'password', secret: true, value: entry ? (entry.password || '') : undefined },
    { name: 'notes', label: 'Notes', type: 'textarea', value: entry ? (entry.notes || '') : undefined },
  ];
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
      okLabel: 'Delete', danger: true,
    });
    if (!ok) return;
    try { await vault.deleteEntry(entry.id); showToast('Credential deleted', 'success'); }
    catch (err) { showToast(`Could not delete: ${err.message}`, 'error'); }
    await renderVaultList();
    return;
  }
  await upsertFromForm(res.values, entry);
}

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
  await renderVaultList();
}

/**
 * Show or clear a vault error.
 *
 * The two <p class="vault-error"> elements ship with the `hidden` attribute and nothing
 * ever removed it, so every setup and unlock failure — wrong passphrase, mismatched
 * confirmation, a crypto error — was written into an element the user could not see. The
 * form simply appeared to do nothing.
 */
function setVaultError(el, message) {
  if (!el) return;
  el.textContent = message || '';
  el.hidden = !message;
}

async function handleVaultSetup(protect) {
  const err = $('vlt-setup-error');
  setVaultError(err, '');
  let passphrase = null;
  if (protect) {
    const p1 = $('vlt-setup-pass') ? $('vlt-setup-pass').value : '';
    const p2 = $('vlt-setup-pass2') ? $('vlt-setup-pass2').value : '';
    if (!p1) { setVaultError(err, 'Enter a passphrase, or choose “Skip”.'); return; }
    if (p1 !== p2) { setVaultError(err, 'The passphrases do not match.'); return; }
    passphrase = p1;
  }
  try {
    await vault.initialize(passphrase);
    if ($('vlt-setup-pass')) $('vlt-setup-pass').value = '';
    if ($('vlt-setup-pass2')) $('vlt-setup-pass2').value = '';
    try { vault.setAutoLockMinutes(vaultAutoLockSetting()); } catch { /* not ready */ }
    await refreshVaultView();
    showToast(protect ? 'Vault created' : 'Vault created (no passphrase)', 'success');
  } catch (e) {
    setVaultError(err, `Could not create the vault: ${e.message}`);
  }
}

async function handleVaultUnlock() {
  const err = $('vlt-unlock-error');
  setVaultError(err, '');
  const pass = $('vlt-unlock-pass') ? $('vlt-unlock-pass').value : '';
  try {
    const ok = await vault.unlock(pass);
    if (!ok) { setVaultError(err, 'Wrong passphrase. Try again.'); return; }
    if ($('vlt-unlock-pass')) $('vlt-unlock-pass').value = '';
    await refreshVaultView();
  } catch (e) {
    setVaultError(err, `Could not unlock: ${e.message}`);
  }
}

async function handleVaultForgot() {
  const ok = await openConfirm({
    title: 'Reset the vault?',
    message: 'This permanently deletes every saved credential and cannot be undone.',
    okLabel: 'Delete everything', danger: true,
  });
  if (!ok) return;
  try {
    await vault.resetVault();
    await refreshVaultView();
    showToast('Vault reset', 'success');
  } catch (e) {
    showToast(`Could not reset vault: ${e.message}`, 'error');
  }
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
    await refreshVaultView();
  } catch (e) {
    showToast(`Could not change passphrase: ${e.message}`, 'error');
  }
}

function wireVault() {
  const on = (id, ev, fn) => { const el = $(id); if (el) el.addEventListener(ev, fn); };
  on('vlt-setup-save', 'click', () => handleVaultSetup(true));
  on('vlt-setup-skip', 'click', () => handleVaultSetup(false));
  on('vlt-unlock-btn', 'click', handleVaultUnlock);
  on('vlt-unlock-pass', 'keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === 'Enter') { e.preventDefault(); handleVaultUnlock(); }
  });
  on('vlt-forgot', 'click', handleVaultForgot);
  on('vlt-add', 'click', addVaultEntry);
  on('vlt-lock', 'click', async () => { try { vault.lock(); } catch { /* nothing to lock */ } await refreshVaultView(); });
  on('vlt-change-pass', 'click', handleChangePassphrase);
  try { vault.onLockChange(() => { refreshVaultView(); }); } catch { /* module not ready */ }
}

// Defer auto-lock on real interaction. One delegated listener per event, throttled
// to ≤1 call/sec so we never spam vault.touch() (§6.2).
function wireVaultTouch() {
  let last = 0;
  const touch = () => {
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    try { vault.touch(); } catch { /* vault not ready */ }
  };
  document.addEventListener('click', touch, true);
  document.addEventListener('keydown', touch, true);
}

// ----------------------------------------------------------- target tab

let displayedTabId = null;

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

async function getTabIdForRun() {
  const tab = await resolveTargetTab();
  if (!tab) {
    throw new Error('No target tab found. Open the job page in a normal browser tab, then try again.');
  }
  return tab.id;
}

async function refreshTargetTab() {
  try {
    const tab = await resolveTargetTab();
    const titleEl = $('target-title');
    const favEl = $('target-favicon');
    if (!tab) {
      titleEl.textContent = 'No target tab';
      favEl.hidden = true;
      displayedTabId = null;
      $('portal-chip').hidden = true;
      return;
    }
    // Re-detect only when the tab actually changed. This runs on a 4s timer, and
    // detectPlatform caches on tabId+URL — but skipping the call entirely keeps the
    // common idle case free.
    const tabChanged = displayedTabId !== tab.id;
    displayedTabId = tab.id;
    titleEl.textContent = `Acting on: ${tab.title || tab.url || 'Untitled'}`;
    if (tabChanged || !detection || detection.host !== hostOfUrl(tab.url)) refreshPortalChip();
    if (tab.favIconUrl && /^https?:/.test(tab.favIconUrl)) {
      favEl.src = tab.favIconUrl;
      favEl.hidden = false;
    } else {
      favEl.hidden = true;
    }
  } catch {
    // tabs API hiccup — leave the previous value; next tick will retry.
  }
}

// -------------------------------------------------------------- run lifecycle

function setRunning(on) {
  running = on;
  if (on) stopRequested = false;
  $('composer').classList.toggle('hidden', on);
  $('run-strip').hidden = !on;
  if (on) {
    setPill('working', 'Working…');
  } else {
    $('run-status').textContent = 'Working…';
    refreshPill();
  }
}

function makeRunner() {
  return new AgentRunner({
    getTabId: getTabIdForRun,
    callbacks: {
      onText: (delta) => {
        appendAssistantText(delta);
        // Live tokens/sec: estimated from characters, because the provider does not send
        // a token count until the stream ends. endStream replaces it with the exact rate.
        stats.onDelta(delta);
        renderStats();
      },
      onToolStart,
      onToolEnd,
      onStreamStart: () => { stats.beginStream(); renderStats(); },
      onStreamEnd: () => {
        // Fires in agent.js's finally, so it runs on abort too. If onUsage already landed,
        // stats.streaming is false and this is a no-op; if the user pressed Stop, no usage
        // event was ever emitted and this is what stops the HUD showing a frozen live rate
        // forever and silently losing that request's tokens.
        stats.abandonStream();
        renderStats();
      },
      onUsage: (usage) => {
        stats.endStream(usage, modelInfo(settings && settings.model, settings || {}));
        renderStats();
      },
      onMemory: ({ label, saved }) => {
        // The chip is the standing indicator of which playbook is live; a notice fires
        // only when the agent actually WROTE something, which is the event worth calling out.
        refreshPortalChip();
        if (saved) {
          addNotice(`Updated the ${label} playbook — the next application on ${label} will use it.`, 'notice-ok');
          if ($('view-memory').classList.contains('active')) refreshMemoryView();
        }
      },
      onAskUser,
      onRequestSecret,
      onRequestDemo,
      onStatus: (text) => {
        $('run-status').textContent = text || 'Working…';
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
  });
}

async function handleSend() {
  const input = $('composer-input');
  const text = input.value.trim();
  if (!text || running) return;

  if (!isConfigured()) {
    showToast('Configure your LLM in Settings first', 'error');
    switchTab('settings');
    return;
  }

  input.value = '';
  autoGrow(input);
  $('btn-send').disabled = true;
  pillState = 'ready'; // clear a sticky error state on new activity

  addUserMessage(text);
  setRunning(true);
  try {
    await runner.run(text);
  } finally {
    finalizeAssistantBubble();
    closeActivityCard();
    settleOrphanStep();
    setRunning(false);
  }
}

function handleStop() {
  // Resolve any open modal (ask_user, request_secret, unlock…) with null so the
  // agent's pending await settles and the run halts cleanly.
  stopRequested = true;
  closeAllModals();
  runner.stop();
  $('run-status').textContent = 'Stopping…';
}

async function handleNewChat({ carryAnswers = true } = {}) {
  if (running) handleStop();
  // The answers you gave in THIS chat travel to the next one. New Chat throws away the
  // message history, and an answer that lived only in that history was gone with it —
  // so the next chat asked the same question again. Anything answered here and not yet
  // in the profile is carried over first (the profile is what every future run's system
  // prompt is built from), skipping only the ones whose save box was deliberately cleared.
  if (carryAnswers) await carryAnswersToProfile();
  runner.reset();
  runner = makeRunner();
  uiMessages = [];
  const list = $('message-list');
  for (const child of [...list.children]) {
    if (child.id !== 'empty-state') child.remove();
  }
  currentAssistant = null;
  currentActivity = null;
  updateEmptyState();
  try {
    await clearChats();
  } catch (err) {
    showToast(`Could not clear stored chat: ${err.message}`, 'error');
  }
  showToast('New chat started', 'success');
}

/** Sweep this chat's answered questions into the profile before the transcript goes. */
async function carryAnswersToProfile() {
  if (!settings || !settings.saveAnswers) return; // the user turned answer-keeping off
  // Keyed, so a question answered twice in one chat carries over ONCE — and as the
  // later answer, which is the correction the user went back and made.
  const byKey = new Map();
  for (const rec of uiMessages) {
    if (!rec || rec.type !== 'question' || rec.saved === false) continue;
    const q = String(rec.question || '').trim();
    const a = String(rec.answer || '').trim();
    if (!q || !a) continue;
    byKey.set(answerKey(q), { q, a });
  }
  if (byKey.size) await saveAnswersToProfile([...byKey.values()]);
}

// ------------------------------------------------------------ chat restore

function restoreChat(records) {
  uiMessages = Array.isArray(records) ? records : [];
  for (const rec of uiMessages) {
    if (rec.type === 'user') renderUserMessage(rec);
    else if (rec.type === 'assistant') renderAssistantBubble(rec, false);
    else if (rec.type === 'activity') renderActivityCard(rec);
    else if (rec.type === 'question') renderQuestionCard(rec);
    else if (rec.type === 'notice') renderNotice(rec);
    else if (rec.type === 'secret') renderSecret(rec);
  }
  updateEmptyState();
  const list = $('message-list');
  list.scrollTop = list.scrollHeight;
}

// ---------------------------------------------------------------- composer

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
}

function wireComposer() {
  const input = $('composer-input');
  const send = $('btn-send');
  input.addEventListener('input', () => {
    autoGrow(input);
    send.disabled = !input.value.trim();
  });
  input.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return; // IME composition commit
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  });
  send.addEventListener('click', handleSend);
  $('btn-stop').addEventListener('click', handleStop);
  // Wrapped, not passed directly: the click event would land in handleNewChat's options.
  $('btn-new-chat').addEventListener('click', () => handleNewChat());
  $('btn-goto-settings').addEventListener('click', () => switchTab('settings'));
  $('btn-goto-profile').addEventListener('click', () => switchTab('profile'));
}

// ---------------------------------------------------------------- profile

const PROFILE_FIELD_IDS = [
  'fullName', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio',
  'addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'country',
  'currentTitle', 'currentCompany', 'yearsExperience',
  'workAuth', 'sponsorshipNeeded', 'salary', 'noticePeriod',
  'gender', 'pronouns', 'ethnicity', 'veteranStatus', 'disabilityStatus',
  'resumeText', 'extraContext',
];

const persistProfile = debounce(async () => {
  try {
    await saveProfile(profile);
    showToast('Saved ✓', 'success');
  } catch (err) {
    showToast(`Could not save profile: ${err.message}`, 'error');
  }
}, 400);

function wireProfileFields() {
  for (const key of PROFILE_FIELD_IDS) {
    const el = $(`pf-${key}`);
    el.value = profile[key] || '';
    el.addEventListener('input', () => {
      profile[key] = el.value;
      persistProfile();
    });
  }
}

// -- documents

async function renderDocuments() {
  let docs;
  try {
    docs = await getDocuments();
  } catch (err) {
    showToast(`Could not load documents: ${err.message}`, 'error');
    return;
  }
  const list = $('doc-list');
  list.textContent = '';
  for (const doc of docs) {
    const row = document.createElement('div');
    row.className = 'doc-row';

    const fileIcon = icon('file', 18);
    fileIcon.classList.add('doc-icon');
    row.appendChild(fileIcon);

    const meta = document.createElement('div');
    meta.className = 'doc-meta';
    const name = document.createElement('div');
    name.className = 'doc-name';
    name.textContent = doc.name;
    const size = document.createElement('div');
    size.className = 'doc-size';
    // Whether the agent can READ this, not just attach it. The old row said only the file
    // size, so a resume whose text JobPilot could not extract looked identical to one it
    // had understood — and the user found out only by being asked their job title again.
    const readable = doc.text
      ? `text read (${doc.text.length.toLocaleString()} chars)`
      : `text NOT read — ${doc.textError || 'paste it into Resume text below'}`;
    size.textContent = `${formatSize(doc.size)}${doc.isDefault ? ' · default' : ''} · ${readable}`;
    if (!doc.text) size.classList.add('doc-warn');
    meta.appendChild(name);
    meta.appendChild(size);
    row.appendChild(meta);

    const star = document.createElement('button');
    star.className = 'doc-star' + (doc.isDefault ? ' active' : '');
    star.title = doc.isDefault ? 'Default document' : 'Make default';
    const starIcon = icon('star', 15);
    if (doc.isDefault) starIcon.querySelector('path').setAttribute('fill', 'currentColor');
    star.appendChild(starIcon);
    star.addEventListener('click', async () => {
      try {
        await setDefaultDocument(doc.id);
        renderDocuments();
      } catch (err) {
        showToast(`Could not set default: ${err.message}`, 'error');
      }
    });
    row.appendChild(star);

    const del = document.createElement('button');
    del.className = 'doc-delete';
    del.title = 'Delete document';
    del.appendChild(icon('trash', 15));
    del.addEventListener('click', async () => {
      try {
        await deleteDocument(doc.id);
        renderDocuments();
        showToast(`Deleted ${doc.name}`, 'success');
      } catch (err) {
        showToast(`Could not delete: ${err.message}`, 'error');
      }
    });
    row.appendChild(del);

    list.appendChild(row);
  }
}

async function addDocumentFile(file) {
  if (file.size > MAX_DOC_BYTES) {
    showToast(`${file.name} is over the 8 MB limit`, 'error');
    return;
  }
  const okTypes = /\.(pdf|docx?|txt)$/i;
  if (!okTypes.test(file.name)) {
    showToast('Only PDF, DOC, DOCX and TXT files are supported', 'error');
    return;
  }
  try {
    const dataBase64 = await fileToBase64(file);
    const mime = file.type || guessMime(file.name);
    // Read the words out of it, not just the bytes. Storing the file and nothing else is
    // what made "I've added my resume" buy the user nothing: the agent could attach it and
    // still had to ask what job they do. Extraction failing is fine and is reported — it is
    // extraction failing SILENTLY that produced the complaint.
    const extracted = await extractDocumentText({ name: file.name, mime, dataBase64 });
    await saveDocument({
      name: file.name,
      mime,
      size: file.size,
      dataBase64,
      text: extracted.text,
      textError: extracted.ok ? '' : extracted.reason,
      isDefault: false,
    });
    // Only ever FILL an empty box. The user's own text wins — silently replacing something
    // they typed and corrected with a fresh machine extraction would be its own bug.
    if (extracted.ok && !String(profile.resumeText || '').trim()) {
      profile.resumeText = extracted.text;
      $('pf-resumeText').value = extracted.text;
      await saveProfile(profile);
    }
    renderDocuments();
    showToast(extracted.ok
      ? `Added ${file.name} — read ${extracted.text.length.toLocaleString()} characters of text`
      : `Added ${file.name} — text could not be read`, extracted.ok ? 'success' : 'warn');
  } catch (err) {
    showToast(`Could not add ${file.name}: ${err.message}`, 'error');
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('file could not be read'));
    reader.readAsDataURL(file);
  });
}

function guessMime(name) {
  const ext = name.toLowerCase().split('.').pop();
  return {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
  }[ext] || 'application/octet-stream';
}

function wireDropzone() {
  const zone = $('dropzone');
  const fileInput = $('doc-file-input');
  const openPicker = () => fileInput.click();
  zone.addEventListener('click', openPicker);
  zone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
  });
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) await addDocumentFile(f);
    fileInput.value = '';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    for (const f of e.dataTransfer.files) await addDocumentFile(f);
  });
}

// -- saved answers

function renderSavedAnswers() {
  const wrap = $('saved-answers');
  wrap.textContent = '';
  if (!profile.savedAnswers.length) {
    const empty = document.createElement('div');
    empty.className = 'saved-answers-empty';
    empty.textContent = 'No saved answers yet. They accumulate as you answer the agent’s questions.';
    wrap.appendChild(empty);
    return;
  }
  profile.savedAnswers.forEach((entry, i) => {
    const row = document.createElement('div');
    row.className = 'answer-row';

    const fields = document.createElement('div');
    fields.className = 'answer-fields';
    const q = document.createElement('input');
    q.type = 'text';
    q.placeholder = 'Question';
    q.value = entry.q;
    q.addEventListener('input', () => { entry.q = q.value; persistProfile(); });
    const a = document.createElement('input');
    a.type = 'text';
    a.placeholder = 'Answer';
    a.value = entry.a;
    a.addEventListener('input', () => { entry.a = a.value; persistProfile(); });
    fields.appendChild(q);
    fields.appendChild(a);
    row.appendChild(fields);

    const del = document.createElement('button');
    del.className = 'answer-delete';
    del.title = 'Delete this answer';
    del.appendChild(icon('trash', 14));
    del.addEventListener('click', () => {
      profile.savedAnswers.splice(i, 1);
      persistProfile();
      renderSavedAnswers();
    });
    row.appendChild(del);

    wrap.appendChild(row);
  });
}

function wireSavedAnswers() {
  $('btn-add-answer').addEventListener('click', () => {
    profile.savedAnswers.push({ q: '', a: '' });
    renderSavedAnswers();
    persistProfile();
    const inputs = $('saved-answers').querySelectorAll('input');
    if (inputs.length >= 2) inputs[inputs.length - 2].focus();
  });
}

// ---------------------------------------------------------------- settings

function settingsFromForm() {
  const typed = $('st-model-text').value.trim();
  const selected = $('st-model-select').value;
  const autoLockEl = $('st-vaultAutoLock');
  const confirmEl = $('st-alwaysConfirmCreds');
  const autoLock = autoLockEl ? Number(autoLockEl.value) : (settings.vaultAutoLockMinutes ?? 15);
  return {
    ...settings,
    provider: $('st-provider').value,
    baseUrl: $('st-baseUrl').value,
    apiKey: $('st-apiKey').value,
    model: typed || selected,
    autoSubmit: $('st-autoSubmit').checked,
    saveAnswers: $('st-saveAnswers').checked,
    // CONTRACT-V4 §1: an explicit 0 means UNLIMITED and must survive — `|| 48`
    // would coerce it back to 48. Only a blank/invalid field falls back.
    maxSteps: maxStepsFromForm(),
    temperature: Number($('st-temperature').value),
    maxTokens: Number($('st-maxTokens').value) || 2048,
    vaultAutoLockMinutes: Number.isFinite(autoLock) ? autoLock : 15,
    alwaysConfirmCredentials: confirmEl ? confirmEl.checked : (settings.alwaysConfirmCredentials ?? true),
    soundOnPrompt: $('st-soundOnPrompt') ? $('st-soundOnPrompt').checked : (settings.soundOnPrompt ?? true),
    // Blank means "use the built-in table" — '' must survive, so these are NOT coerced to 0.
    contextWindow: fieldOrBlank('st-contextWindow'),
    priceIn: fieldOrBlank('st-priceIn'),
    priceOut: fieldOrBlank('st-priceOut'),
  };
}

/** CONTRACT-V4 §1 — 0 is a real value (unlimited); blank/garbage falls back to 48. */
function maxStepsFromForm() {
  const raw = String($('st-maxSteps').value ?? '').trim();
  if (raw === '') return 48;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 48;
}

/** '' when the input is empty, so a blank price override stays "unset" not "free". */
function fieldOrBlank(id) {
  const el = $(id);
  if (!el) return '';
  const raw = String(el.value || '').trim();
  return raw === '' ? '' : Number(raw);
}

function vaultAutoLockSetting() {
  return settings && Number.isFinite(settings.vaultAutoLockMinutes) ? settings.vaultAutoLockMinutes : 15;
}

const persistSettings = debounce(async () => {
  try {
    settings = await saveSettings(settingsFromForm());
    // Reflect clamped/normalized values back into the form (skip a field the
    // user is still typing in) so the display never lies about what's stored.
    const synced = [
      ['st-maxSteps', settings.maxSteps],
      ['st-temperature', settings.temperature],
      ['st-maxTokens', settings.maxTokens],
      ['st-vaultAutoLock', settings.vaultAutoLockMinutes],
    ];
    for (const [id, value] of synced) {
      const el = $(id);
      if (el && document.activeElement !== el && String(el.value) !== String(value)) el.value = value;
    }
    try { vault.setAutoLockMinutes(vaultAutoLockSetting()); } catch { /* vault not ready */ }
    refreshPill();
    showToast('Saved ✓', 'success');
  } catch (err) {
    showToast(`Could not save settings: ${err.message}`, 'error');
  }
}, 400);

function fillSettingsForm() {
  $('st-provider').value = settings.provider;
  $('st-baseUrl').value = settings.baseUrl;
  $('st-apiKey').value = settings.apiKey;
  $('st-model-text').value = settings.model;
  $('st-autoSubmit').checked = settings.autoSubmit;
  $('st-saveAnswers').checked = settings.saveAnswers;
  $('st-maxSteps').value = settings.maxSteps;
  $('st-temperature').value = settings.temperature;
  $('st-maxTokens').value = settings.maxTokens;
  if ($('st-vaultAutoLock')) $('st-vaultAutoLock').value = settings.vaultAutoLockMinutes ?? 15;
  if ($('st-alwaysConfirmCreds')) $('st-alwaysConfirmCreds').checked = settings.alwaysConfirmCredentials ?? true;
  if ($('st-soundOnPrompt')) $('st-soundOnPrompt').checked = settings.soundOnPrompt ?? true;
  if ($('st-contextWindow')) $('st-contextWindow').value = settings.contextWindow ?? '';
  if ($('st-priceIn')) $('st-priceIn').value = settings.priceIn ?? '';
  if ($('st-priceOut')) $('st-priceOut').value = settings.priceOut ?? '';
}

function wireSettings() {
  const inputs = ['st-provider', 'st-baseUrl', 'st-apiKey', 'st-autoSubmit',
    'st-saveAnswers', 'st-maxSteps', 'st-temperature', 'st-maxTokens', 'st-model-text',
    'st-vaultAutoLock', 'st-alwaysConfirmCreds', 'st-soundOnPrompt'];
  for (const id of inputs) {
    const el = $(id);
    if (!el) continue;
    el.addEventListener('input', persistSettings);
    el.addEventListener('change', persistSettings);
  }

  $('st-model-select').addEventListener('change', () => {
    const v = $('st-model-select').value;
    if (v) $('st-model-text').value = v;
    persistSettings();
  });

  $('btn-toggle-key').addEventListener('click', () => {
    const key = $('st-apiKey');
    key.type = key.type === 'password' ? 'text' : 'password';
  });

  $('btn-refresh-models').addEventListener('click', async () => {
    const btn = $('btn-refresh-models');
    btn.disabled = true;
    try {
      const models = await listModels(settingsFromForm());
      const select = $('st-model-select');
      select.textContent = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = `— ${models.length} models —`;
      select.appendChild(placeholder);
      for (const id of models) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = id;
        select.appendChild(opt);
      }
      const current = $('st-model-text').value.trim();
      if (current && models.includes(current)) select.value = current;
      showToast(`Loaded ${models.length} models`, 'success');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });

  $('btn-test').addEventListener('click', async () => {
    const btn = $('btn-test');
    const result = $('test-result');
    btn.disabled = true;
    result.className = 'test-result';
    result.textContent = 'Testing…';
    const outcome = await testConnection(settingsFromForm());
    result.textContent = outcome.message;
    result.className = `test-result ${outcome.ok ? 'ok' : 'fail'}`;
    btn.disabled = false;
  });

  wireDangerButton($('btn-clear-chat'), 'Clear chat', async () => {
    await handleNewChat();
  });
  wireDangerButton($('btn-clear-all'), 'Clear ALL data', async () => {
    // A debounced save pending from a recent edit would silently re-write the
    // just-cleared data (API key included) — cancel them all first.
    persistSettings.cancel();
    persistProfile.cancel();
    persistChats.cancel();
    // Wipe the vault (in-memory key + entries + stored blob) before the rest, so
    // no decrypted secret survives in module memory.
    try { await vault.resetVault(); } catch { /* nothing to reset */ }
    await clearAllData();
    settings = await getSettings();
    profile = await getProfile();
    fillSettingsForm();
    wireProfileValues();
    renderDocuments();
    renderSavedAnswers();
    await refreshVaultView();
    // The memory bank is user data too. Clearing it re-seeds the shipped playbooks on the
    // next read — the built-ins come back, everything learned does not.
    openPlaybooks.clear();
    clearDetectionCache();
    await refreshMemoryView();
    await refreshPortalChip();
    stats.reset();
    renderStats();
    // carryAnswers OFF: "Clear ALL data" means all of it. The transcript in memory still
    // holds this session's answers, and sweeping them into the profile here would put
    // user data back seconds after wiping it.
    await handleNewChat({ carryAnswers: false });
    pillState = 'unconfigured';
    refreshPill();
    showToast('All data cleared', 'success');
  });
}

function wireProfileValues() {
  for (const key of PROFILE_FIELD_IDS) $(`pf-${key}`).value = profile[key] || '';
}

// Double-click confirm pattern (§10) — no window.confirm.
function wireDangerButton(btn, label, action) {
  let timer = null;
  btn.addEventListener('click', async () => {
    if (btn.dataset.armed !== 'true') {
      btn.dataset.armed = 'true';
      btn.textContent = 'Click again to confirm';
      timer = setTimeout(() => {
        btn.dataset.armed = 'false';
        btn.textContent = label;
      }, 3000);
      return;
    }
    clearTimeout(timer);
    btn.dataset.armed = 'false';
    btn.textContent = label;
    try {
      await action();
    } catch (err) {
      showToast(`Failed: ${err.message}`, 'error');
    }
  });
}

// -------------------------------------------------------------------- init

async function init() {
  try {
    [settings, profile] = await Promise.all([getSettings(), getProfile()]);
  } catch (err) {
    showToast(`Could not load stored data: ${err.message}`, 'error');
    settings = await getSettings().catch(() => ({}));
    profile = await getProfile().catch(() => ({ savedAnswers: [] }));
  }

  runner = makeRunner();

  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchTab(tab.dataset.view));
  }

  wireComposer();
  wireProfileFields();
  wireDropzone();
  wireSavedAnswers();
  fillSettingsForm();
  wireSettings();
  wireVault();
  wireVaultTouch();
  wireMemory();
  wireStats();
  renderDocuments();
  renderSavedAnswers();
  refreshMemoryView();
  renderStats();
  try { vault.setAutoLockMinutes(vaultAutoLockSetting()); } catch { /* vault module not ready */ }
  refreshVaultView();

  try {
    restoreChat(await getChats());
  } catch (err) {
    showToast(`Could not restore chat: ${err.message}`, 'error');
    updateEmptyState();
  }

  refreshPill();
  $('target-favicon').addEventListener('error', () => { $('target-favicon').hidden = true; });
  refreshTargetTab();
  refreshPortalChip();
  setInterval(refreshTargetTab, 4000);
  window.addEventListener('focus', refreshTargetTab);
}

init();
