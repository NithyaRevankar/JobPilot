// ActivityCard.jsx — the tool-step card. Port of renderActivityCard (panel.js:345),
// renderToolStep (355) and applyStepOutcome (383).
//
// panel.js drove a step through three DOM mutations: created running, then
// applyStepOutcome rewrote its class, its outcome glyph and sometimes its label. Here the
// step record IS the state and the same three cases are one pure render, which is why
// applyStepOutcome has no counterpart of its own — read the branches below against it.

import { memo } from 'react';

import Icon from '../Icon.jsx';

/**
 * @param {object}  props.step     {name, label, ok, result, waiting}. `ok` is null while in
 *                                 flight AND for a step that never reported. `waiting` is
 *                                 set by onRequestSecret (panel.js:913), which rewrote the
 *                                 live step's label to "— waiting for you…" rather than
 *                                 closing it ✓, because the tool's real verdict had not
 *                                 arrived yet. It lives ON the record rather than being
 *                                 passed down as an index, so two credential prompts in one
 *                                 run each keep their own label — see ChatView's note.
 * @param {boolean} props.running  this is the step currently in flight (panel.js passed
 *                                 `live` to renderToolStep). Only ever true for the newest
 *                                 step of the open card.
 */
function ToolStep({ step, running }) {
  const waiting = Boolean(step.waiting);
  let className = 'tool-step';
  let outcome;
  let label = step.label;
  let detail = null;

  if (running) {
    className += ' running';
    outcome = '…';
    if (waiting) label = `${step.label} — waiting for you…`;
  } else if (step.ok == null) {
    // `ok` is null for a step that was still in flight when the panel closed — the run ended
    // without an outcome, so there is nothing to report either way. Painting that as a red ✗
    // told the user an action had FAILED when it may well have completed on the page, which
    // is the CONTRACT-V3 §7.1 lie in its other direction.
    className += ' unknown';
    outcome = '–';
    label = `${step.label} — outcome unknown (the panel closed while this was running)`;
  } else {
    className += step.ok ? ' ok' : ' fail';
    outcome = step.ok ? '✓' : '✗';
    if (!step.ok) {
      label = `${step.label} — ${String(step.result).slice(0, 80)}`;
    } else if (waiting) {
      // applyStepOutcome only ever rewrote the label on FAILURE, so a step that was waiting
      // on the user and then succeeded kept the "waiting for you…" text panel.js:915 had
      // written into it. Carried across deliberately rather than tidied: the label is the
      // record of what the step stopped for, and dropping it here would quietly change what
      // a successful credential fill looks like.
      label = `${step.label} — waiting for you…`;
    }
    if (step.result) detail = step.result;
  }

  return (
    <details className={className}>
      <summary>
        <Icon name="gear" size={13} className="gear" />
        <span className="tool-label">{label}</span>
        <span className="tool-outcome">{outcome}</span>
      </summary>
      {detail === null ? null : <div className="tool-detail">{detail}</div>}
    </details>
  );
}

/**
 * @param {object} props.record        {type:'activity', steps:[…]} — MUTATED in place by
 *                                     onToolStart/onToolEnd exactly as panel.js mutated it,
 *                                     because it is also the object that gets persisted.
 * @param {number} props.rev           bumped by ChatView whenever `record.steps` is mutated.
 *                                     Unused in the body ON PURPOSE: it is the only thing
 *                                     that tells React.memo the card changed, since the
 *                                     record reference deliberately does not.
 * @param {number} props.runningIndex  index of the in-flight step, or -1
 */
function ActivityCard({ record, runningIndex = -1 }) {
  return (
    <div className="activity-card">
      {record.steps.map((step, i) => (
        // Index keys are correct here: steps are only ever appended, never reordered or
        // removed, so an index is a stable identity for the life of the card.
        <ToolStep key={i} step={step} running={i === runningIndex} />
      ))}
    </div>
  );
}

export default memo(ActivityCard);
