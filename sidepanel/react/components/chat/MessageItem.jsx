// MessageItem.jsx — one settled transcript row. Port of renderUserMessage (panel.js:284),
// renderAssistantBubble's non-streaming branch (299), renderNotice (489), renderSecret
// (513) and renderQuestionCard (540).
//
// "Settled" is the load-bearing word. Everything here renders from a record that is not
// going to change again this second, so the whole component is memoized: while the model
// streams, MessageList re-renders zero of these. Only the row whose `rev` was bumped — a
// tool step reporting its outcome, an assistant bubble finishing — re-renders at all.
//
// Nothing in this file uses dangerouslySetInnerHTML and nothing ever may. Every string
// below (message text, tool labels, playbook names, question text) has been through an LLM
// that just read a hostile web page. panel.js built all of it with createElement +
// textContent for that reason; a JSX child is the same guarantee.

import { memo } from 'react';

import Icon from '../Icon.jsx';
import Markdown from '../Markdown.jsx';
import ActivityCard from './ActivityCard.jsx';

// A masked record only — never carries the value. `{type:'secret', kind, host}`
// renders as "🔒 Provided password for cisco.com" and round-trips through
// persistChats() with nothing sensitive in it.
export const SECRET_KIND_NOUN = {
  password: 'password', username: 'username', otp: 'one-time code', other: 'value',
};

function SecretRecord({ record }) {
  const noun = SECRET_KIND_NOUN[record.kind] || 'value';
  return (
    <div className="msg-secret">
      <Icon name="lock" size={13} className="secret-lock" />
      <span>{record.host ? `Provided ${noun} for ${record.host}` : `Provided ${noun}`}</span>
    </div>
  );
}

// A live question is a modal now (see ChatView's onAskUser). This renderer stays ONLY to
// paint already-answered questions in the restored transcript / after the modal
// resolves — never an interactive card.
function QuestionCard({ record }) {
  return (
    <div className="question-card answered">
      <div className="question-title">
        <Icon name="question" size={16} />
        <span>{record.question}</span>
      </div>
      <div className="question-answer-note">
        {record.answer != null ? `You answered: ${record.answer}` : 'Not answered.'}
      </div>
    </div>
  );
}

/**
 * The settled assistant bubble — stage two of the two-stage render. StreamingBubble paints
 * plain text while the tokens arrive; once finalizeAssistantBubble settles the record the
 * same text is re-rendered through <Markdown>, which is exactly what panel.js:331 did
 * (`el.textContent = ''; el.appendChild(renderMarkdown(record.text))`).
 *
 * <Markdown> is a DIRECT child with no wrapper: panel.css styles markdown through its
 * container (`.msg-assistant p`, `.msg-assistant pre`, `.msg-assistant a`), so an extra
 * div here would silently unstyle every model reply.
 */
function AssistantMessage({ record }) {
  return (
    <div className="msg msg-assistant">
      <Markdown text={record.text} />
    </div>
  );
}

/**
 * @param {object} props.row           {id, rev, record, live} — the wrapper ChatView keeps.
 *                                     A mutation bumps `rev` and replaces the wrapper, which
 *                                     is what gets past React.memo; the record reference
 *                                     stays stable because it is also the persisted object.
 * @param {number} props.runningIndex  activity rows only; -1 for everything else
 */
function MessageItem({ row, runningIndex }) {
  const record = row.record;
  switch (record.type) {
    case 'user':
      return <div className="msg msg-user">{record.text}</div>;
    case 'assistant':
      return <AssistantMessage record={record} />;
    case 'activity':
      return (
        <ActivityCard
          record={record}
          rev={row.rev}
          runningIndex={runningIndex}
        />
      );
    case 'notice':
      return <div className={`msg-notice ${record.variant || ''}`.trim()}>{record.text}</div>;
    case 'secret':
      return <SecretRecord record={record} />;
    case 'question':
      return <QuestionCard record={record} />;
    default:
      // restoreChat (panel.js:2087) fell through silently on a record type it did not know,
      // which is what lets an old transcript written by an older build still load.
      return null;
  }
}

export default memo(MessageItem);
