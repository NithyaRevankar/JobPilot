// EmptyState.jsx — panel.html.orig lines 66-82, plus updateEmptyState (panel.js:278).
//
// panel.js kept this node in #message-list permanently and toggled its `hidden` attribute
// against `uiMessages.length`; here it is simply not rendered when there is a transcript.
// Same result — `.empty-state` declares no display of its own, so `hidden` genuinely hid
// it — and it removes the `if (child.id !== 'empty-state')` special case handleNewChat
// (panel.js:2054) needed when it swept the list.

/**
 * @param {boolean} props.configured  the LLM is connected. TWO different audiences read
 *   this screen: someone who has never set the panel up (show them the setup steps), and —
 *   since applications became concurrent — someone opening their SECOND application of the
 *   afternoon, whose settings are shared and already fine. Showing that person "Connect
 *   your LLM" reads as an error ("did it lose my key?"), so they get the steps that are
 *   actually in front of them: put the job in its own tab and start.
 */
export default function EmptyState({ configured, onOpenSettings, onOpenProfile }) {
  return (
    <div id="empty-state" className="empty-state">
      <svg viewBox="0 0 48 48" width="40" height="40" aria-hidden="true" className="empty-icon">
        <rect x="8" y="10" width="32" height="26" rx="4" fill="none" stroke="currentColor" strokeWidth="2" />
        <path d="M16 20h16M16 26h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path d="M30 33l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <h2>Your AI job-application copilot</h2>
      {configured ? (
        <ol className="empty-steps">
          <li><span className="step-num">1</span> Open the job posting in its <strong>own tab</strong></li>
          <li><span className="step-num">2</span> Switch to that tab, then come back here</li>
          <li><span className="step-num">3</span> Paste the link or say &ldquo;apply to this job&rdquo; — it fills the form and asks when unsure</li>
        </ol>
      ) : (
        <ol className="empty-steps">
          <li><span className="step-num">1</span> Connect your LLM in <strong>Settings</strong></li>
          <li><span className="step-num">2</span> Add your resume &amp; details in <strong>Profile</strong></li>
          <li><span className="step-num">3</span> Paste job links here and let it fill the forms</li>
        </ol>
      )}
      {configured ? (
        <p className="empty-hint">
          Applying to several at once? <strong>New job</strong> gives each application its own
          chat — one application per tab.
        </p>
      ) : (
        <div className="empty-actions">
          <button id="btn-goto-settings" className="btn-primary btn-small" onClick={onOpenSettings}>
            Open Settings
          </button>
          <button id="btn-goto-profile" className="btn-ghost btn-small" onClick={onOpenProfile}>
            Open Profile
          </button>
        </div>
      )}
    </div>
  );
}
