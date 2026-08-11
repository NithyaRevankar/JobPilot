/**
 * JobsView — the application log. Every application the agent finished lands here (written
 * by agent.js at `done`, storage key `applications`): what, where, when, and the honest
 * outcome. The tracker the chat transcript cannot be — transcripts are per-run, capped,
 * and cleared by New Chat; "what did I apply to this month" has to outlive all of that.
 *
 * Read-mostly by design: records are created by the agent, and the only edits offered
 * here are delete and CSV export. Editing history by hand is what spreadsheets are for —
 * which is exactly where the CSV button leads.
 */

import { useCallback, useEffect, useState } from 'react';

import { applicationsToCsv, deleteApplication, getApplications } from '../../js/storage.js';
import { platformLabel } from '../../js/platforms.js';
import { showToast } from '../components/Toast.jsx';
import { useAppShell } from '../state/store.jsx';

const STATUS_META = {
  submitted: { text: 'Submitted', cls: 'app-status-ok' },
  ready_for_review: { text: 'Filled — submitted by you', cls: 'app-status-ok' },
  already_applied: { text: 'Already applied', cls: 'app-status-info' },
};

function dayOf(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export default function JobsView() {
  const { tab } = useAppShell();
  const [apps, setApps] = useState([]);

  const reload = useCallback(async () => {
    try {
      setApps(await getApplications());
    } catch (err) {
      showToast(`Could not read the application log: ${err.message}`, 'error');
    }
  }, []);

  // Fresh on mount and every time the tab is opened — runs append records while the user
  // is elsewhere, and a log that shows yesterday's count until a reload reads as broken.
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => { if (tab === 'jobs') reload(); }, [tab, reload]);

  const onExport = useCallback(() => {
    // Same detached-anchor download as the settings backup — see SettingsView for why
    // the URL is not revoked in this tick.
    const csv = applicationsToCsv(apps);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `jobpilot-applications-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, [apps]);

  const onDelete = useCallback(async (id) => {
    await deleteApplication(id);
    reload();
  }, [reload]);

  return (
    <div className="scroll-area">
      <div className="apps-header">
        <span className="apps-count">
          {apps.length ? `${apps.length} application${apps.length === 1 ? '' : 's'}` : 'No applications yet'}
        </span>
        <button
          id="btn-export-csv"
          className="btn-ghost btn-small"
          disabled={!apps.length}
          title="Download the log as CSV — opens in Excel or Google Sheets"
          onClick={onExport}
        >
          Export CSV
        </button>
      </div>

      {!apps.length ? (
        <p className="apps-empty">
          Every application the agent finishes is recorded here automatically — title,
          company, link, date and outcome. Apply to something and it will appear.
        </p>
      ) : (
        <ul className="apps-list">
          {apps.map((a) => {
            const meta = STATUS_META[a.status] || STATUS_META.submitted;
            return (
              <li key={a.id} className="apps-row">
                <div className="apps-main">
                  <span className="apps-title">{a.jobTitle || '(untitled position)'}</span>
                  <span className="apps-company">
                    {a.company || a.host || ''}
                    {a.portal ? ` · ${platformLabel(a.portal)}` : ''}
                  </span>
                </div>
                <div className="apps-side">
                  <span className={`apps-status ${meta.cls}`}>{meta.text}</span>
                  <span className="apps-date">{dayOf(a.submittedAt)}</span>
                  <span className="apps-actions">
                    {a.url ? (
                      <a href={a.url} target="_blank" rel="noopener noreferrer" title="Open the posting">↗</a>
                    ) : null}
                    <button
                      type="button"
                      className="apps-delete"
                      title="Remove from the log"
                      aria-label={`Remove ${a.jobTitle || 'this application'}`}
                      onClick={() => onDelete(a.id)}
                    >
                      ×
                    </button>
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
