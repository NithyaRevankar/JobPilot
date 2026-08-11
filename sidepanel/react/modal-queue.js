/**
 * modal-queue.js — the modal state machine, with no React in it.
 *
 * WHY THIS IS ITS OWN FILE. openAsk() and openConfirm() are the interface sidepanel/js/
 * agent.js awaits from onAskUser / onRequestSecret, and agent.js is not React. What they
 * are, underneath, is a promise queue with three rules — one modal open at a time, later
 * requests wait their turn, and Stop resolves every one of them with null — and none of
 * those rules involve rendering. Modal.jsx subscribes to this and draws whatever is at the
 * head; that is the whole of its relationship to it.
 *
 * Splitting it out is not tidiness. This file is plain ES modules with no JSX, so `node`
 * can import it directly, and test/react-harness.mjs drives the FIFO ordering, the
 * settle-exactly-once rule and closeAllModals() with no browser at all. As a const inside
 * Modal.jsx the same logic needed a bundler and a DOM to reach, so it was never tested —
 * and it is the piece a stopped run deadlocks on if it is wrong.
 *
 * The field-value helpers live here for the same reason: `collectValues` decides what the
 * caller actually receives, a checklist's answer is a comma-joined index list that nothing
 * else in the app would guess, and all three functions are pure.
 */

/** @typedef {{name:string, label:string,
 *             type:('text'|'password'|'otp'|'textarea'|'choice'|'checklist'|'plan'),
 *             placeholder?:string, value?:string, required?:boolean,
 *             options?:string[], items?:{label:string, checked?:boolean}[],
 *             rows?:{ref:string, label:string, value:string, source:string, detail:string}[],
 *             secret?:boolean, autocomplete?:string, prose?:boolean}} Field */

/** @typedef {{id:number, kind:'ask'|'confirm', spec:Object,
 *             resolve:Function, settled:boolean}} Job */

/**
 * The `choice` picker's escape hatch. A sentinel and not '' or ' ', because it has to be
 * distinguishable from both "no answer" and any option the page supplied — those options
 * are model- or page-authored, so the marker must be something no form would ever emit.
 */
export const CHOICE_OTHER = '__jobpilot_other__';

// ---------------------------------------------------------------- queue state
//
// Module level, exactly as in modal.js: openAsk must work from a non-React caller and
// must not depend on a component being mounted at the moment it is called. A job pushed
// before <ModalHost/> mounts simply waits in the queue.

/** @type {Job|null} */
let active = null;
/** @type {Job[]} */
let queue = [];
let seq = 0;

const listeners = new Set();

function emit() {
  for (const fn of [...listeners]) fn();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The snapshot <ModalHost/> renders. Object identity only changes when the job does. */
export function getActive() {
  return active;
}

function pump() {
  if (active || queue.length === 0) return;
  active = queue.shift();
}

/**
 * Resolve a job exactly once and advance the queue.
 *
 * There is no `cleanup()` call here: tearing the dialog down (close it, restore focus) is
 * the unmount effect of the component rendering it, which React runs as soon as `active`
 * changes. Resolving first and cleaning up on the next commit is what lets the awaiting
 * agent continue while the dialog animates away.
 */
export function settle(job, value) {
  if (job.settled) return;
  job.settled = true;
  job.resolve(value);
  if (active === job) {
    active = null;
    pump();
  }
  emit();
}

function enqueue(kind, spec, owner) {
  return new Promise((resolve) => {
    queue.push({ id: ++seq, kind, spec, resolve, settled: false, owner: owner || null });
    pump();
    emit();
  });
}

/**
 * @param {{title:string, message?:string, warning?:string, host?:string, fields?:Field[],
 *          options?:string[], saveOption?:{label:string, checked:boolean},
 *          extraButtons?:{id:string,label:string,danger?:boolean}[],
 *          submitLabel?:string}} spec
 * @returns {Promise<{action:string, values:Object<string,string>, save:boolean}|null>}
 */
export function openAsk(spec, owner) {
  return enqueue('ask', spec || {}, owner);
}

/**
 * @param {{title:string, message?:string, okLabel?:string, danger?:boolean}} spec
 * @returns {Promise<boolean>}
 */
export function openConfirm(spec, owner) {
  return enqueue('confirm', spec || {}, owner);
}

export function isModalOpen() {
  return active !== null;
}

/**
 * Force-close every open and queued modal, resolving each with null.
 *
 * Panel teardown only. Stop must NOT use this any more — see closeModalsFor.
 */
export function closeAllModals() {
  const jobs = active ? [active, ...queue] : queue.slice();
  queue = [];
  for (const job of jobs) settle(job, null);
}

/**
 * Force-close one run's modals, resolving each with null. What Stop uses.
 *
 * Stop used to call closeAllModals, which was right while a panel could only have one run:
 * every dialog on screen belonged to the run being stopped. With several applications going
 * at once it is actively wrong — stopping one run would answer `null` to the question a
 * DIFFERENT run is blocked on, and that run would take the null as "the user declined" and
 * abandon a form it was halfway through filling.
 *
 * A job with no owner is nobody's in particular (the vault unlock prompt, for instance,
 * which is panel-wide) and is left alone.
 */
export function closeModalsFor(owner) {
  if (!owner) return;
  const doomed = [];
  if (active && active.owner === owner) doomed.push(active);
  const kept = [];
  for (const job of queue) (job.owner === owner ? doomed : kept).push(job);
  queue = kept;
  for (const job of doomed) settle(job, null);
}

// -------------------------------------------------------------- field values
//
// modal.js kept each control's value in the DOM and read it back through a per-field
// `.value` getter. In the React version the values are component state, and these three
// functions are the getters' replacement: one shape per field type in, one plain string
// per field out — so what `collect()` hands the caller is identical to what the vanilla
// one did.

export function initialValues(fields) {
  const values = {};
  for (const field of fields) {
    const type = field.type || 'text';
    if (type === 'plan') {
      // Rows start ticked unless one says otherwise. The card is an approval, not a
      // selection: the common action is "yes, all of that", and making the user tick twenty
      // boxes to say so would be a worse interruption than the fifteen plan mode removes.
      // `include: false` is for the rows where the default has to be the other way — a
      // resume extraction proposing a value OVER something the user typed themselves (see
      // profile-intel.js extractionRows).
      values[field.name] = (field.rows || []).map((row) => ({
        include: !row || row.include !== false,
        value: row && row.value != null ? String(row.value) : '',
      }));
    } else if (type === 'checklist') {
      values[field.name] = (field.items || []).map((item) => item.checked !== false);
    } else if (type === 'choice') {
      values[field.name] = { select: '', other: '' };
    } else {
      values[field.name] = field.value != null ? String(field.value) : '';
    }
  }
  return values;
}

/** The string a field contributes — the exact output of modal.js's `.value` getters. */
export function fieldValueOf(field, raw) {
  const type = field.type || 'text';
  // A plan row carries two things (kept / edited-value) where every other field carries
  // one, so it is encoded rather than represented directly. JSON and not a bespoke
  // separator because the values are real form answers: an address contains commas, a
  // cover letter contains newlines, and a salary contains both. collectValues stays
  // uniform — one string per field — and decodePlanRows below is the only reader.
  if (type === 'plan') {
    return JSON.stringify((raw || []).map((r) => ({
      include: Boolean(r && r.include),
      value: r && r.value != null ? String(r.value) : '',
    })));
  }
  if (type === 'checklist') {
    return (raw || []).map((checked, i) => (checked ? i : -1)).filter((i) => i >= 0).join(',');
  }
  if (type === 'choice') {
    const v = raw || { select: '', other: '' };
    return v.select === CHOICE_OTHER ? v.other : v.select;
  }
  return raw ?? '';
}

export function collectValues(fields, values) {
  const out = {};
  for (const field of fields) out[field.name] = fieldValueOf(field, values[field.name]);
  return out;
}

/**
 * The other half of the `plan` encoding: the string collectValues produced, back into rows.
 *
 * Returns [] rather than throwing on anything unexpected. The caller pairs these positionally
 * with the rows it sent, and an empty list means "nothing was approved", which is the safe
 * reading — a malformed payload must never be interpreted as blanket approval to type
 * twenty values into somebody's job application.
 *
 * @returns {{include:boolean, value:string}[]}
 */
export function decodePlanRows(encoded) {
  let parsed;
  try {
    parsed = JSON.parse(String(encoded ?? ''));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((r) => ({
    include: Boolean(r && r.include),
    value: r && r.value != null ? String(r.value) : '',
  }));
}
