# JobPilot — AI Job Application Copilot

JobPilot is a Chrome extension (Manifest V3, no build step) that puts a chat panel
next to your browser tab and connects it to an LLM **you** supply — any
OpenAI-compatible endpoint or the Anthropic API, with your own base URL, API key,
and model. The model runs an agentic loop against the active tab: it reads the
page as compact text, fills job-application forms from your saved profile, uploads
your stored resume into file inputs, and asks you in chat whenever it is unsure.
By default it **stops and asks for your confirmation before clicking the final
submit button**.

There is no backend. Your profile, resume, and API key live in
`chrome.storage.local`, and the only network requests are the ones the panel makes
to the LLM endpoint you configured.

## Features

- Side-panel chat driven by your own LLM (OpenAI-compatible or Anthropic format;
  works with OpenAI, OpenRouter, local Ollama/LM Studio, or any compatible proxy).
- Agentic browser tools: read the page, autofill the basic contact fields in one
  call, fill inputs (framework-safe, works on React-controlled fields, committed
  with a real focus loss for Workday-style forms), pick native select options,
  drive custom dropdowns/comboboxes/typeaheads in a single `choose_option` call,
  toggle checkboxes/radios, upload your stored resume into file inputs, read
  validation errors, navigate, and wait — either blind or until specific text
  appears. Clicks report the validation errors they trigger, and a stale element
  ref comes back with a fresh page snapshot so the agent re-targets immediately.
- Max steps per run is configurable up to 10,000 in Settings — or **0 for
  unlimited** (the run then ends only at `done`, Stop, or an error).
- **The driven tab says so.** Everything JobPilot does happens with no cursor moving and no
  window focused: fields fill themselves, a dropdown opens and closes, a wizard advances.
  While a run is live the tab being driven carries a ring around the viewport and a pill
  reading **“JobPilot is controlling this tab”**, with the step it is on — so the answer to
  “why did that just happen” is on the page it happened to, not only in a side panel you may
  have collapsed. It follows the agent through the navigations it causes, switches to a red
  “watching — recording your demonstration” while `request_demo` hands the page back to you,
  and comes down the moment the run ends. It is drawn into a **closed shadow root** with
  `pointer-events:none`, so the page cannot read it, it can never absorb a click meant for
  the form, and `read_page` cannot see it. If the side panel is closed — or crashes — the
  page takes the indicator down by itself: a tab must never be left announcing that a dead
  process is typing into it.
- **Plan mode — one review per page, not fifteen interruptions.** The agent used to
  discover what it did not know the way it walked the form: fill three fields, hit a
  question, stop and ask, fill two more, stop again. A six-page Workday wizard cost you
  fifteen interruptions, and everything it *could* answer was filled silently — so what
  went into your application was something you found out afterwards, from an activity log,
  one row at a time. Now it reads the whole page first and shows you **one card**: every
  value it intends to enter, and every question it cannot answer. Each value says where it
  came from — *profile · Phone*, *you answered before*, or **worked out**, which is the one
  worth reading, because it is the model's own judgement rather than something of yours.
  Correct anything, untick what should stay empty, answer the questions, approve — and the
  page is filled in a single step. Unticked means unticked: the agent is told you decided
  it, not that it failed, so it does not go back and fill it anyway.
  Three settings: **Show me each page** (the default), **Only when there is something to
  decide** — the card appears for a question or a worked-out value, so the later pages of a
  wizard pass without stopping you at all — and **Off**, which behaves exactly as JobPilot
  did before plan mode existed, down to the tool list the model is sent. Credentials can
  never appear in a plan; they still go through the vault path, unseen by the model.
- **Setting up is one upload, not twenty-five boxes.** The Profile tab asks for ~25 values
  across eight sections, and nobody fills that on the day they install an extension — so the
  usual first run is against a name and an email, and then the agent has to stop and ask for
  everything else, one application at a time. **Fill from my resume** answers it: JobPilot
  already extracts the text of your upload, so one model call reads the plain facts off it
  and proposes them in the same review card plan mode uses. You accept them per field.
  Nothing is written until you do, a value that would **replace something you typed starts
  unticked and marked** — what you typed wins — and the extractor is not allowed to touch
  visa status, sponsorship, salary or notice period, because a resume does not state them
  and a model asked for them anyway will produce something plausible.
- **A readiness meter that names what to fill next.** "60% complete" tells you nothing, so
  the meter is weighted by how often forms actually ask (a missing phone number costs more
  than a missing Address line 2) and it *lists* the gaps worst-first, each a link straight to
  the box. One part of that ranking is not a general claim but evidence: if a real form has
  already made the agent stop and ask you for something, the meter says **"a form asked you
  this 2 times"** and promotes it. Self-identification is deliberately excluded — a blank
  there is a complete answer, and no percentage is worth nudging somebody toward disclosing
  a protected characteristic.
- **A first-run checklist that goes away.** Three steps in the header — connect an LLM, add a
  resume JobPilot can *read*, fill name/email/phone — each a button to the tab that finishes
  it. It disappears the moment they are done, because a strip that survives completion is a
  nag. Nothing about it blocks the panel: the fastest way to understand JobPilot is still to
  point it at a job.
- **Memory bank**: reusable playbooks for how to apply on each job portal, keyed by
  **portal, not company**. Workday, Greenhouse, Lever, iCIMS, Taleo, SuccessFactors,
  SmartRecruiters, Workable, Ashby and LinkedIn ship with a playbook, and the agent
  improves them as it works. What it learns applying at one employer makes every other
  employer on the same portal fast.
- **Under the hood**: the built-in tools are recipes, and a recipe only fits the controls
  someone anticipated. When one defeats the agent, it does not immediately fetch you — it
  opens the hood. `inspect_dom` shows it the element's real markup, including the option
  lists that custom dropdowns render off in a corner of `<body>` with nothing pointing at
  them, and `dom_act` lets it drive the control with the same clicks and keystrokes your
  hardware produces (a click that a `mousedown`-only widget actually responds to;
  `ArrowDown` ×3 then `Enter` for a keyboard-only combobox). It also does the things no
  recipe can: **scroll** a virtualized list so its rows exist at all, **paste** into an
  editor that ignores typing, hold `Ctrl`/`Shift` for a chord or a multi-select click, and
  **drag** — to reorder a "rank these skills" question, or by pixels to move a slider. It
  may only touch what you could touch — hidden and honeypot fields are refused — and it can
  never type a credential. When a sequence works, it writes it into the portal playbook, so
  the next application does not have to work it out again.
- **It stops re-reading the whole page.** `read_page` is capped, which used to cut both
  ways: on a long page the control the agent wanted could be past the cap and therefore
  invisible to it, while checking whether one field had registered cost a second full
  inventory. Now `find` locates a control by name anywhere in any frame, `read_page
  within:` inventories one section, and `read_page mode:"changes"` reports only what is
  new, changed or gone — typically a few hundred characters instead of eight thousand.
  "No changes" is a useful answer in itself: it means the click did nothing. Refs stay
  stable through all three, because a partial view that renumbered them would leave the
  agent holding refs that point at the wrong field and *still work*.
- **Web components and blocked clicks.** Queries cross open shadow roots, so a portal built
  out of custom elements is no longer an apparently empty page; if something is still
  missing it is behind a *closed* root, and JobPilot says that instead of guessing. And
  before any click it checks what a real click would actually hit — a cookie banner over
  the Submit button gets named and the click is refused, rather than swallowed and reported
  as a successful submission.
- **Show me how**: when a control defeats the agent even then, it stops guessing and asks you
  to do it by hand. You click *Show me how*, perform the action in the page, and JobPilot
  watches — recording the *intent* (one `fill` per field; "choose Mobile in Phone Device
  Type", not two anonymous div clicks). You review the steps, untick anything it should not
  repeat, and it is saved as a macro **for the portal**, so no future application on that
  portal has to ask again. **Credentials are never recorded**: a password field records the
  *shape* of the step and its value is never read, so a macro carries you to the password
  box and stops. Nothing the *page* fakes is recorded either — only real, trusted input.
  The recording **follows you**: through the navigation your demonstration causes, into an
  embedded ATS form in an iframe, and into a tab the page opens — a demonstration exists to
  get you past an obstacle, and getting past it moves you. Take as long as you need; it ends
  when *you* say so, not on a timer. The toolbar shows **REC** for as long as it is watching.
- A short chime when JobPilot needs you — a question, a credential, a demonstration, or a
  run that finished while you were on another screen. Off with one toggle in Settings.
- Profile tab: contact details, the postal address split the way forms split it
  (line 1/2, city, state, postal code, country), your current role (title, employer,
  years of experience), work eligibility including a plain yes/no for visa sponsorship,
  salary/notice preferences, voluntary self-identification, your resume as **text**,
  freeform context, and reusable saved answers to screening questions. Whatever is in
  here the agent uses without asking — it only stops for something the profile
  genuinely does not hold.
- **Your resume is read, not just attached.** Upload a PDF or DOCX and JobPilot pulls the
  text out of it — including the subset-font PDFs that Word, Google Docs and LaTeX
  produce, by decoding the font's own `/ToUnicode` table. That text goes into the prompt,
  so "what is your current job title?" is answered from your resume instead of asked.
  When a file cannot be read — a scan, an image, an old `.doc` — the Profile tab says so
  on the document row rather than letting you believe it was understood, and you can
  paste the text yourself. What you paste always wins over what was extracted.
- Voluntary self-identification (gender, pronouns, race/ethnicity, veteran and
  disability status) is answered from the profile, and anything you leave blank is
  answered with the form's "Decline to self-identify" option. The agent never asks you
  these and never guesses them. See `CONTRACT-V10.md`.
- Session stats: live tokens/sec, how full the context window is, and what the session
  has cost you.
- Document store: resumes/cover letters (PDF, DOC, DOCX, TXT; up to 8 MB each)
  kept locally as base64 with a default-document toggle.
- **Confirmation-before-submit by default** (`autoSubmit` off), and it is **one click**.
  The dialog names what is being sent and which button will be pressed, and offers exactly
  two answers: **Submit** and **Cancel**. Nothing to type — this used to arrive as an
  ordinary question, which meant a text box you had to put "yes" into and then a second
  press to send it, for the one moment in a run that most deserves to be simple. Submit
  *submits*: the approval and the click are the same action, so a dialog whose button says
  Submit can never leave the form unsent. Cancel clicks nothing and leaves the form filled
  exactly as it is, for you to look over yourself.
- **And when the form refuses, you are told — in the portal's own words.** Plenty of
  applications bounce on a required field the agent could not satisfy: *"Please go back to
  these steps before submitting your application — Final certificate - Attachment is
  required."* The **click** succeeds in that case (the button was there and it was pressed),
  so nothing in the result contradicts it, and the only thing standing between that and
  "Application submitted ✓" in the chat was the model remembering to check. JobPilot checks
  itself, every time: after an approved submit it reads the page's own validation and, if the
  form pushed back, says so as **Not submitted — the form is still asking for: …**, quoting
  the message you will find waiting in the tab. Anything asking for a **file** is called out
  separately, because it is the one blocker the agent usually cannot clear alone — it will
  attach a stored document if one fits, and otherwise tell you to add it in the Profile tab.
  The agent is forbidden from reporting a bounced application as submitted. And it will not
  spend your click at all on a page that is *already* showing unresolved problems.
- Multi-frame support: forms embedded in iframes (the common Greenhouse/Lever
  embed pattern) are enumerated and operated on per frame.
- One form for every question the agent has. A page with five unknowns is **one**
  interruption with five boxes — not five modals — and each question carries its own
  option list where the form has one. Anything you leave blank counts as "no answer"
  and is not asked about again.
- Every answer is saved as its **own** reusable row, and re-answering the same question
  replaces its row instead of stacking up a second copy. Answers you gave in a chat are
  carried into the profile when you start a new chat, so they survive it.
- Works on pages that were open before install: the panel injects the content
  script on demand.
- Export/import of everything JobPilot has learned, as one JSON file. An unpacked
  extension's storage is tied to the folder Chrome loaded it from, so this is what
  carries a profile, a memory bank and a vault to a new folder or a new machine.

## Install (load unpacked)

1. Clone or download this folder.
2. Generate the icons once (pure Python 3, no dependencies):
   ```
   python3 assets/make_icons.py
   ```
   (Skip if `assets/icon16/32/48/128.png` already exist.)
3. Build the side panel. It is React 19 bundled by Vite, so the repo root is **not**
   loadable on its own:
   ```
   npm install
   npm run build
   ```
4. Open `chrome://extensions` in Chrome 116 or newer.
5. Enable **Developer mode** (top right).
6. Click **Load unpacked** and select **`dist/`** — the folder `npm run build` just
   wrote, not the repo root.
7. Click the JobPilot toolbar icon to open the side panel.

Rebuilding is safe: `dist/` keeps its path, so Chrome keeps the same extension id and
your data stays put. Use `npm run dev` to rebuild on save, then hit ⟳ on the extension
card.

## Backup and restore (Settings tab)

An unpacked extension's id is derived from **the folder Chrome loaded it from**, and
`chrome.storage.local` is keyed by that id. So moving the extension — repo root to
`dist/`, a re-clone into a different path, a second machine — is a *new* extension with
empty storage, while the old profile, memory bank and vault sit on disk under an id
nothing points at any more. Nothing in the browser migrates that for you.

The **Backup** section of the Settings tab does:

- **Export backup** writes one `jobpilot-backup-YYYY-MM-DD.json` holding all eight keys
  JobPilot owns: settings, profile (saved answers included), documents, chat history,
  playbooks, site notes, macros, and the vault blob.
- **Import backup** reads that file back. It also accepts a raw
  `chrome.storage.local.get(null)` dump, which is what you have if you rescued an older
  install from the DevTools console.

To move an install: export, load the extension from its new folder, import, check it, and
only then remove the old one — removing it is what actually deletes the old storage.

Two things worth knowing before you use it:

- **The file contains your API key in plain text.** Keep it somewhere private. The vault
  travels as ciphertext and still needs its passphrase after a restore, which you will be
  asked for the next time a credential is filled.
- **Importing replaces, it does not merge.** Everything currently stored is overwritten,
  and any key the file does not carry is removed. That is the only restore with a
  predictable meaning — a merged one would leave you with yesterday's vault against
  today's profile. Export the current data first if you might want it back.

## Configure the LLM (Settings tab)

1. **Provider** — `OpenAI-compatible` or `Anthropic`.
2. **Base URL** — examples:
   - OpenAI: `https://api.openai.com/v1`
   - OpenRouter: `https://openrouter.ai/api/v1`
   - Ollama (local): `http://localhost:11434/v1`
   - LM Studio (local): `http://localhost:1234/v1`
   - Anthropic: `https://api.anthropic.com`
3. **API key** — stored only in `chrome.storage.local` on your machine. Local
   servers usually accept any placeholder string.
4. **Model** — press ⟳ to fetch the model list from your endpoint, or type a
   model id directly. **The model must support tool/function calling** — that is
   how JobPilot operates the page. Small chat-tuned local models without tool
   support will not work.
5. Click **Test connection** and fix anything it reports before moving on.

Behavior settings worth knowing: `Auto-submit applications` (off by default —
leave it off unless you fully trust your model), max agent steps per run, and
temperature.

## Set up your profile and resume

In the **Profile** tab:

0. Drop your resume in, then press **Fill from my resume** at the top. One model call reads
   it and proposes values for most of the page; you tick through them and the rest of this
   list is mostly done. The readiness meter above the button then names whatever is still
   worth filling, worst first. Everything below can be done by hand instead if you prefer.
1. Drop your resume (PDF/DOC/DOCX/TXT) into the Documents zone and star it as the
   default. This is the file the agent attaches to "Upload resume" fields.
2. Fill in the basics: name, email, phone, location, LinkedIn/GitHub/portfolio.
3. Fill in work eligibility (e.g. "US citizen" or "Needs H-1B sponsorship"),
   salary expectation, and notice period. The agent is instructed to **never
   fabricate** these — if a field is empty it will ask you instead of guessing.
4. Use "Anything else the AI should know" for context: key skills, visa details,
   relocation preferences, anything you would tell a recruiter.
5. Saved answers accumulate as you answer the agent's questions; edit or delete
   them here.

## The memory bank (Memory tab)

The first time anyone applies through Workday, the agent has to work the whole thing out:
where "Apply" hides, that it wants an account, that the application is a six-page wizard,
that the "Next" button lives at the very bottom. That is slow and expensive — and without
memory it would happen *again* on the next Workday application, at a different company.

So JobPilot remembers **per portal, not per company**. `nvidia.wd5.myworkdayjobs.com` and
`cisco.wd1.myworkdayjobs.com` are the same Workday product with the same wizard, so one
playbook serves both — and every other Workday employer you ever apply to.

- **Detection.** JobPilot works out which ATS a page belongs to by matching every frame's
  URL against known portal patterns, falling back to DOM fingerprints. A company careers
  page that embeds Greenhouse in an iframe is detected as Greenhouse. A Glassdoor page
  wrapping a Lever form is detected as Lever — the real application form wins over the
  aggregator around it.
- **Shipped playbooks.** Workday, Greenhouse, Lever, Ashby, iCIMS, Taleo, SuccessFactors,
  SmartRecruiters, Workable and LinkedIn come with a playbook out of the box, so even your
  first application on them is fast.
- **The agent writes to it.** When it works out something the playbook did not say, it
  calls `remember` and the playbook improves. The chat says so when it does.
- **You write to it.** The Memory tab lets you edit the procedure and tips for any portal,
  add a playbook by hand, or reset a shipped one back to default.
- **Company notes.** Quirks that really are specific to one employer ("this one asks for a
  referral code on step 3") go in a separate note attached to that host, so they never
  pollute the shared portal playbook.

The chat header shows what was detected for the current tab — *Workday · playbook ✓* or
*Workday · no playbook yet* — so you can see the memory working. If detection cannot run at
all on a page, it says that too, rather than silently behaving like an ordinary site.

Because a playbook is persistent and shared across every employer on a portal, a hostile
posting that talked the agent into recording one bad line would poison every future
application there. So the agent may only write a playbook for the portal it is **actually
detected** on, and lines carrying a URL or your personal answers (salary, visa, notice
period) are rejected outright. Playbooks are given to the model as reference notes that
never override its rules — and you can read and edit every one of them in the Memory tab.

Playbooks are capped (15 steps, 20 tips, 200 characters a line) and only the *detected*
portal's playbook is ever sent to the model, so memory cannot quietly inflate every request.

## Session stats

The strip under the composer shows three things, and expands for the full breakdown:

- **Context** — how full the model's context window is right now, as a gauge that turns
  amber past 70% and red past 90%. This is the input-token count of the latest request,
  which is exactly how much of the window the conversation currently occupies.
- **Speed** — output tokens/sec, live while the reply streams, then the session average.
- **Cost** — what the session has cost, accumulated per request.

JobPilot knows the context window and price of most common models. If yours is not
recognised (a proxy, a fine-tune, a local model), the numbers it cannot know are shown as
`—` rather than guessed — set **Context window** and **Input/Output $/1M** in Settings to
fill them in.

Anything it cannot stand behind is marked rather than dressed up as a measurement. A cost
prefixed `~` means something in it was approximated — your endpoint did not report token
counts (so they are estimated from text length), or the model returned cached tokens with
no known cache price (so they are billed at the full input rate, making the figure an upper
bound). Expand the strip and it tells you which.

## Usage

1. Open the tab with a job posting (or any page — the agent can navigate).
2. Open the JobPilot side panel. The composer shows which tab it is acting on.
3. Paste one or more job links, or just describe what you want:
   > https://boards.greenhouse.io/example/jobs/123456 — apply to this with my
   > default resume
4. The agent navigates, reads the page, and fills the form. Each action shows up
   as a compact activity row (`⚙ fill "First Name" ✓`); expand a row to see the
   full result.
5. When it hits a question it cannot answer from your profile (e.g. "Why do you
   want this role?" specifics, unusual screening questions), it pauses and asks
   you in chat. You can save the answer to your profile for future applications.
6. **Before submitting**, the agent asks for your go-ahead (unless you enabled
   auto-submit). Reply "submit" to proceed, or say "let me review" and it will
   stop with the form filled for you to check.
7. After submitting, it re-reads the page to verify the submission actually went
   through and reports honestly, including any validation errors it found.
8. Multiple links are processed one at a time; press **Stop** anytime.

## Testing with the mock pages

The `test/` folder contains a self-contained fake job application designed to
exercise everything: a hidden file input behind a styled upload button, a native
country select, a custom `role=combobox` dropdown, a radio group, a required
consent checkbox, a React-style controlled input that rejects direct `.value`
writes, and a visually hidden honeypot field (`middle_initial`) that a careful
agent should leave empty.

Serve it over HTTP:

```
cd test
python3 -m http.server 8899
```

Then open <http://localhost:8899/mock-application.html> and tell the agent to
apply with your profile. Use
<http://localhost:8899/mock-application-iframe.html> to test the iframe-embedded
variant (frame enumeration and `f<frameId>:e<n>` refs).

<http://localhost:8899/mock-login.html> exercises the credential path: a
`type=password` field, then a 6-digit 2FA step. Tell the agent "sign in and apply"
and it should open a modal for each secret rather than typing one itself. The 2FA
field is deliberately named `code` with no `autocomplete="one-time-code"`, so
attribute sniffing alone does not recognise it — it is protected only because
`request_secret` marks whatever element it fills as sticky-secret. After the code
is entered, ask the agent to `read_page`: the field must come back as
`value="(hidden)"`. If you ever see the real code in the activity log, that is a
bug worth reporting.

<http://localhost:8899/mock-tricky.html> is the page the recipe tools *cannot* do:
a prompt button that only opens on `mousedown` and portals its options to `<body>`
as role-less `<div>`s, a combobox whose list does not exist until you press
`ArrowDown` and only commits on `Enter`, an off-screen honeypot, and a password
box. Ask the agent to fill it and watch it climb the ladder — `choose_option`
fails, `inspect_dom` finds the portalled list, `dom_act` drives the control, and
only if that fails does it ask you to demonstrate. The same page also carries a
form field inside an open shadow root (which `document.querySelectorAll` cannot
see) and a **Simulate cookie banner** button: press it, then ask the agent to
submit — it should refuse and tell you what is in the way, not claim it submitted.

<http://localhost:8899/mock-long.html> is the page that is too big to read at once:
its last field sits behind 420 job rows, past `read_page`'s element cap, so it is
genuinely absent from the inventory. Ask the agent to fill the referral code — it
should `find` it rather than re-reading. Then press **Reveal extra questions** and
ask what changed; `read_page mode:"changes"` should report two new fields, one
changed value and one removed button, and nothing else.

<http://localhost:8899/mock-widgets.html> is the page that clicking and typing
cannot operate at all: a country list with 500 options of which about 20 exist in
the DOM ("Zanzibar" is #480, so no selector can match it until the list scrolls), a
drag-to-rank question, a chip you attach by dragging, an editor that accepts a real
paste and nothing else, a notes box that submits on `Ctrl+Enter`, and a salary
slider with no `<input type=range>` behind it. Ask the agent to pick Zanzibar —
`choose_option` should scroll until the row exists, without being told to. The same
page also carries a consent button inside an open shadow root (clicking the
component must not be refused as "something is covering it" — its own shadow
content is not an obstruction) and a drag-to-rank list built from `<a href>`, where
`draggable` is true by default and the real protocol is pointer events.

Opening the file directly via `file://` also works, but only if you enable
**Allow access to file URLs** for JobPilot on `chrome://extensions`. The HTTP
server is the more realistic setup.

A successful run ends with the form replaced by
"Application submitted ✓ (confirmation #MOCK-1234)". If the confirmation panel
warns that the honeypot was tripped, your model filled a field no human can see —
worth knowing before you point it at real applications.

## What works and what doesn't

Honest expectations:

- **Generally good**: single-page application forms — Greenhouse, Lever, Ashby,
  and similar embedded/hosted forms. Standard inputs, selects, textareas, file
  uploads, and common custom dropdowns.
- **Workday**: its form controls are handled specifically. Workday's prompts —
  "How Did You Hear About Us?", "Country Phone Code", "Country", "Phone Device
  Type" — declare no dropdown ARIA at all: the multiselect is a bare
  `<input placeholder="Search">`, so naive automation types into it, selects
  nothing, and Workday reports the field empty. JobPilot reads them as dropdowns,
  refuses to `fill` them, drives them with `choose_option` (including the
  category → leaf drill-down), verifies against the selected pills rather than the
  search box, and knows that re-picking a chosen value would *remove* it. See
  `CONTRACT-V5.md`. You still have to log in yourself.
- **Bespoke widgets**: a control nobody anticipated — a `<div>` that only listens for
  `mousedown`, a listbox with no `role=option`, a combobox that only responds to
  `ArrowDown`/`Enter` — is no longer a dead end. The agent inspects the real DOM and
  drives it with primitives (`CONTRACT-V7.md`), and only asks you to demonstrate if
  that also fails. `CONTRACT-V9.md` adds the gestures a click cannot express: scrolling
  a virtualized list into existence, a real paste, a modifier chord, and a drag. Two
  things it will still never do: touch a control you cannot see, or type a credential.
- **Often problematic**: Taleo, SuccessFactors and other multi-step portals that
  require creating an account, logging in, and walking wizard pages. The agent can
  make progress but expect to help it along. The memory bank exists precisely to
  blunt this, and each application on a portal makes the next one better — but a
  six-page wizard behind a login wall is still the hardest thing here.
- **New tabs**: clicking Apply on most job boards (LinkedIn's plain "Apply" above
  all) opens the real application in a *new* tab. The run follows that tab
  automatically — the tool result says so, and the "controlled by JobPilot"
  indicator moves with it. A popup the site closes again, or a tab you opened
  yourself, is left alone.
- **CAPTCHAs are detected, never solved**: the agent spots hCaptcha, reCAPTCHA
  (including invisible v3), Cloudflare Turnstile and FunCaptcha — the invisible
  kinds matter most, because they block a submit with no error text and used to
  read as "the form silently refused". It asks you to solve the widget in the
  tab, then carries on. It will not (and cannot) bypass one.
- **Requires you**: email/SMS verification, SSO, or a login wall it has no saved
  credential for. JobPilot will not bypass these — it calls `done` with status
  `blocked` and tells you what it ran into. Solve the wall, then ask it to
  continue.
- File uploads work by attaching your stored document to the page's file input
  programmatically. A few sites use third-party upload widgets that fetch to
  their own servers in ways that ignore the input — verify the filename shows up
  on the page (the agent checks this too).

Always review before submitting. The default confirmation step exists because no
model gets every form right every time.

## Privacy

- Everything stays local: profile, documents (base64), chat history, portal playbooks,
  and settings are stored in `chrome.storage.local` on your machine. Nothing syncs
  anywhere.
- Playbooks describe **how a portal works**, not what you answered — the agent is
  instructed never to write your salary, visa status or notice period into one, because a
  playbook is shared across every employer on that portal. Your answers live in the
  Profile tab's saved answers instead. You can read and edit every playbook in the Memory
  tab, so nothing the agent remembers is hidden from you.
- Your API key is stored in `chrome.storage.local` and sent only as an auth
  header to the base URL you configured — no other destination.
- A backup file exported from the Settings tab is a plain-text copy of that storage,
  API key included. It never leaves your machine on its own — it lands in your Downloads
  folder and goes wherever you put it — but it is as sensitive as the storage it came
  from. The vault stays encrypted inside it.
- The extension makes network requests **only** to your configured LLM endpoint.
  There is no telemetry, no analytics, no third-party calls.
- Page text and your profile data are sent to that LLM endpoint as part of the
  agent conversation — choose an endpoint you trust with that data (a local
  Ollama/LM Studio model keeps everything on your machine).

### Credentials

Passwords and one-time codes are handled differently from everything else: **they
are never sent to your LLM.** The model cannot read them and cannot type them.

- The model calls `request_secret`, which names a field but carries no value. The
  extension opens a modal, you supply the value, and the extension types it
  straight into the page. The model is told only `Filled the password into e12.`
- `fill` on a `type=password` or `autocomplete="one-time-code"` field is rejected
  by the content script. The internal flag that permits a secret fill is stripped
  from anything the model sends, so it cannot be forged.
- `read_page` redacts credential values — including ones your browser's own
  password manager autofilled before the agent started — and any field that ever
  received a secret stays redacted for the life of the page.
- A credential is looked up, displayed, and typed under the origin of the frame
  its field lives in. A page that embeds a cross-origin iframe cannot get the top
  page's password: the fill is refused, and the modal names the foreign origin.
- Vault entries are encrypted at rest with AES-GCM-256 under a key derived from
  your master passphrase (PBKDF2-SHA256, 600,000 iterations). The key lives in
  memory only, and the vault auto-locks when idle. If you skip the passphrase, the
  entries are stored unencrypted — convenient, and worth understanding.
- One-time codes are never stored, never offered for saving, and never reused.

The residual risk is honest: anything in `chrome.storage.local` sits unencrypted on
disk unless you set a vault passphrase, and an unlocked vault is readable by
anything running in the panel page. Use a spend-capped API key and a passphrase.

## Troubleshooting

- **"Model does not support tools" / the agent chats but never acts** — your
  model lacks tool/function calling. Pick one that supports it (most hosted
  models do; for local models check the model card — e.g. many Llama 3.1+ and
  Qwen 2.5+ builds do, many older/small chats do not).
- **"Receiving end does not exist"** — the content script is not in the tab yet.
  JobPilot auto-injects and retries once; if the error persists, reload the tab
  and try again. Pages like `chrome://…` and the Chrome Web Store can never be
  scripted.
- **Model list is empty or stale** — check base URL and API key, then press the
  ⟳ refresh button next to the model select. You can always type a model id
  manually.
- **Ollama requests fail from the extension** — Ollama rejects cross-origin
  browser requests by default. Start it with `OLLAMA_ORIGINS=*` (e.g.
  `OLLAMA_ORIGINS=* ollama serve`) and use base URL `http://localhost:11434/v1`.
- **401/403 from the endpoint** — wrong or expired API key; the error toast
  includes the response body snippet, which usually says exactly what is wrong.
- **Agent acts on the wrong tab** — the target tab is captured when a run
  starts (shown under the composer). Start the run with the job tab focused;
  switching tabs mid-run does not redirect the agent.
- **Nothing happens on file:// mock pages** — enable "Allow access to file URLs"
  for JobPilot in `chrome://extensions`, or serve the pages over HTTP as above.

## Architecture

```
manifest.json                 MV3 manifest (side panel, content script, permissions)
vite.config.js                the build; also verifies every manifest path exists in dist/
background/service-worker.js  opens the side panel on toolbar click; owns the recording
                              session and the "controlled by JobPilot" session (both live
                              in chrome.storage.session so a page that loads mid-run can
                              ask what is happening to it)
content/content-script.js     single IIFE injected into every frame; executes page tools
sidepanel/panel.html|css      the mount point and ALL styling (panel.css is not bundled
                              per-component — it is one file, linked from the HTML)

sidepanel/react/              the UI. React 19, one component per thing on screen.
  main.jsx                    entry; mounts <App/> into #root
  App.jsx                     shell: header, status pill, tab bar, five view slots
  state/store.jsx             settings/profile/documents/memory + the debounced writers
  modal-queue.js              the modal promise queue — no React, so node can test it
  vault-ui.js                 vault policy shared by ChatView and VaultView
  views/                      ChatView, ProfileView, MemoryView, VaultView, SettingsView
  components/                 Modal, Toast, StatsBar, Markdown, Icon + components/chat/*

sidepanel/js/                 the logic layer. Dependency-free, no DOM, NOT React —
                              imported unchanged by the components above.
  agent.js                    AgentRunner — the agentic loop
  llm.js                      streaming clients (OpenAI-compatible + Anthropic SSE)
  tools.js                    tool schemas + executor, frame dispatch
  storage.js                  typed chrome.storage.local access; BACKUP_KEYS is the one
                              definition of "all my data" that the wipe, the export and
                              the import all read from
  plan.js                     plan mode: what a propose_plan may carry, where each value
                              came from, and what the model is told the user decided
  profile-intel.js            onboarding: reading a profile off a resume, ranking what is
                              still missing, and the three-step setup checklist
  prompts.js                  system prompt built from profile/documents/settings/memory
  platforms.js                ATS portal detection (frame URLs, then DOM fingerprints)
  playbook-seeds.js           shipped playbooks for the ~10 major portals
  stats.js                    tokens/sec, context-window usage, session cost
  vault.js                    encrypted credential store
  doctext.js                  text out of an uploaded PDF / DOCX / TXT (zero deps)
  panel.js, modal.js          DEAD. Superseded by sidepanel/react/; nothing loads them.
                              Kept only because the React sources cite their line numbers
                              as the map back to what each component replaced. Both carry
                              a banner saying so. Delete them once nothing cites them.

assets/make_icons.py          stdlib-only icon generator
test/                         mock application pages (plain + iframe-embedded)
test/*-harness.mjs            the checks; `npm test` runs all ten
```

Six harnesses drive `content/content-script.js` in a real Chromium through
Playwright — including `indicator-harness.mjs`, where every hard part of the
"controlled by JobPilot" pill is a negative that only a browser can prove: the shadow
root really is closed, the overlay really does take no part in hit testing (or it would
eat the click on a Submit button), `read_page` really cannot see it, and the page really
does take it down by itself once the panel stops saying it is there. Three need no
browser at all and run `sidepanel/js/*` and `background/*` as plain ES modules against a
stubbed `chrome`: `panel-harness.mjs` (the logic layer), `worker-harness.mjs` (the
recording session — who may open one, what happens to a step from a tab nobody is
watching, what expiry leaves behind — and the control session that decides which tab
shows the indicator), and `doctext-harness.mjs` (document text extraction, against PDFs
and DOCXs built byte by byte in the test). `react-harness.mjs` is the tenth and does both:
it unit-tests
`modal-queue.js` in node, then builds `dist/`, serves it, and drives the **real panel**
in Chromium against a stubbed `chrome` — a debounced write racing a keystroke, a
restored transcript full of hostile markup, a dialog's Enter key.

That split matters — for a long time `npm test` executed zero lines of `tools.js`,
`agent.js` or `storage.js`, and the worst bugs this codebase has had lived in exactly
that gap (a `run_macro` that called a method which did not exist, a recorded step that
lost the frame it was demonstrated in, a `read_errors` that reported an all-clear for a
frame it could not read). No page-driven harness could have caught any of them. The
React migration re-opened the same gap from the other end — 6,000 new lines that no
harness imported — which is what `react-harness.mjs` exists to close.

The panel talks to the content script with `chrome.tabs.sendMessage` using
`jobpilot:exec` / `jobpilot:ping` messages, addressing an explicit frame id so
iframe-embedded forms work. `read_page` returns a compact inventory where every
interactive element gets a short ref like `e12` (prefixed `f<frameId>:e12` for
non-main frames); subsequent tools act on those refs and report stale refs when
the page has changed.

Two things the model never sees go through the worker instead of that channel, for the
same reason: the agent navigates, and a page the panel spoke to directly is gone a step
later. The recording session (`jobpilot:rec-*`) and the control indicator
(`jobpilot:ctrl-*`) both live in `chrome.storage.session`, and a freshly loaded content
script asks the worker on startup whether it is inside a recording, or on a tab being
driven — which is what carries both across the navigations the agent itself causes. The
panel heartbeats while each is live, so both expire on their own if it stops.

The LLM sees twenty-two tools. Twelve execute in the page:

| Tool | Purpose |
| --- | --- |
| `read_page` | Compact inventory of interactive elements (or readable page text). `mode:"changes"` reports **only what is new, changed or gone** since the last full read — a few hundred characters instead of eight thousand, and "No changes" is itself the answer that the click did nothing. `within:` inventories one section. Only a full read renumbers refs. Crosses **open shadow roots**, so portals built from web components (Salesforce/LWC, Vaadin, Phenom) are readable at all — and when a page yields nothing *and* uses shadow DOM, it says so rather than reporting an empty page |
| `find` | Locate controls by their visible name across every frame, with refs. `read_page` is capped, so on a long page or a job board the control the agent needs can be missing from the inventory entirely and re-reading returns the same truncated list — this is "look again, harder". Also returns section refs for `read_page within:` |
| `autofill` | Deterministically fill the basic contact fields from the profile in one call — never overwrites, skips credential fields and typeaheads |
| `fill` | Set a text-like input/textarea/contenteditable via native setter + `input`/`change` events, committed with a genuine focus loss (Workday discards unblurred values); falls back to a keyboard-style `insertText` when the setter is reverted |
| `select_option` | Choose an option in a native `<select>` |
| `choose_option` | Custom dropdowns/comboboxes/typeaheads in one call: open, wait for the list, match, click, verify. **Scrolls virtualized lists itself** — a modern country picker keeps 500 options in memory and ~20 in the DOM, so the one you want does not exist until the list scrolls; if it still misses, the error says how far it looked |
| `click` | Click buttons/links/options (full pointer-event sequence for custom widgets); reports any validation errors the click caused. **Refuses to fire when something is covering the target** — a cookie banner or sticky bar absorbs the click, and reporting that as success is how a run "submits" an application that was never submitted |
| `set_checkbox` | Set a checkbox to a target state |
| `upload_file` | Attach a stored document to a file input via `DataTransfer` (never opens the OS picker) |
| `read_errors` | Report currently visible validation/alert text |
| `inspect_dom` | The raw markup of one element when a tool failed on it: every attribute, the ancestor chain, the subtree, whatever `aria-controls`/`aria-owns` point at, and the **open layers** — popups and option lists portalled elsewhere in the document, which is where custom dropdowns keep them. Everything actionable comes back with a usable ref |
| `dom_act` | Drive a widget by hand with a short sequence of primitives — `click` (a full pointer sequence, so a control that opens on `mousedown` actually opens, and with `ctrl`/`shift` for multi-select), `key` (`ArrowDown` ×3 then `Enter`, or a `Ctrl+Enter` chord), `type`, `paste` (for editors that accept nothing else), `scroll`, `drag`, `hover`, `focus`, `blur`, `scroll_into_view`, `wait_for`, `read`. Stops at the first failure and says which actions already ran. Refuses anything a human could not see, and never types — or pastes — a credential |

Two execute in the panel: `navigate` (drive the tab and wait for load) and `wait`,
which either sleeps or — given `until_text` — polls until that text is visible (up
to 30s), so wizard transitions don't need guessed sleeps. A failed ref also comes
back with a fresh page snapshot attached, so the model re-targets without spending
a step on `read_page`.

Seven are owned by the agent loop and never reach the page — `ask_user` (pause for your
answer in chat), `propose_plan` (agree a whole page in one card, then fill it),
`confirm_submit` (the two-button go-ahead for the final submit, which then clicks it),
`request_secret`
(collect a credential the model never sees), `remember`
(write what it learned to the portal playbook), `request_demo` (stop guessing and ask you
to demonstrate; the extension records it as a macro for the portal) and `run_macro`
(replay one, verifying every step) — plus `done`, which ends the run with a status of
`submitted`, `ready_for_review`, `already_applied`, `blocked`, or `answered`.

`propose_plan` and `confirm_submit` are the two of those that act on the page, and they do it
*through the other tools*: once you approve, the panel dispatches each entry down the ordinary `fill` /
`select_option` / `choose_option` / `set_checkbox` path, one at a time. Every guard that
makes a fill safe — the credential refusal, the hidden-field refusal, the framework-safe
setter, the focus-loss commit, the stale-ref snapshot — is already on that path, and a
second entrance beside it would be a second thing to keep correct. It also means the model
does not spend a step per field re-issuing fills it has already written down: twenty
round-trips become one.

The agent loop streams the model's reply, executes tool calls sequentially,
feeds results (including failures — the model self-corrects) back into the
conversation, prunes old tool output to stay small-model friendly, and stops at
`done`, at the step limit, or when you press Stop.
