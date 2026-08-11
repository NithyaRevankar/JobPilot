/**
 * ProfileView — the React port of the Profile tab.
 *
 * App.jsx already renders the wrapper:
 *     <section id="view-profile" class="view [active]"> <ProfileView/> </section>
 * so this component's ROOT element is <div className="scroll-area">, exactly what lived
 * INSIDE that section in panel.html.orig (lines 134-237).
 *
 * PORTED FROM sidepanel/js/panel.js:
 *   MAX_DOC_BYTES (48), formatSize (73), PROFILE_FIELD_IDS (2131),
 *   persistProfile / wireProfileFields (2140-2158), renderDocuments (2162),
 *   addDocumentFile (2234), fileToBase64 (2277), guessMime (2286), wireDropzone (2296),
 *   renderSavedAnswers (2322), wireSavedAnswers (2367), wireProfileValues (2568).
 *
 * WHAT DISAPPEARED, and why that is the point:
 *   * wireProfileValues (2568) existed only so "Clear ALL data" could shove the wiped
 *     profile back into 27 live <input> nodes. The inputs are controlled by `profile`
 *     now, so reloadAll() re-rendering the store is the whole of it.
 *   * renderDocuments / renderSavedAnswers rebuilt their subtree by hand on every change.
 *     They are a .map() over store state.
 *   * The debounce itself: persistProfile (2140) is the store's `updateProfile`, which
 *     fires 'Saved ✓' / 'Could not save profile: …' on the SAME 400ms timer. This view
 *     must therefore never toast around it — that would be two toasts per save.
 *
 * WHAT DELIBERATELY DID NOT CHANGE:
 *   fileToBase64 and guessMime are byte-for-byte the originals. The base64 payload, the
 *   original MIME and the original filename are what the content script hands to a real
 *   file input on a real job site; "improving" any of the three silently breaks resume
 *   upload, which is the product.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../components/Icon.jsx';
import { openAsk } from '../components/Modal.jsx';
import { showToast } from '../components/Toast.jsx';
import { decodePlanRows } from '../modal-queue.js';
import { useAppShell, useDocuments, useProfile, useSettings } from '../state/store.jsx';
import { extractDocumentText } from '../../js/doctext.js';
import {
  extractProfileFromResume, extractionRows, profileCompleteness,
} from '../../js/profile-intel.js';

const MAX_DOC_BYTES = 8 * 1024 * 1024;

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
    reader.onerror = () => reject(new Error('file could not be read'));
    reader.readAsDataURL(file);
  });
}

function guessMime(name) {
  const ext = name.toLowerCase().split('.').pop();
  return {
    pdf: 'application/pdf',
    doc: 'application/msword',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    txt: 'text/plain',
  }[ext] || 'application/octet-stream';
}

/**
 * One `<label class="field">` from panel.html.orig. A helper only so the 24 of them below
 * read as the list they are; the emitted markup is identical to the hand-written original,
 * ids included. A field with no `placeholder` emits no placeholder attribute, because
 * `placeholder={undefined}` is how JSX omits an attribute.
 */
function PfField({ name, label, type = 'text', placeholder, wide = false, value, onValue }) {
  return (
    <label className={wide ? 'field field-wide' : 'field'}>
      <span>{label}</span>
      <input
        type={type}
        id={`pf-${name}`}
        placeholder={placeholder}
        autoComplete="off"
        value={value}
        onChange={(e) => onValue(name, e.target.value)}
      />
    </label>
  );
}

/**
 * CONTRACT-V12 §2 — how ready this profile is, and what to type next.
 *
 * The bar is the least useful thing on it and it is there because people look for one. The
 * LIST is the feature: the empty fields that actually stop applications, worst first, with
 * the ones a form has already had to ask about called out — because that is evidence about
 * the jobs THIS person applies to rather than a general claim about forms.
 */
function CompletenessMeter({ profile, onJump }) {
  const { percent, filled, total, missing } = useMemo(() => profileCompleteness(profile), [profile]);
  const top = missing.slice(0, 4);
  const tone = percent >= 90 ? 'ok' : percent >= 55 ? 'warn' : 'low';

  return (
    <div className="pf-meter">
      <div className="pf-meter-head">
        <span className="pf-meter-pct">{percent}% ready</span>
        <span className="pf-meter-count">{filled} of {total} fields</span>
      </div>
      <div className={`pf-meter-track pf-meter-${tone}`}>
        <div className="pf-meter-fill" style={{ width: `${percent}%` }} />
      </div>
      {top.length ? (
        <>
          <p className="pf-meter-lead">
            {/* Named, not counted. "8 fields missing" tells you nothing you can act on. */}
            Worth filling next — these are what stop an application:
          </p>
          <ul className="pf-missing">
            {top.map((m) => (
              <li key={m.key}>
                <button type="button" className="pf-missing-link" onClick={() => onJump(m.key)}>
                  {m.label}
                </button>
                <span className="pf-missing-why">
                  {/* Evidence outranks the general claim, and says so plainly: this one has
                      already cost the user an interruption on a real application. */}
                  {m.asked
                    ? `a form asked you this ${m.asked === 1 ? 'once' : `${m.asked} times`}`
                    : m.why}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="pf-meter-lead">Nothing important is missing. The agent has what it needs.</p>
      )}
    </div>
  );
}

export default function ProfileView() {
  const { profile, updateProfile, saveProfileNow } = useProfile();
  const { documents, addDocument, removeDocument, makeDefaultDocument } = useDocuments();
  const { settings } = useSettings();
  const { isConfigured, setTab } = useAppShell();

  const [dragover, setDragover] = useState(false);
  const [extracting, setExtracting] = useState(false);
  const fileInputRef = useRef(null);
  const answersRef = useRef(null);
  const focusNewAnswerRef = useRef(false);

  // panel.js kept `profile` in module scope, so the SECOND file of a multi-file drop saw
  // the resumeText the first one had just auto-filled. React's `profile` is captured per
  // render and the sequential loop in onFiles does not re-render between files, so the
  // "only ever FILL an empty box" check below reads through this ref, which the auto-fill
  // updates the instant it lands rather than waiting for a commit.
  const profileRef = useRef(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  // wireProfileFields (panel.js:2149) — every keystroke merges into the profile and rides
  // the store's 400ms debounce. No toast here: updateProfile already fires 'Saved ✓'.
  const setField = (name, value) => updateProfile({ [name]: value });

  // ------------------------------------------------------------------ documents

  async function addDocumentFile(file) {
    if (file.size > MAX_DOC_BYTES) {
      showToast(`${file.name} is over the 8 MB limit`, 'error');
      return;
    }
    const okTypes = /\.(pdf|docx?|txt)$/i;
    if (!okTypes.test(file.name)) {
      showToast('Only PDF, DOC, DOCX and TXT files are supported', 'error');
      return;
    }
    try {
      const dataBase64 = await fileToBase64(file);
      const mime = file.type || guessMime(file.name);
      // Read the words out of it, not just the bytes. Storing the file and nothing else is
      // what made "I've added my resume" buy the user nothing: the agent could attach it and
      // still had to ask what job they do. Extraction failing is fine and is reported — it is
      // extraction failing SILENTLY that produced the complaint.
      const extracted = await extractDocumentText({ name: file.name, mime, dataBase64 });
      await addDocument({
        name: file.name,
        mime,
        size: file.size,
        dataBase64,
        text: extracted.text,
        textError: extracted.ok ? '' : extracted.reason,
        isDefault: false,
      });
      // Only ever FILL an empty box. The user's own text wins — silently replacing something
      // they typed and corrected with a fresh machine extraction would be its own bug.
      if (extracted.ok && !String(profileRef.current.resumeText || '').trim()) {
        // saveProfileNow, not updateProfile: panel.js called saveProfile() directly here, so
        // this write lands immediately and does NOT toast 'Saved ✓' on top of the add toast.
        profileRef.current = await saveProfileNow({ resumeText: extracted.text });
      }
      showToast(extracted.ok
        ? `Added ${file.name} — read ${extracted.text.length.toLocaleString()} characters of text`
        : `Added ${file.name} — text could not be read`, extracted.ok ? 'success' : 'warn');
    } catch (err) {
      showToast(`Could not add ${file.name}: ${err.message}`, 'error');
    }
  }

  // Sequential on purpose. storage.saveDocument is a read-modify-write of one `documents`
  // array, so running two adds concurrently loses one of them.
  async function addFiles(files) {
    for (const f of files) await addDocumentFile(f);
  }

  const openPicker = () => fileInputRef.current && fileInputRef.current.click();

  async function onFileInputChange(e) {
    // Snapshot before awaiting: the reset below empties e.target.files mid-loop otherwise.
    const files = Array.from(e.target.files || []);
    await addFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function onDrop(e) {
    e.preventDefault();
    setDragover(false);
    // dataTransfer is only valid for the duration of the handler, so read it before await.
    const files = Array.from(e.dataTransfer.files || []);
    await addFiles(files);
  }

  // panel.js bound dragover/dragleave/drop only; dragenter sets the same flag, which
  // changes nothing observable and makes the zone a valid target on the first event.
  const onDragOver = (e) => {
    e.preventDefault();
    setDragover(true);
  };

  async function onMakeDefault(doc) {
    try {
      await makeDefaultDocument(doc.id);
    } catch (err) {
      showToast(`Could not set default: ${err.message}`, 'error');
    }
  }

  async function onDeleteDocument(doc) {
    try {
      await removeDocument(doc.id);
      showToast(`Deleted ${doc.name}`, 'success');
    } catch (err) {
      showToast(`Could not delete: ${err.message}`, 'error');
    }
  }

  // ------------------------------------------------------- fill from the resume
  //
  // CONTRACT-V12 §1. The 25-field wall, answered by the document that already states most
  // of it. One model call proposes values; the user reviews them in the same card plan mode
  // uses, per field, and nothing is written until they accept.

  /** The text to read: what the user typed wins over any extraction, as everywhere else. */
  const resumeSource = useMemo(() => {
    const typed = String(profile.resumeText || '').trim();
    if (typed) return typed;
    const withText = documents.filter((d) => d && String(d.text || '').trim());
    const preferred = withText.find((d) => d.isDefault) || withText[0];
    return preferred ? String(preferred.text).trim() : '';
  }, [profile.resumeText, documents]);

  async function onFillFromResume() {
    if (!isConfigured()) {
      showToast('Connect your LLM in Settings first — reading the resume takes one model call', 'error');
      setTab('settings');
      return;
    }
    setExtracting(true);
    try {
      const res = await extractProfileFromResume({ settings, resumeText: resumeSource });
      if (!res.ok) {
        showToast(res.error, 'error');
        return;
      }
      const rows = extractionRows(res.values, profile);
      if (!rows.length) {
        // Two very different situations, and telling them apart is the difference between
        // "it is broken" and "it already did its job".
        showToast(Object.keys(res.values).length
          ? 'Your profile already matches everything the resume says'
          : 'Nothing usable could be read from the resume — check the Resume text box below',
        Object.keys(res.values).length ? 'success' : 'warn');
        return;
      }

      const overwrites = rows.filter((r) => r.warn).length;
      const result = await openAsk({
        title: 'From your resume',
        message: `Read ${rows.length} value${rows.length === 1 ? '' : 's'} off your resume. `
          + (overwrites
            ? `${overwrites} would replace something already in your profile — those are marked and start unticked, because what you typed wins.`
            : 'Nothing here overwrites anything you have already filled in.'),
        fields: [{ name: 'plan', type: 'plan', label: 'Fields', rows }],
        submitLabel: 'Save',
      });
      if (!result) return;

      const decoded = decodePlanRows(result.values.plan);
      const patch = {};
      rows.forEach((row, i) => {
        const d = decoded[i];
        const value = d ? d.value.trim() : '';
        // Same rule as the plan card: an emptied box is an unticked row, never a write of ''.
        if (d && d.include && value) patch[row.key] = value;
      });
      const keys = Object.keys(patch);
      if (!keys.length) {
        showToast('Nothing was saved — every field was unticked', '');
        return;
      }
      // saveProfileNow, not updateProfile: this is a deliberate bulk write the user just
      // approved, and it should be on disk before they can navigate away from the tab.
      await saveProfileNow(patch);
      showToast(`Saved ${keys.length} field${keys.length === 1 ? '' : 's'} from your resume`, 'success');
    } catch (err) {
      showToast(`Could not read the resume: ${err.message}`, 'error');
    } finally {
      setExtracting(false);
    }
  }

  /** Jump the user to a field the meter named, and put the caret in it. */
  const jumpToField = (key) => {
    const el = document.getElementById(`pf-${key}`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  };

  // --------------------------------------------------------------- saved answers

  const savedAnswers = profile.savedAnswers;

  const setAnswer = (i, patch) => {
    const list = savedAnswers.map((entry, j) => (j === i ? { ...entry, ...patch } : entry));
    updateProfile({ savedAnswers: list });
  };

  const deleteAnswer = (i) => {
    updateProfile({ savedAnswers: savedAnswers.filter((_, j) => j !== i) });
  };

  const addAnswer = () => {
    focusNewAnswerRef.current = true;
    updateProfile({ savedAnswers: [...savedAnswers, { q: '', a: '' }] });
  };

  // wireSavedAnswers (panel.js:2367) focused `inputs[inputs.length - 2]` after appending —
  // the Question box of the row it just created, so "Add answer" leaves the caret where
  // you are about to type. Same query, run after the commit that created the row.
  useEffect(() => {
    if (!focusNewAnswerRef.current) return;
    focusNewAnswerRef.current = false;
    const inputs = answersRef.current ? answersRef.current.querySelectorAll('input') : [];
    if (inputs.length >= 2) inputs[inputs.length - 2].focus();
  });

  // ---------------------------------------------------------------------- render

  return (
    <div className="scroll-area">

      {/* First, because it is the answer to "what do I do here" — and because the button
          under it is the one that means you may not have to do the rest by hand. */}
      <div className="section">
        <h3 className="section-title">Your profile</h3>
        <CompletenessMeter profile={profile} onJump={jumpToField} />
        <div className="pf-fill-row">
          <button
            id="btn-fill-from-resume"
            className="btn-primary btn-small"
            disabled={extracting || !resumeSource}
            title={resumeSource
              ? 'One model call reads your resume and proposes values — you review each one before anything is saved'
              : 'Add a resume below first, or paste it into Resume text'}
            onClick={onFillFromResume}
          >
            {extracting ? 'Reading your resume…' : 'Fill from my resume'}
          </button>
          <span className="pf-fill-hint">
            {resumeSource
              ? 'Proposes values from your resume. You review every one before it is saved — nothing is written until you say so.'
              : 'Add a resume below and this can fill most of this page for you.'}
          </span>
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Documents</h3>
        <p className="section-hint">Resume / CV files the agent can upload into applications.</p>
        <div
          id="dropzone"
          className={dragover ? 'dropzone dragover' : 'dropzone'}
          tabIndex={0}
          role="button"
          aria-label="Add a document"
          onClick={openPicker}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
          }}
          onDragEnter={onDragOver}
          onDragOver={onDragOver}
          onDragLeave={() => setDragover(false)}
          onDrop={onDrop}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M12 15V4M8 8l4-4 4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M4 15v3.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <span>Drop a file or <strong>browse</strong></span>
          <span className="dropzone-sub">PDF, DOC, DOCX, TXT — up to 8 MB</span>
        </div>
        <input
          type="file"
          id="doc-file-input"
          ref={fileInputRef}
          accept=".pdf,.doc,.docx,.txt,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
          hidden
          onChange={onFileInputChange}
        />
        <div id="doc-list" className="doc-list">
          {documents.map((doc) => (
            <div className="doc-row" key={doc.id}>
              <Icon name="file" size={18} className="doc-icon" />
              <div className="doc-meta">
                <div className="doc-name">{doc.name}</div>
                {/* Whether the agent can READ this, not just attach it. The old row said only
                    the file size, so a resume whose text JobPilot could not extract looked
                    identical to one it had understood — and the user found out only by being
                    asked their job title again. */}
                <div className={doc.text ? 'doc-size' : 'doc-size doc-warn'}>
                  {`${formatSize(doc.size)}${doc.isDefault ? ' · default' : ''} · ${
                    doc.text
                      ? `text read (${doc.text.length.toLocaleString()} chars)`
                      : `text NOT read — ${doc.textError || 'paste it into Resume text below'}`
                  }`}
                </div>
              </div>
              <button
                className={doc.isDefault ? 'doc-star active' : 'doc-star'}
                title={doc.isDefault ? 'Default document' : 'Make default'}
                onClick={() => onMakeDefault(doc)}
              >
                <Icon name="star" size={15} solid={doc.isDefault} />
              </button>
              <button
                className="doc-delete"
                title="Delete document"
                onClick={() => onDeleteDocument(doc)}
              >
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Basics</h3>
        <div className="field-grid">
          <PfField name="fullName" label="Full name" value={profile.fullName || ''} onValue={setField} />
          <PfField name="email" label="Email" type="email" value={profile.email || ''} onValue={setField} />
          <PfField name="phone" label="Phone" type="tel" value={profile.phone || ''} onValue={setField} />
          <PfField name="location" label="Location" value={profile.location || ''} onValue={setField} />
          <PfField name="linkedin" label="LinkedIn" type="url" placeholder="https://linkedin.com/in/…" value={profile.linkedin || ''} onValue={setField} />
          <PfField name="github" label="GitHub" type="url" placeholder="https://github.com/…" value={profile.github || ''} onValue={setField} />
          <PfField name="portfolio" label="Portfolio / website" type="url" wide value={profile.portfolio || ''} onValue={setField} />
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Address</h3>
        <p className="section-hint">Application forms split the address into separate boxes. Fill these once and the agent stops asking.</p>
        <div className="field-grid">
          <PfField name="addressLine1" label="Address line 1" placeholder="Street address" wide value={profile.addressLine1 || ''} onValue={setField} />
          <PfField name="addressLine2" label="Address line 2" placeholder="Apartment, suite, unit — optional" wide value={profile.addressLine2 || ''} onValue={setField} />
          <PfField name="city" label="City" value={profile.city || ''} onValue={setField} />
          <PfField name="state" label="State / Province" value={profile.state || ''} onValue={setField} />
          <PfField name="postalCode" label="Postal code" placeholder="ZIP / PIN" value={profile.postalCode || ''} onValue={setField} />
          <PfField name="country" label="Country" value={profile.country || ''} onValue={setField} />
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Current role</h3>
        <p className="section-hint">Every application asks for these. Fill them once and the agent stops asking.</p>
        <div className="field-grid">
          <PfField name="currentTitle" label="Current / most recent job title" placeholder="e.g. Senior Software Engineer" value={profile.currentTitle || ''} onValue={setField} />
          <PfField name="currentCompany" label="Current / most recent employer" placeholder="e.g. Acme Corp" value={profile.currentCompany || ''} onValue={setField} />
          <PfField name="yearsExperience" label="Years of experience" placeholder="e.g. 7" value={profile.yearsExperience || ''} onValue={setField} />
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Work eligibility</h3>
        <div className="field-grid">
          <PfField name="workAuth" label="Work authorization" placeholder="e.g. Indian citizen, unrestricted right to work in India" wide value={profile.workAuth || ''} onValue={setField} />
          {/* workAuth is free text and applicants write it a dozen ways. This one is the
              form's yes-or-no and must never be inferred from that prose. */}
          <PfField name="sponsorshipNeeded" label="Needs visa sponsorship, now or in future" placeholder="Yes / No — forms ask this as a yes-or-no and the agent must not guess" wide value={profile.sponsorshipNeeded || ''} onValue={setField} />
          <PfField name="salary" label="Salary expectation" placeholder="e.g. $150k" value={profile.salary || ''} onValue={setField} />
          <PfField name="noticePeriod" label="Notice period" placeholder="e.g. 2 weeks" value={profile.noticePeriod || ''} onValue={setField} />
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Resume text</h3>
        <p className="section-hint" id="resume-text-hint">
          What your resume <em>says</em>. Uploading a file above only gives the agent something to
          attach — this is the part it can read. JobPilot fills this in automatically when it can
          read your upload; correct it or paste your own, and what is here wins.
        </p>
        <textarea
          id="pf-resumeText"
          className="textarea"
          rows={8}
          placeholder="Paste your resume as plain text — job titles, employers, dates, skills, education…"
          value={profile.resumeText || ''}
          onChange={(e) => setField('resumeText', e.target.value)}
        />
      </div>

      <div className="section">
        <h3 className="section-title">Voluntary self-identification</h3>
        <p className="section-hint">
          The optional EEO / diversity questions at the bottom of most applications. Anything you leave
          blank is answered with the form’s <strong>“Decline to self-identify”</strong> option — the agent
          never asks you and never guesses.
        </p>
        <div className="field-grid">
          <PfField name="gender" label="Gender" placeholder="e.g. Male / Female / Non-binary" value={profile.gender || ''} onValue={setField} />
          <PfField name="pronouns" label="Pronouns" placeholder="e.g. he/him" value={profile.pronouns || ''} onValue={setField} />
          <PfField name="ethnicity" label="Race / ethnicity" placeholder="e.g. Asian" wide value={profile.ethnicity || ''} onValue={setField} />
          <PfField name="veteranStatus" label="Veteran status" placeholder="e.g. Not a veteran" value={profile.veteranStatus || ''} onValue={setField} />
          <PfField name="disabilityStatus" label="Disability status" placeholder="e.g. No disability" value={profile.disabilityStatus || ''} onValue={setField} />
        </div>
      </div>

      <div className="section">
        <h3 className="section-title">Anything else the AI should know</h3>
        <textarea
          id="pf-extraContext"
          className="textarea"
          rows={4}
          placeholder="Skills, visa details, preferences, years of experience, anything a form might ask…"
          value={profile.extraContext || ''}
          onChange={(e) => setField('extraContext', e.target.value)}
        />
      </div>

      <div className="section">
        <h3 className="section-title">Saved answers</h3>
        <p className="section-hint">Reusable screening answers. The agent uses these before asking you again.</p>
        <div id="saved-answers" className="saved-answers" ref={answersRef}>
          {!savedAnswers.length ? (
            <div className="saved-answers-empty">
              No saved answers yet. They accumulate as you answer the agent’s questions.
            </div>
          ) : savedAnswers.map((entry, i) => (
            // Index keys, deliberately: a saved answer has no id, mergeSavedAnswers updates
            // rows IN PLACE so the order does not shuffle, and both boxes are fully
            // controlled — so an index key renders the same rows a keyed list would.
            <div className="answer-row" key={i}>
              <div className="answer-fields">
                <input
                  type="text"
                  placeholder="Question"
                  value={entry.q}
                  onChange={(e) => setAnswer(i, { q: e.target.value })}
                />
                <input
                  type="text"
                  placeholder="Answer"
                  value={entry.a}
                  onChange={(e) => setAnswer(i, { a: e.target.value })}
                />
              </div>
              <button
                className="answer-delete"
                title="Delete this answer"
                onClick={() => deleteAnswer(i)}
              >
                <Icon name="trash" size={14} />
              </button>
            </div>
          ))}
        </div>
        <button id="btn-add-answer" className="btn-ghost btn-small" onClick={addAnswer}>
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          Add answer
        </button>
      </div>

    </div>
  );
}
