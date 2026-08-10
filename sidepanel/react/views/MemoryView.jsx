/**
 * MemoryView — the memory bank (CONTRACT-V3 §6): portal playbooks, the demonstrations the
 * user recorded (CONTRACT-V6 §7.5), and per-company notes.
 *
 * App.jsx renders the wrapper — <section id="view-memory" class="view [active]"> — so this
 * component's ROOT element is <div className="scroll-area">.
 *
 * PORTED FROM  sidepanel/panel.html.orig lines 243-285 (markup) and sidepanel/js/panel.js:
 *   refreshMemoryView (1036) -> useMemoryBank().reloadMemory(),
 *   renderMacros (1050), renderMemoryList (1103), renderPlaybookRow (1111),
 *   memorySubtitle (1252), textareaField (1259), splitLines (1278),
 *   renderSiteNotes (1282), wireMemory (1329), relativeTime (130), platformName (820).
 *
 * THE POINT OF THE MIGRATION, IN ONE LINE. panel.js:44 was
 *     let openPlaybooks = new Set();  // which rows are expanded — survives a re-render
 * — a module-level Set that existed only because renderMemoryList() threw every row away
 * and rebuilt it from scratch after every save, delete and reload, so the DOM could not be
 * asked which rows were open. Here it is ordinary component state: React keeps the rows,
 * so the state that describes them can live with them. renderPlaybookRow's ~140 lines of
 * createElement are the JSX below.
 *
 * Playbooks are keyed by PORTAL, not employer (CONTRACT-V3 §0) — one Workday playbook
 * serves every company on Workday.
 */

import { useEffect, useRef, useState } from 'react';

import Icon from '../components/Icon.jsx';
import { openAsk, openConfirm } from '../components/Modal.jsx';
import { showToast } from '../components/Toast.jsx';
import { useAppShell, useMemoryBank } from '../state/store.jsx';
import { PLATFORMS, platformLabel } from '../../js/platforms.js';
import { seedFor } from '../../js/playbook-seeds.js';

// ----------------------------------------------------------------- helpers

/** panel.js:1278, verbatim. Trim every line, drop the blank ones — a textarea is prose. */
function splitLines(text) {
  return String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
}

/**
 * "3m ago" / "2d ago" — for playbook last-updated stamps. panel.js:130, verbatim.
 * Local to this view because it is the only screen that stamps a row; if a second view
 * ever wants it, hoist it into a shared util rather than copying it again.
 */
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

/** panel.js:1252. A builtin's updatedAt is the moment it was seeded, so it is not shown. */
function memorySubtitle(pb) {
  const bits = [`${pb.procedure.length} steps`, `${pb.tips.length} tips`];
  if (pb.useCount > 0) bits.push(`used ${pb.useCount}×`);
  if (pb.updatedAt && pb.source !== 'builtin') bits.push(relativeTime(pb.updatedAt));
  return bits.join(' · ');
}

/**
 * The three source kinds and the words the user sees for them (panel.js:1131). The class
 * suffix and the label deliberately differ: `user` reads as "edited", because from the
 * user's side of the screen that is what it is.
 */
function badgeFor(source) {
  if (source === 'builtin') return { kind: 'builtin', label: 'built-in' };
  if (source === 'learned') return { kind: 'learned', label: 'learned' };
  return { kind: 'user', label: 'edited' };
}

// panel.js:820's platformName is platforms.js's own platformLabel — same lookup, same
// fall back to the raw key for a portal the user typed in by hand.
const platformName = platformLabel;

// ------------------------------------------------------------------- view

export default function MemoryView() {
  const { tab } = useAppShell();
  const {
    playbooks, siteNotes, macros,
    reloadMemory, savePlaybook, deleteSiteNote, deleteMacro,
    pendingPlaybook, consumePendingPlaybook, memoryEpoch,
  } = useMemoryBank();

  // panel.js:44's `openPlaybooks` Set, now where it belongs. A Set (not an array) because
  // every read is a membership test, and it is replaced rather than mutated so React sees
  // the change.
  const [openPlaybooks, setOpenPlaybooks] = useState(() => new Set());

  const setOpen = (platform, open) => {
    setOpenPlaybooks((prev) => {
      const next = new Set(prev);
      if (open) next.add(platform);
      else next.delete(platform);
      return next;
    });
  };

  // switchTab (panel.js:240) called refreshMemoryView() on the way in. setTab is pure
  // state now, so the on-activate refresh is this view's job. All five views stay mounted
  // for the whole session, so this effect is how the bank picks up what the agent wrote
  // while the user was on another tab. Nothing to clean up — it only reads — and running
  // twice under StrictMode is idempotent.
  useEffect(() => {
    if (tab === 'memory') reloadMemory();
  }, [tab, reloadMemory]);

  // panel.js:1333 — the chat header's portal chip expanded the detected portal's row
  // BEFORE switching tabs, so arriving via the chip showed that playbook open. The chip is
  // ChatView's and this Set is ours, so the platform arrives through the store as a
  // one-shot request. Consume it here: clearing it is what stops the row from re-expanding
  // every subsequent time the user comes back to this tab.
  useEffect(() => {
    if (tab !== 'memory' || !pendingPlaybook) return;
    setOpen(pendingPlaybook, true);
    consumePendingPlaybook();
  }, [tab, pendingPlaybook, consumePendingPlaybook]);

  // panel.js:2551 — "Clear ALL data" ran openPlaybooks.clear() so a wipe did not leave
  // rows expanded from before it. The wipe lives in SettingsView and bumps this counter.
  // Skips the first render: the initial epoch is not a wipe.
  const seenEpoch = useRef(memoryEpoch);
  useEffect(() => {
    if (seenEpoch.current === memoryEpoch) return;
    seenEpoch.current = memoryEpoch;
    setOpenPlaybooks(new Set());
  }, [memoryEpoch]);

  // ---- wireMemory's "Add" button (panel.js:1340)
  async function handleAdd() {
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
      // Expand the one they already have rather than leaving them looking for it.
      setOpen(key, true);
      await reloadMemory();
      return;
    }

    try {
      await savePlaybook({
        platform: key,
        label: match ? match.label : typed,
        procedure: [],
        tips: [],
      }, 'user');
      setOpen(key, true);
      // panel.js followed this with refreshMemoryView(); the store's savePlaybook re-reads
      // the whole bank itself, so state already mirrors disk by the time we get here.
      showToast(`${match ? match.label : typed} playbook created — add the steps`, 'success');
    } catch (err) {
      showToast(`Could not create the playbook: ${err.message}`, 'error');
    }
  }

  return (
    <div className="scroll-area">

      <div className="section">
        <div className="mem-head">
          <h3 className="section-title">Portal playbooks</h3>
          <button
            id="mem-add"
            type="button"
            className="btn-ghost btn-small"
            title="Write a playbook by hand"
            onClick={handleAdd}
          >
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
            Add
          </button>
        </div>
        <p className="section-hint">
          How to apply on each job portal — Workday, Greenhouse, Lever and the rest. These are
          keyed by <strong>portal, not company</strong>, so what the agent learns applying at one
          employer makes every other employer on the same portal fast. It updates these itself as
          it works; edit or add your own here.
        </p>
        <div id="mem-list" className="mem-list">
          {playbooks.map((pb) => (
            <PlaybookRow
              key={pb.platform}
              pb={pb}
              open={openPlaybooks.has(pb.platform)}
              onOpenChange={setOpen}
            />
          ))}
        </div>
        <p id="mem-empty" className="mem-empty" hidden={playbooks.length > 0}>No playbooks yet.</p>
      </div>

      {/* CONTRACT-V6 §7.5 — the demonstrations the user recorded, per portal. Visible and
          deletable: a macro that replays a wrong action must be easy to get rid of. */}
      <div id="mem-macros-section" className="section" hidden={macros.length === 0}>
        <h3 className="section-title">Recorded demonstrations</h3>
        <p className="section-hint">
          When JobPilot gets stuck it asks you to show it how, watches you do it once, and saves
          the steps against the portal — so it can do it itself on every future application there.
          Credentials are never recorded.
        </p>
        <div id="mem-macros-list" className="mem-list">
          {macros.map((macro) => (
            <MacroRow
              key={`${macro.platform}\u0000${macro.name}`}
              macro={macro}
              onDelete={async () => {
                try {
                  await deleteMacro(macro.platform, macro.name);
                  showToast('Macro deleted', 'success');
                } catch (err) {
                  showToast(`Could not delete: ${err.message}`, 'error');
                }
              }}
            />
          ))}
        </div>
      </div>

      <div id="mem-notes-section" className="section" hidden={siteNotes.length === 0}>
        <h3 className="section-title">Company notes</h3>
        <p className="section-hint">
          Quirks that are true of one employer only, not of the portal in general. These load in
          addition to the portal playbook when you are on that site.
        </p>
        <div id="mem-notes-list" className="mem-list">
          {siteNotes.map((note) => (
            <SiteNoteRow
              key={note.host}
              note={note}
              onDelete={async () => {
                try {
                  await deleteSiteNote(note.host);
                  showToast('Company notes deleted', 'success');
                } catch (err) {
                  showToast(`Could not delete: ${err.message}`, 'error');
                }
              }}
            />
          ))}
        </div>
        {/* Carried across from panel.js:1288 even though the whole section is hidden when the
            list is empty: the two guards were always belt-and-braces, and dropping one is
            exactly the kind of "obviously redundant" edit that turns into a blank section the
            day the section stops hiding itself. */}
        <p id="mem-notes-empty" className="mem-empty" hidden={siteNotes.length > 0}>No company-specific notes yet.</p>
      </div>

    </div>
  );
}

// -------------------------------------------------------------- playbook row

/**
 * One collapsible playbook. panel.js:1111 built this with ~140 lines of createElement and
 * hand-wired the head's click to three separate DOM mutations (row.classList.toggle,
 * head.setAttribute('aria-expanded'), body.hidden); here the open flag renders all three.
 *
 * The body stays MOUNTED when the row is collapsed — `hidden`, exactly as the original did
 * — so folding a row away does not throw an in-progress edit on the floor.
 */
function PlaybookRow({ pb, open, onOpenChange }) {
  const { savePlaybook, deletePlaybook, resetPlaybook } = useMemoryBank();
  // The chat header's portal chip reads playbook presence straight from storage, so a save
  // or a delete here makes it stale. panel.js:1185 and panel.js:1231 both ended with
  // refreshPortalChip() for exactly this; the store's `chat` handle is how this view reaches
  // ChatView's copy of it. (panel.js deliberately did NOT refresh after "Reset to default"
  // — a reset re-seeds the portal, so the chip's ✓/cold verdict cannot change — nor after
  // mem-add, which creates an empty playbook the chip still reads as "no playbook yet".)
  const { chat } = useAppShell();

  const storedProcedure = pb.procedure.join('\n');
  const storedTips = pb.tips.join('\n');

  const [procedure, setProcedure] = useState(storedProcedure);
  const [tips, setTips] = useState(storedTips);
  const [stored, setStored] = useState({ procedure: storedProcedure, tips: storedTips });

  // The vanilla row was destroyed and rebuilt by every refreshMemoryView(), so its
  // textareas always showed what was on disk — which is load-bearing twice over: after a
  // save they show storage.js's CLAMPED result (12 steps / 14 tips, deduped, trimmed), and
  // after "Reset to default" they show the seed. A controlled textarea has to re-seed
  // itself deliberately, so it does that here, and only when the stored text actually
  // changed. An unrelated refresh — a site note deleted, another portal saved — leaves an
  // edit in progress alone, which the wholesale re-render could not manage.
  if (stored.procedure !== storedProcedure || stored.tips !== storedTips) {
    setStored({ procedure: storedProcedure, tips: storedTips });
    setProcedure(storedProcedure);
    setTips(storedTips);
  }

  const badge = badgeFor(pb.source);

  async function handleSave() {
    // Read the drafts BEFORE the await: the save round-trips through storage and re-seeds
    // this row from disk when it lands.
    const procedureLines = splitLines(procedure);
    const tipLines = splitLines(tips);
    try {
      // ONE write, with replaceTips. A hand-edit of these two boxes means "the playbook is
      // what I have typed" — savePlaybook merges tips by default so the AGENT can add one
      // without restating the rest, which is the right rule for the agent and the wrong one
      // here: under it, deleting a tip line was silently impossible and correcting a tip's
      // wording left both versions behind.
      //
      // panel.js:1171-1183 tried to get the same effect by saving `tips: []` first and the
      // real list second. That could never work — merging an empty array is a no-op — so
      // the clearing pass did nothing and the second call merged onto the untouched list.
      // The port carried it across faithfully, bug included; the fix is storage.js's
      // explicit replaceTips, which also makes this a single atomic write instead of two
      // that could leave the row half-saved if the second one threw.
      await savePlaybook({
        platform: pb.platform,
        label: pb.label,
        procedure: procedureLines,
        tips: tipLines,
        replaceTips: true,
      }, 'user');
      showToast(`${pb.label} playbook saved`, 'success');
      // panel.js:1184-1185 followed this with refreshMemoryView() + refreshPortalChip().
      // The store's savePlaybook does the first; this is the second. It cannot be left to
      // the 4s target-tab poll — that only refreshes the chip when the tab or its host
      // changed (ChatView.jsx:504), which a save on an unchanged tab never does.
      chat.refreshPortalChip();
    } catch (err) {
      showToast(`Could not save: ${err.message}`, 'error');
    }
  }

  async function handleReset() {
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
    } catch (err) {
      showToast(`Could not reset: ${err.message}`, 'error');
    }
  }

  async function handleDelete() {
    const ok = await openConfirm({
      title: `Delete the ${pb.label} playbook?`,
      message: 'The agent will have to work this portal out from scratch on the next application.',
      okLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await deletePlaybook(pb.platform);
      // Forget the expansion too — a seeded portal can come back via "Reset to default",
      // and it should come back folded like every other row.
      onOpenChange(pb.platform, false);
      showToast(`${pb.label} playbook deleted`, 'success');
      chat.refreshPortalChip(); // panel.js:1231
    } catch (err) {
      showToast(`Could not delete: ${err.message}`, 'error');
    }
  }

  return (
    <div className={open ? 'mem-row open' : 'mem-row'}>
      <button
        type="button"
        className="mem-row-head"
        aria-expanded={open}
        onClick={() => onOpenChange(pb.platform, !open)}
      >
        <div>
          <div className="mem-title">
            <span className="mem-name">{pb.label}</span>
            <span className={`mem-badge mem-badge-${badge.kind}`}>{badge.label}</span>
          </div>
          <div className="mem-sub">{memorySubtitle(pb)}</div>
        </div>
        <span className="mem-caret"><Icon name="caret" size={12} /></span>
      </button>

      <div className="mem-body" hidden={!open}>
        {/* textareaField (panel.js:1259): label > span, .textarea, .mem-hint. The stated
            caps are the ones the user is asked to respect; storage.js is what enforces
            them, and it keeps the FRONT of a procedure and the BACK of the tips. */}
        <label className="mem-field">
          <span>Procedure</span>
          <textarea
            className="textarea"
            value={procedure}
            onChange={(e) => setProcedure(e.target.value)}
          />
          <div className="mem-hint">One step per line, in order. Max 15.</div>
        </label>
        <label className="mem-field">
          <span>Tips</span>
          <textarea
            className="textarea"
            value={tips}
            onChange={(e) => setTips(e.target.value)}
          />
          <div className="mem-hint">One per line: selectors, control labels, traps. Max 20.</div>
        </label>

        <div className="mem-actions">
          <button type="button" className="btn-primary btn-small" onClick={handleSave}>Save</button>
          {/* Only a seeded portal has a default to go back to. */}
          {seedFor(pb.platform) ? (
            <button type="button" className="btn-ghost btn-small" onClick={handleReset}>Reset to default</button>
          ) : null}
          <button type="button" className="btn-link" onClick={handleDelete}>Delete</button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- macro / note rows
//
// Both reuse .mem-note-row, whose grid is `1fr 28px` — exactly two children, the block of
// text and the delete button.

/** panel.js:1057. */
function MacroRow({ macro, onDelete }) {
  const state = macro.status === 'broken'
    ? `broken: ${macro.lastError || 'it failed last time'}`
    : macro.status === 'working' ? `worked ${macro.useCount}×` : 'not replayed yet';

  return (
    <div className="mem-note-row">
      <div>
        <div className="mem-note-host">{`${macro.name} — ${platformName(macro.platform)}`}</div>
        <div className="mem-sub">
          {`${macro.steps.length} step${macro.steps.length === 1 ? '' : 's'} · ${state}`}
        </div>
        <ul className="mem-note-list">
          {macro.steps.map((step, i) => (
            // Steps have no id and their labels repeat ("Click Next"), so the index is the
            // only honest key. The list is replaced wholesale on every reload anyway.
            <li key={i}>{step.label}</li>
          ))}
        </ul>
      </div>
      <button
        type="button"
        className="answer-delete"
        title={`Delete the macro "${macro.name}"`}
        onClick={onDelete}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}

/** panel.js:1290. */
function SiteNoteRow({ note, onDelete }) {
  return (
    <div className="mem-note-row">
      <div>
        <div className="mem-note-host">{note.host}</div>
        <ul className="mem-note-list">
          {note.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </div>
      <button
        type="button"
        className="answer-delete"
        title={`Delete the notes for ${note.host}`}
        onClick={onDelete}
      >
        <Icon name="trash" size={14} />
      </button>
    </div>
  );
}
