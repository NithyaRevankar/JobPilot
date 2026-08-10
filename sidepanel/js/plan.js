// plan.js — Plan mode (CONTRACT-V11): read the whole page, agree what goes in it ONCE,
// then fill it without stopping.
//
// THE PROBLEM. A six-page Workday wizard used to cost the user fifteen interruptions,
// because unknowns are discovered the way the model walks the form: fill three fields, hit
// a question, ask, fill two more, hit another. Rule 6 already tells the model to read the
// whole form and batch its ask_user calls, and that helps — but it only ever batches the
// things it CANNOT answer. Everything it *can* answer is filled silently, and the user
// finds out what was entered on their behalf afterwards, from an activity log, one row at
// a time.
//
// So plan mode changes the unit of interaction from "a question" to "a page". The model
// proposes every value it intends to enter AND every question it cannot answer, in one
// call. The panel shows both in one card. The user corrects, unticks, answers, approves —
// and the whole page is then filled in a single tool call.
//
// WHY THE PANEL EXECUTES, AND NOT THE MODEL. If propose_plan merely returned an approved
// plan, the model would spend one step per field re-issuing fills it has already written
// down — twenty steps and twenty round-trips to do what it just described. So the approved
// entries are executed here. They are executed by dispatching each one through the ORDINARY
// executeTool path, not through some new page-side batch endpoint: every guard that makes
// `fill` safe (the credential refusal, the hidden/honeypot refusal, the framework-safe
// setter, the focus-loss commit, the stale-ref snapshot) is in that path already, and a
// second entrance beside it would be a second thing to keep correct.
//
// WHAT IS DELIBERATELY NOT HERE. The plan does not carry "…and then submit". The
// confirmation before a final submit is its own flow (rule 8) and it is the one guard the
// user is most likely to be relying on; folding it into a card whose primary button says
// "Fill 14 fields" would make the most consequential click in the extension a side effect
// of an ordinary one. Merging the two is a later change, if it is one at all.
//
// Dependency-free and DOM-free, like the rest of sidepanel/js — the node harness drives
// every function in this file without a browser.

import { PROFILE_LABELS } from './prompts.js';

/**
 * How many fields one plan may carry.
 *
 * Much higher than ask_user's MAX_QUESTIONS (8) and for the opposite reason. Eight boxes is
 * a wall because every one of them is WORK: the user has to compose an answer. A plan row
 * is mostly READING — the value is already filled in, and the common action is to skim and
 * approve. The card scrolls. What this cap actually protects is the tool result and the
 * execution time, not the user's patience.
 */
export const MAX_PLAN_FILLS = 40;

/**
 * The tools a plan entry may use. Exactly the four that put a VALUE into a form control.
 *
 * `click` is not here, and that is the whole point of the list rather than an oversight: a
 * plan is a description of what a page will contain when it is filled, and a click is not a
 * value — it is navigation, an accordion, a "Next", or a submit. Approving "Country =
 * India" is a thing a user can meaningfully read and agree to; approving "click e47" is
 * not, and a card full of those would train people to approve without reading, which is the
 * failure mode this feature exists to remove.
 *
 * `upload_file` is excluded for a different reason: it needs a document id rather than a
 * value, the model handles it in one call already, and it is the single action a user is
 * most likely to want to see land on its own.
 */
export const PLAN_FILL_TOOLS = Object.freeze(['fill', 'select_option', 'choose_option', 'set_checkbox']);
const PLAN_TOOL_SET = new Set(PLAN_FILL_TOOLS);

/** `e12`, or `f381:e12` for a control inside an iframe. Same shape parseRef accepts. */
const REF_RE = /^(?:f\d+:)?e\d+$/;

/**
 * Labels that suggest the entry is a credential.
 *
 * DEFENCE IN DEPTH, NOT THE GUARD. The real refusal lives in the content script, which
 * rejects a non-secret `fill` on a password or one-time-code field and cannot be talked out
 * of it by anything the model sends. This is here because plan mode adds something new: a
 * SCREEN that displays the value before it is typed. A model that mistakenly put a password
 * in a plan would have it rendered into a card, and a rendered credential is a leaked one
 * even if the fill downstream is refused a moment later. So a plausible-looking credential
 * entry never reaches the card at all.
 */
const CREDENTIAL_LABEL = /\b(?:pass(?:word|code|phrase)|\bpin\b|otp|one[-\s]?time|2fa|mfa|auth(?:enticator)? code|verification code|security (?:code|answer|question)|secret)\b/i;

/**
 * The scalar profile keys a proposed value can be traced back to.
 *
 * Taken from prompts.js rather than re-listed, because these are exactly the fields the
 * model was GIVEN — a value can only be "from your profile" if the profile is where the
 * model read it. Listing them twice would let the two drift, and the drift would show up as
 * a row labelled "inferred" that came straight out of the profile, which is precisely the
 * label the user is being asked to pay attention to.
 */
const PROFILE_KEYS = Object.keys(PROFILE_LABELS);

// ------------------------------------------------------------------ normalize

/**
 * The `fills` array of a propose_plan call, sanitized into entries this module will execute.
 *
 * Every rejection produces a REASON rather than a silent drop. A model that had three
 * entries thrown away and was told "saved 11 fields" will keep sending the same malformed
 * three on the next page, and the user will keep finding three empty boxes with nothing
 * anywhere saying why.
 *
 * @param {unknown} raw  args.fills, straight off the wire — any shape
 * @returns {{fills: {ref:string,label:string,value:string,tool:string}[],
 *            dropped: number, refused: string[]}}
 *   `dropped` counts entries lost to the cap (the model is told to plan the rest in a
 *   second call); `refused` names the reasons entries were rejected outright.
 */
export function normalizePlanFills(raw) {
  const list = Array.isArray(raw) ? raw : [];
  /** ref -> index in `fills`, so a repeated ref REPLACES rather than filling twice. */
  const seen = new Map();
  const fills = [];
  const refused = [];
  let dropped = 0;

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      refused.push('an entry that was not an object');
      continue;
    }
    const ref = String(item.ref ?? '').trim();
    if (!REF_RE.test(ref)) {
      refused.push(`an entry with an unusable ref (${ref ? `"${truncate(ref, 20)}"` : 'missing'}) — refs look like e12 or f381:e12`);
      continue;
    }
    const tool = String(item.tool ?? 'fill').trim() || 'fill';
    if (!PLAN_TOOL_SET.has(tool)) {
      refused.push(`an entry using "${truncate(tool, 20)}", which a plan cannot carry — a plan holds values (${PLAN_FILL_TOOLS.join(', ')}), not clicks or uploads`);
      continue;
    }
    const label = String(item.label ?? '').trim() || ref;
    if (CREDENTIAL_LABEL.test(label)) {
      refused.push(`"${truncate(label, 30)}" — a credential can never go in a plan; use request_secret for it`);
      continue;
    }
    const value = planValueOf(tool, item.value);
    // An empty value is not an error, it is just nothing to do — and a plan padded with
    // blank rows is a card the user has to read past. Say so, so the model stops sending it.
    if (!value) {
      refused.push(`"${truncate(label, 30)}" — it carried no value, so there was nothing to fill`);
      continue;
    }

    const at = seen.get(ref);
    if (at !== undefined) {
      // The later entry wins: two rows for one ref is the model correcting itself, and the
      // correction is the one it meant. Filling twice would also be visibly wrong on a
      // checkbox, where the second write undoes the first.
      fills[at] = { ref, label, value, tool };
      continue;
    }
    if (fills.length >= MAX_PLAN_FILLS) { dropped++; continue; }
    seen.set(ref, fills.length);
    fills.push({ ref, label, value, tool });
  }

  return { fills, dropped, refused: dedupe(refused) };
}

/**
 * The value a plan entry carries, as a string the card can display and edit.
 *
 * `set_checkbox` is the odd one: its wire form is a boolean, but a card row showing an
 * unlabelled `true` is not something a person can check at a glance, and an editable box
 * containing `true` invites them to type something that is not a boolean. So it is carried
 * as Yes/No throughout and converted back at execution (planArgsFor).
 */
function planValueOf(tool, raw) {
  if (tool === 'set_checkbox') {
    if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
    const s = String(raw ?? '').trim().toLowerCase();
    if (!s) return '';
    return /^(?:y|yes|true|1|on|check(?:ed)?|tick(?:ed)?)$/.test(s) ? 'Yes' : 'No';
  }
  return String(raw ?? '').trim();
}

/** True when a Yes/No plan value means checked. The one definition, used by both sides. */
export function isCheckedValue(value) {
  return /^(?:y|yes|true|1|on|check(?:ed)?|tick(?:ed)?)$/i.test(String(value ?? '').trim());
}

/**
 * The executeTool arguments for one approved entry.
 *
 * Kept next to normalizePlanFills so the encoding above and the decoding here can never be
 * changed independently of each other.
 */
export function planArgsFor(entry) {
  const ref = entry.ref;
  switch (entry.tool) {
    case 'select_option':
    case 'choose_option':
      return { ref, option: entry.value };
    case 'set_checkbox':
      return { ref, checked: isCheckedValue(entry.value) };
    default:
      return { ref, value: entry.value };
  }
}

// ----------------------------------------------------------------- provenance

/**
 * Where a proposed value came from — computed, never taken on the model's word.
 *
 * WHY NOT JUST ASK THE MODEL. It would be one more optional field on the tool and it would
 * usually be right. But the entire job of the source chip is to tell the user which rows
 * are worth reading: "from your profile · Phone" means skim it, "inferred" means look. A
 * self-reported source is exactly as trustworthy as the value it is labelling, so a wrong
 * value would arrive wearing the badge that says "you do not need to check this". Matching
 * the value against the profile the model was given is cheap, needs no trust, and cannot be
 * talked into the wrong answer by anything on the page.
 *
 * Matching is deliberately loose on presentation and strict on content: case and internal
 * whitespace are normalized away (a form wanting "INDIA" is still the profile's "India"),
 * but nothing is fuzzy-matched. A value that is *nearly* the profile's is a value the model
 * changed, and a changed value is the kind the user most wants flagged.
 *
 * @param {string} value
 * @param {object} profile
 * @returns {{source:'profile'|'saved'|'inferred', detail:string}}
 */
export function provenanceOf(value, profile) {
  const needle = normalizeForMatch(value);
  if (!needle) return { source: 'inferred', detail: '' };
  const p = profile && typeof profile === 'object' ? profile : {};

  for (const key of PROFILE_KEYS) {
    if (normalizeForMatch(p[key]) === needle) {
      return { source: 'profile', detail: PROFILE_LABELS[key] };
    }
  }

  // The derivations rule 6 explicitly asks for. A form with separate First/Last boxes is
  // the single most common form there is, so without this the two most ordinary rows on
  // every application would be badged "inferred" — and a chip that cries wolf on the name
  // fields is a chip nobody reads by the third application.
  const name = String(p.fullName || '').trim().split(/\s+/).filter(Boolean);
  if (name.length > 1) {
    if (normalizeForMatch(name[0]) === needle) return { source: 'profile', detail: 'first name' };
    if (normalizeForMatch(name[name.length - 1]) === needle) return { source: 'profile', detail: 'last name' };
  }

  const saved = Array.isArray(p.savedAnswers) ? p.savedAnswers : [];
  for (const row of saved) {
    if (row && normalizeForMatch(row.a) === needle) {
      return { source: 'saved', detail: truncate(String(row.q || '').trim(), 40) };
    }
  }

  return { source: 'inferred', detail: '' };
}

/** Case-folded, whitespace-collapsed. Presentation differences only — never fuzzy. */
function normalizeForMatch(v) {
  return String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Rows the user should actually read: the ones no profile value backs. */
export function inferredCount(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r && r.source === 'inferred').length;
}

// --------------------------------------------------------------- tool result

/**
 * What the model is told after a plan ran.
 *
 * Three things it MUST be able to work out from this string, because getting any of them
 * wrong costs the user a visible mistake:
 *
 *   1. Which fields are done — so it does not fill them again. A re-fill on a checkbox
 *      unchecks it, and on a typeahead it opens a menu over the next control.
 *   2. Which the USER unticked — and that this was a decision, not a failure. The model's
 *      instinct on seeing an unfilled field is to fill it; that instinct is wrong here and
 *      has to be countermanded explicitly, exactly as a blank ask_user answer is.
 *   3. Which genuinely failed, with the error, so it can go down the ladder (rule 4) on
 *      those and only those.
 *
 * @param {{results: {entry:object, status:'ok'|'skipped'|'failed', detail?:string}[],
 *          answers?: string[], unknowns?: object[], dropped?: number, refused?: string[],
 *          autoApproved?: boolean, stopped?: boolean}} input
 */
export function formatPlanResult({
  results = [], answers = null, unknowns = [], dropped = 0, refused = [],
  autoApproved = false, stopped = false,
}) {
  const filled = results.filter((r) => r.status === 'ok');
  const skipped = results.filter((r) => r.status === 'skipped');
  const failed = results.filter((r) => r.status === 'failed');
  const lines = [];

  lines.push(autoApproved
    ? `Plan executed automatically (no unknowns, every value came from the profile): ${filled.length} of ${results.length} fields filled.`
    : `Plan approved by the user: ${filled.length} of ${results.length} fields filled.`);

  if (filled.length) {
    lines.push('Filled — do NOT fill these again:');
    for (const r of filled) lines.push(`  ✓ ${r.entry.label} (${r.entry.ref}) = "${truncate(r.entry.value, 60)}"`);
  }

  if (skipped.length) {
    lines.push(
      'The USER unticked these — that is a decision, not an oversight. Leave them empty, ' +
      'do not fill them, and do not ask about them:'
    );
    for (const r of skipped) lines.push(`  – ${r.entry.label} (${r.entry.ref})`);
  }

  if (failed.length) {
    lines.push('FAILED — these still need you. Read each error and go down the ladder (inspect_dom → dom_act) rather than repeating the same call:');
    for (const r of failed) lines.push(`  ✗ ${r.entry.label} (${r.entry.ref}): ${firstLine(r.detail)}`);
  }

  if (stopped) lines.push('The run was stopped part-way through, so anything not listed above was never attempted.');

  // The answers ride in the same result as the fills, because they were collected in the
  // same card. Formatting them exactly as formatAnswers does keeps one shape for "what the
  // user told you" regardless of which tool asked.
  if (Array.isArray(answers) && unknowns.length) {
    lines.push('The user answered your questions:');
    const blanks = [];
    unknowns.forEach((q, i) => {
      const a = String(answers[i] ?? '').trim();
      lines.push(`  ${i + 1}. ${q.question} → ${a ? `"${a}"` : '(left blank)'}`);
      if (!a) blanks.push(i + 1);
    });
    if (blanks.length) {
      lines.push(
        `  Blank (${blanks.join(', ')}) means the user chose not to answer: leave that field empty or use the ` +
        'form\'s skip/decline option, and do NOT ask again.'
      );
    }
    lines.push('Now fill those answers in with fill/select_option/choose_option — they are NOT filled yet.');
  }

  if (dropped > 0) {
    lines.push(`${dropped} more field(s) did not fit in one plan (the cap is ${MAX_PLAN_FILLS}). Call propose_plan again for the rest.`);
  }
  if (refused.length) {
    lines.push(`Rejected before the user saw them: ${refused.join('; ')}.`);
  }

  return lines.join('\n');
}

/** The activity-row label for a plan, e.g. `plan: 12 fields, 2 questions`. */
export function planLabel(args) {
  const fills = Array.isArray(args && args.fills) ? args.fills.length : 0;
  const unknowns = Array.isArray(args && args.unknowns) ? args.unknowns.length : 0;
  const parts = [];
  if (fills) parts.push(`${fills} field${fills === 1 ? '' : 's'}`);
  if (unknowns) parts.push(`${unknowns} question${unknowns === 1 ? '' : 's'}`);
  return `plan: ${parts.join(', ') || 'empty'}`;
}

// ---------------------------------------------------------------- the gate

/**
 * The refusal that turns "you should plan first" from prose into something that happened.
 *
 * Fired at most ONCE per run, on the first value-writing tool call made without a plan.
 * That bound is the design, not a shortcut. Hard enforcement — refusing every unplanned
 * fill for the life of the run — sounds stricter and is worse: a model that cannot produce
 * a plan the normaliser accepts (a portal whose refs keep going stale under it, a page it
 * can only read in fragments) would be refused forever and the run would die on a form it
 * was perfectly capable of filling. One refusal is enough to redirect a model that simply
 * had not reached for the tool yet; a model that comes back and fills anyway has told us
 * planning does not fit this page, and a filled application beats an unfilled one.
 */
export const PLAN_GATE_MESSAGE =
  'Plan mode is on, and this is the first value you have tried to write on this page. ' +
  'Stop and call propose_plan FIRST: read the whole form, then send EVERY field you intend to fill ' +
  '(fills: [{ref, label, value, tool}]) together with EVERY question you cannot answer from the profile, ' +
  'the resume or the saved answers (unknowns: [{question, options}]). The user reviews the lot in one card, ' +
  'and the approved fields are then filled for you in that single call — you do not fill them again afterwards. ' +
  'This refusal happens once: if propose_plan genuinely will not work on this page, retry this call and it will go through.';

// ------------------------------------------------------------------ helpers

function dedupe(list) {
  return [...new Set(list)];
}

function truncate(v, n) {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** Tool errors carry a fresh page snapshot on the following lines; the first line is the why. */
function firstLine(msg) {
  const s = String(msg ?? '').trim();
  const nl = s.indexOf('\n');
  return nl >= 0 ? s.slice(0, nl) : s;
}
