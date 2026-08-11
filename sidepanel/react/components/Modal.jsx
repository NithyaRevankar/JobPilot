/**
 * Modal.jsx — the React port of sidepanel/js/modal.js (CONTRACT-V2 §4, Owner B).
 *
 * THE IMPERATIVE API IS THE CONTRACT. `openAsk(spec)` and `openConfirm(spec)` return
 * PROMISES, and sidepanel/js/agent.js awaits them from its onAskUser / onRequestSecret
 * callbacks. agent.js is not React and never will be, so the promise API survives this
 * port byte-for-byte in shape: same spec fields, same resolved values, same null-on-cancel.
 * What changed is only WHO builds the DOM — a module-level queue plus a <ModalHost/>
 * subscriber, instead of createElement into a pair of <dialog>s that lived in panel.html.
 *
 * Renders on top of the panel with a dimmed ::backdrop. Exactly ONE modal is open at
 * a time. The QUEUE ITSELF is not in this file — it is ../modal-queue.js, which has no
 * React in it so that `node` can drive its FIFO ordering and its Stop semantics directly
 * (test/react-harness.mjs). This file subscribes to it and draws whatever is at the head.
 * openAsk / openConfirm / isModalOpen / closeAllModals are re-exported here so that every
 * existing `from '../components/Modal.jsx'` import keeps working unchanged.
 *
 * The title, message, host, options and field values may originate from a web page or
 * the model — treat them as hostile. Every string reaches the DOM as a JSX child, which
 * React escapes; nothing here is built with innerHTML or dangerouslySetInnerHTML.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import {
  CHOICE_OTHER,
  collectValues,
  fieldValueOf,
  getActive,
  initialValues,
  settle,
  subscribe,
} from '../modal-queue.js';

export { closeAllModals, closeModalsFor, isModalOpen, openAsk, openConfirm } from '../modal-queue.js';

/** @typedef {import('../modal-queue.js')} */

// ------------------------------------------------------------------- icons
//
// Local to the modal, as they were in modal.js. They are not in components/Icon.jsx
// because Icon.jsx is the port of panel.js's ICON_PATHS table and these two were never
// in it — the eye has a `.eye-slash` line panel.css toggles, which no other icon has.

function EyeIcon() {
  return (
    <svg viewBox="0 0 20 20" width={15} height={15} aria-hidden="true">
      <path d="M2 10s3-5 8-5 8 5 8 5-3 5-8 5-8-5-8-5Z" fill="none" stroke="currentColor" strokeWidth={1.4} />
      <circle cx={10} cy={10} r={2.2} fill="none" stroke="currentColor" strokeWidth={1.4} />
      <line x1={3.5} y1={3.5} x2={16.5} y2={16.5} stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" className="eye-slash" />
    </svg>
  );
}

function LockIcon({ size = 14 }) {
  return (
    <svg viewBox="0 0 20 20" width={size} height={size} aria-hidden="true">
      <rect x={4} y={9} width={12} height={8} rx={2} fill="none" stroke="currentColor" strokeWidth={1.5} />
      <path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" fill="none" stroke="currentColor" strokeWidth={1.5} />
    </svg>
  );
}

function restoreFocus(prev) {
  if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
    try {
      prev.focus();
    } catch {
      /* element detached mid-flight */
    }
  }
}

// ------------------------------------------------------------- field builder

/**
 * One field. Presentational: every value lives in AskDialog so submit-validation and
 * collect() see one consistent snapshot, exactly as `inputs` did in modal.js.
 *
 * @param {{field:Field, value:*, onChange:(next:*)=>void,
 *          registerFocus:(name:string, node:HTMLElement|null)=>void}} props
 */
function AskField({ field, value, onChange, registerFocus }) {
  const type = field.type || 'text';

  // A STABLE ref callback. Written inline as `ref={(n) => registerFocus(field.name, n)}` it
  // was a new function on every render, and React detaches a changed ref callback (calling
  // it with null) before reattaching it — so every keystroke in any field flickered that
  // field's entry in `focusable.current` to null and back. Nothing reads it outside the
  // mount effect today, which is the only reason it never bit; it is exactly the setup for
  // "the ref was null at the moment I needed it".
  const setNode = useCallback(
    (node) => registerFocus(field.name, node),
    [registerFocus, field.name],
  );

  // CONTRACT-V11 §4 — the plan card's field list. Like a checklist it is many controls
  // rather than one, so it registers no focus target and gets its own container; unlike a
  // checklist each row also carries an editable value and a provenance chip.
  if (type === 'plan') {
    return <PlanField field={field} value={value} onChange={onChange} setNode={setNode} />;
  }

  // A checklist is a <label> per row, not one control — so it gets its own container
  // and contributes the checked indices, which keeps collect() uniform.
  if (type === 'checklist') {
    const checks = value || [];
    return (
      <div className="modal-field">
        <span className="modal-label">{field.label || field.name}</span>
        <div className="modal-checklist">
          {(field.items || []).map((item, i) => (
            <label className="modal-check-row" key={i}>
              <input
                type="checkbox"
                checked={Boolean(checks[i])}
                onChange={(e) => {
                  const next = checks.slice();
                  next[i] = e.target.checked;
                  onChange(next);
                }}
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      </div>
    );
  }

  const label = (
    <span className={'modal-label' + (field.prose ? ' modal-label-prose' : '')}>
      {field.label || field.name}
    </span>
  );

  // A per-question option list. The whole-modal quick-reply buttons cannot do this job
  // once there are several questions — clicking one would submit the form with every
  // other box still empty — so options belonging to ONE question render as a picker.
  // "Something else…" keeps it from becoming a cage: the page's option list is often
  // not the list the user's real answer is on.
  if (type === 'choice') {
    return <ChoiceField field={field} label={label} value={value} onChange={onChange} setNode={setNode} />;
  }

  // autocomplete: the explicit otp rule wins; secret fields fall back to 'off'.
  const autoComplete =
    field.autocomplete != null ? field.autocomplete : type === 'otp' ? 'one-time-code' : field.secret ? 'off' : undefined;
  const spellCheck = type === 'otp' || field.secret ? false : undefined;

  if (type === 'textarea') {
    return (
      <label className="modal-field">
        {label}
        <textarea
          className="modal-input modal-textarea"
          rows={3}
          ref={setNode}
          value={value}
          placeholder={field.placeholder || undefined}
          autoComplete={autoComplete}
          spellCheck={spellCheck}
          onChange={(e) => onChange(e.target.value)}
        />
      </label>
    );
  }

  if (type === 'password') {
    return <PasswordField field={field} label={label} value={value} onChange={onChange} setNode={setNode} autoComplete={autoComplete} />;
  }

  return (
    <label className="modal-field">
      {label}
      <input
        className={type === 'otp' ? 'modal-input modal-otp' : 'modal-input'}
        type="text"
        ref={setNode}
        value={value}
        placeholder={field.placeholder || undefined}
        autoComplete={autoComplete}
        spellCheck={spellCheck}
        {...(type === 'otp' ? { inputMode: 'numeric', maxLength: 10, autoCapitalize: 'off' } : null)}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/**
 * The list of fields a plan will enter: one row each, ticked, with the value editable.
 *
 * THE CHIP IS THE POINT. A twenty-row card that treats every row alike is a card people
 * approve without reading by the third application, and then the feature has cost them an
 * interruption and bought them nothing. So the rows that no profile value backs are marked,
 * and only those: `inferred` gets a highlighted chip because it is the model's own judgement
 * and the one thing here worth a second of attention. Everything else says where it came
 * from and can be skimmed. agent.js computes the source by MATCHING the value against the
 * profile — it is never the model's claim about its own output (see plan.js provenanceOf).
 *
 * Presentational, like AskField: every value lives in AskDialog, so collect() sees one
 * consistent snapshot whichever control was last touched.
 */
function PlanField({ field, value, onChange, setNode }) {
  const rows = Array.isArray(field.rows) ? field.rows : [];
  const state = value || [];
  const kept = state.filter((r) => r && r.include).length;

  const setRow = (i, patch) => {
    const next = state.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };

  return (
    <div className="modal-field modal-plan">
      <div className="plan-head">
        <span className="modal-label">
          {kept} of {rows.length} field{rows.length === 1 ? '' : 's'} will be filled
        </span>
        {/* Only offered once unticking is a chore — with three rows the checkboxes are
            right there and a bulk control is noise. */}
        {rows.length > 3 ? (
          <button
            type="button"
            className="btn-ghost btn-small plan-toggle-all"
            onClick={() => onChange(state.map((r) => ({ ...r, include: kept !== rows.length })))}
          >
            {kept === rows.length ? 'Untick all' : 'Tick all'}
          </button>
        ) : null}
      </div>

      <ul className="plan-rows">
        {rows.map((row, i) => {
          const st = state[i] || { include: false, value: '' };
          // ONE highlighted state, whatever the card is for. In a plan it means "the model
          // worked this value out rather than reading it off your profile"; in a resume
          // extraction it means "this would replace something you typed". Both are the same
          // instruction to the reader — look at this one — so they get the same chip, and
          // the caller decides what earns it (see plan.js provenanceOf, profile-intel.js
          // extractionRows). A chip that means several things is a chip nobody reads.
          const warn = Boolean(row.warn);
          return (
            <li className={'plan-row' + (st.include ? '' : ' plan-row-off')} key={row.ref || i}>
              <label className="plan-row-head">
                <input
                  type="checkbox"
                  // The dialog's opening focus. Without a target registered here it fell
                  // through to the SUBMIT button (see AskDialog's mount effect), which on a
                  // card whose entire purpose is being read makes "approve everything" the
                  // default action one Enter away. Focus belongs in the content; Tab then
                  // walks the rows and Enter still approves once you have looked.
                  ref={i === 0 ? setNode : undefined}
                  checked={Boolean(st.include)}
                  onChange={(e) => setRow(i, { include: e.target.checked })}
                />
                <span className="plan-row-label">{row.label}</span>
                <span
                  className={'plan-src' + (warn ? ' plan-src-inferred' : '')}
                  title={row.chipTitle || undefined}
                >
                  {row.chip}
                </span>
              </label>
              <input
                className="modal-input plan-value"
                type="text"
                value={st.value}
                // Editing a row you unticked is how you meant to keep it: typing is a
                // stronger statement of intent than the box you clicked a moment ago, so
                // it re-ticks rather than quietly discarding what you just typed.
                onChange={(e) => setRow(i, { value: e.target.value, include: true })}
                aria-label={row.label}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ChoiceField({ field, label, value, onChange, setNode }) {
  const v = value || { select: '', other: '' };
  const otherRef = useRef(null);
  // Set when the user picks "Something else…", consumed after the commit that unhides the
  // box — focusing it in the change handler would target an element still `hidden`.
  const wantOtherFocus = useRef(false);

  useEffect(() => {
    if (wantOtherFocus.current) {
      wantOtherFocus.current = false;
      if (otherRef.current) otherRef.current.focus();
    }
  });

  return (
    <label className="modal-field">
      {label}
      <select
        className="modal-input modal-select"
        ref={setNode}
        value={v.select}
        onChange={(e) => {
          if (e.target.value === CHOICE_OTHER) wantOtherFocus.current = true;
          onChange({ ...v, select: e.target.value });
        }}
      >
        <option value="">{field.required ? 'Choose…' : 'No answer'}</option>
        {(field.options || []).map((opt, i) => (
          <option value={opt} key={i}>
            {opt}
          </option>
        ))}
        <option value={CHOICE_OTHER}>Something else…</option>
      </select>
      <input
        className="modal-input modal-other"
        type="text"
        ref={otherRef}
        placeholder="Type your answer"
        hidden={v.select !== CHOICE_OTHER}
        value={v.other}
        onChange={(e) => onChange({ ...v, other: e.target.value })}
      />
    </label>
  );
}

function PasswordField({ field, label, value, onChange, setNode, autoComplete }) {
  const [revealed, setRevealed] = useState(false);
  const inputRef = useRef(null);

  // One stable callback for the two things that want this node: the eye button (to hand
  // focus back after a reveal) and the dialog's focus table.
  const attach = useCallback((node) => {
    inputRef.current = node;
    setNode(node);
  }, [setNode]);

  return (
    <label className="modal-field">
      {label}
      <span className="input-with-btn">
        <input
          className="modal-input"
          type={revealed ? 'text' : 'password'}
          ref={attach}
          value={value}
          placeholder={field.placeholder || undefined}
          autoComplete={autoComplete}
          spellCheck={field.secret ? false : undefined}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className={'btn-icon modal-eye' + (revealed ? ' revealed' : '')}
          title="Show / hide"
          aria-label="Show or hide value"
          onClick={() => {
            setRevealed((on) => !on);
            if (inputRef.current) inputRef.current.focus();
          }}
        >
          <EyeIcon />
        </button>
      </span>
    </label>
  );
}

// ------------------------------------------------------------------ openAsk

function AskDialog({ job }) {
  const spec = job.spec;
  const fields = Array.isArray(spec.fields) ? spec.fields : [];

  const dlgRef = useRef(null);
  const submitRef = useRef(null);
  /** name -> the DOM node modal.js would have called `.focus()` on. */
  const focusable = useRef({});
  // Stable, so AskField's `setNode` is stable, so a ref is not torn down and rebuilt on
  // every keystroke. See the note in AskField.
  const registerFocus = useCallback((name, node) => {
    focusable.current[name] = node;
  }, []);

  const [values, setValues] = useState(() => initialValues(fields));
  const [save, setSave] = useState(() => Boolean(spec.saveOption && spec.saveOption.checked));

  const disabled = fields.some((f) => f.required && !String(fieldValueOf(f, values[f.name])).trim());

  /**
   * A plan card's primary button counts what is actually ticked, RIGHT NOW.
   *
   * spec.submitLabel is fixed when the dialog opens, which is fine for every other prompt
   * and wrong for this one: untick two rows and the footer went on promising to fill all
   * eight while the header above it said seven of eight. The last thing the user reads
   * before clicking has to be the thing that is about to happen.
   */
  const planField = fields.find((f) => (f.type || 'text') === 'plan');
  const planKept = planField
    ? (values[planField.name] || []).filter((r) => r && r.include).length
    : 0;
  const submitLabel = planField
    ? (planKept === 0 ? 'Skip all fields' : `Fill ${planKept} field${planKept === 1 ? '' : 's'}`)
    : (spec.submitLabel || 'Submit');

  function doSubmit(snapshot = values) {
    const bad = fields.some((f) => f.required && !String(fieldValueOf(f, snapshot[f.name])).trim());
    if (bad) return;
    settle(job, { action: 'submit', values: collectValues(fields, snapshot), save });
  }

  function onFieldChange(field, next) {
    // Built here rather than read back from state, because an otp that just completed has
    // to submit THIS keystroke's value — setValues has not committed yet.
    const snapshot = { ...values, [field.name]: next };
    setValues(snapshot);
    if ((field.type || 'text') === 'otp' && /^\d{6}$/.test(String(next))) doSubmit(snapshot);
  }

  // Enter submits (guarding IME composition). In a TEXTAREA it does not: these boxes now
  // hold cover letters and "why this company" paragraphs, and a plain Enter submitting
  // the form mid-paragraph would send half an answer with no way back. There it takes
  // Ctrl/Cmd+Enter — the convention everywhere else a message box submits.
  function onKeyDown(e) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // Enter on a focused BUTTON is that button's own activation, and the listener is on the
    // FORM, so without this it swallowed the key and submitted instead — tab to Cancel,
    // press Enter, and the dialog submitted. Same for the eye toggle and every quick reply.
    // Returning lets the browser fire the button's click, which is what the user asked for.
    // (Carried over from modal.js:347, which had the same shape and the same bug.)
    if (e.target instanceof HTMLButtonElement) return;
    if (e.target instanceof HTMLTextAreaElement && !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    doSubmit();
  }

  useEffect(() => {
    const dlg = dlgRef.current;
    const prevFocus = document.activeElement;
    // Esc. React has no onCancel for <dialog> we can rely on, and this is the same
    // native listener modal.js attached: swallow the default close so the promise is
    // always settled through settle() and never left dangling.
    const onCancel = (e) => {
      e.preventDefault();
      settle(job, null);
    };
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();

    // Focus the first field; fall back to the first quick-reply, then the submit button.
    // A checklist registers no focus target (it is n checkboxes, not one control), so a
    // checklist in first position falls through to the quick-reply/submit branch instead
    // of throwing the way modal.js's `inputs[name].focus()` would have.
    const first = fields.length ? focusable.current[fields[0].name] : null;
    if (first) first.focus();
    else {
      const opt = dlg.querySelector('.modal-option');
      const target = opt || submitRef.current;
      if (target) target.focus();
    }

    return () => {
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      restoreFocus(prevFocus);
    };
    // One dialog element per job (ModalHost keys on job.id), so this runs exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  // Whole-modal quick replies: one click answers and submits. That is only coherent
  // while there is ONE field to answer — with several, a click would submit the form
  // with the other boxes still empty, so they are ignored and each question carries
  // its own `choice` picker instead.
  const quickReplies = Array.isArray(spec.options) && spec.options.length && fields.length <= 1 ? spec.options : null;
  const answerName = fields.length ? fields[0].name : 'answer';

  return (
    <dialog id="dlg-ask" className="modal" ref={dlgRef}>
      <form className="modal-form" onSubmit={(e) => e.preventDefault()} onKeyDown={onKeyDown}>
        <div className="modal-head">
          <h2 className="modal-title">{spec.title || 'JobPilot'}</h2>
          {spec.host ? (
            <span className="modal-host">
              <LockIcon size={12} />
              <span>{spec.host}</span>
            </span>
          ) : null}
        </div>

        <div className="modal-body">
          {/* A warning outranks the message: it is the reason the user might say no. */}
          {spec.warning ? <p className="modal-warning">{spec.warning}</p> : null}
          {spec.message ? <p className="modal-message">{spec.message}</p> : null}

          {quickReplies ? (
            <div className="modal-options">
              {quickReplies.map((opt, i) => (
                <button
                  type="button"
                  className="modal-option"
                  key={i}
                  // Only the clicked answer is sent, not collect() — same as modal.js:305.
                  onClick={() => settle(job, { action: 'submit', values: { [answerName]: opt }, save })}
                >
                  {opt}
                </button>
              ))}
            </div>
          ) : null}

          {fields.map((field) => (
            <AskField
              key={field.name}
              field={field}
              value={values[field.name]}
              onChange={(next) => onFieldChange(field, next)}
              registerFocus={registerFocus}
            />
          ))}

          {spec.saveOption ? (
            <label className="modal-save">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
              <span>{spec.saveOption.label || 'Save'}</span>
            </label>
          ) : null}
        </div>

        {/* footer: extra buttons left, cancel + submit right */}
        <div className="modal-foot">
          <div className="modal-foot-left">
            {(Array.isArray(spec.extraButtons) ? spec.extraButtons : []).map((b) => (
              <button
                type="button"
                key={b.id}
                className={'btn-ghost modal-extra' + (b.danger ? ' modal-extra-danger' : '')}
                onClick={() => settle(job, { action: b.id, values: collectValues(fields, values), save })}
              >
                {b.label}
              </button>
            ))}
          </div>
          <div className="modal-foot-right">
            <button type="button" className="btn-ghost modal-cancel" onClick={() => settle(job, null)}>
              Cancel
            </button>
            {/* type="button" so the form never navigates — which is why the click handler
                is not optional: without it, answering by MOUSE did nothing at all and
                every modal in the panel could only be completed with Enter. */}
            <button type="button" className="btn-primary modal-submit" ref={submitRef} disabled={disabled} onClick={() => doSubmit()}>
              {submitLabel}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}

// --------------------------------------------------------------- openConfirm

function ConfirmDialog({ job }) {
  const spec = job.spec;
  const dlgRef = useRef(null);
  const okRef = useRef(null);
  const cancelRef = useRef(null);

  useEffect(() => {
    const dlg = dlgRef.current;
    const prevFocus = document.activeElement;
    const onCancel = (e) => {
      e.preventDefault();
      settle(job, false);
    };
    dlg.addEventListener('cancel', onCancel);
    dlg.showModal();
    // Destructive confirms default focus to Cancel; benign ones to the primary action.
    const target = spec.danger ? cancelRef.current : okRef.current;
    if (target) target.focus();

    return () => {
      dlg.removeEventListener('cancel', onCancel);
      if (dlg.open) dlg.close();
      restoreFocus(prevFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  // Enter must never trigger a destructive action. On a danger confirm the focus
  // sits on Cancel, and Enter is the reflex for "get me out of this dialog" — so
  // let the focused button handle it rather than forcing `true`.
  function onKeyDown(e) {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.keyCode === 229) return;
    // A focused button handles its own Enter — otherwise tabbing to Cancel and pressing
    // Enter confirmed. The danger guard below stays as well: on a destructive confirm,
    // Enter with focus nowhere in particular must still do nothing rather than default to
    // yes. (modal.js:421 had only the danger half.)
    if (e.target instanceof HTMLButtonElement) return;
    if (spec.danger) return;
    e.preventDefault();
    settle(job, true);
  }

  return (
    <dialog id="dlg-confirm" className="modal modal-confirm" ref={dlgRef}>
      <form className="modal-form" onSubmit={(e) => e.preventDefault()} onKeyDown={onKeyDown}>
        <div className="modal-head">
          <h2 className="modal-title">{spec.title || 'Are you sure?'}</h2>
        </div>

        <div className="modal-body">{spec.message ? <p className="modal-message">{spec.message}</p> : null}</div>

        <div className="modal-foot">
          <div className="modal-foot-left" />
          <div className="modal-foot-right">
            <button type="button" className="btn-ghost modal-cancel" ref={cancelRef} onClick={() => settle(job, false)}>
              Cancel
            </button>
            <button
              type="button"
              className={(spec.danger ? 'btn-danger' : 'btn-primary') + ' modal-ok'}
              ref={okRef}
              onClick={() => settle(job, true)}
            >
              {spec.okLabel || 'Confirm'}
            </button>
          </div>
        </div>
      </form>
    </dialog>
  );
}

// ------------------------------------------------------------------ the host

/**
 * Mounted ONCE, by App. Renders whichever job is at the head of the queue, or nothing.
 *
 * `key={job.id}` is deliberate: it gives every job a fresh <dialog> element, so the
 * showModal/close pair and the `dialog.modal[open]` entry animation behave exactly as
 * they did when modal.js closed and re-opened the same element between queued prompts.
 */
export function ModalHost() {
  const job = useSyncExternalStore(subscribe, getActive, getActive);
  if (!job) return null;
  return job.kind === 'confirm' ? <ConfirmDialog key={job.id} job={job} /> : <AskDialog key={job.id} job={job} />;
}
