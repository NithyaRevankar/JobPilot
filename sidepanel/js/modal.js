// ============================================================================
//  DEAD CODE. NOTHING LOADS THIS FILE. DO NOT EDIT IT TO FIX A BUG.
//
//  Superseded by sidepanel/react/components/Modal.jsx, which exports openAsk,
//  openConfirm, isModalOpen and closeAllModals with the SAME NAMES and the same
//  signatures. That collision is the whole reason for this banner: two files in one
//  repo define `openAsk`, and only one of them is reachable. The live one is the JSX.
//
//  The only importer left is sidepanel/js/panel.js, which is itself dead (see its own
//  banner). Kept for the same reason panel.js is: the React port cites `modal.js:NNN`
//  line numbers, and those only resolve while the file does.
//
//  Delete it together with panel.js. `git show ccb146a:sidepanel/js/modal.js` is the
//  last commit in which it was live.
// ============================================================================

/**
 * modal.js — native <dialog> prompts for JobPilot (CONTRACT-V2 §4, Owner B).
 *
 * Renders on top of the panel with a dimmed ::backdrop. Exactly ONE modal is open at
 * a time. Concurrency policy: a FIFO queue — a second openAsk/openConfirm issued while
 * one is open waits its turn (it neither rejects nor stacks visually). Stop calls
 * closeAllModals(), which resolves the open modal AND every queued one with null.
 *
 * The title, message, host, options and field values may originate from a web page or
 * the model — treat them as hostile. Every string reaches the DOM through textContent;
 * nothing here is built with innerHTML.
 */

/** @typedef {{name:string, label:string,
 *             type:('text'|'password'|'otp'|'textarea'|'choice'|'checklist'),
 *             placeholder?:string, value?:string, required?:boolean,
 *             options?:string[], items?:{label:string, checked?:boolean}[],
 *             secret?:boolean, autocomplete?:string}} Field */

/** @typedef {{run:Function, spec:Object, resolve:Function,
 *             settled:boolean, cleanup:(Function|null), cancelValue:*}} Job */

// The `choice` picker's escape hatch. A sentinel and not '' or ' ', because it has to be
// distinguishable from both "no answer" and any option the page supplied — those options
// are model- or page-authored, so the marker must be something no form would ever emit.
const CHOICE_OTHER = '__jobpilot_other__';

// ---------------------------------------------------------------- queue state

/** @type {Job|null} */
let active = null;
/** @type {Job[]} */
let queue = [];

function pump() {
  if (active || queue.length === 0) return;
  active = queue.shift();
  active.run(active.spec, active);
}

/** Resolve a job exactly once, tear down its dialog, and advance the queue. */
function settle(job, value) {
  if (job.settled) return;
  job.settled = true;
  try { if (job.cleanup) job.cleanup(); } catch { /* dialog already gone */ }
  job.resolve(value);
  if (active === job) { active = null; pump(); }
}

function enqueue(run, spec) {
  return new Promise((resolve) => {
    queue.push({ run, spec, resolve, settled: false, cleanup: null, cancelValue: null });
    pump();
  });
}

// ------------------------------------------------------------- DOM helpers

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

const SVGNS = 'http://www.w3.org/2000/svg';

/** Build an SVG from plain attribute bags — no innerHTML, no untrusted input. */
function svg(children, size, viewBox) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', viewBox || '0 0 20 20');
  s.setAttribute('width', String(size || 16));
  s.setAttribute('height', String(size || 16));
  s.setAttribute('aria-hidden', 'true');
  for (const c of children) {
    const node = document.createElementNS(SVGNS, c.tag || 'path');
    for (const k of Object.keys(c)) {
      if (k === 'tag') continue;
      node.setAttribute(k, String(c[k]));
    }
    s.appendChild(node);
  }
  return s;
}

function eyeIcon() {
  return svg([
    { d: 'M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 },
    { tag: 'circle', cx: 10, cy: 10, r: 2.2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.4 },
    { tag: 'line', x1: 3.5, y1: 3.5, x2: 16.5, y2: 16.5, stroke: 'currentColor', 'stroke-width': 1.4, 'stroke-linecap': 'round', class: 'eye-slash' },
  ], 15);
}

function lockIcon(size) {
  return svg([
    { tag: 'rect', x: 4, y: 9, width: 12, height: 8, rx: 2, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 },
    { d: 'M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5 },
  ], size || 14);
}

function restoreFocus(prev) {
  if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
    try { prev.focus(); } catch { /* element detached mid-flight */ }
  }
}

// ------------------------------------------------------------- field builder

/**
 * @param {Field} field
 * @param {Object<string,HTMLElement>} inputs  collected by name
 * @param {Function} onInput      re-evaluates the submit-enabled state
 * @param {Function} onOtpComplete fired when an otp field reaches 6 digits
 */
function buildField(field, inputs, onInput, onOtpComplete) {
  // A checklist is a <label> per row, not one control — so it gets its own container
  // and exposes a synthetic `.value` (the checked indices) to keep collect() uniform.
  if ((field.type || 'text') === 'checklist') {
    const box = el('div', 'modal-field');
    box.appendChild(el('span', 'modal-label', field.label || field.name));
    const list = el('div', 'modal-checklist');
    const boxes = [];
    for (const [i, item] of (field.items || []).entries()) {
      const row = el('label', 'modal-check-row');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = item.checked !== false;
      cb.addEventListener('change', onInput);
      boxes.push(cb);
      row.appendChild(cb);
      row.appendChild(el('span', null, item.label));
      list.appendChild(row);
    }
    box.appendChild(list);
    // collect() reads `.value` off whatever we register here.
    inputs[field.name] = {
      get value() {
        return boxes.map((cb, i) => (cb.checked ? i : -1)).filter((i) => i >= 0).join(',');
      },
    };
    return box;
  }

  const wrap = el('label', 'modal-field');
  wrap.appendChild(el('span', 'modal-label' + (field.prose ? ' modal-label-prose' : ''), field.label || field.name));

  const type = field.type || 'text';
  let input;

  // A per-question option list. The whole-modal quick-reply buttons cannot do this job
  // once there are several questions — clicking one would submit the form with every
  // other box still empty — so options belonging to ONE question render as a picker.
  // "Something else…" keeps it from becoming a cage: the page's option list is often
  // not the list the user's real answer is on.
  if (type === 'choice') {
    const select = el('select', 'modal-input modal-select');
    const blank = el('option', null, field.required ? 'Choose…' : 'No answer');
    blank.value = '';
    select.appendChild(blank);
    for (const opt of (field.options || [])) {
      const o = el('option', null, opt);
      o.value = opt;
      select.appendChild(o);
    }
    const otherOpt = el('option', null, 'Something else…');
    otherOpt.value = CHOICE_OTHER;
    select.appendChild(otherOpt);

    const other = el('input', 'modal-input modal-other');
    other.type = 'text';
    other.placeholder = 'Type your answer';
    other.hidden = true;

    select.addEventListener('change', () => {
      other.hidden = select.value !== CHOICE_OTHER;
      if (!other.hidden) other.focus();
      onInput();
    });
    other.addEventListener('input', onInput);

    wrap.appendChild(select);
    wrap.appendChild(other);
    inputs[field.name] = {
      get value() { return select.value === CHOICE_OTHER ? other.value : select.value; },
      focus() { select.focus(); },
    };
    return wrap;
  }

  if (type === 'textarea') {
    input = el('textarea', 'modal-input modal-textarea');
    input.rows = 3;
  } else {
    input = el('input', type === 'otp' ? 'modal-input modal-otp' : 'modal-input');
    input.type = type === 'password' ? 'password' : 'text';
    if (type === 'otp') input.inputMode = 'numeric';
  }

  // autocomplete: the explicit otp rule wins; secret fields fall back to 'off'.
  if (field.autocomplete != null) input.autocomplete = field.autocomplete;
  else if (type === 'otp') input.autocomplete = 'one-time-code';
  else if (field.secret) input.autocomplete = 'off';

  if (type === 'otp') { input.maxLength = 10; input.autocapitalize = 'off'; }
  if (type === 'otp' || field.secret) input.spellcheck = false;
  if (field.placeholder) input.placeholder = field.placeholder;
  if (field.value != null) input.value = String(field.value);

  input.addEventListener('input', onInput);
  if (type === 'otp') {
    input.addEventListener('input', () => {
      if (/^\d{6}$/.test(input.value)) onOtpComplete();
    });
  }

  if (type === 'password') {
    const row = el('span', 'input-with-btn');
    row.appendChild(input);
    const eye = el('button', 'btn-icon modal-eye');
    eye.type = 'button';
    eye.title = 'Show / hide';
    eye.setAttribute('aria-label', 'Show or hide value');
    eye.appendChild(eyeIcon());
    eye.addEventListener('click', () => {
      const reveal = input.type === 'password';
      input.type = reveal ? 'text' : 'password';
      eye.classList.toggle('revealed', reveal);
      input.focus();
    });
    wrap.appendChild(row);
  } else {
    wrap.appendChild(input);
  }

  inputs[field.name] = input;
  return wrap;
}

// ------------------------------------------------------------------ openAsk

function runAsk(spec, job) {
  const dlg = /** @type {HTMLDialogElement} */ (document.getElementById('dlg-ask'));
  dlg.replaceChildren();
  const prevFocus = document.activeElement;
  job.cancelValue = null;

  const fields = Array.isArray(spec.fields) ? spec.fields : [];
  /** @type {Object<string,HTMLElement>} */
  const inputs = {};
  let saveCheck = null;

  const form = el('form', 'modal-form');
  form.addEventListener('submit', (e) => e.preventDefault());

  // --- head
  const head = el('div', 'modal-head');
  head.appendChild(el('h2', 'modal-title', spec.title || 'JobPilot'));
  if (spec.host) {
    const chip = el('span', 'modal-host');
    chip.appendChild(lockIcon(12));
    chip.appendChild(el('span', null, spec.host));
    head.appendChild(chip);
  }
  form.appendChild(head);

  // --- body
  const body = el('div', 'modal-body');
  // A warning outranks the message: it is the reason the user might say no.
  if (spec.warning) body.appendChild(el('p', 'modal-warning', spec.warning));
  if (spec.message) body.appendChild(el('p', 'modal-message', spec.message));

  const submitBtn = el('button', 'btn-primary modal-submit', spec.submitLabel || 'Submit');
  submitBtn.type = 'button';

  function collect() {
    const values = {};
    for (const f of fields) values[f.name] = inputs[f.name] ? inputs[f.name].value : '';
    return values;
  }
  function saveState() { return saveCheck ? saveCheck.checked : false; }
  function updateSubmit() {
    const bad = fields.some((f) => f.required && !(inputs[f.name] && inputs[f.name].value.trim()));
    submitBtn.disabled = bad;
  }
  function doSubmit() {
    if (submitBtn.disabled) return;
    settle(job, { action: 'submit', values: collect(), save: saveState() });
  }
  // The button is type="button" (so the form never navigates), which means nothing
  // happens on click unless we wire it. Cancel, the quick replies and the extra
  // buttons each had a listener; the primary one did not, so answering by MOUSE did
  // nothing at all — every modal in the panel could only be completed with Enter.
  submitBtn.addEventListener('click', doSubmit);

  // Whole-modal quick replies: one click answers and submits. That is only coherent
  // while there is ONE field to answer — with several, a click would submit the form
  // with the other boxes still empty, so they are ignored and each question carries
  // its own `choice` picker instead.
  if (Array.isArray(spec.options) && spec.options.length && fields.length <= 1) {
    const answerName = fields.length ? fields[0].name : 'answer';
    const opts = el('div', 'modal-options');
    for (const opt of spec.options) {
      const b = el('button', 'modal-option', opt);
      b.type = 'button';
      b.addEventListener('click', () => settle(job, { action: 'submit', values: { [answerName]: opt }, save: saveState() }));
      opts.appendChild(b);
    }
    body.appendChild(opts);
  }

  for (const f of fields) body.appendChild(buildField(f, inputs, updateSubmit, doSubmit));

  if (spec.saveOption) {
    const lab = el('label', 'modal-save');
    saveCheck = el('input');
    saveCheck.type = 'checkbox';
    saveCheck.checked = !!spec.saveOption.checked;
    lab.appendChild(saveCheck);
    lab.appendChild(el('span', null, spec.saveOption.label || 'Save'));
    body.appendChild(lab);
  }
  form.appendChild(body);

  // --- footer: extra buttons left, cancel + submit right
  const foot = el('div', 'modal-foot');
  const left = el('div', 'modal-foot-left');
  for (const b of (Array.isArray(spec.extraButtons) ? spec.extraButtons : [])) {
    const btn = el('button', 'btn-ghost modal-extra' + (b.danger ? ' modal-extra-danger' : ''), b.label);
    btn.type = 'button';
    btn.addEventListener('click', () => settle(job, { action: b.id, values: collect(), save: saveState() }));
    left.appendChild(btn);
  }
  const right = el('div', 'modal-foot-right');
  const cancel = el('button', 'btn-ghost modal-cancel', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => settle(job, null));
  right.appendChild(cancel);
  right.appendChild(submitBtn);
  foot.appendChild(left);
  foot.appendChild(right);
  form.appendChild(foot);

  // Enter submits (guarding IME composition). In a TEXTAREA it does not: these boxes now
  // hold cover letters and "why this company" paragraphs, and a plain Enter submitting
  // the form mid-paragraph would send half an answer with no way back. There it takes
  // Ctrl/Cmd+Enter — the convention everywhere else a message box submits.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    if (e.target instanceof HTMLTextAreaElement && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    doSubmit();
  });

  dlg.appendChild(form);

  const onCancel = (e) => { e.preventDefault(); settle(job, null); };
  dlg.addEventListener('cancel', onCancel);
  job.cleanup = () => {
    dlg.removeEventListener('cancel', onCancel);
    if (dlg.open) dlg.close();
    dlg.replaceChildren();
    restoreFocus(prevFocus);
  };

  updateSubmit();
  dlg.showModal();

  // Focus the first field; fall back to the first quick-reply, then the submit button.
  if (fields.length && inputs[fields[0].name]) inputs[fields[0].name].focus();
  else {
    const opt = body.querySelector('.modal-option');
    (opt || submitBtn).focus();
  }
}

/**
 * @param {{title:string, message?:string, host?:string, fields?:Field[],
 *          options?:string[], saveOption?:{label:string, checked:boolean},
 *          extraButtons?:{id:string,label:string,danger?:boolean}[],
 *          submitLabel?:string}} spec
 * @returns {Promise<{action:string, values:Object<string,string>, save:boolean}|null>}
 */
export function openAsk(spec) { return enqueue(runAsk, spec || {}); }

// --------------------------------------------------------------- openConfirm

function runConfirm(spec, job) {
  const dlg = /** @type {HTMLDialogElement} */ (document.getElementById('dlg-confirm'));
  dlg.replaceChildren();
  const prevFocus = document.activeElement;
  job.cancelValue = false;

  const form = el('form', 'modal-form');
  form.addEventListener('submit', (e) => e.preventDefault());

  const head = el('div', 'modal-head');
  head.appendChild(el('h2', 'modal-title', spec.title || 'Are you sure?'));
  form.appendChild(head);

  const body = el('div', 'modal-body');
  if (spec.message) body.appendChild(el('p', 'modal-message', spec.message));
  form.appendChild(body);

  const foot = el('div', 'modal-foot');
  foot.appendChild(el('div', 'modal-foot-left'));
  const right = el('div', 'modal-foot-right');
  const cancel = el('button', 'btn-ghost modal-cancel', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => settle(job, false));
  const ok = el('button', (spec.danger ? 'btn-danger' : 'btn-primary') + ' modal-ok', spec.okLabel || 'Confirm');
  ok.type = 'button';
  ok.addEventListener('click', () => settle(job, true));
  right.appendChild(cancel);
  right.appendChild(ok);
  foot.appendChild(right);
  form.appendChild(foot);

  // Enter must never trigger a destructive action. On a danger confirm the focus
  // sits on Cancel, and Enter is the reflex for "get me out of this dialog" — so
  // let the focused button handle it rather than forcing `true`.
  form.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.keyCode === 229) return;
    if (spec.danger) return;
    e.preventDefault();
    settle(job, true);
  });

  dlg.appendChild(form);

  const onCancel = (e) => { e.preventDefault(); settle(job, false); };
  dlg.addEventListener('cancel', onCancel);
  job.cleanup = () => {
    dlg.removeEventListener('cancel', onCancel);
    if (dlg.open) dlg.close();
    dlg.replaceChildren();
    restoreFocus(prevFocus);
  };

  dlg.showModal();
  // Destructive confirms default focus to Cancel; benign ones to the primary action.
  (spec.danger ? cancel : ok).focus();
}

/**
 * @param {{title:string, message?:string, okLabel?:string, danger?:boolean}} spec
 * @returns {Promise<boolean>}
 */
export function openConfirm(spec) { return enqueue(runConfirm, spec || {}); }

// --------------------------------------------------------------- lifecycle

export function isModalOpen() { return active !== null; }

/** Force-close every open and queued modal, resolving each with null. Used by Stop. */
export function closeAllModals() {
  const jobs = active ? [active, ...queue] : queue.slice();
  queue = [];
  for (const job of jobs) settle(job, null);
}
