// playbook-seeds.js — shipped portal playbooks (CONTRACT-V3 §1.3).
//
// These exist so the FIRST application on a major portal is not a rediscovery. They are
// starting points, not gospel: the agent verifies each step against the live page and
// improves them via `remember`. An edited playbook is never overwritten by a seed.
//
// Bump a seed's `seedVersion` to push an improvement to every user who has not edited
// their copy. Never bump it to overwrite someone's edits — that is what `edited:true`
// protects, and `resetPlaybook()` is the only way back to a seed.
//
// Caps (enforced in storage.js, §1.1): procedure ≤ 15, tips ≤ 20, 200 chars per line.
// Write about the PORTAL, never about one employer, and never about the user's answers.

/** @type {import('./storage.js').Playbook[]} */
export const SEEDS = [
  {
    platform: 'workday',
    label: 'Workday',
    // v4: Voluntary Disclosures / Self Identify had no step of their own, so the wizard's
    // two demographic pages became two rounds of questions on every application.
    seedVersion: 4,
    procedure: [
      'Read the posting, then click "Apply". If offered, choose "Apply Manually" — "Use My Last Application" silently reuses stale data.',
      'Workday requires an account. If a Sign In / Create Account screen appears, ask the user which they want, then use request_secret for the password. Never type it yourself.',
      'After sign-in the application is a multi-page wizard. The usual order is: My Information → My Experience → Application Questions → Voluntary Disclosures → Self Identify → Review.',
      'On "My Information", run autofill first (it fills the name/phone/address boxes and skips every prompt), then read_page and choose_option every dropdown: source, country, state, phone type, phone code.',
      'On "My Experience", upload_file the resume, then fill Work Experience, Education, Skills and Websites. Autofill-from-resume is fine, but read_page afterwards and correct what it got wrong.',
      'Answer every Application Question. These are the screening questions — use saved answers where they match, ask_user where they do not.',
      'On "Voluntary Disclosures" and "Self Identify", answer from the profile\'s self-identification values, pick the decline option wherever it is blank, and never ask the user (rule 16).',
      'Advance with the button at the very bottom of the page ("Next" / "Save and Continue"). read_page to find it; do not guess its ref.',
      'After each Next, wait with until_text for the next section heading, then call read_errors. Workday refuses to advance on a validation error and the message is easy to miss.',
      'On the Review page, read_page with mode "text" and check every section before submitting.',
      'Submit per the autoSubmit rule, then read_page again — success replaces the wizard with a confirmation banner.',
    ],
    tips: [
      'Every Workday control carries a data-automation-id attribute. It is the most stable hook on the page — prefer it over visible text when refs go stale.',
      'The bottom button is data-automation-id="pageFooterNextButton" (older tenants: "bottom-navigation-next-button"). Its text is usually "Save and Continue".',
      'Workday has NO native <select>. Anything read_page calls a "dropdown" is a Workday prompt — always choose_option, never fill or select_option.',
      'Prompts like "How Did You Hear About Us?" and "Country Phone Code" look like plain search boxes but are dropdowns. Typing in them selects nothing; choose_option types AND picks.',
      '"How Did You Hear About Us?" opens on categories (Job Boards, Social Media…). choose_option searches through to the leaf — pass the leaf label, not the category.',
      'A chosen value shows as a pill, not as text in the box. read_page reports the pill, so an empty-looking search box does not mean an empty field.',
      'Never re-pick a value a prompt already holds: in a Workday multiselect, choosing an option that is already selected REMOVES it.',
      'Workday registers a value only when the field loses focus. fill blurs for you; if validation still claims a filled field is empty, click another field to commit it, then read_errors again.',
      'Dates are three separate MM / DD / YYYY inputs, not one field. Fill each.',
      'The Self Identify page also asks for Name and Date — fill them from the profile; the date is today.',
      'The resume drop zone has a visible button that opens the OS file picker — it cannot be automated. Find the underlying file input and use upload_file on that.',
      'Adding a work-experience or education row re-renders the section, so every ref goes stale. read_page again after each "Add".',
      'Required fields carry a red asterisk. Workday marks them only after a failed Next.',
      'Sessions time out. If controls stop responding, read_page — you may have been bounced to a login screen.',
    ],
  },

  {
    platform: 'greenhouse',
    label: 'Greenhouse',
    // v2: the EEO step used to end in "ask_user if unsure", which made every Greenhouse
    // application stop and ask the same demographic questions again.
    seedVersion: 2,
    procedure: [
      'Greenhouse is usually a single long form on one page — no account, no wizard. This is one of the easy ones.',
      'Greenhouse embeds two ways: the older widget in an iframe, and a newer one injected into the company page. read_page shows which — only use f<frameId>:e<n> refs if it reports a frame.',
      'Upload the resume first with upload_file — some boards parse it and prefill name/email/phone, which saves work.',
      'read_page after the upload to see what got prefilled, then correct anything wrong and fill the rest.',
      'Fill the custom questions at the bottom. These vary per company and are where saved answers pay off.',
      'EEO / demographic questions: answer from the profile\'s self-identification values; where blank pick "Decline to self-identify". Never guess and never ask the user (rule 16).',
      'Submit per the autoSubmit rule, then read_page to confirm — success shows a thank-you / confirmation message and the form disappears.',
    ],
    tips: [
      'The application form has id="application_form"; the embed container is #grnhse_app.',
      'The resume field accepts either an attach-file input or a paste-text box. Prefer upload_file on the input.',
      'Fields named job_application[answers_attributes][…] are the company-specific custom questions.',
      'Required fields are marked with an asterisk next to the label; read_errors after submit lists any you missed.',
      'Some boards render a "Autofill with Greenhouse" button — it needs a Greenhouse account and can be ignored.',
    ],
  },

  {
    platform: 'lever',
    label: 'Lever', seedVersion: 1,
    procedure: [
      'Lever is a single-page form at jobs.lever.co — no account needed. Another easy one.',
      'Upload the resume with upload_file first; Lever parses it and prefills name, email, phone and links.',
      'read_page after the upload, then correct the prefilled fields — Lever\'s parser often mangles the phone and location.',
      'Fill the "Additional Information" box and any custom questions the company added.',
      'Fill the URL fields (LinkedIn, GitHub, portfolio) from the profile.',
      'Submit per the autoSubmit rule, then read_page — success shows a confirmation page, not the form.',
    ],
    tips: [
      'The resume input is name="resume"; the posting form posts to jobs.lever.co.',
      'Lever custom questions use name="cards[…]" — they are the company-specific screening block.',
      'The EEO section is a set of native <select> dropdowns, so select_option works here (unlike Workday).',
      'Lever shows validation errors inline above the field; read_errors picks them up after a failed submit.',
    ],
  },

  {
    platform: 'ashby',
    label: 'Ashby', seedVersion: 2,
    procedure: [
      'Ashby is a single-page React form, usually embedded on the company careers site.',
      'Upload the resume with upload_file; Ashby parses it and prefills several fields.',
      'read_page after the upload and correct anything the parser got wrong.',
      'Fill the remaining fields and the company\'s custom questions.',
      'Submit per the autoSubmit rule, then read_page to verify the confirmation.',
    ],
    tips: [
      'Ashby inputs are React-controlled — direct value writes are ignored, but the fill tool already uses the native setter, so plain fill works.',
      'Dropdowns are custom comboboxes, not native <select> — use choose_option on them.',
      'The embed container is #ashby_embed; the form may live in an iframe, so expect f<frameId>: refs.',
    ],
  },

  {
    platform: 'icims',
    label: 'iCIMS', seedVersion: 2,
    procedure: [
      'iCIMS renders the entire application inside an iframe (#icims_content_iframe). Every ref will be frame-qualified — expect f<frameId>:e<n>.',
      'Most iCIMS portals require an account. If a login/register screen appears, ask the user, then use request_secret for the password.',
      'The application is a short multi-step flow with a progress bar. Fill each page and advance with "Next" / "Continue".',
      'Upload the resume with upload_file. iCIMS often offers to parse it into the fields — let it, then read_page and fix what it got wrong.',
      'Answer the screening questions, then reach the review/submit step.',
      'Submit per the autoSubmit rule, then read_page to confirm.',
    ],
    tips: [
      'Everything is inside the iframe. If read_page shows only a shell, look for the frame section in the output.',
      'iCIMS ids are prefixed icims_ and are reasonably stable.',
      'The portal is slow. After each advance, wait with until_text for the next step\'s heading, then read_page — acting on a half-rendered page produces stale-ref errors.',
      'Some iCIMS portals accept a LinkedIn/Indeed sign-in shortcut. Ignore it and apply manually unless the user asks.',
    ],
  },

  {
    platform: 'taleo',
    label: 'Taleo', seedVersion: 1,
    procedure: [
      'Taleo (Oracle) almost always requires creating an account first. Ask the user before creating one, and use request_secret for the password.',
      'The application is a long multi-step wizard with a numbered progress bar.',
      'Upload the resume with upload_file. Taleo\'s parser is poor — always read_page afterwards and expect to fix most fields by hand.',
      'Walk each wizard step, filling everything required, and advance with "Save and Continue".',
      'read_errors after every step. Taleo blocks advancement on validation errors and shows them at the top of the page.',
      'Reach the review step, verify with read_page mode "text", then submit per the autoSubmit rule.',
    ],
    tips: [
      'Taleo is old and slow. Use wait then read_page after every navigation; refs go stale constantly.',
      'The page is dense with frames and legacy markup. If elements are missing, re-read the page rather than guessing refs.',
      'Sessions expire quickly and silently. If controls stop responding, read_page to check for a login screen.',
      'Taleo often requires answering every question before it will even show the next step — do not skip optional-looking fields.',
    ],
  },

  {
    platform: 'successfactors',
    // v3: the SAP UI5 "EasyApply" variant (employer-hosted, control ids "EasyApply---…")
    // had no craft at all — runs filled the plain text inputs and stalled on every UI5
    // dropdown, date picker and collapsed section, which read as "it only fills basics".
    label: 'SAP SuccessFactors', seedVersion: 4,
    procedure: [
      'SuccessFactors usually requires an account. If a sign-in / register screen appears, ask the user, then use request_secret for the password.',
      'The application is a multi-step flow. Upload the resume with upload_file early — it may prefill some fields.',
      'read_page after the upload and correct the parsed fields; the parser is unreliable.',
      'Fill each step fully, then advance with "Next".',
      'read_errors after each step — validation errors block advancement.',
      'Before submitting, read the whole page to the bottom: required consent controls (privacy / Datenschutz) sit last and block submission silently — often toggle switches; set_checkbox true on each.',
      'Verify on the review step, then submit per the autoSubmit rule and read_page to confirm.',
    ],
    tips: [
      'The careers site is often at a jobs2web.com or sapsf.com host even when it is branded as the company.',
      'The UI is slow to render. wait, then read_page, before acting after any navigation.',
      'Many fields are custom SAP controls rather than native inputs — use choose_option on their dropdowns.',
      'The EasyApply variant (control ids start "EasyApply---") is a SAP UI5 app that renders into an EMPTY page. If read_page finds nothing, wait with until_text for the form heading, then re-read.',
      'UI5 text boxes are real inputs under the skin — plain fill works. UI5 dropdowns are NOT native selects: use choose_option.',
      'A UI5 dropdown\'s option list renders at the very END of the document, not next to the box. If choose_option fails, click the dropdown arrow, then read_page mode:"changes" and click the item there.',
      'Date fields want the page language\'s format (German: TT.MM.JJJJ, e.g. 03.11.2025). fill the value, then click another field — UI5 validates on blur.',
      'The upload button hides a real file input. find the input[type=file] and upload_file on that ref — clicking the button opens an OS dialog that cannot be automated.',
      'EasyApply uses FriendlyCaptcha. If submit appears to do nothing, treat it as a captcha: request_captcha, then retry the submit.',
      'Sections may be collapsed panels — click a section header to expand it before reading; collapsed fields are invisible to read_page.',
    ],
  },

  {
    platform: 'pi_loga',
    label: 'P&I LOGA', seedVersion: 1,
    procedure: [
      'The application form sits directly BELOW the job posting on the same page — scroll down; no account and no separate apply step.',
      'Fill the personal fields (Anrede, Nachname, Vorname, E-Mail + Bestätigung, address, Handy). E-Mail Bestätigung must repeat the e-mail exactly.',
      'Geburtsdatum wants the German format TT.MM.JJJJ — fill it, then click another field to commit.',
      'Uploads are separate labelled slots: Lebenslauf = resume, Anschreiben = cover letter; the rest are optional. upload_file on each slot\'s file input.',
      'Answer "Wie haben Sie uns gefunden?" with choose_option.',
      'At the bottom set every consent checkbox the user would: the Datenschutzerklärung one marked * is REQUIRED; the data-retention one (Datenfreigabe) is the user\'s choice — ask if unsure.',
      'read_errors, then submit with the "JETZT BEWERBEN" button per the autoSubmit rule, and read_page to confirm.',
    ],
    tips: [
      'Labels live in the table cell to the LEFT of each field — the inputs themselves carry no label attributes and GUID names.',
      'Controls are flagged (aria-hidden) in read_page — that is LOGA marking its own live form, not a trap; fill them normally.',
      'Dropdowns (Anrede, source) are combo inputs, not native selects — choose_option, never select_option.',
      'Buttons are DIVs, listed by their text ("JETZT BEWERBEN") — click works on them normally.',
      'The posting page and the form share one long page — read_page within the form section to keep refs stable.',
    ],
  },

  {
    platform: 'smartrecruiters',
    label: 'SmartRecruiters', seedVersion: 1,
    procedure: [
      'SmartRecruiters is a single-page form, no account required.',
      'Upload the resume with upload_file — it parses it and prefills name, email, phone and experience.',
      'read_page after the upload and correct the parsed values.',
      'Fill the remaining fields and the company\'s screening questions.',
      'Submit per the autoSubmit rule, then read_page to verify the confirmation.',
    ],
    tips: [
      'The app mounts at #sr-app and may be embedded in an iframe on the company site.',
      'It offers LinkedIn/Indeed import shortcuts — ignore them and apply manually unless the user asks.',
      'Consent checkboxes (GDPR/data retention) are required and easy to miss. read_errors after a failed submit will name them.',
    ],
  },

  {
    platform: 'workable',
    label: 'Workable', seedVersion: 1,
    procedure: [
      'Workable is a single-page form, no account required.',
      'Upload the resume with upload_file; it parses and prefills the basics.',
      'read_page after the upload and correct anything wrong.',
      'Fill the remaining fields and the custom questions.',
      'Submit per the autoSubmit rule, then read_page to confirm.',
    ],
    tips: [
      'The form is often embedded via #workable-embed on the company careers page, so expect frame-qualified refs.',
      'Elements carry data-ui attributes — a stable hook when refs go stale.',
      'GDPR consent checkboxes are required in EU postings.',
    ],
  },

  {
    platform: 'linkedin',
    label: 'LinkedIn',
    // v2: the plain "Apply" button opens the company's ATS in a NEW tab. The run now
    // follows that tab automatically (rule 17), and the step says so — before, the agent
    // kept reading the LinkedIn tab and reported the posting had no application form.
    seedVersion: 2,
    procedure: [
      'Check which kind of posting this is. "Easy Apply" keeps you on LinkedIn; a plain "Apply" button sends you to the company\'s real ATS.',
      'A plain "Apply" usually opens the company ATS in a NEW tab. JobPilot follows it automatically and says so in the click\'s result — read_page there; that portal\'s playbook applies from then on.',
      'For Easy Apply: click it and expect a small modal wizard of 1-5 steps.',
      'Step 1 is usually contact info, prefilled from the LinkedIn profile. Verify it against the user profile and correct it.',
      'Attach the resume with upload_file if a file input is offered; otherwise LinkedIn reuses a previously uploaded one.',
      'Answer the screening questions. These are often required, numeric ("years of experience with X"), and are exactly what saved answers are for. Never invent a number — ask_user.',
      'The last step is a review. Submit per the autoSubmit rule, then read_page to confirm the "Application sent" state.',
    ],
    tips: [
      'The modal advances with "Next" and ends with "Review" then "Submit application".',
      'Do NOT tick "Follow <company>" unless the user asked for it — it is checked by default.',
      'Screening questions are commonly required and block submission; read_errors surfaces the ones left blank.',
      'If the user is not signed in to LinkedIn, Easy Apply is unavailable. Do not try to sign them in unless they ask — call done with status "blocked".',
      'LinkedIn is an aggregator, so it ranks below a real ATS: if the posting redirects to Workday, use the Workday playbook, not this one.',
    ],
  },
];

/** Seed for one platform, or null. */
export function seedFor(platform) {
  return SEEDS.find((s) => s.platform === platform) || null;
}
