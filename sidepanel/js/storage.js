// storage.js — typed access to chrome.storage.local (contract §6).
// Keys: settings, profile, documents, chatHistory — exact strings.
// Plus vault (CONTRACT-V2 §3) and playbooks / siteNotes (CONTRACT-V3 §1).

import { SEEDS, seedFor } from './playbook-seeds.js';

// Exported because a caller that could not READ storage still has to render something with
// the right SHAPE. store.jsx's reloadAll used to fall back to `{}`, which turned every
// settings box into an uncontrolled <input value={undefined}> and printed the literal text
// "undefined" into the number fields. A read failure is not a reason to hand the UI a
// different type than it gets every other time.
/** The legal values of settings.planMode, in the order the Settings tab offers them. */
export const PLAN_MODES = Object.freeze(['ask', 'auto', 'off']);

export const DEFAULT_SETTINGS = {
  provider: 'openai',
  baseUrl: '',
  apiKey: '',
  model: '',
  temperature: 0.2,
  maxTokens: 2048,
  maxSteps: 48,
  // How many job applications may run at once. Each one is a live LLM stream you pay for
  // and a tab being driven, so this is a cost and rate-limit guard, not a Chrome limit.
  maxConcurrentRuns: 3,
  autoSubmit: false,
  // CONTRACT-V11 §1. 'ask' = agree every page in one card before it is filled;
  // 'auto' = show the card only when there is something to decide (a question, or a value
  // no profile field backs), so the later pages of a wizard pass without stopping;
  // 'off' = the propose_plan tool is not offered at all and the agent behaves exactly as
  // it did before plan mode existed.
  planMode: 'ask',
  saveAnswers: true,
  vaultAutoLockMinutes: 15,
  alwaysConfirmCredentials: true,
  // CONTRACT-V6 §6: chime when the run stops and is waiting on a human.
  soundOnPrompt: true,
  // Stats overrides. '' means "use the built-in model table" — a 0 would mean "free",
  // which is a different and much more misleading claim.
  contextWindow: '',
  priceIn: '',
  priceOut: '',
};

/** Exported for the same reason as DEFAULT_SETTINGS above. */
export const DEFAULT_PROFILE = {
  fullName: '',
  email: '',
  phone: '',
  location: '',
  linkedin: '',
  github: '',
  portfolio: '',
  // A postal address is five or six boxes on every real application form, and a single
  // free-text `location` ("Bengaluru, India") cannot answer them. Without these the
  // agent has nothing to fill Address Line 1 / State / Postal Code from, so it asks —
  // on every single application. `location` stays: it is what a "Current location"
  // field wants, and it is what existing profiles already hold.
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  // Employment. Every application asks for these and the profile held none of them, so
  // "Current job title?" / "Current employer?" / "Years of experience?" were three
  // ask_user questions on every single form — the resume that answers all three was
  // stored as base64 and never read by anything (see resumeText below).
  currentTitle: '',
  currentCompany: '',
  yearsExperience: '',
  workAuth: '',
  // workAuth is free text and applicants write it a dozen ways. "Do you now or in the
  // future require sponsorship?" is a yes/no on the form and must not be inferred from
  // prose — a wrong guess here is a withdrawn application.
  sponsorshipNeeded: '',
  salary: '',
  noticePeriod: '',
  // The resume, as TEXT. Filled automatically when a document is uploaded and its text can
  // be read; always editable, and what the user types here wins. This is the difference
  // between "I gave JobPilot my resume" being true and being decorative.
  resumeText: '',
  // Voluntary self-identification (EEO). Optional on the form and optional here — a
  // blank one is not a gap to ask about, it means "decline to self-identify", which
  // every one of these forms accepts as an answer.
  gender: '',
  pronouns: '',
  ethnicity: '',
  veteranStatus: '',
  disabilityStatus: '',
  extraContext: '',
  savedAnswers: [],
};

const CHAT_HISTORY_CAP = 200;

async function get(key) {
  const obj = await chrome.storage.local.get(key);
  return obj[key];
}

async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

export async function getSettings() {
  const stored = await get('settings');
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

/**
 * Every clamp and trim a settings object gets on its way to disk, as a PURE function.
 *
 * Split out of saveSettings so importAllData() can put a RESTORED settings object through
 * the identical normalization rather than a second copy of these rules that drifts from
 * this one. A backup file is a text file the user can edit, so what comes out of it is
 * exactly as untrusted as what comes out of a form field.
 */
export function normalizeSettings(settings) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  merged.baseUrl = String(merged.baseUrl || '').trim().replace(/\/+$/, '');
  merged.apiKey = String(merged.apiKey || '').trim();
  merged.model = String(merged.model || '').trim();
  merged.temperature = clampNumber(merged.temperature, 0, 2, 0.2);
  merged.maxTokens = Math.round(clampNumber(merged.maxTokens, 64, 200000, 2048));
  // CONTRACT-V4 §1: 0 means unlimited (agent.js maps it to Infinity).
  merged.maxSteps = Math.round(clampNumber(merged.maxSteps, 0, 10000, 48));
  merged.vaultAutoLockMinutes = Math.round(clampNumber(merged.vaultAutoLockMinutes, 0, 480, 15));
  // At least 1 — 0 concurrent applications would be a panel that cannot do anything. The
  // ceiling is judgement rather than a hard limit: past a handful, provider rate limits and
  // the fact that background tabs do not render make more runs slower, not faster.
  merged.maxConcurrentRuns = Math.round(clampNumber(merged.maxConcurrentRuns, 1, 8, 3));
  merged.alwaysConfirmCredentials = Boolean(merged.alwaysConfirmCredentials);
  merged.soundOnPrompt = Boolean(merged.soundOnPrompt);
  // An unrecognised value falls back to 'ask' rather than to 'off'. A backup file is
  // hand-editable and a typo is the likely cause, and of the three the SAFE failure is the
  // one that shows the user what is about to be entered — not the one that silently turns
  // the review off.
  merged.planMode = PLAN_MODES.includes(merged.planMode) ? merged.planMode : 'ask';
  return merged;
}

export async function saveSettings(settings) {
  const merged = normalizeSettings(settings);
  await set('settings', merged);
  return merged;
}

export async function getProfile() {
  const stored = await get('profile');
  const profile = { ...DEFAULT_PROFILE, ...(stored || {}) };
  if (!Array.isArray(profile.savedAnswers)) profile.savedAnswers = [];
  return profile;
}

/** Pure, for the same reason as normalizeSettings above. */
export function normalizeProfile(profile) {
  const merged = { ...DEFAULT_PROFILE, ...profile };
  if (!Array.isArray(merged.savedAnswers)) merged.savedAnswers = [];
  return merged;
}

export async function saveProfile(profile) {
  const merged = normalizeProfile(profile);
  await set('profile', merged);
  return merged;
}

/** Loose match for "the same question asked again" — punctuation and case are noise. */
export function answerKey(q) {
  return String(q || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Saved answers are the one user-authored list with no cap, and every row of it goes
// into the system prompt of EVERY run — the same budget the playbooks are capped for
// (MAX_PROCEDURE/MAX_TIPS above). Left unbounded it grows for as long as the extension
// is used, quietly eating the room the live page needs.
const MAX_SAVED_ANSWERS = 40;
// An essay is not a reusable screening answer. A cover letter written for one employer
// is wrong at the next one, and storing it would replay it — truncated — into every
// future prompt. Over this length the answer stays in the chat and is not saved.
const MAX_ANSWER_LEN = 600;
const MAX_QUESTION_LEN = 200;

/**
 * Merge answered questions into savedAnswers, replacing rather than appending.
 *
 * Appending was the quiet cost of saving answers: a question answered on ten
 * applications arrived in the prompt ten times. Pure, so the caller decides when to
 * persist.
 *
 * @param {{q:string,a:string}[]} existing
 * @param {{q:string,a:string}[]} pairs
 * @returns {{list:{q:string,a:string}[], added:number, updated:number,
 *            skipped:number, evicted:number}}
 */
export function mergeSavedAnswers(existing, pairs) {
  const list = (Array.isArray(existing) ? existing : []).map((e) => ({ ...e }));
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const pair of (Array.isArray(pairs) ? pairs : [])) {
    const q = String((pair && pair.q) || '').trim().slice(0, MAX_QUESTION_LEN);
    const a = String((pair && pair.a) || '').trim();
    if (!q || !a) continue;
    if (a.length > MAX_ANSWER_LEN) { skipped++; continue; }
    const key = answerKey(q);
    const idx = list.findIndex((e) => answerKey(e && e.q) === key);
    if (idx >= 0) {
      if (list[idx].a !== a) updated++;
      list[idx] = { q, a }; // in place: the Profile tab's order should not shuffle
    } else {
      list.push({ q, a });
      added++;
    }
  }
  // Oldest-first eviction. The rows the user typed by hand are as evictable as the rest —
  // they are all visible and editable in the Profile tab, which is where a keeper belongs.
  const evicted = Math.max(0, list.length - MAX_SAVED_ANSWERS);
  return { list: evicted ? list.slice(evicted) : list, added, updated, skipped, evicted };
}

/**
 * Merge answers into the STORED profile and persist, under the lock.
 *
 * Why this exists rather than the caller merging: the panel holds the profile in React
 * state, so the obvious `mergeSavedAnswers(profileInMemory, pairs)` + whole-object save is
 * last-write-wins. With one run that is invisible; with three runs answering screening
 * questions at the same time it silently drops answers, and the only symptom is the agent
 * asking something it was already told. Re-reading inside the lock is what makes two
 * concurrent merges compose instead of race.
 *
 * Returns the merge counts AND the normalized profile, because the caller must adopt it:
 * the Profile editor's next debounced save writes its whole in-memory object, and would
 * otherwise put the pre-merge copy straight back over this write.
 *
 * @returns {Promise<{profile:object, added:number, updated:number, skipped:number, evicted:number}>}
 */
export async function appendSavedAnswers(pairs) {
  return withWriteLock('profile', async () => {
    const current = await getProfile();
    const { list, added, updated, skipped, evicted } = mergeSavedAnswers(current.savedAnswers, pairs);
    const merged = normalizeProfile({ ...current, savedAnswers: list });
    await set('profile', merged);
    return { profile: merged, added, updated, skipped, evicted };
  });
}

export async function getDocuments() {
  const docs = await get('documents');
  return Array.isArray(docs) ? docs : [];
}

/**
 * Add or update a document. If `doc.id` is missing, one is generated.
 * The first document ever added becomes the default automatically.
 */
// The three document mutations are read-whole / modify / write-whole on one key, and the
// "exactly one default" invariant is re-established per write across the WHOLE array — so
// two interleaved writes can leave zero defaults or two. Serialized for the same reason
// the memory bank is.
export async function saveDocument(doc) {
  return withWriteLock('documents', () => saveDocumentImpl(doc));
}

async function saveDocumentImpl(doc) {
  const docs = await getDocuments();
  const entry = {
    id: doc.id || crypto.randomUUID(),
    name: doc.name,
    mime: doc.mime,
    size: doc.size,
    dataBase64: doc.dataBase64,
    // What the file SAYS, when it could be read (doctext.js). The bytes are for upload_file;
    // this is the only part the model ever sees. '' means "not readable", which the Profile
    // tab reports rather than hides — an unreadable resume the user believes was understood
    // is how the agent ends up asking for a job title that is printed on page one.
    text: typeof doc.text === 'string' ? doc.text : '',
    textError: typeof doc.textError === 'string' ? doc.textError : '',
    isDefault: Boolean(doc.isDefault),
    addedAt: doc.addedAt || Date.now(),
  };
  const idx = docs.findIndex((d) => d.id === entry.id);
  if (idx >= 0) docs[idx] = entry;
  else docs.push(entry);
  if (!docs.some((d) => d.isDefault)) docs[0].isDefault = true;
  if (entry.isDefault) {
    for (const d of docs) d.isDefault = d.id === entry.id;
  }
  await set('documents', docs);
  return entry;
}

export async function deleteDocument(id) {
  return withWriteLock('documents', async () => {
    let docs = await getDocuments();
    const removedDefault = docs.some((d) => d.id === id && d.isDefault);
    docs = docs.filter((d) => d.id !== id);
    if (removedDefault && docs.length) docs[0].isDefault = true;
    await set('documents', docs);
    return docs;
  });
}

export async function setDefaultDocument(id) {
  return withWriteLock('documents', async () => {
    const docs = await getDocuments();
    for (const d of docs) d.isDefault = d.id === id;
    await set('documents', docs);
    return docs;
  });
}

// ------------------------------------------------------------ transcripts
//
// One key, many runs. Concurrent applications each need their own transcript, and the
// obvious shape — a `chat:<runId>` key per run — is WRONG here: BACKUP_KEYS below is a
// frozen list of literal key names and the single definition of "all my data" that the
// export, the import and the wipe all read from. Dynamic keys would silently escape all
// three, so "Clear ALL data" would leave transcripts behind. Hence one key holding a map.
//
// v1 was a bare array — the single transcript from before runs existed. Reads still accept
// it and hand it to the default run, so an existing install keeps its chat; the first write
// after that stores v2. BACKUP_FORMAT is bumped alongside, because an OLD build reading
// this shape would find a non-array and quietly show an empty transcript (see the
// `chatHistory` case in importAllData) — a version refusal is the honest failure.

/** The run a legacy transcript belongs to, and the id used while only one run exists. */
export const DEFAULT_RUN_ID = 'run-1';

// Per run, as before. The total cap is new and exists because N runs would otherwise
// multiply the storage footprint by N.
const CHAT_TOTAL_CAP = CHAT_HISTORY_CAP * 5;

/** Accepts v1 (bare array) or v2, and always returns a v2 store. Never throws. */
export function normalizeChats(raw) {
  if (Array.isArray(raw)) {
    return { v: 2, runs: { [DEFAULT_RUN_ID]: raw.slice(-CHAT_HISTORY_CAP) } };
  }
  if (!isPlainObject(raw) || !isPlainObject(raw.runs)) return { v: 2, runs: {} };
  const runs = {};
  let total = 0;
  // Newest-first so the total cap drops the OLDEST runs rather than whichever the key
  // order happened to put last.
  const ids = Object.keys(raw.runs).reverse();
  for (const id of ids) {
    const rows = raw.runs[id];
    if (!Array.isArray(rows) || !rows.length) continue;
    if (total >= CHAT_TOTAL_CAP) break;
    const kept = rows.slice(-Math.min(CHAT_HISTORY_CAP, CHAT_TOTAL_CAP - total));
    runs[id] = kept;
    total += kept.length;
  }
  return { v: 2, runs };
}

/** Total messages across every run — what the backup summary counts. Accepts both shapes. */
export function countChats(raw) {
  const store = normalizeChats(raw);
  return Object.values(store.runs).reduce((n, rows) => n + rows.length, 0);
}

export async function getChats(runId = DEFAULT_RUN_ID) {
  const store = normalizeChats(await get('chatHistory'));
  const rows = store.runs[runId];
  return Array.isArray(rows) ? rows : [];
}

/**
 * Read-modify-write on a key several runs write to at once, so it holds the lock. Without
 * it three debounced writers interleave and the last one to land erases the other two
 * transcripts.
 */
export async function saveChats(runId, messages) {
  const id = runId || DEFAULT_RUN_ID;
  const capped = (Array.isArray(messages) ? messages : []).slice(-CHAT_HISTORY_CAP);
  await withWriteLock('chatHistory', async () => {
    const store = normalizeChats(await get('chatHistory'));
    store.runs[id] = capped;
    await set('chatHistory', normalizeChats(store));
  });
  return capped;
}

/** Clears ONE run's transcript. The whole key is cleared by clearAllData, via BACKUP_KEYS. */
export async function clearChats(runId = DEFAULT_RUN_ID) {
  await withWriteLock('chatHistory', async () => {
    const store = normalizeChats(await get('chatHistory'));
    delete store.runs[runId];
    await set('chatHistory', store);
  });
}

// ------------------------------------------------------ the application log
//
// One record per application, captured by the agent loop at `done`. This is the tracker
// the transcript cannot be: transcripts are capped, per-run, and cleared by New Chat,
// while "what did I apply to, where, and when" has to survive all of that. Local like
// everything else, and in BACKUP_KEYS so export/import/wipe carry it automatically.
//
// Which outcomes count: submitted, ready_for_review (the user clicked the button
// themselves — a tracker with holes where the manual submits were is not a tracker) and
// already_applied (knowing you already applied IS tracking data). Never blocked or
// answered — neither is an application.

/** @typedef {{id:string, submittedAt:number, status:string, jobTitle:string,
 *             company:string, url:string, host:string, portal:string, runId:string}} ApplicationRecord */

export const APPLICATION_STATUSES = Object.freeze(['submitted', 'ready_for_review', 'already_applied']);
const MAX_APPLICATIONS = 500;

function normalizeApplication(a) {
  if (!isPlainObject(a)) return null;
  const rec = {
    id: typeof a.id === 'string' && a.id ? a.id : crypto.randomUUID(),
    submittedAt: Number.isFinite(a.submittedAt) ? a.submittedAt : Date.now(),
    status: APPLICATION_STATUSES.includes(a.status) ? a.status : 'submitted',
    jobTitle: String(a.jobTitle || '').slice(0, 160),
    company: String(a.company || '').slice(0, 120),
    url: String(a.url || '').slice(0, 600),
    host: String(a.host || '').slice(0, 120),
    portal: String(a.portal || '').slice(0, 40),
    runId: String(a.runId || '').slice(0, 60),
  };
  // A record with no title, no company and no URL identifies nothing — drop it.
  if (!rec.jobTitle && !rec.company && !rec.url) return null;
  return rec;
}

/** Accepts anything (imports are hand-editable files); returns newest-first records. */
export function normalizeApplications(value) {
  const list = (Array.isArray(value) ? value : [])
    .map(normalizeApplication)
    .filter(Boolean)
    .sort((x, y) => y.submittedAt - x.submittedAt);
  return list.slice(0, MAX_APPLICATIONS);
}

export async function getApplications() {
  return normalizeApplications(await get('applications'));
}

/**
 * Append one record, under the lock — three concurrent runs can finish together.
 * Returns the stored record.
 */
export async function logApplication(app) {
  const rec = normalizeApplication(app);
  if (!rec) return null;
  await withWriteLock('applications', async () => {
    const list = normalizeApplications(await get('applications'));
    list.unshift(rec);
    await set('applications', list.slice(0, MAX_APPLICATIONS));
  });
  return rec;
}

export async function deleteApplication(id) {
  await withWriteLock('applications', async () => {
    const list = normalizeApplications(await get('applications'));
    await set('applications', list.filter((a) => a.id !== id));
  });
}

/**
 * The log as CSV, for Excel / Google Sheets. Pure, so node can test the quoting — a
 * job title containing a comma or a quote is the NORMAL case, not the edge case.
 */
export function applicationsToCsv(records) {
  const esc = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [['date', 'status', 'job_title', 'company', 'url', 'portal', 'host']];
  for (const a of (records || [])) {
    rows.push([
      new Date(a.submittedAt).toISOString().slice(0, 10),
      a.status, a.jobTitle, a.company, a.url, a.portal, a.host,
    ]);
  }
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

// ------------------------------------------------------- memory bank (V3 §1)
//
// Playbooks are keyed by PORTAL, never by employer (V3 §0): one Workday playbook serves
// every company on Workday. Site notes are the small second layer for quirks that really
// are employer-specific.
//
// Every write goes through clamp/dedupe below. The `remember` payload is authored by the
// model, so nothing here may be trusted: an unclamped 200-item tips array would ride
// along in the system prompt on every subsequent request, in every future run.

/**
 * @typedef {{platform:string, label:string, procedure:string[], tips:string[],
 *            source:'builtin'|'learned'|'user', seedVersion:number, edited:boolean,
 *            useCount:number, updatedAt:number, updatedBy:'seed'|'agent'|'user'}} Playbook
 * @typedef {{host:string, platform:string, notes:string[], updatedAt:number}} SiteNote
 */

// These caps are the only thing bounding what a playbook adds to EVERY request of a run.
// Measured against the shipped Workday seed (10 steps, 9 tips), the memory block is ~535
// words; at these caps the absolute worst case is ~2.1k tokens. That is a real cost, and
// it is worth paying: a portal playbook removes whole rediscovery steps, each of which
// costs a full read_page (thousands of tokens). Loosen them and that trade stops holding.
const MAX_PROCEDURE = 12;
const MAX_TIPS = 14;
const MAX_SITE_NOTES = 6;
const MAX_LINE = 200;

const NO_DROPS = { overCap: 0, duplicate: 0, truncated: 0 };

/**
 * Every playbook mutation is a read-whole-array / modify / write-whole-array, and several
 * can be in flight at once: `bumpPlaybookUse` is deliberately fire-and-forget from the
 * agent loop while the user is saving an edit in the Memory tab. Interleave two of those
 * and the later write commits a snapshot taken before the earlier one — silently
 * reverting a just-saved playbook.
 *
 * chrome.storage.local has no compare-and-swap, so serialize instead: every mutation runs
 * inside a chain, so each one re-reads only after the previous has committed.
 *
 * WHY THIS IS NOW GENERAL. It was written for playbooks, but the same read-whole /
 * modify / write-whole shape is everywhere in this file, and concurrent runs turn every
 * one of them into the race described above — several applications answering questions
 * and writing transcripts at the same moment, not just an agent racing the Memory tab.
 * So the chain is keyed, and every unserialized read-modify-write has been brought under
 * it: `documents`, `chatHistory`, and `getPlaybooks`'s own self-healing write.
 *
 * SCOPE, precisely: these chains are module-level, so they serialize writers inside ONE
 * document. A second side panel is a second document with its own chains, and two panels
 * racing on the same key would still clobber each other. Closing that would need a
 * compare-and-swap the storage API does not offer; this is the bound, not an oversight.
 * (Concurrent RUNS all live in one panel document, so they are covered.)
 */
const writeChains = new Map();

function withWriteLock(key, fn) {
  const prev = writeChains.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  // Keep the chain alive even when a mutation rejects — one failed write must not wedge
  // every later one.
  writeChains.set(key, run.then(() => {}, () => {}));
  return run;
}

// The memory bank's three keys deliberately share ONE lock, exactly as they did when this
// was a single `playbookWriteChain`. Splitting them per key would be faster and would also
// be a behaviour change in code that is not what this feature is about.
const MEMORY_BANK_LOCK = 'memory-bank';
const withPlaybookLock = (fn) => withWriteLock(MEMORY_BANK_LOCK, fn);

/** Normalized dedupe key: same lesson learned twice must not grow the playbook. */
function dedupeKey(line) {
  return String(line).toLowerCase().replace(/\s+/g, ' ').replace(/[.;,!]+$/, '').trim();
}

/**
 * Clamp a model- or user-authored string array to the caps in V3 §1.1.
 *
 * `keep` decides WHICH end survives when the list is over cap, and it is load-bearing:
 *
 *   'first' — procedure. The caller sends an ordered list; step 1 matters most.
 *   'last'  — tips and site notes, which are MERGED as [...existing, ...new]. Keeping the
 *             first N would mean that once a playbook reached the cap, every future tip
 *             the agent learned was silently discarded while it was told "Saved — 20 tips".
 *             The memory bank would go permanently deaf and cheerfully report success.
 *             Newest-wins keeps it learning; the user can curate in the Memory tab.
 *
 * Returns the dropped counts too, so the caller can TELL the model what did not survive
 * rather than letting it believe a 50-tip payload landed intact.
 *
 * @returns {{lines: string[], dropped: {overCap:number, duplicate:number, truncated:number}}}
 */
function cleanLines(value, max, keep = 'first') {
  const dropped = { overCap: 0, duplicate: 0, truncated: 0 };
  if (!Array.isArray(value)) return { lines: [], dropped };

  const out = [];
  const seen = new Set();
  for (const raw of value) {
    const collapsed = String(raw ?? '').replace(/\s+/g, ' ').trim();
    if (!collapsed) continue;
    const line = collapsed.slice(0, MAX_LINE);
    if (line.length < collapsed.length) dropped.truncated += 1;
    const key = dedupeKey(line);
    if (seen.has(key)) { dropped.duplicate += 1; continue; }
    seen.add(key);
    out.push(line);
  }

  if (out.length > max) {
    dropped.overCap = out.length - max;
    return { lines: keep === 'last' ? out.slice(-max) : out.slice(0, max), dropped };
  }
  return { lines: out, dropped };
}

/** cleanLines when the caller only wants the lines (reads, normalization). */
function clamp(value, max, keep = 'first') {
  return cleanLines(value, max, keep).lines;
}

/** "3 over the 20-tip cap; 2 duplicates" — '' when nothing was dropped. */
function describeDropped(dropped, noun, cap, keep = 'last') {
  const bits = [];
  // WHICH end was evicted depends on the caller: tips keep the newest (keep='last', so the
  // oldest go), a procedure keeps the opening steps (keep='first', so the NEWEST go).
  // Hard-coding "oldest evicted" told the model the exact opposite half the time.
  if (dropped.overCap) {
    const which = keep === 'first' ? 'the newest evicted' : 'the oldest evicted';
    bits.push(`${dropped.overCap} dropped (${which} — the ${cap}-${noun} cap is full)`);
  }
  if (dropped.duplicate) bits.push(`${dropped.duplicate} duplicate${dropped.duplicate === 1 ? '' : 's'} merged`);
  if (dropped.truncated) bits.push(`${dropped.truncated} truncated to ${MAX_LINE} chars`);
  return bits.join(', ');
}

/**
 * Read every playbook, reconciling the shipped seeds first (V3 §1.3):
 * a missing seed is inserted; an UNEDITED copy of an outdated seed is refreshed; an
 * edited copy is never touched — resetPlaybook() is the only way back to a seed.
 *
 * Deleting a SEEDED playbook leaves a tombstone rather than removing the row. Without
 * one, the reconcile below would re-insert the seed on the very next read and the delete
 * would silently undo itself — and the cold-start path (V3 §3.3) would be unreachable for
 * every portal that ships a seed. A tombstone is how "no, I really do not want this
 * playbook" survives.
 */
/**
 * The read half: reconcile the seeds IN MEMORY and report whether that changed anything.
 *
 * Split out from getPlaybooks because the write half has to hold the memory-bank lock, and
 * the four `*Impl` mutators below call this while they are ALREADY holding it — routing
 * them through a lock-taking read would deadlock the chain against itself. So mutators use
 * this (pure, no write) and only the public read persists.
 */
async function reconcilePlaybooks() {
  const stored = await get('playbooks');
  const raw = Array.isArray(stored) ? stored : [];

  const tombstones = new Set(
    raw.filter((p) => p && p.deleted && p.platform).map((p) => String(p.platform))
  );
  const list = raw.filter((p) => p && !p.deleted).map(normalizePlaybook);
  const byPlatform = new Map(list.map((p) => [p.platform, p]));

  let changed = false;
  for (const seed of SEEDS) {
    if (tombstones.has(seed.platform)) continue; // deliberately deleted — stay gone
    const existing = byPlatform.get(seed.platform);
    if (!existing) {
      byPlatform.set(seed.platform, playbookFromSeed(seed));
      changed = true;
    } else if (!existing.edited && (existing.seedVersion || 0) < (seed.seedVersion || 0)) {
      byPlatform.set(seed.platform, playbookFromSeed(seed));
      changed = true;
    }
  }

  const merged = [...byPlatform.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { merged, tombstones, changed };
}

/** The merged list without persisting. For callers already inside the memory-bank lock. */
async function mergedPlaybooks() {
  return (await reconcilePlaybooks()).merged;
}

export async function getPlaybooks() {
  const { merged, changed } = await reconcilePlaybooks();
  if (!changed) return merged;
  // Persisting the reconcile used to happen right here, unlocked, on the READ path — so a
  // seed insert could land on top of a playbook the agent or the Memory tab had just
  // written. Take the lock and re-reconcile inside it: by then the mutation has committed,
  // and if it already did the seeding this second pass reports nothing left to change.
  await withPlaybookLock(async () => {
    const fresh = await reconcilePlaybooks();
    if (!fresh.changed) return;
    await set('playbooks', [
      ...fresh.merged,
      ...[...fresh.tombstones].map((platform) => ({ platform, deleted: true })),
    ]);
  });
  return merged;
}

export async function getPlaybook(platform) {
  if (!platform) return null;
  const all = await getPlaybooks();
  return all.find((p) => p.platform === platform) || null;
}

/**
 * Upsert a playbook. `procedure` REPLACES the stored one (the caller sends the full
 * improved list); `tips` are MERGED into the existing tips and deduped, so the agent can
 * add one lesson without having to restate the rest.
 *
 * @param {{platform:string, label?:string, procedure?:string[], tips?:string[]}} input
 * @param {'agent'|'user'} by
 * @returns {Promise<Playbook>}
 */
export async function savePlaybook(input, by = 'user') {
  return withPlaybookLock(() => savePlaybookImpl(input, by));
}

async function savePlaybookImpl(input, by) {
  const platform = String(input.platform || '').trim().toLowerCase();
  if (!platform) throw new Error('savePlaybook needs a platform key.');

  const all = await mergedPlaybooks();
  const idx = all.findIndex((p) => p.platform === platform);
  const prev = idx >= 0 ? all[idx] : null;
  const seed = seedFor(platform);

  // procedure: replace when supplied (ordered list — keep the FRONT on overflow).
  const procResult = input.procedure !== undefined
    ? cleanLines(input.procedure, MAX_PROCEDURE, 'first')
    : { lines: prev ? prev.procedure : [], dropped: NO_DROPS };

  // tips: MERGED into the existing ones by default. That is what the agent needs — it can
  // add one tip without restating the twelve it already knows — and the BACK is kept on
  // overflow, so a saturated playbook evicts its oldest tip rather than silently refusing
  // to learn anything new.
  //
  // `replaceTips` opts into wholesale replacement, and exists because merging is the WRONG
  // rule for a human editing the Tips textarea: with only the merge available, deleting a
  // line there was silently impossible — the line came straight back on the next read, and
  // correcting a tip's wording left both versions behind. The Memory tab used to try to
  // work around it by saving `tips: []` first and the real list second, which cannot work:
  // merging an empty array is a no-op. Over-cap keeps the FRONT here, because a replacement
  // is an ordered list the user typed top-down, not an accumulating log.
  const tipsResult = input.tips !== undefined
    ? cleanLines(
      input.replaceTips ? input.tips : [...(prev ? prev.tips : []), ...input.tips],
      MAX_TIPS,
      input.replaceTips ? 'first' : 'last',
    )
    : { lines: prev ? prev.tips : [], dropped: NO_DROPS };

  const entry = {
    platform,
    label: String(input.label || (prev && prev.label) || (seed && seed.label) || platform).slice(0, 60),
    procedure: procResult.lines,
    tips: tipsResult.lines,
    source: by === 'agent' ? 'learned' : 'user',
    seedVersion: prev ? prev.seedVersion : (seed ? seed.seedVersion : 0),
    edited: true, // any write pins it against future seed refreshes (V3 §1.3)
    useCount: prev ? prev.useCount : 0,
    updatedAt: Date.now(),
    updatedBy: by,
  };

  if (idx >= 0) all[idx] = entry;
  else all.push(entry);
  // Writing a playbook revives a deleted one — the tombstone has served its purpose.
  await writePlaybooks(all, { revive: platform });

  // `dropped` is returned, never persisted: the caller needs it to tell the model what
  // did not survive, instead of letting it read "20 tips" as "all 50 landed".
  return {
    ...entry,
    dropped: {
      procedure: describeDropped(procResult.dropped, 'step', MAX_PROCEDURE, 'first'),
      tips: describeDropped(tipsResult.dropped, 'tip', MAX_TIPS, 'last'),
    },
  };
}

/**
 * Delete a playbook. For a SEEDED portal this leaves a tombstone, so the seed does not
 * quietly reappear on the next read. resetPlaybook() is how the user gets it back.
 */
export async function deletePlaybook(platform) {
  return withPlaybookLock(() => deletePlaybookImpl(platform));
}

async function deletePlaybookImpl(platform) {
  const all = await mergedPlaybooks();
  const kept = all.filter((p) => p.platform !== platform);
  const tombstone = Boolean(seedFor(platform));
  await writePlaybooks(kept, tombstone ? { bury: platform } : { revive: platform });
}

/** Restore the shipped seed, discarding edits (and any tombstone). Null when no seed exists. */
export async function resetPlaybook(platform) {
  return withPlaybookLock(() => resetPlaybookImpl(platform));
}

async function resetPlaybookImpl(platform) {
  const seed = seedFor(platform);
  if (!seed) return null;
  const all = await mergedPlaybooks();
  const fresh = playbookFromSeed(seed);
  const idx = all.findIndex((p) => p.platform === platform);
  if (idx >= 0) {
    fresh.useCount = all[idx].useCount; // usage is history, not content — keep it
    all[idx] = fresh;
  } else {
    all.push(fresh);
  }
  await writePlaybooks(all, { revive: platform });
  return fresh;
}

/**
 * Persist the live playbooks alongside the tombstone rows, adding or clearing one.
 * getPlaybooks() strips tombstones from what it returns, so every caller passes a clean
 * list and never has to know they exist.
 */
async function writePlaybooks(live, { bury, revive } = {}) {
  const stored = await get('playbooks');
  const raw = Array.isArray(stored) ? stored : [];
  const tombstones = new Set(
    raw.filter((p) => p && p.deleted && p.platform).map((p) => String(p.platform))
  );
  if (bury) tombstones.add(bury);
  if (revive) tombstones.delete(revive);

  await set('playbooks', [
    ...live.filter((p) => !tombstones.has(p.platform)),
    ...[...tombstones].map((platform) => ({ platform, deleted: true })),
  ]);
}

/** useCount++ — fire-and-forget; a failure here must never break a run. */
export async function bumpPlaybookUse(platform) {
  return withPlaybookLock(() => bumpPlaybookUseImpl(platform));
}

async function bumpPlaybookUseImpl(platform) {
  try {
    const all = await mergedPlaybooks();
    const p = all.find((x) => x.platform === platform);
    if (!p) return;
    p.useCount = (p.useCount || 0) + 1;
    await writePlaybooks(all); // must not go through set() directly — it would drop tombstones
  } catch { /* usage stats are not worth failing a run over */ }
}

function playbookFromSeed(seed) {
  return {
    platform: seed.platform,
    label: seed.label,
    procedure: clamp(seed.procedure, MAX_PROCEDURE),
    tips: clamp(seed.tips, MAX_TIPS),
    source: 'builtin',
    seedVersion: seed.seedVersion || 0,
    edited: false,
    useCount: 0,
    updatedAt: Date.now(),
    updatedBy: 'seed',
  };
}

function normalizePlaybook(p) {
  const obj = p && typeof p === 'object' ? p : {};
  return {
    platform: String(obj.platform || ''),
    label: String(obj.label || obj.platform || ''),
    procedure: clamp(obj.procedure, MAX_PROCEDURE),
    tips: clamp(obj.tips, MAX_TIPS),
    source: ['builtin', 'learned', 'user'].includes(obj.source) ? obj.source : 'user',
    seedVersion: Number(obj.seedVersion) || 0,
    edited: Boolean(obj.edited),
    useCount: Number(obj.useCount) || 0,
    updatedAt: Number(obj.updatedAt) || 0,
    updatedBy: ['seed', 'agent', 'user'].includes(obj.updatedBy) ? obj.updatedBy : 'user',
  };
}

// -------------------------------------------------------------- site notes

/** One stored row, clamped. Shared with importAllData so the two cannot drift. */
function normalizeSiteNote(n) {
  return {
    host: String((n && n.host) || ''),
    platform: String((n && n.platform) || ''),
    notes: clamp(n && n.notes, MAX_SITE_NOTES, 'last'),
    updatedAt: Number((n && n.updatedAt) || 0),
  };
}

export async function getSiteNotes() {
  const stored = await get('siteNotes');
  if (!Array.isArray(stored)) return [];
  return stored.map(normalizeSiteNote).filter((n) => n.host && n.notes.length);
}

export async function getSiteNote(host) {
  if (!host) return null;
  const all = await getSiteNotes();
  return all.find((n) => n.host === host) || null;
}

/** Merge notes into the host's entry (deduped, capped). Empty result deletes it. */
export async function saveSiteNote(host, platform, notes) {
  return withPlaybookLock(() => saveSiteNoteImpl(host, platform, notes));
}

async function saveSiteNoteImpl(host, platform, notes) {
  const key = String(host || '').trim().toLowerCase().replace(/^www\./, '');
  if (!key) throw new Error('saveSiteNote needs a host.');

  const all = await getSiteNotes();
  const idx = all.findIndex((n) => n.host === key);
  const prev = idx >= 0 ? all[idx] : null;
  // Newest-wins on overflow, same reason as tips: a full note list must not go deaf.
  const { lines: merged, dropped } = cleanLines(
    [...(prev ? prev.notes : []), ...(notes || [])], MAX_SITE_NOTES, 'last'
  );

  if (!merged.length) {
    if (idx >= 0) {
      all.splice(idx, 1);
      await set('siteNotes', all);
    }
    return null;
  }

  const entry = {
    host: key,
    platform: String(platform || (prev && prev.platform) || ''),
    notes: merged,
    updatedAt: Date.now(),
  };
  if (idx >= 0) all[idx] = entry;
  else all.push(entry);
  await set('siteNotes', all);
  return { ...entry, dropped: describeDropped(dropped, 'note', MAX_SITE_NOTES) };
}

export async function deleteSiteNote(host) {
  return withPlaybookLock(() => deleteSiteNoteImpl(host));
}

async function deleteSiteNoteImpl(host) {
  const all = await getSiteNotes();
  await set('siteNotes', all.filter((n) => n.host !== host));
}

// ------------------------------------------------------------------ macros
// CONTRACT-V6 §2. Recorded demonstrations, keyed by PORTAL (never an employer —
// V3 §0). Caps live here, not in the recorder and not in the model: a page can
// dispatch events all day, and a macro is only ever as big as this layer allows.

const MACRO_CAPS = { perPlatform: 12, steps: 30, chars: 200 };

/**
 * Last line of defence for CONTRACT-V2 §0. The recorder already refuses to read a
 * credential's value (V6 §4), so nothing should ever arrive here carrying one — but this
 * is the layer that writes to disk, and a stored credential is unencrypted, cross-employer
 * and replayed forever. It is worth paying for the check twice.
 *
 * Deliberately mirrors content-script.js's looksSecretToRecord rather than importing it:
 * the content script is a page-world file with no module boundary to this one, and a
 * duplicated regex that drifts toward MORE caution is an acceptable price for a check
 * that survives a bug in the recorder.
 */
const SECRET_FIELD_HINT =
  /password|passcode|passphrase|\bpin\b|\botp\b|\bmfa\b|\b2fa\b|one-?time|verification|verify|authenticat|\bcvv\b|\bcvc\b|\bssn\b|social[\s_-]*security|security[\s_-]*(?:code|answer|question)|account[\s_-]*number|routing|card[\s_-]*number|\bsecret\b|\btoken\b/i;
const CODE_WORD = /\bcode\b/i;
const EVERYDAY_CODE = /postal|\bzip\b|post[\s_-]*code|area[\s_-]*code|country|phone|dial|promo|coupon|discount|referral|voucher|currency/i;

function stepLooksCredential(step) {
  const hay = [step.label || '', ...(step.locators || []).map((l) => `${l.value || ''}`)].join(' ');
  if (SECRET_FIELD_HINT.test(hay)) return true;
  return CODE_WORD.test(hay) && !EVERYDAY_CODE.test(hay);
}

/** Strip a step down to the fields §3 defines. Anything else the page invented is dropped. */
function sanitizeStep(step) {
  if (!step || typeof step !== 'object') return null;
  const action = String(step.action || '');
  if (!['fill', 'click', 'choose_option', 'select_option', 'set_checkbox', 'request_secret'].includes(action)) {
    return null;
  }
  const locators = (Array.isArray(step.locators) ? step.locators : [])
    .filter((l) => l && typeof l === 'object' && typeof l.by === 'string')
    .slice(0, 6)
    .map((l) => ({
      by: String(l.by).slice(0, 20),
      value: String(l.value ?? '').slice(0, MACRO_CAPS.chars),
      ...(l.tag ? { tag: String(l.tag).slice(0, 20) } : {}),
    }));
  if (!locators.length) return null;

  const out = { action, locators, label: String(step.label ?? action).slice(0, MACRO_CAPS.chars) };

  // CONTRACT-V6 §8 — the frame the step was DEMONSTRATED in, so replayStep can try it
  // first. Dropping it here made that preference dead code for every saved macro: a step
  // performed inside an embedded ATS iframe would be re-run against the outer employer
  // page, match a lookalike field there, and report success having filled the wrong form.
  //
  // A bare hostname is safe to persist — no path, no query, nothing user-authored — so
  // this does not reopen the V3 §4.1 scrub. Anything that is not a plain hostname is
  // dropped rather than trusted.
  if (typeof step.host === 'string' && /^[a-z0-9.-]{1,253}$/i.test(step.host)) out.host = step.host;

  // A step that fills a credential-looking field is rewritten into a request_secret step —
  // its value is dropped, not stored, whatever the recorder thought. A macro must never be
  // able to type a recorded credential into a live login form.
  if (action !== 'request_secret' && action !== 'click' && stepLooksCredential(out)) {
    return {
      action: 'request_secret',
      locators,
      ...(out.host ? { host: out.host } : {}),
      secretKind: /one-?time|\botp\b|\bmfa\b|\b2fa\b|\bcode\b|authenticat|verif/i.test(out.label) ? 'otp' : 'password',
      label: out.label.replace(/\s*=\s*".*"$/, ''), // never carry the value through the label either
    };
  }

  if (action === 'request_secret') {
    // CONTRACT-V2 §0 / V6 §4: a secret step carries a KIND and never a value. Even if
    // something upstream tried to smuggle one in, it does not survive this layer.
    out.secretKind = ['password', 'otp', 'other'].includes(step.secretKind) ? step.secretKind : 'other';
    return out;
  }
  if (action === 'set_checkbox') out.checked = Boolean(step.checked);
  else if (step.valueFrom) out.valueFrom = String(step.valueFrom).slice(0, 60);
  else if (step.value != null) out.value = String(step.value).slice(0, MACRO_CAPS.chars);
  if (step.irreversible) out.irreversible = true;
  return out;
}

export async function getMacros() {
  const stored = await get('macros');
  return Array.isArray(stored) ? stored : [];
}

/** Macros for one portal, most-used first. */
export async function getMacrosFor(platform) {
  if (!platform) return [];
  const all = await getMacros();
  return all
    .filter((m) => m.platform === platform)
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0));
}

/**
 * Macros are read-whole-array / modify / write-whole-array, exactly like playbooks, and
 * the interleavings are just as real: `markMacroResult` fires as a run ends while the user
 * deletes a macro in the Memory tab, or two macros finish at once. The later write commits
 * a snapshot taken before the earlier one, so a deleted macro comes back or a recorded one
 * vanishes. Same chain, same reason — see withPlaybookLock.
 */
export async function saveMacro(input) {
  return withPlaybookLock(() => saveMacroLocked(input));
}

async function saveMacroLocked(input) {
  const platform = String(input.platform || '').trim().toLowerCase();
  const name = String(input.name || '').trim().slice(0, 80);
  if (!platform || !name) throw new Error('A macro needs a platform and a name.');

  const steps = (Array.isArray(input.steps) ? input.steps : [])
    .map(sanitizeStep)
    .filter(Boolean)
    .slice(0, MACRO_CAPS.steps);
  if (!steps.length) throw new Error('That recording captured no usable steps.');

  const all = await getMacros();
  const key = (m) => m.platform === platform && m.name.toLowerCase() === name.toLowerCase();
  const existing = all.find(key);
  const macro = {
    platform,
    name,
    goal: String(input.goal || existing?.goal || '').slice(0, MACRO_CAPS.chars),
    steps,
    status: 'unverified', // V6 §1: never replayed on the page it was recorded on
    createdAt: existing?.createdAt || Date.now(),
    updatedAt: Date.now(),
    useCount: existing?.useCount || 0,
    lastError: '',
  };

  const rest = all.filter((m) => !key(m));
  const mine = rest.filter((m) => m.platform === platform);
  // Cap per portal: drop the least-used to make room, never silently refuse the new one.
  if (mine.length >= MACRO_CAPS.perPlatform) {
    const doomed = mine.sort((a, b) => (a.useCount || 0) - (b.useCount || 0))[0];
    const i = rest.indexOf(doomed);
    if (i >= 0) rest.splice(i, 1);
  }
  await set('macros', [...rest, macro]);
  return macro;
}

/** Record the outcome of a replay. A macro that failed says so — V3 §7.1. */
export async function markMacroResult(platform, name, ok, error = '') {
  return withPlaybookLock(async () => {
    const all = await getMacros();
    const macro = all.find((m) => m.platform === platform && m.name === name);
    if (!macro) return;
    macro.status = ok ? 'working' : 'broken';
    macro.lastError = ok ? '' : String(error || '').slice(0, MACRO_CAPS.chars);
    if (ok) macro.useCount = (macro.useCount || 0) + 1;
    macro.updatedAt = Date.now();
    await set('macros', all);
  });
}

export async function deleteMacro(platform, name) {
  return withPlaybookLock(async () => {
    const all = await getMacros();
    await set('macros', all.filter((m) => !(m.platform === platform && m.name === name)));
  });
}

/** The encrypted vault blob (contract §3), or undefined when no vault exists. */
export async function getVaultBlob() {
  return get('vault');
}

export async function setVaultBlob(blob) {
  await set('vault', blob);
}

export async function clearVaultBlob() {
  await chrome.storage.local.remove('vault');
}

export async function clearAllData() {
  await chrome.storage.local.remove([...BACKUP_KEYS]);
}

// ------------------------------------------------------------ backup / restore
//
// WHY THIS EXISTS: an unpacked extension's id is derived from the FOLDER Chrome loaded it
// from, and chrome.storage.local is keyed by that id. Moving the extension — repo root to
// dist/ after the Vite migration, one machine to another, a re-clone into a new path — is
// a new id and therefore an empty profile, an empty memory bank and a lost vault, with the
// old data still on disk under an id nothing points at any more. Nothing in the panel could
// carry data across that line, so the only answer was a DevTools console snippet.
//
// The file is the whole of chrome.storage.local that JobPilot owns, wrapped in an envelope
// that says what it is. Restoring is a REPLACE, not a merge: see importAllData.

/**
 * Every key JobPilot owns in chrome.storage.local. This list is the single definition of
 * "all my data" — clearAllData wipes exactly it, exportAllData reads exactly it, and
 * importAllData refuses to write anything outside it.
 *
 * A new key belongs HERE, not in one of the three call sites. That is the point of the
 * const: a key added to the wipe list but forgotten in the backup list is a key that
 * survives "Clear ALL data" in a backup file and silently comes back on the next restore.
 *
 * NOT included, deliberately: chrome.storage.session (the recorder's in-flight session —
 * memory-only by design, and meaningless once the panel that was recording is gone).
 */
export const BACKUP_KEYS = Object.freeze([
  'settings', 'profile', 'documents', 'chatHistory', 'vault', 'playbooks', 'siteNotes', 'macros',
  // The application log. Additive, so no BACKUP_FORMAT bump: an older build importing a
  // newer file simply does not restore this key, which loses tracker rows it could not
  // display anyway — not user data it silently corrupts.
  'applications',
]);

/**
 * Envelope version. Bump ONLY when a stored shape changes in a way importAllData has to
 * branch on; the per-key normalizers below already absorb additive changes, because they
 * merge onto the current defaults.
 *
 * 2 — `chatHistory` became {v:2, runs:{...}} so concurrent runs get their own transcripts.
 * This bump is NOT bookkeeping. Reading is backward compatible (normalizeChats takes a v1
 * bare array), but writing is not FORWARD compatible: a v1 build's importer does
 * `Array.isArray(raw) ? … : []` and would restore this file with every transcript silently
 * gone. parseBackup refuses `format > BACKUP_FORMAT` with a readable message, so the bump
 * turns silent data loss into a version error the user can act on.
 */
export const BACKUP_FORMAT = 2;

/**
 * The whole of JobPilot's storage, ready to be JSON.stringify'd into a file.
 *
 * Reads RAW through chrome.storage.local rather than through getPlaybooks() / getSiteNotes(),
 * and that is load-bearing for playbooks: getPlaybooks() drops tombstones from what it
 * returns (they are bookkeeping, not playbooks) and re-seeds anything missing. Exporting its
 * output would therefore lose every "I deleted this seeded playbook" tombstone, and the
 * restore would hand the user back the Workday playbook they deleted on purpose.
 *
 * SECRETS: the file contains the API key in clear and the vault blob as-is. The vault blob
 * is still PBKDF2+AES-GCM ciphertext and its passphrase is not in the file — but the API key
 * is plain text, which is why every UI path to this function says so out loud.
 */
export async function exportAllData() {
  const data = await chrome.storage.local.get([...BACKUP_KEYS]);
  let version = '';
  try {
    version = chrome.runtime.getManifest().version;
  } catch {
    /* not running as an extension (tests) — the envelope does not need it */
  }
  return {
    jobpilot: 'backup',
    format: BACKUP_FORMAT,
    exportedAt: Date.now(),
    version,
    // Only the keys that actually exist. A never-used install should export a small file
    // that says so, not eight nulls.
    data,
  };
}

/**
 * Turn the text of a backup file into the `data` bag importAllData takes.
 *
 * Accepts TWO shapes on purpose:
 *   1. the envelope exportAllData() writes, and
 *   2. a bare `chrome.storage.local.get(null)` dump — which is what anyone who rescued
 *      their data from an older build with a DevTools one-liner has in hand. Refusing it
 *      would make this feature useless to the exact migration it was written for.
 *
 * Throws with a readable message rather than returning null: every caller shows it to the
 * user, and "Unexpected token < in JSON at position 0" is not a message about their file.
 *
 * @param {string} text
 * @returns {{data: Record<string, unknown>, meta: {format:number, exportedAt:number, version:string, bare:boolean}}}
 */
export function parseBackup(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('That file is not JSON. Pick the .json file the Export button saved.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('That file does not contain a JobPilot backup.');
  }

  const envelope = parsed.jobpilot === 'backup' && parsed.data && typeof parsed.data === 'object';
  const data = envelope ? parsed.data : parsed;

  // A file written by a NEWER JobPilot may hold shapes the normalizers below would quietly
  // flatten. Refusing is the honest outcome — a half-understood restore is worse than none.
  const format = envelope ? Number(parsed.format) || 0 : 0;
  if (format > BACKUP_FORMAT) {
    throw new Error(
      `That backup was written by a newer JobPilot (format ${format}). Update the extension first.`,
    );
  }

  const known = BACKUP_KEYS.filter((k) => data[k] !== undefined);
  if (!known.length) {
    throw new Error('That file has none of JobPilot\'s data in it — nothing to restore.');
  }

  return {
    data,
    meta: {
      format,
      exportedAt: Number(envelope ? parsed.exportedAt : 0) || 0,
      version: String((envelope && parsed.version) || ''),
      // True when it came from a raw console dump, which the UI mentions so a user who
      // picked the wrong file has one more chance to notice.
      bare: !envelope,
    },
  };
}

/**
 * `typeof [] === 'object'` and `typeof null === 'object'`, and both would spread onto the
 * defaults — an array leaves numeric keys behind in what gets written. Settings and profile
 * are the two keys that are objects rather than arrays, so both go through this first.
 */
function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

/** Documents hold the uploaded bytes; a row without them cannot be uploaded to a form. */
function normalizeDocuments(value) {
  if (!Array.isArray(value)) return [];
  const docs = value
    .filter((d) => d && typeof d === 'object' && d.dataBase64)
    .map((d) => ({
      id: String(d.id || crypto.randomUUID()),
      name: String(d.name || 'document'),
      mime: String(d.mime || 'application/octet-stream'),
      size: Number(d.size) || 0,
      dataBase64: String(d.dataBase64),
      text: typeof d.text === 'string' ? d.text : '',
      textError: typeof d.textError === 'string' ? d.textError : '',
      isDefault: Boolean(d.isDefault),
      addedAt: Number(d.addedAt) || Date.now(),
    }));
  // saveDocument's invariant: exactly one default, and never zero while a document exists.
  // A hand-edited backup can arrive with none or with three.
  const firstDefault = docs.findIndex((d) => d.isDefault);
  const chosen = firstDefault >= 0 ? firstDefault : 0;
  docs.forEach((d, i) => { d.isDefault = i === chosen; });
  return docs;
}

/**
 * Playbooks, tombstones included.
 *
 * A tombstone is `{platform, deleted:true}` and carries no other field, so it is normalized
 * separately — putting one through normalizePlaybook() would give it a label and an empty
 * procedure, and getPlaybooks() would stop reading it as a tombstone and re-seed the very
 * playbook the user deleted.
 */
function normalizePlaybooks(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((p) => p && typeof p === 'object' && p.platform)
    .map((p) => (p.deleted
      ? { platform: String(p.platform), deleted: true }
      : normalizePlaybook(p)));
}

/**
 * Macros — the one key with no normalization on the READ path (getMacros returns the stored
 * array as-is), so this is the only thing standing between a hand-edited backup file and
 * what run_macro will replay against a live page. Every step goes through sanitizeStep, the
 * same CONTRACT-V2 §0 filter saveMacro uses: unknown actions dropped, locators capped, a
 * host that is not a bare hostname dropped, and any step that looks like it types a
 * credential rewritten into a request_secret that carries no value.
 */
function normalizeMacros(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const byPlatform = new Map();
  for (const m of value) {
    if (!m || typeof m !== 'object') continue;
    const platform = String(m.platform || '').trim().toLowerCase();
    const name = String(m.name || '').trim().slice(0, 80);
    if (!platform || !name) continue;
    const steps = (Array.isArray(m.steps) ? m.steps : [])
      .map(sanitizeStep)
      .filter(Boolean)
      .slice(0, MACRO_CAPS.steps);
    if (!steps.length) continue;
    // saveMacroLocked's per-portal cap, applied here too: a backup must not be a way to
    // install 500 macros for one platform.
    const count = byPlatform.get(platform) || 0;
    if (count >= MACRO_CAPS.perPlatform) continue;
    byPlatform.set(platform, count + 1);
    out.push({
      platform,
      name,
      goal: String(m.goal || '').slice(0, MACRO_CAPS.chars),
      steps,
      status: ['working', 'broken', 'unverified'].includes(m.status) ? m.status : 'unverified',
      createdAt: Number(m.createdAt) || Date.now(),
      updatedAt: Number(m.updatedAt) || Date.now(),
      useCount: Number(m.useCount) || 0,
      lastError: String(m.lastError || '').slice(0, MACRO_CAPS.chars),
    });
  }
  return out;
}

/**
 * A vault blob is opaque ciphertext to everything except vault.js, so all that can be
 * checked here is that it has the SHAPE vault.js's unlock() reads. That check is worth
 * having: writing a malformed blob makes the vault permanently "initialized" and every
 * unlock attempt throws instead of returning false, which reads to the user as "my
 * passphrase stopped working" with no way back except Clear ALL data.
 *
 * @returns {object|null} the blob when usable, null when it should be skipped.
 */
function normalizeVaultBlob(blob) {
  if (!blob || typeof blob !== 'object') return null;
  if (blob.protected) {
    const kdf = blob.kdf;
    const ok = kdf && typeof kdf.salt === 'string' && Number(kdf.iterations) > 0
      && typeof blob.iv === 'string' && typeof blob.ct === 'string';
    return ok ? blob : null;
  }
  return Array.isArray(blob.entries) ? blob : null;
}

/**
 * Restore a parsed backup. This REPLACES JobPilot's storage — it is not a merge.
 *
 * Replace rather than merge is a decision, not a shortcut. Every key has its own idea of
 * what merging would mean (savedAnswers by question, documents by id, playbooks by
 * platform, macros by platform+name) and the vault has none at all — two blobs are two
 * different keys and only one passphrase can hold. Worse, a partial restore leaves
 * combinations that never existed: yesterday's vault against today's profile, so credentials
 * for accounts the profile no longer mentions. "This file, exactly" is the only restore with
 * a meaning the user can predict.
 *
 * A key ABSENT from the backup is therefore removed, not left alone.
 *
 * Writes once, at the end. Normalizing first means a malformed key throws before anything
 * has been written, instead of leaving storage half-replaced.
 *
 * @param {Record<string, unknown>} data  the `data` bag from parseBackup()
 * @returns {Promise<{restored: string[], skipped: {key:string, reason:string}[]}>}
 */
export async function importAllData(data) {
  const next = {};
  const remove = [];
  const skipped = [];

  for (const key of BACKUP_KEYS) {
    const raw = data[key];
    if (raw === undefined || raw === null) {
      remove.push(key);
      continue;
    }
    switch (key) {
      case 'settings':
        next.settings = normalizeSettings(isPlainObject(raw) ? raw : {});
        break;
      case 'profile':
        next.profile = normalizeProfile(isPlainObject(raw) ? raw : {});
        break;
      case 'documents':
        next.documents = normalizeDocuments(raw);
        break;
      case 'chatHistory':
        // The same caps saveChats applies, per run and in total. An unbounded transcript in
        // the file must not become an unbounded transcript on disk. normalizeChats also
        // absorbs the v1 bare array, so an older backup restores into the default run.
        next.chatHistory = normalizeChats(raw);
        break;
      case 'playbooks':
        next.playbooks = normalizePlaybooks(raw);
        break;
      case 'siteNotes':
        next.siteNotes = Array.isArray(raw)
          ? raw.map(normalizeSiteNote).filter((n) => n.host && n.notes.length)
          : [];
        break;
      case 'macros':
        next.macros = normalizeMacros(raw);
        break;
      case 'applications':
        next.applications = normalizeApplications(raw);
        break;
      case 'vault': {
        const blob = normalizeVaultBlob(raw);
        if (blob) {
          next.vault = blob;
        } else {
          // The ONE exception to replace-means-replace, and only for the case where the file
          // says it HAS a vault and this code cannot read it. That is a failure to restore,
          // not an instruction to delete: destroying a working set of credentials over a
          // parse error is unrecoverable, while keeping them is visible and reversible. It
          // is reported so the toast can say the vault did not come across.
          //
          // A backup with NO vault key is a different thing entirely — it is a snapshot of
          // an install that had no vault, and it falls through to the removal below like
          // every other absent key.
          skipped.push({ key: 'vault', reason: 'the file\'s vault blob could not be read' });
        }
        break;
      }
      default:
        break;
    }
  }

  // Everything the file did not carry goes away — see the "replace, not merge" note above.
  if (remove.length) await chrome.storage.local.remove(remove);
  await chrome.storage.local.set(next);

  return { restored: Object.keys(next), skipped };
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
