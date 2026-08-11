// tools.js — LLM-facing tool schemas + panel-side executor with multi-frame dispatch
// (contract §5.2 / §5.3). Content script only ever sees bare eN refs; the frame prefix
// f{frameId}:eN is added/stripped here.

import { planLabel } from './plan.js';
import { getDocuments, getProfile } from './storage.js';

export const TOOL_DEFS = [
  toolDef('read_page',
    'Read the current page. ALWAYS call this after navigation or when refs go stale. mode "interactive" (default) lists ' +
    'form elements with refs; "text" returns readable page text; "changes" reports ONLY what is new, changed or gone since ' +
    'your last full read — far cheaper than re-reading, and the right call after clicking or filling something. ' +
    'Pass within to inventory just one section (use a section ref from find). ' +
    'Only a full read renumbers refs: "changes" and within keep the refs you already have.', {
      mode: { type: 'string', enum: ['interactive', 'text', 'changes'], description: 'What to read; default "interactive".' },
      within: { type: 'string', description: 'Ref of a container to read inside, e.g. a section ref from find. Ignored with mode "text".' },
    }, []),
  // CONTRACT-V8 §2. read_page is capped, so on a long page the control you want can be
  // past the cap and re-reading returns the same truncated list. This is "look again,
  // harder" — and it is also how you find a section to scope a read to.
  toolDef('find',
    'Find controls by their visible name — label, button text, placeholder — across every frame, and get refs for them. ' +
    'Use this instead of re-reading a long page: read_page is capped, so on a job board or a long form the control you ' +
    'want may not be in the inventory at all. Also returns matching SECTIONS you can pass to read_page within.', {
      text: { type: 'string', description: 'Visible name to look for, e.g. "Referral code" or "Continue". A short fragment matches more.' },
      role: {
        type: 'string',
        enum: ['any', 'button', 'link', 'textbox', 'dropdown', 'checkbox', 'radio', 'file'],
        description: 'Only return controls of this kind. Useful when a label is shared by a field and a button.',
      },
      limit: { type: 'number', description: 'Max matches (1–20, default 8).' },
    }, ['text']),
  toolDef('fill', 'Type a value into a text-like input, textarea, or contenteditable identified by ref.', {
    ref: { type: 'string', description: 'Element ref from read_page, e.g. "e3" or "f381:e3".' },
    value: { type: 'string', description: 'The exact text to enter.' },
  }, ['ref', 'value']),
  toolDef('select_option', 'Choose an option in a native <select> dropdown by its visible label or value. ONLY for native selects — for custom dropdowns use choose_option.', {
    ref: { type: 'string', description: 'Ref of the <select> element.' },
    option: { type: 'string', description: 'Option label (preferred) or value to select.' },
  }, ['ref', 'option']),
  toolDef('choose_option',
    'Choose an option in a CUSTOM dropdown/combobox/typeahead (anything that is not a native <select>) in ONE step: ' +
    'opens the control, waits for the option list, clicks the matching option, and reports the resulting value. ' +
    'Handles typeaheads by typing the option text to filter the list.', {
      ref: { type: 'string', description: 'Ref of the dropdown trigger (button, combobox, or typeahead input).' },
      option: { type: 'string', description: 'Visible text of the option to choose.' },
    }, ['ref', 'option']),
  toolDef('autofill',
    'Deterministically fill the basic contact fields (name, email, phone, location, LinkedIn/GitHub/portfolio) from the ' +
    'user profile in ONE step. Call it once on each new application form BEFORE filling fields individually. It never ' +
    'overwrites a non-empty field and skips credential fields and typeaheads. Verify the result with read_page.', {}, []),
  toolDef('click', 'Click a button, link, radio, checkbox, or custom control identified by ref.', {
    ref: { type: 'string', description: 'Element ref from read_page.' },
  }, ['ref']),
  toolDef('set_checkbox', 'Set a checkbox to a specific checked state (clicks only if it differs).', {
    ref: { type: 'string', description: 'Ref of the checkbox.' },
    checked: { type: 'boolean', description: 'Desired state.' },
  }, ['ref', 'checked']),
  toolDef('upload_file', 'Attach a stored document (resume/CV) to a file input identified by ref.', {
    ref: { type: 'string', description: 'Ref of the file input (or its visible upload control).' },
    document_id: { type: 'string', description: 'Stored document id; omit to use the default document.' },
  }, ['ref']),
  toolDef('read_errors', 'Return currently visible validation/error/alert text on the page.', {}, []),
  // CONTRACT-V7 §2 — the rung between "my recipe fits" and "a human must do it".
  toolDef('inspect_dom',
    'Look at the RAW markup of one element when a tool failed on it and you need to know why. Unlike read_page ' +
    '(a summary), this returns every attribute, the ancestor chain, the subtree, whatever aria-controls/aria-owns ' +
    'point at, and — most usefully — the OPEN LAYERS: popups and option lists rendered elsewhere in the document, ' +
    'which is where a custom dropdown usually keeps its options. Everything actionable it reports comes back with a ' +
    'ref you can use in click/fill/dom_act. Typical use: choose_option failed → inspect_dom the trigger → dom_act a ' +
    'click on it → inspect_dom again to see the list that opened.', {
      ref: { type: 'string', description: 'Element ref from read_page or a previous inspect_dom.' },
      selector: { type: 'string', description: 'CSS selector instead of a ref; searched in every frame. Must match exactly one visible element.' },
    }, []),
  toolDef('dom_act',
    'Operate a control YOURSELF with low-level browser events, for widgets no other tool handles — a div that only ' +
    'responds to mousedown, a listbox with no role=option, a combobox that needs ArrowDown then Enter. Runs a short ' +
    'sequence (max 12) and stops at the first failure, telling you exactly which actions already ran. ' +
    'Use it AFTER choose_option/click/fill have failed and inspect_dom has shown you what the control really is. ' +
    'It also does the things no other tool can: scroll a virtualized list so its rows exist at all, paste into an editor ' +
    'that ignores typing, hold Ctrl/Shift for a chord or a multi-select click, and drag (to reorder a ranking, or by dx/dy for a slider). ' +
    'It can only touch elements a human could see and touch, and it will NEVER type a credential — use request_secret. ' +
    'When a sequence works, save it with remember so the next application on this portal does not have to work it out again.', {
      actions: {
        type: 'array',
        description: 'Ordered actions. Each needs op, plus ref or selector (wait_for/read take a selector).',
        items: {
          type: 'object',
          properties: {
            op: {
              type: 'string',
              enum: ['click', 'key', 'type', 'paste', 'hover', 'drag', 'scroll', 'focus', 'blur', 'scroll_into_view', 'wait_for', 'read'],
              description: 'click = full pointer sequence; key = keydown/keyup (with optional ctrl/meta/shift/alt); type = set text; ' +
                'paste = a real paste event, for editors that only accept one; drag = pointer or HTML5 drag onto a target or by dx/dy; ' +
                'scroll = scroll a container, which is the ONLY way to reach rows in a virtualized list; wait_for = poll for a selector; ' +
                'read = read matches back to verify.',
            },
            ref: { type: 'string', description: 'Target ref from read_page/inspect_dom. All refs in one call must be in the same frame.' },
            selector: { type: 'string', description: 'CSS selector for the target (or, for wait_for/read, what to poll or read). Must match exactly one visible element when acting.' },
            value: { type: 'string', description: 'type/paste only — the text to enter.' },
            clear: { type: 'boolean', description: 'type only — empty the field first.' },
            commit: { type: 'boolean', description: 'type/paste only — release focus afterwards so the page registers the value.' },
            key: { type: 'string', description: 'key only — "ArrowDown", "Enter", "Escape", "Tab", "Backspace", or a single character.' },
            times: { type: 'number', description: 'key: repeat count 1–10. scroll: number of pages to scroll, 1–20.' },
            ctrl: { type: 'boolean', description: 'click/key only — hold Ctrl.' },
            meta: { type: 'boolean', description: 'click/key only — hold Meta/Cmd.' },
            shift: { type: 'boolean', description: 'click/key only — hold Shift (shift-click is how multi-select lists extend a selection).' },
            alt: { type: 'boolean', description: 'click/key only — hold Alt.' },
            to_ref: { type: 'string', description: 'drag only — ref of the element to drop onto.' },
            to_selector: { type: 'string', description: 'drag only — selector of the element to drop onto.' },
            dx: { type: 'number', description: 'drag only — horizontal pixels to drag by, when there is no drop target (sliders).' },
            dy: { type: 'number', description: 'drag only — vertical pixels to drag by.' },
            to: { type: 'string', enum: ['top', 'bottom'], description: 'scroll only — jump to one end instead of scrolling by pages.' },
            by: { type: 'number', description: 'scroll only — exact pixels (negative scrolls up). Omit for one page per time.' },
            state: { type: 'string', enum: ['visible', 'gone'], description: 'wait_for only — default "visible".' },
            timeout: { type: 'number', description: 'wait_for only — seconds, 0.5–10 (default 5).' },
          },
          required: ['op'],
        },
      },
    }, ['actions']),
  toolDef('navigate', 'Navigate the working tab to a URL and wait for the page to load.', {
    url: { type: 'string', description: 'Absolute URL to open.' },
  }, ['url']),
  toolDef('wait',
    'Pause for a number of seconds (0.5–10), or — better after clicking something that loads a new wizard page — ' +
    'pass until_text to wait until that text is visible on the page (up to 30s, returns as soon as it appears).', {
      seconds: { type: 'number', description: 'Seconds to wait (0.5–10), or the timeout when until_text is set (0.5–30, default 10).' },
      until_text: { type: 'string', description: 'Wait until this text is visible anywhere on the page, e.g. the next page\'s heading.' },
    }, []),
  // Batched by design. One call renders ONE form with a box per question, so a page
  // with five unknown fields costs the user one interruption instead of five.
  // `questions` is REQUIRED and it is the only question parameter advertised. The old
  // singular `question` is still accepted by normalizeQuestions — models mix the shapes and
  // rejecting one costs the user a round-trip — but it is no longer offered, because being
  // offered it is what produced the failure this batching exists to prevent: six questions
  // numbered inside ONE string, rendered as one box, and saved to the profile as one
  // unmatchable row that never gets reused.
  toolDef('ask_user',
    'Ask the human for information you do not have, and wait. ASK EVERYTHING AT ONCE: put every ' +
    'outstanding question for this page in `questions` and the user answers them in a single form. ' +
    'Five separate ask_user calls for five fields is five interruptions — do not do that. ' +
    'ONE QUESTION PER ARRAY ENTRY: never number several questions inside a single question string. ' +
    'Each entry becomes its own input box and its own reusable saved answer; a numbered list crammed ' +
    'into one entry becomes one box the user has to hand-number, and one saved answer that matches ' +
    'nothing on the next application.', {
      questions: {
        type: 'array',
        description: 'Every question you need answered right now, one entry each, in the order the fields appear on the page.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'ONE question in plain words, e.g. "What is your expected salary?". Never a numbered list of several.' },
            options: { type: 'array', items: { type: 'string' }, description: 'Choices to offer — usually the form control\'s own options. The user can still type something else.' },
            long: { type: 'boolean', description: 'True when the answer is a paragraph (cover letter, "why this company"), so the user gets a big box.' },
          },
          required: ['question'],
        },
      },
    }, ['questions']),
  // CONTRACT-V11 §2. Agent-owned: the loop shows the card, and then EXECUTES the approved
  // entries by dispatching each through executeTool — so the model does not spend a step
  // per field re-issuing fills it has already written down here.
  toolDef('propose_plan',
    'Agree the whole page with the user in ONE interruption, then fill it. Read the form first (read_page, ' +
    'find, read_page within), then send EVERY field you intend to fill AND EVERY question you cannot answer ' +
    'from the profile, the resume or the saved answers. The user sees one card: your values (which they can ' +
    'correct or untick) and your questions (which they answer). ' +
    'THE APPROVED FIELDS ARE THEN FILLED FOR YOU BY THIS CALL — the result says which landed, which the user ' +
    'unticked, and which failed. Do NOT fill an approved field again afterwards; re-filling a checkbox ' +
    'unchecks it and re-filling a typeahead opens a menu over the next control. ' +
    'The answers to your questions are NOT filled — fill those yourself after this returns. ' +
    'Use this once per form page, before your first fill on that page; on a wizard, once per page. ' +
    'Never put a password, OTP or any other credential in a plan — those go through request_secret.', {
      fills: {
        type: 'array',
        description: 'Every value you intend to enter on this page. Omit fields that are already correctly filled.',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: 'Element ref from read_page, e.g. "e12" or "f381:e12".' },
            label: { type: 'string', description: 'The field\'s visible name, as the user would read it on the form — this is what they see in the card.' },
            value: { type: 'string', description: 'The exact value to enter. For set_checkbox use "Yes" or "No".' },
            tool: {
              type: 'string',
              enum: ['fill', 'select_option', 'choose_option', 'set_checkbox'],
              description: 'How to enter it — the same choice you would make calling the tool directly ' +
                '(select_option only for a native <select>, choose_option for every custom dropdown/combobox/typeahead). Default "fill".',
            },
          },
          required: ['ref', 'label', 'value'],
        },
      },
      unknowns: {
        type: 'array',
        description: 'Everything on this page you genuinely cannot answer. One entry per question — never number several questions inside one string.',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question, in the user\'s words.' },
            options: { type: 'array', items: { type: 'string' }, description: 'The form\'s own choices, when it offers a list.' },
            long: { type: 'boolean', description: 'True for a paragraph answer (a cover letter, "why this company"), so the user gets a big box.' },
          },
          required: ['question'],
        },
      },
    }, []),
  // CONTRACT-V11 §5. The pre-submit confirmation, as a tool rather than a phrasing of
  // ask_user. It CLICKS on approval: a dialog whose button says "Submit application" and
  // which then merely tells the model it *may* submit is a dialog that lies about what the
  // click did — the model can still error, pick a different control, or be stopped in
  // between, and the user who pressed Submit would be left with an unsubmitted form and no
  // reason to think so.
  toolDef('confirm_submit',
    'Get the user\'s go-ahead for the FINAL submit and, if they approve, click it. Call this INSTEAD of ' +
    'ask_user when everything is filled and the only thing left is to submit the application. ' +
    'The user gets a two-button dialog — Submit or Cancel — and clicks once; they are not asked to type anything. ' +
    'On approval this CLICKS the button you named, so do not click it again yourself: read_page / read_errors ' +
    'afterwards to verify the submission actually went through (rule 9), then call done. ' +
    'If they cancel, the form is left filled and untouched — call done with status "ready_for_review".', {
      ref: { type: 'string', description: 'Ref of the final submit button, from read_page.' },
      label: { type: 'string', description: 'The button\'s visible text, e.g. "Submit application" — the user sees this, so it must be what the page really says.' },
      summary: {
        type: 'string',
        description: 'One or two plain sentences: what is being submitted and to whom, e.g. ' +
          '"Your application for Senior Engineer at Acme, with resume.pdf attached." This is what the user reads before deciding.',
      },
    }, ['ref', 'summary']),
  toolDef('request_secret',
    'Ask the user for a credential (password, OTP, 2FA code) and type it into a field. ' +
    'The extension collects the value and fills it directly — you never see it. ' +
    'This is the ONLY way to fill a credential field.', {
      ref: { type: 'string', description: 'Element ref of the credential field, e.g. e12 or f381:e12.' },
      kind: { type: 'string', enum: ['username', 'password', 'otp', 'other'], description: 'What kind of secret to collect.' },
      label: { type: 'string', description: 'Human hint, e.g. "Cisco SSO password".' },
    }, ['ref', 'kind']),
  // CONTRACT-V3 §4. Agent-owned — the loop handles it, executeTool refuses it, and the
  // content script never sees it. The "about the PORTAL, not this company" instruction is
  // the whole point: the same portal serves hundreds of employers, so a playbook keyed to
  // one of them is worthless to the other 99%.
  toolDef('remember',
    'Save what you learned about how this JOB PORTAL works, so future applications on the same portal — at any company — are fast. ' +
    'Call this before done whenever you worked out something the playbook did not already say: the entry point, the wizard steps, ' +
    'which control advances a page, a trap you hit. Write it about the PORTAL (how Workday behaves), NOT about this one employer — ' +
    'the same portal serves hundreds of companies. Put employer-only quirks in site_notes. ' +
    'Never save the user\'s personal answers (salary, visa status, notice period) here.', {
      platform: { type: 'string', description: 'Optional. Must match the portal actually detected on this page; the write is refused otherwise. Normally just omit it.' },
      procedure: { type: 'array', items: { type: 'string' }, description: 'Ordered steps to complete an application on this portal. REPLACES the stored procedure — send the full improved list, not a fragment.' },
      tips: { type: 'array', items: { type: 'string' }, description: 'Reusable facts: stable selectors, control labels, traps. Merged into the existing tips and deduped.' },
      site_notes: { type: 'array', items: { type: 'string' }, description: 'Quirks true ONLY of this specific employer/host, not of the portal in general.' },
    }, []),
  // CONTRACT-V6 §5.1. The escape hatch from thrashing: when a control has defeated you
  // twice, stop guessing and let the user show you. Agent-owned — the loop pauses the
  // run and the panel takes over; the content script never sees this tool.
  toolDef('request_demo',
    'Ask the user to SHOW you how to do something you cannot work out. Use this after you have failed the SAME control twice — ' +
    'do not keep trying a third time, and do not give up with done(blocked) when a human could simply demonstrate it. ' +
    'The user performs the action by hand, the extension records it, and it is saved as a reusable macro for this PORTAL, ' +
    'so no future application on this portal has to ask again. When the run resumes, the action is ALREADY DONE — ' +
    'read_page to see the new state and carry on from there. Do NOT repeat the action yourself.', {
      goal: { type: 'string', description: 'What you are stuck on, in plain language the user can act on: "select the Country Phone Code — the dropdown will not open for me".' },
    }, ['goal']),
  // Agent-owned, like request_demo: a captcha is a HUMAN handoff, not a page action.
  // The loop brings the tab forward, the content script spotlights the widget, and the
  // panel shows a one-button dialog — no typing, because there is nothing to type.
  toolDef('request_captcha',
    'Hand a CAPTCHA to the user. Call this the moment read_page/read_errors reports one, or when a submit silently ' +
    'does nothing (that is how invisible captchas behave). It focuses the tab, scrolls the challenge into view, and ' +
    'asks the user to confirm once they have solved it. Never try to solve or bypass a captcha yourself, and never ' +
    'use ask_user for one. When this returns, retry the blocked action, then read_errors.', {
      reason: { type: 'string', description: 'One short line of context, e.g. "reCAPTCHA checkbox before submit".' },
    }, []),
  // Panel-orchestrated (§5.2): it binds profile values and routes credential steps
  // through the vault, so it cannot be a plain content tool.
  toolDef('run_macro',
    'Replay a demonstration the user previously recorded for this portal. The available macros are listed in your ' +
    'system prompt under "Recorded macros" — call this with one of those names instead of struggling with the same control again. ' +
    'Every step is verified; if a step fails the macro stops and tells you, and you should call request_demo for a fresh demonstration.', {
      name: { type: 'string', description: 'The macro name, exactly as listed in the system prompt.' },
    }, ['name']),
  toolDef('done', 'Call when the task is finished or blocked. Ends the run with an honest status.', {
    status: {
      type: 'string',
      enum: ['submitted', 'ready_for_review', 'already_applied', 'blocked', 'answered'],
      description: 'submitted = verified submit; ready_for_review = filled, awaiting human; ' +
        'already_applied = the portal says this candidate has already applied to this position; ' +
        'blocked = cannot proceed; answered = question answered.',
    },
    summary: { type: 'string', description: 'Short honest summary of the outcome.' },
    // The application log's two human-readable columns. The model has just read the
    // posting, so it reports them cleanly — scraping the tab title gets "Careers –
    // Acme GmbH | Jobs" instead of the job.
    job_title: { type: 'string', description: 'For submitted / ready_for_review / already_applied: the position\'s title, as the posting states it.' },
    company: { type: 'string', description: 'For the same statuses: the employer\'s name (the company hiring, not the job board).' },
  }, ['status', 'summary']),
];

function toolDef(name, description, properties, required) {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
  };
}

// ------------------------------------------------------------------ refs

export function parseRef(ref) {
  const m = /^f(\d+):(e\d+)$/.exec(String(ref || '').trim());
  if (m) return { frameId: Number(m[1]), ref: m[2] };
  return { frameId: 0, ref: String(ref || '').trim() };
}

// -------------------------------------------------------------- messaging

const CONTENT_TOOLS = new Set([
  'read_page', 'find', 'fill', 'select_option', 'choose_option', 'click', 'set_checkbox',
  'upload_file', 'read_errors', 'autofill',
  // CONTRACT-V7 — routed by their own handlers below, because neither takes a plain
  // required `ref`: inspect_dom accepts a selector, and dom_act carries a sequence.
  'inspect_dom', 'dom_act',
]);
// check_text is deliberately NOT here: it is internal to wait({until_text}) —
// the model never drives it directly (CONTRACT-V4 §3).

// Tools the AGENT loop owns — executeTool must never dispatch these to the page.
// `request_secret` is here so a secret can never fall through to the content
// script via the generic executor, nor produce "Unknown tool" confusion (§5.1).
// `remember` is panel-side data, not a page action (CONTRACT-V3 §4).
// `request_demo` pauses the run for a human demonstration and `run_macro` needs the
// profile and the vault, so both are panel-side too (CONTRACT-V6 §5).
// `propose_plan` opens a review card and then re-enters executeTool once per approved
// entry, so it must never be dispatchable itself (CONTRACT-V11 §2).
const AGENT_OWNED = new Set([
  'ask_user', 'done', 'request_secret', 'remember', 'request_demo', 'run_macro',
  'request_captcha',
  // Both open a dialog and then re-enter executeTool with the result, so neither may be
  // dispatchable itself (CONTRACT-V11 §2, §5).
  'propose_plan', 'confirm_submit',
]);

function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore/i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com/i.test(url);
}

const RESTRICTED_ERROR = 'Cannot operate on this page (browser-internal). Navigate to the job page first.';

async function sendToFrame(tabId, frameId, msg) {
  try {
    return await chrome.tabs.sendMessage(tabId, msg, { frameId });
  } catch (err) {
    if (!/Receiving end does not exist|Could not establish connection/i.test(err.message || '')) {
      throw err;
    }
    // Inject on demand, then retry once (§3).
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/content-script.js'],
    });
    return await chrome.tabs.sendMessage(tabId, msg, { frameId });
  }
}

async function execInFrame(tabId, frameId, tool, args) {
  const resp = await sendToFrame(tabId, frameId, { kind: 'jobpilot:exec', tool, args });
  if (!resp || typeof resp.ok !== 'boolean') {
    return { ok: false, error: 'Content script gave no response. Reload the page and try again.' };
  }
  return resp;
}

// Probe a frame without triggering injection — cross-origin/sandboxed frames
// where the script cannot run simply fail the ping and are skipped.
async function pingFrame(tabId, frameId) {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, { kind: 'jobpilot:ping' }, { frameId });
    return Boolean(resp && resp.ok && resp.ready);
  } catch {
    return false;
  }
}

// ------------------------------------------------------- multi-frame read

async function listFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return frames || [];
  } catch {
    return [{ frameId: 0, url: '' }];
  }
}

// Run a no-ref tool in every reachable frame. The main frame gets the full
// inject-on-demand fallback; subframes are pinged first and skipped silently
// when unreachable (cross-origin frames without the script just fail ping).
async function execAllFrames(tabId, tool, args) {
  const frames = await listFrames(tabId);
  const usable = frames.filter((f) =>
    f.frameId === 0 || (f.url && f.url !== 'about:blank'));
  usable.sort((a, b) => a.frameId - b.frameId);

  const results = [];
  // Subframe failures are RECORDED, not just skipped: an iframe that errored
  // mid-tool is not the same as an iframe with nothing to say, and callers like
  // autofill must be able to tell the model which frames went unchecked
  // (CONTRACT-V4 §7). Frames that merely fail the ping (sandboxed, script
  // never injected) stay silent — that is the normal case, not a failure.
  const failures = [];
  let mainError = null;

  const execOne = async (frame) => {
    let resp;
    try {
      resp = await execInFrame(tabId, frame.frameId, tool, args); // frame 0 injects + retries if needed
    } catch (err) {
      const msg = err.message || String(err);
      if (frame.frameId === 0) mainError = msg;
      else failures.push({ frame, error: msg });
      return;
    }
    if (!resp.ok) {
      if (frame.frameId === 0) mainError = resp.error;
      else failures.push({ frame, error: resp.error });
      return;
    }
    const text = String(resp.result || '').trim();
    if (text) results.push({ frame, text });
  };

  const pingFailed = [];
  for (const frame of usable) {
    if (frame.frameId === 0) { await execOne(frame); continue; }
    if (await pingFrame(tabId, frame.frameId)) await execOne(frame);
    else pingFailed.push(frame);
  }
  // One SHARED second chance for the frames that did not answer. The case this exists
  // for: an ATS iframe (Greenhouse/Lever/iCIMS embed) inserted moments ago whose content
  // script is still loading — dropping it turns "the form exists" into "the page is a
  // shell", with no unread note, because a failed ping is normally not a failure. The
  // wait is one 250ms beat for the whole batch, not per frame, so an ad-heavy page with
  // twenty permanently-dead frames costs one beat, not five seconds. Frames that stay
  // silent stay silent — listing every sandboxed ad frame as "unread" on every read
  // would drown the note the model actually needs.
  if (pingFailed.length) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    for (const frame of pingFailed) {
      if (await pingFrame(tabId, frame.frameId)) await execOne(frame);
    }
  }
  return { results, mainError, failures };
}

function frameHost(frame) {
  try { return new URL(frame.url).hostname; } catch { return frame.url || 'unknown'; }
}

/**
 * CONTRACT-V6 §8 — "nothing matched" and "I could not look" must never read the same.
 *
 * execAllFrames already RECORDS which frames it could not read; every reader has to say
 * so, or a partial answer is served as a whole one. The sharpest case is a clean-looking
 * `read_errors` on a page whose ATS iframe failed to answer: the model reads an all-clear
 * that was never checked and calls done on a form that never submitted.
 *
 * Returns '' when every frame answered, so the ordinary case adds nothing.
 */
function unreadNote(mainError, failures) {
  const parts = [];
  // The sentinel means the frame LOOKED and matched nothing — an honest miss, not a
  // frame that went unchecked. Reporting it here would manufacture the opposite lie.
  const unchecked = (e) => e && !String(e).startsWith('NO_TARGET_IN_FRAME: ');
  if (unchecked(mainError)) parts.push(`the main frame (${firstLine(mainError)})`);
  for (const { frame, error } of failures || []) {
    if (!unchecked(error)) continue;
    parts.push(`f${frame.frameId} ${frameHost(frame)} (${firstLine(error)})`);
  }
  if (!parts.length) return '';
  return `\n\n(${parts.length} frame${parts.length === 1 ? '' : 's'} could NOT be read, so this answer does not ` +
    `cover the whole page: ${parts.join('; ')}.)`;
}

function firstLine(msg) {
  const s = String(msg || 'no reason given').split('\n')[0].trim();
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

async function readPageAllFrames(tabId, args) {
  const { results, mainError, failures } = await execAllFrames(tabId, 'read_page', args);
  const unread = unreadNote(mainError, failures);
  const textMode = args && args.mode === 'text';
  // CONTRACT-V8 §4 — in changes mode a quiet frame is the NORMAL answer, not an
  // absent one, so it is counted rather than treated as a frame that failed.
  const changesMode = args && args.mode === 'changes';
  let quiet = 0;
  const sections = [];
  for (const { frame, text } of results) {
    if (changesMode && /^No changes since the last read/.test(text)) {
      quiet++;
      continue;
    }
    if (frame.frameId === 0) {
      sections.unshift(text);
    } else if (changesMode) {
      // A changes report DOES carry refs, so it needs the frame prefix — unlike text
      // mode, which is prose. Getting this wrong would hand out refs that resolve in
      // the wrong document.
      sections.push(`== FRAME f${frame.frameId} (${frameHost(frame)}) ==\n${prefixRefs(text, frame.frameId)}`);
    } else if (textMode) {
      // Text mode produces no [eN] refs — include any subframe with real prose
      // beyond its URL/TITLE header (job descriptions often live in iframes).
      const body = text.replace(/^URL: .*$/m, '').replace(/^TITLE: .*$/m, '').trim();
      if (!body) continue;
      sections.push(`== FRAME f${frame.frameId} (${frameHost(frame)}) ==\n${text}`);
    } else {
      // Only include subframes that actually reported interactive elements.
      if (!/\[e\d+\]/.test(text)) continue;
      const rewritten = text.replace(/\[e(\d+)\]/g, `[f${frame.frameId}:e$1]`);
      sections.push(`== FRAME f${frame.frameId} (${frameHost(frame)}) ==\n${rewritten}`);
    }
  }
  if (!sections.length) {
    // "Every frame reported no changes" is a SUCCESS and a useful answer — it means the
    // action did nothing. Only an actual read failure is an error (§4).
    if (changesMode && quiet) {
      return {
        ok: true,
        result: `No changes since the last read, in any of the ${quiet} frame${quiet === 1 ? '' : 's'} checked. ` +
          'The page did not react. If you expected it to, the action may not have registered.' + unread,
      };
    }
    return {
      ok: false,
      error: mainError || 'Could not read any frame on this page. Reload the page and try again.',
    };
  }
  if (changesMode && quiet) sections.push(`(${quiet} other frame${quiet === 1 ? '' : 's'} unchanged.)`);
  return { ok: true, result: budgetSections(sections).join('\n\n') + unread };
}

// READ_CAP in the content script is per FRAME. A portal that runs its form in three iframes
// therefore returned three times that cap, and this module is the only place that ever sees
// the whole thing — so until this existed, nothing bounded a read of a ten-frame page at all.
const READ_TOTAL_CAP = 12000;

/**
 * Fit every frame's section into one shared character budget.
 *
 * Deliberately NOT first-come-first-served. On Workday the main frame is often a shell
 * worth a few hundred characters while the form lives in an iframe, so spending the budget
 * in frame order would starve the only frame that mattered. Each section instead gets an
 * equal share, and any section under its share donates the remainder to the ones over it —
 * small frames survive whole and the big ones split what is left.
 *
 * Cuts land on a line boundary (half of "[e12] textbox label=" is worse than none of it)
 * and say what was lost: a silently short inventory reads exactly like a complete one, and
 * that is how a model calls done on a form it never finished seeing.
 *
 * Exported for the harness.
 */
export function budgetSections(sections, total = READ_TOTAL_CAP) {
  const joinCost = 2 * Math.max(0, sections.length - 1); // the '\n\n' between sections
  const budget = total - joinCost;
  if (budget <= 0 || sections.reduce((n, s) => n + s.length, 0) <= budget) return sections;

  // Water-filling: hand out an equal share smallest-first, letting each under-share section
  // settle at its true length so the unused remainder grows the share of the ones still to
  // come. One pass in ascending order is enough — a section that fits its share can never
  // be made to overflow by a later, larger one.
  const allow = new Array(sections.length);
  const order = sections.map((s, i) => ({ i, len: s.length })).sort((a, b) => a.len - b.len);
  let left = budget;
  let remaining = order.length;
  for (const { i, len } of order) {
    const take = Math.min(len, Math.floor(left / remaining));
    allow[i] = take;
    left -= take;
    remaining--;
  }

  return sections.map((s, i) => (s.length <= allow[i] ? s : cutToLine(s, allow[i])));
}

/**
 * `text` cut to about `max` characters, ending on a line boundary and saying how much went.
 *
 * The 200-character floor can push a section slightly over its allowance; that is
 * deliberate. A section cut so hard that only the truncation note survived would spend the
 * budget saying nothing, and the overshoot is bounded by the frame count.
 */
function cutToLine(text, max) {
  const note = (n) => `\n…(${n} more characters of this frame were cut to fit one read into the ` +
    'context budget. Use find, or read_page with within:, to reach what is missing.)';
  const room = Math.max(200, max - note(text.length).length);
  if (text.length <= room) return text;
  const nl = text.lastIndexOf('\n', room);
  const cut = text.slice(0, nl > room * 0.5 ? nl : room);
  return cut + note(text.length - cut.length);
}

/** CONTRACT-V8 §3.1 — a scoped read runs in the frame its `within` ref belongs to. */
async function readWithinTool(tabId, args) {
  const { frameId, ref } = parseRef(args.within);
  if (!/^e\d+$/.test(ref)) {
    return { ok: false, error: `"${args.within}" is not a valid ref for within. Use a ref from read_page or find.` };
  }
  const resp = await execInFrame(tabId, frameId, 'read_page', { within: ref });
  if (!resp.ok) return await attachFreshSnapshot(tabId, resp);
  return { ok: true, result: frameId ? prefixRefs(resp.result, frameId) : resp.result };
}

/** CONTRACT-V8 §2 — search every frame; a frame with no match says so and is dropped. */
async function findTool(tabId, args) {
  const text = String((args && args.text) || '').trim();
  if (!text) return { ok: false, error: 'find needs {text} — the visible label or button text to look for.' };
  const payload = { text: text.slice(0, 120) };
  if (args.role) payload.role = String(args.role).slice(0, 20);
  if (args.limit != null) payload.limit = Number(args.limit) || undefined;

  const { results, mainError, failures } = await execAllFrames(tabId, 'find', payload);
  const unread = unreadNote(mainError, failures);
  const hits = [];
  const misses = [];
  for (const { frame, text: out } of results) {
    if (/^No .*named /.test(out)) {
      misses.push(out);
      continue;
    }
    hits.push(frame.frameId === 0
      ? out
      : `== FRAME f${frame.frameId} (${frameHost(frame)}) ==\n${prefixRefs(out, frame.frameId)}`);
  }
  if (hits.length) return { ok: true, result: hits.join('\n\n') + unread };
  if (misses.length) {
    // Not an error: the search worked and found nothing, and the near-misses it
    // collected are the useful part. Returning ok:false here would push the model
    // into error-recovery instead of into a better search term.
    //
    // `unread` is what stops that reading as "the control is not on this page" when the
    // one frame holding it never answered — a miss from the frames we COULD search is
    // not the same claim (V6 §8).
    return { ok: true, result: misses.join('\n\n') + unread };
  }
  return {
    ok: false,
    error: mainError || `Could not search this page for "${text}". Reload the page and try again.`,
  };
}

async function readErrorsAllFrames(tabId, args) {
  const { results, mainError, failures } = await execAllFrames(tabId, 'read_errors', args);
  if (!results.length && mainError) return { ok: false, error: mainError };
  const sections = [];
  for (const { frame, text } of results) {
    if (/^No visible errors\.?$/i.test(text)) continue;
    sections.push(frame.frameId === 0
      ? text
      : `== FRAME f${frame.frameId} (${frameHost(frame)}) ==\n${text}`);
  }
  // The all-clear is the single most dangerous string this tool can return: the model
  // reads it as "the form is clean" and calls done. It may only be said about frames that
  // actually answered (V6 §8).
  const unread = unreadNote(mainError, failures);
  if (sections.length) return { ok: true, result: sections.join('\n\n') + unread };
  return {
    ok: true,
    result: unread
      ? `No visible errors in the frames that could be read.${unread}`
      : 'No visible errors.',
  };
}

/**
 * The validation text out of a read_errors result, or '' when the page is clean.
 *
 * CONTRACT-V11 §6. Lives next to readErrorsAllFrames because it is the only other place
 * that knows what that function's strings mean — in particular that BOTH all-clear forms
 * open with "No visible errors", the second being the partial-read variant. A copy of this
 * predicate anywhere else would be a second reader of a format only this file defines, and
 * the failure mode is the worst one available: reading a form that refused to submit as a
 * form that submitted.
 */
export function visibleErrorText(res) {
  if (!res || !res.ok) return '';
  const text = String(res.result ?? '').trim();
  if (!text || /^No visible errors/i.test(text)) return '';
  return text;
}

/**
 * A page's validation block, as one short line a person can read.
 *
 * read_errors returns everything it found across every frame, with `== FRAME f7 (host) ==`
 * headers between them — right for the model and wrong for a notice in the transcript,
 * which has one line to say why an application the user just approved did not go in.
 */
export function summarizeErrors(text, maxItems = 3) {
  const lines = String(text ?? '')
    .split('\n')
    .map((l) => l.replace(/^[\s•\-*]+/, '').trim())
    // Frame headers are plumbing, and a bare "Error"/"Warning" is the label ATS markup puts
    // in its own element next to the message — neither says anything about what is wrong.
    .filter((l) => l && !/^==\s*FRAME/i.test(l) && !/^(?:error|warning|alert)!?$/i.test(l));
  const seen = [];
  for (const l of lines) {
    if (!seen.some((s) => s.toLowerCase() === l.toLowerCase())) seen.push(l);
    if (seen.length >= maxItems) break;
  }
  const more = lines.length > seen.length ? ` (+${lines.length - seen.length} more)` : '';
  return seen.join(' · ') + more;
}

/**
 * Does this validation text describe a missing FILE?
 *
 * Worth singling out because it is the one class of blocker the agent usually cannot clear
 * on its own: every other required field can be filled from the profile or asked about, but
 * "Final certificate — Attachment is required" needs a document that may simply not be in
 * the store. Saying so turns a dead end into an instruction the user can act on.
 */
export function needsAttachment(text) {
  return /\b(?:attach(?:ment|ed)?|upload(?:ed)?|file|document|resum[eé]|cv|certificate|transcript|portfolio)\b/i.test(String(text ?? ''))
    && /\b(?:require[ds]?|mandatory|missing|must|needed|please (?:attach|upload|provide))\b/i.test(String(text ?? ''));
}

/**
 * CONTRACT-V4 §4 — a stale ref gets a fresh snapshot attached so the model re-targets
 * in the SAME round trip instead of burning a step on read_page.
 */
async function attachFreshSnapshot(tabId, resp) {
  if (!resp || resp.ok || !/Stale ref|expected a bare ref/i.test(resp.error || '')) return resp;
  try {
    const snap = await readPageAllFrames(tabId, {});
    if (snap.ok) {
      return { ok: false, error: `${resp.error}\n\nFresh page snapshot (these refs are current):\n${snap.result}` };
    }
  } catch { /* recovery is best-effort — the original error stands */ }
  return resp;
}

// ------------------------------------------------- CONTRACT-V7: DOM tools

/** Subframe refs are frame-qualified exactly as read_page does it (§5.2). */
function prefixRefs(text, frameId) {
  return String(text).replace(/\[e(\d+)\]/g, `[f${frameId}:e$1]`);
}

/**
 * The content script's "nothing matched, and nothing was performed" sentinel (V7 §4).
 * It exists so the panel may safely retry another frame; it must never reach the model.
 */
function stripSentinel(msg) {
  return String(msg || '').replace(/^NO_TARGET_IN_FRAME: /, '');
}

async function inspectDomTool(tabId, args) {
  args = args && typeof args === 'object' ? args : {};

  if (args.ref) {
    const { frameId, ref } = parseRef(args.ref);
    if (!/^e\d+$/.test(ref)) {
      return { ok: false, error: `"${args.ref}" is not a valid ref. Call read_page and use a ref like e3 or f381:e3.` };
    }
    const resp = await execInFrame(tabId, frameId, 'inspect_dom', { ref });
    if (!resp.ok) return { ok: false, error: stripSentinel(resp.error) };
    return { ok: true, result: frameId ? prefixRefs(resp.result, frameId) : resp.result };
  }

  const selector = String(args.selector || '').trim();
  if (!selector) {
    return { ok: false, error: 'inspect_dom needs a ref (from read_page) or a CSS selector.' };
  }
  // Every frame: an embedded ATS form is the normal case (V6 §8), and the element the
  // model wants to look at is very often inside one.
  const { results, mainError, failures } = await execAllFrames(tabId, 'inspect_dom', { selector: selector.slice(0, 300) });
  if (!results.length) {
    return {
      ok: false,
      error: stripSentinel(mainError) ||
        `No element matches "${selector}" in any frame. Call read_page to see what is actually there.`,
    };
  }
  const sections = results.map(({ frame, text }) => (
    frame.frameId === 0
      ? text
      : `== FRAME f${frame.frameId} (${frameHost(frame)}) ==\n${prefixRefs(text, frame.frameId)}`
  ));
  // A main-frame AMBIGUITY refusal (V6 §3.1) lands in mainError. Dropping it because some
  // subframe answered would turn "several things match" into a confident single answer
  // about whichever frame replied first — a coin flip wearing a verdict's clothes.
  return { ok: true, result: sections.join('\n\n') + unreadNote(mainError, failures) };
}

const DOM_ACT_OPS = new Set([
  'click', 'key', 'type', 'paste', 'hover', 'drag', 'scroll',
  'focus', 'blur', 'scroll_into_view', 'wait_for', 'read',
]);
const DOM_ACT_MAX_ACTIONS = 12;
const DOM_ACT_MAX_VALUE = 500;
const DOM_ACT_SWEEP_MS = 25000; // wall-clock ceiling on the try-every-frame fallthrough

/**
 * §5.3's rule, applied to a nested payload: build each action from ONLY the keys its op
 * understands. Model-supplied extras are dropped rather than forwarded — notably any
 * attempt at a `secret` flag, which has no meaning here and must never acquire one.
 */
function sanitizeDomAction(a) {
  const op = String(a.op || '').trim();
  if (!DOM_ACT_OPS.has(op)) {
    return { error: `unknown op "${op}". Supported: ${[...DOM_ACT_OPS].join(', ')}.` };
  }
  const action = { op };
  let frameId = null;
  const notes = [];

  if (a.ref != null && String(a.ref).trim()) {
    const parsed = parseRef(a.ref);
    if (!/^e\d+$/.test(parsed.ref)) {
      return { error: `"${a.ref}" is not a valid ref. Use one from read_page or inspect_dom.` };
    }
    action.ref = parsed.ref;
    frameId = parsed.frameId;
  }
  if (a.selector != null && String(a.selector).trim()) {
    action.selector = String(a.selector).trim().slice(0, 300);
  }

  switch (op) {
    case 'type':
    case 'paste': {
      // The cap stays — but a silent cut is the worst of both worlds. The content script
      // verifies the write against the value it RECEIVED, so a truncated cover letter
      // passes its own read-back and the model is told the whole thing landed (V3 §7.1).
      const full = String(a.value ?? '');
      action.value = full.slice(0, DOM_ACT_MAX_VALUE);
      if (full.length > DOM_ACT_MAX_VALUE) {
        notes.push(`only the first ${DOM_ACT_MAX_VALUE} of ${full.length} characters were ${op}d — ` +
          `the remaining ${full.length - DOM_ACT_MAX_VALUE} were NOT entered`);
      }
      if (a.clear === true) action.clear = true;
      if (a.commit === true) action.commit = true;
      break;
    }
    case 'key':
      action.key = String(a.key ?? '').slice(0, 20);
      if (!action.key) return { error: 'key needs a key, e.g. "ArrowDown" or "Enter".' };
      if (a.times != null) action.times = Number(a.times) || 1;
      break;
    case 'wait_for':
      if (!action.selector) return { error: 'wait_for needs a selector.' };
      if (a.state === 'gone') action.state = 'gone';
      if (a.timeout != null) action.timeout = Number(a.timeout) || 5;
      break;
    case 'scroll':
      if (a.to === 'top' || a.to === 'bottom') action.to = a.to;
      if (a.by != null) action.by = Number(a.by) || 0;
      if (a.times != null) action.times = Number(a.times) || 1;
      break;
    case 'drag': {
      // The destination is a second target, so it gets the same ref discipline as the
      // first — including the rule that both must live in the same frame.
      if (a.to_ref != null && String(a.to_ref).trim()) {
        const parsed = parseRef(a.to_ref);
        if (!/^e\d+$/.test(parsed.ref)) {
          return { error: `"${a.to_ref}" is not a valid ref for to_ref.` };
        }
        action.to_ref = parsed.ref;
        if (frameId != null && parsed.frameId !== frameId) {
          return { error: 'a drag cannot cross frames — its source and destination refs are in different documents.' };
        }
        frameId = parsed.frameId;
      }
      if (a.to_selector != null && String(a.to_selector).trim()) {
        action.to_selector = String(a.to_selector).trim().slice(0, 300);
      }
      if (a.dx != null) action.dx = Number(a.dx) || 0;
      if (a.dy != null) action.dy = Number(a.dy) || 0;
      if (!action.to_ref && !action.to_selector && !action.dx && !action.dy) {
        return { error: 'drag needs a destination: to_ref, to_selector, or dx/dy pixels.' };
      }
      break;
    }
    default:
      break;
  }

  // CONTRACT-V9 §2 — modifiers are forwarded for EVERY op, including the ones that cannot
  // hold one. Stripping them here would silently grant the model's request instead of
  // refusing it, and the named refusal in runDomAction ("ctrl is only meaningful on click
  // and key, not on type") could never fire. §5.3 drops keys the op does not understand;
  // this is not that — the model asked for a chord, and it has to be told it did not get one.
  for (const mod of ['ctrl', 'meta', 'shift', 'alt']) {
    if (a[mod] === true) action[mod] = true;
  }

  // scroll with no target means the page itself, which is a legitimate request.
  if (!action.ref && !action.selector && op !== 'scroll') {
    return { error: `${op} needs a ref or a selector.` };
  }
  return { action, frameId, notes };
}

/** Frame 0 first, then any subframe that answers a ping (V7 §4). */
async function frameOrder(tabId) {
  const frames = await listFrames(tabId);
  const order = [0];
  for (const f of frames.sort((a, b) => a.frameId - b.frameId)) {
    if (f.frameId === 0 || !f.url || f.url === 'about:blank') continue;
    if (await pingFrame(tabId, f.frameId)) order.push(f.frameId);
  }
  return order;
}

async function domActTool(tabId, args) {
  args = args && typeof args === 'object' ? args : {};
  const raw = Array.isArray(args.actions) ? args.actions : [];
  if (!raw.length) {
    return { ok: false, error: `dom_act needs {actions:[…]} with at least one action. Ops: ${[...DOM_ACT_OPS].join(', ')}.` };
  }
  if (raw.length > DOM_ACT_MAX_ACTIONS) {
    return { ok: false, error: `dom_act takes at most ${DOM_ACT_MAX_ACTIONS} actions; you sent ${raw.length}. Split it into two calls.` };
  }

  const actions = [];
  const notes = [];
  let frameId = null;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i] && typeof raw[i] === 'object' ? raw[i] : {};
    const { action, frameId: fid, error, notes: n } = sanitizeDomAction(a);
    if (error) return { ok: false, error: `Action ${i + 1}: ${error}` };
    for (const note of n || []) notes.push(`Action ${i + 1}: ${note}`);
    if (fid != null) {
      if (frameId != null && frameId !== fid) {
        return {
          ok: false,
          error: 'All refs in one dom_act must belong to the SAME frame — a sequence split across frames is two ' +
            'sequences, and half of it would run against the wrong document. Split it into two calls.',
        };
      }
      frameId = fid;
    }
    actions.push(action);
  }

  // A ref pins the frame. With selectors only we try the main frame and fall through to
  // the others — safe ONLY because the sentinel means action 1 resolved nothing, so
  // nothing was performed (V7 §3.3).
  const order = frameId != null ? [frameId] : await frameOrder(tabId);
  const tail = notes.length ? `\n(${notes.join('; ')}.)` : '';
  let firstError = null;
  // A THROW is not a miss. The sentinel means the frame resolved nothing and touched
  // nothing; an exception means the message channel died, and the commonest reason for
  // that is that the click we just dispatched navigated the page out from under us. Those
  // two must not collapse into the same "Nothing was performed" (V3 §7.1).
  let torndown = null;
  // The sweep is per-frame, and `wait_for` can legitimately spend its full timeout in each
  // one. An ad-heavy page carries our content script in dozens of frames, so an unbounded
  // sweep of a selector that is nowhere would hang the run for minutes. Stop after this,
  // and SAY which frames went unlooked-at — an abandoned sweep must not read like an
  // exhausted one (V6 §8).
  const sweepDeadline = Date.now() + DOM_ACT_SWEEP_MS;
  let unswept = 0;
  for (const fid of order) {
    if (fid !== order[0] && Date.now() > sweepDeadline) { unswept++; continue; }
    let resp;
    try {
      resp = await execInFrame(tabId, fid, 'dom_act', { actions });
    } catch (err) {
      const msg = err.message || String(err);
      if (torndown == null) torndown = msg;
      if (firstError == null) firstError = msg;
      continue;
    }
    if (resp.ok) {
      // Subframe refs are frame-qualified exactly as read_page does it (§5.2). The `read`
      // and `inspect` ops emit refs, and without the prefix they resolve in the WRONG
      // document the moment the model uses one.
      const result = fid ? prefixRefs(String(resp.result ?? ''), fid) : resp.result;
      return { ok: true, result: `${result}${tail}` };
    }
    const error = resp.error || '';
    if (error.startsWith('NO_TARGET_IN_FRAME: ')) {
      if (firstError == null) firstError = stripSentinel(error);
      continue;
    }
    return { ok: false, error: `${error}${tail}` };
  }
  if (torndown) {
    return {
      ok: false,
      error: `dom_act could not reach the page: ${firstLine(torndown)}. This usually means the page ` +
        'NAVIGATED — which an earlier action in this sequence may well have caused. Do NOT assume ' +
        'nothing happened: call read_page to see where you are before retrying anything.' + tail,
    };
  }
  const gaveUp = unswept
    ? ` ${unswept} further frame${unswept === 1 ? ' was' : 's were'} NOT tried — the search ran out of time, ` +
      'so this is not proof the target is absent from the page.'
    : '';
  return {
    ok: false,
    error: `${firstError || 'dom_act found nothing to act on.'} Nothing was performed.${gaveUp} ` +
      'Call read_page or inspect_dom to see what is actually on the page.' + tail,
  };
}

// ------------------------------------------------------------ panel tools

async function navigateTool(tabId, args, signal) {
  const url = String(args.url || '').trim();
  if (!url) return { ok: false, error: 'navigate needs a url.' };
  if (isRestrictedUrl(url)) return { ok: false, error: RESTRICTED_ERROR };

  try {
    await chrome.tabs.update(tabId, { url });
  } catch (err) {
    return { ok: false, error: `Could not navigate: ${err.message}. The tab may have been closed — ask the user to reopen the job page.` };
  }

  const timedOut = await waitForComplete(tabId, 25000, signal);
  await sleep(800, signal);

  let title = '';
  let finalUrl = url;
  try {
    const tab = await chrome.tabs.get(tabId);
    title = tab.title || '';
    finalUrl = tab.url || url;
  } catch { /* tab gone; report what we know */ }
  const note = timedOut ? ' (load did not finish within 25s — page may still be loading)' : '';
  return { ok: true, result: `Now on ${title || '(untitled)'} — ${finalUrl}${note}` };
}

export function waitForComplete(tabId, timeoutMs, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (timedOut) => {
      if (settled) return;
      settled = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve(timedOut);
    };
    // listener/timer must exist before finish() can run (finish references both).
    const listener = (updatedTabId, info) => {
      if (updatedTabId === tabId && info.status === 'complete') finish(false);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const onAbort = () => finish(true);
    chrome.tabs.onUpdated.addListener(listener);
    if (signal) {
      if (signal.aborted) return finish(true);
      signal.addEventListener('abort', onAbort, { once: true });
    }
    // The tab may already be complete (e.g. same-page anchor).
    chrome.tabs.get(tabId).then((tab) => {
      if (tab && tab.status === 'complete' && tab.url && !tab.pendingUrl) {
        // Give onUpdated a moment to fire for the new load before trusting this.
        setTimeout(() => {
          chrome.tabs.get(tabId).then((t) => {
            if (t && t.status === 'complete') finish(false);
          }).catch(() => finish(true));
        }, 1200);
      }
    }).catch(() => finish(true));
  });
}

async function waitTool(args, signal, getTabId) {
  // CONTRACT-V4 §3 — with until_text, poll the page instead of sleeping blind.
  const until = String(args.until_text || '').replace(/\s+/g, ' ').trim();
  let seconds = Number(args.seconds);
  if (!Number.isFinite(seconds)) seconds = until ? 10 : 1;
  seconds = Math.min(until ? 30 : 10, Math.max(0.5, seconds));

  if (!until) {
    await sleep(seconds * 1000, signal);
    if (signal && signal.aborted) return { ok: true, result: 'Wait cut short — the run was stopped.' };
    return { ok: true, result: `Waited ${seconds}s.` };
  }

  let tabId;
  try {
    tabId = await getTabId();
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isRestrictedUrl(tab.url || tab.pendingUrl || '')) return { ok: false, error: RESTRICTED_ERROR };
  } catch {
    return { ok: false, error: 'The working tab was closed. Ask the user to open the job page again.' };
  }

  const started = Date.now();
  const deadline = started + seconds * 1000;
  // "Did not appear" may only be claimed if at least one poll actually reached a
  // frame. A page that spent the whole window mid-navigation was never CHECKED,
  // and asserting absence anyway would be reporting a fact never verified.
  let everChecked = false;
  for (;;) {
    if (signal && signal.aborted) return { ok: true, result: 'Wait cut short — the run was stopped.' };
    try {
      const { results } = await execAllFrames(tabId, 'check_text', { text: until });
      if (results.length) everChecked = true;
      if (results.some((r) => r.text === 'found')) {
        return { ok: true, result: `"${until}" appeared after ${((Date.now() - started) / 1000).toFixed(1)}s.` };
      }
    } catch { /* mid-navigation — keep polling until the deadline */ }
    if (Date.now() >= deadline) break;
    await sleep(400, signal);
  }
  // A timeout is a fact the model must react to, not a success (CONTRACT-V4 §3).
  if (!everChecked) {
    return {
      ok: false,
      error: `Waited ${seconds}s but the page could not be checked (it may still be loading or navigating), so it is unknown whether "${until}" is present. Call read_page to see the current state.`,
    };
  }
  return {
    ok: false,
    error: `Waited ${seconds}s but "${until}" did not appear on the page. Call read_page to see the current state — the text may be worded differently.`,
  };
}

/** CONTRACT-V4 §7 — panel side of autofill: profile → value set → all frames. */
async function autofillTool(tabId) {
  let profile;
  try {
    profile = await getProfile();
  } catch (err) {
    return { ok: false, error: `Could not read the profile (${err.message}). Fill fields individually instead.` };
  }
  const fields = autofillFields(profile);
  if (!Object.keys(fields).length) {
    return { ok: false, error: 'The profile has no contact details to autofill. Ask the user to fill the Profile tab, or fill fields individually.' };
  }

  const { results, mainError, failures } = await execAllFrames(tabId, 'autofill', { fields });
  if (!results.length) {
    return { ok: false, error: mainError || 'Could not reach any frame on this page. Reload the page and try again.' };
  }

  // A frame that errored is a frame whose fields may still be EMPTY — say so,
  // or a partial autofill reads exactly like a complete one (CONTRACT-V4 §7).
  // The main frame counts: it is the biggest frame on the page, and omitting it was the
  // one gap in a report built precisely to close this gap.
  const failureNotes = failures.map(({ frame, error }) =>
    `Frame f${frame.frameId} (${frameHost(frame)}) could NOT be autofilled: ${error}`);
  if (mainError) failureNotes.unshift(`The MAIN frame could NOT be autofilled: ${firstLine(mainError)}`);

  // "Autofilled 0 fields" + a Did-NOT-stick list means fields WERE found and the
  // values did not hold — that diagnostic must survive, not collapse into
  // "no matching fields" (which would be a lie in the other direction).
  const nothingAnywhere = results.every(({ text }) =>
    text.startsWith('Autofilled 0 fields.') && !text.includes('Did NOT stick'));
  if (nothingAnywhere) {
    const note = failureNotes.length ? ` ${failureNotes.join(' ')}` : '';
    return {
      ok: true,
      result: `No matching empty contact fields were found — nothing was autofilled. Fill fields individually from read_page.${note}`,
    };
  }

  const sections = [];
  for (const { frame, text } of results) {
    // Subframes with nothing to say are noise; the main frame always reports.
    if (frame.frameId !== 0 && text.startsWith('Autofilled 0 fields.') && !text.includes('Did NOT stick')) continue;
    sections.push(frame.frameId === 0 ? text : `== FRAME f${frame.frameId} (${frameHost(frame)}) ==\n${text}`);
  }
  sections.push(...failureNotes);
  return {
    ok: true,
    result: `${sections.join('\n\n')}\nVerify with read_page; dropdowns, typeaheads and non-contact fields still need individual handling.`,
  };
}

/**
 * Identity/contact values ONLY. workAuth, salary, noticePeriod, the voluntary
 * self-identification answers and the saved answers are judgment calls that stay
 * with the model — they are never sent to the deterministic matcher, which cannot
 * map "Male" onto whatever option list this particular form uses (CONTRACT-V4 §7).
 *
 * The postal address IS deterministic — one profile box per form box — so it goes
 * through here rather than costing a fill call, or an ask_user, per line.
 */
function autofillFields(profile) {
  const p = profile || {};
  const fields = {};
  const put = (key, v) => {
    const s = String(v || '').trim();
    if (s) fields[key] = s;
  };
  const full = String(p.fullName || '').trim();
  put('fullName', full);
  const lastSpace = full.lastIndexOf(' ');
  if (lastSpace > 0) {
    put('firstName', full.slice(0, lastSpace));
    put('lastName', full.slice(lastSpace + 1));
  } else {
    put('firstName', full);
  }
  put('email', p.email);
  put('phone', p.phone);
  put('location', p.location);
  // A profile with structured city/state/country but a blank freeform Location still
  // deserves a hit on single-box "Current location" fields — the content script's
  // matcher happily splits a comma-joined value back apart.
  if (!fields.location) {
    put('location', [p.city, p.state, p.country].map((v) => String(v || '').trim()).filter(Boolean).join(', '));
  }
  put('addressLine1', p.addressLine1);
  put('addressLine2', p.addressLine2);
  put('city', p.city);
  put('state', p.state);
  put('postalCode', p.postalCode);
  put('country', p.country);
  put('linkedin', p.linkedin);
  put('github', p.github);
  put('portfolio', p.portfolio);
  return fields;
}

async function uploadFileTool(tabId, args) {
  const docs = await getDocuments();
  if (!docs.length) {
    return { ok: false, error: 'No documents uploaded. Ask the user to add a resume in the Profile tab.' };
  }
  let doc = null;
  if (args.document_id) {
    doc = docs.find((d) => d.id === args.document_id);
    if (!doc) {
      const list = docs.map((d) => `${d.id} (${d.name})`).join(', ');
      return { ok: false, error: `No document with id "${args.document_id}". Available: ${list}.` };
    }
  } else {
    doc = docs.find((d) => d.isDefault) || docs[0];
  }
  const { frameId, ref } = parseRef(args.ref);
  return execInFrame(tabId, frameId, 'upload_file', {
    ref,
    file: { name: doc.name, mime: doc.mime, dataBase64: doc.dataBase64 },
  });
}

// Resolves early (without throwing) when the run's abort signal fires, so a
// stopped run doesn't sit out a full navigate/wait before the loop notices.
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    if (signal) {
      if (signal.aborted) return done();
      signal.addEventListener('abort', done, { once: true });
    }
  });
}

// ------------------------------------------------------------- executor

/**
 * Execute one LLM tool call. `ask_user` and `done` are NOT handled here — the
 * agent loop owns those. Returns {ok, result|error}; never throws for tool-level
 * failures (only for programmer errors).
 *
 * @param {string} name  tool name from TOOL_DEFS
 * @param {object} args  parsed tool arguments
 * @param {() => Promise<number>} getTabId  fresh working-tab resolver
 * @param {AbortSignal} [signal]  run abort signal — cuts navigate/wait short on Stop
 */
export async function executeTool(name, args, getTabId, signal) {
  args = args && typeof args === 'object' ? args : {};

  // Agent-owned tools (ask_user, done, request_secret) are handled by the loop,
  // never here — guard so request_secret can't reach the page or the "Unknown
  // tool" fall-through below.
  if (AGENT_OWNED.has(name)) {
    return { ok: false, error: `${name} is handled by the agent loop, not executeTool.` };
  }

  if (name === 'wait') return waitTool(args, signal, getTabId);

  let tabId;
  try {
    tabId = await getTabId();
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }

  if (name === 'navigate') return navigateTool(tabId, args, signal);

  if (CONTENT_TOOLS.has(name)) {
    // Guard against browser-internal pages before messaging.
    let tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      return { ok: false, error: 'The working tab was closed. Ask the user to open the job page again.' };
    }
    if (isRestrictedUrl(tab.url || tab.pendingUrl || '')) {
      return { ok: false, error: RESTRICTED_ERROR };
    }

    try {
      if (name === 'read_page') {
        // §3.1 — a scoped read names its frame through the ref it scopes to.
        if (args && args.within && args.mode !== 'text') return await readWithinTool(tabId, args);
        return await readPageAllFrames(tabId, args);
      }
      if (name === 'find') return await findTool(tabId, args);
      if (name === 'upload_file') return await uploadFileTool(tabId, args);
      if (name === 'read_errors') return await readErrorsAllFrames(tabId, args);
      if (name === 'autofill') return await autofillTool(tabId);
      // CONTRACT-V7. Both take a selector OR a ref, so neither can use the
      // single-ref path below — but a stale ref costs them a step just the same.
      if (name === 'inspect_dom') return await attachFreshSnapshot(tabId, await inspectDomTool(tabId, args));
      if (name === 'dom_act') return await attachFreshSnapshot(tabId, await domActTool(tabId, args));
      const { frameId, ref } = parseRef(args.ref);
      if (!/^e\d+$/.test(ref)) {
        return { ok: false, error: `"${args.ref}" is not a valid ref. Call read_page and use a ref like e3 or f381:e3.` };
      }
      // §5.3 (closes L4): NEVER spread model args into the page message. Build
      // the payload per tool so a forged {secret:true} (or any other key) is
      // dropped — `fill` here carries no `secret`, so the model cannot type a
      // credential. Only fillSecret() sends secret:true.
      const resp = await execInFrame(tabId, frameId, name, buildContentArgs(name, args, ref));
      return await attachFreshSnapshot(tabId, resp);
    } catch (err) {
      return {
        ok: false,
        error: `Could not reach the page (${err.message}). The page may be reloading or protected — call read_page again, or ask the user to reload the tab.`,
      };
    }
  }

  return { ok: false, error: `Unknown tool "${name}".` };
}

/**
 * §5.3 arg whitelist. Build the content-script payload for a ref-taking tool
 * from ONLY the keys that tool understands — model-supplied extras (notably a
 * forged `secret:true`) are dropped. `fill` deliberately carries no `secret`.
 */
function buildContentArgs(name, args, ref) {
  switch (name) {
    case 'fill': return { ref, value: String(args.value ?? '') };
    case 'select_option': return { ref, option: String(args.option ?? '') };
    case 'choose_option': return { ref, option: String(args.option ?? '') };
    case 'set_checkbox': return { ref, checked: Boolean(args.checked) };
    case 'click': return { ref };
    default: return { ref };
  }
}

/**
 * §5.2 — Fill `value` into a credential field without the value ever appearing
 * in the returned string. Sends {tool:'fill', args:{ref, value, secret:true}};
 * the content script marks the field sticky-secret and returns "Filled (hidden)
 * into eN.". The success string the model sees is assembled by agent.js and
 * never contains `value`. CRITICAL: no string this function returns — success
 * OR error — may contain `value` or a caught exception's message (a thrown
 * value could embed the secret).
 *
 * @param {() => Promise<number>} getTabId
 * @param {string} ref  frame-qualified or bare ref
 * @param {string} value  the secret — never logged, never returned
 * @param {AbortSignal} [signal]
 * @param {string} expectHost  host the credential was collected for; the fill is
 *   refused unless the destination frame still serves that exact host. Without
 *   this, a page could embed a cross-origin iframe, have the model aim
 *   request_secret at a field inside it, and receive the top origin's password.
 * @returns {Promise<{ok:true, result:string}|{ok:false, error:string}>}
 */
// ------------------------------------------------------- record & replay
// CONTRACT-V6. The panel drives these — the model never calls them directly.

/**
 * Start watching (CONTRACT-V6 §8).
 *
 * EVERY frame, not just the main one. The first cut armed frame 0 alone — "the user
 * demonstrates where they can see" — which was the wrong instinct: what they see is
 * very often rendered by an embedded ATS iframe, and events do not cross that
 * boundary. Frames that load LATER arm themselves off the session (rec-hello), which
 * is what carries the recording through the navigation the demonstration causes.
 */
export async function startRecording(runId, tabId) {
  const opened = await chrome.runtime.sendMessage({ kind: 'jobpilot:rec-open', runId, tabId });
  if (!opened || !opened.ok) {
    // The worker's own refusal is the useful one — there is exactly one recorder, and
    // "another application is already recording" is a thing the user can act on, unlike a
    // generic failure. Only fall back to the generic wording when it said nothing.
    return {
      ok: false,
      error: (opened && opened.error)
        || 'Could not open a recording session in the background worker.',
    };
  }
  const { results, mainError } = await execAllFrames(tabId, 'record_start', {});
  if (!results.length) {
    // never leave it armed
    await chrome.runtime.sendMessage({ kind: 'jobpilot:rec-close', runId });
    return { ok: false, error: mainError || 'No frame in this tab could be watched.' };
  }
  return { ok: true, frames: results.length };
}

/**
 * Stop watching and collect the demonstration (CONTRACT-V6 §3.2, §8).
 *
 * The steps come from the session, not from the page: by now the page the user
 * started on may be gone, and half the steps may have been performed in a tab that
 * did not exist when they began. Every frame of every tab the session touched is
 * flushed first, so a value typed and never blurred is still banked.
 *
 * @returns {{ok:true, steps:object[], dropped:number, lost:number, expired:string, host:string,
 *            tabs:number}|{ok:false, error:string, steps:[]}}
 */
export async function stopRecording(runId, tabId) {
  const listed = await chrome.runtime.sendMessage({ kind: 'jobpilot:rec-tabs', runId });
  const tabIds = listed && listed.ok && listed.tabIds.length ? listed.tabIds : [tabId];
  const lost = new Set();
  // Every host the recording could legitimately have touched. The review modal warns about
  // a step whose host is not one of these, and without the FRAME hosts an embedded ATS form
  // — the normal case — would trip that warning on every single demonstration.
  const frameHosts = new Set();

  for (const id of tabIds) {
    try {
      for (const f of await listFrames(id)) {
        const h = frameHost(f);
        if (h && h !== 'unknown') frameHosts.add(h);
      }
    } catch { /* a closed tab contributes no hosts */ }
  }

  for (const id of tabIds) {
    // A tab the user closed mid-demonstration has nothing left to flush, and its steps are
    // already banked — losing it must not lose the whole recording. But execAllFrames folds
    // per-frame failures into its RETURN value rather than throwing, so a bare try/catch
    // would hide the one thing a failed flush actually costs: a field the user typed and
    // never blurred, which only record_stop commits.
    try {
      const { results, mainError, failures } = await execAllFrames(id, 'record_stop', {});
      if (mainError) console.debug('[jobpilot] tab', id, 'main frame did not flush:', mainError);
      for (const f of failures) console.debug('[jobpilot] a frame did not flush:', f.error);
      // A frame that is still alive can tell us how many of its posts the worker refused or
      // never answered. The worker catches the rest by finding gaps in each frame's step
      // sequence — between them, a step the user performed cannot vanish unremarked.
      for (const r of results) {
        try {
          for (const id of JSON.parse(r.text).unacked || []) lost.add(id);
        } catch { /* not our shape */ }
      }
    } catch (err) {
      console.debug('[jobpilot] could not reach tab', id, err);
    }
  }

  const closed = await chrome.runtime.sendMessage({ kind: 'jobpilot:rec-close', runId });
  if (!closed || !closed.ok) {
    return { ok: false, error: 'The recording could not be read back.', steps: [] };
  }
  return {
    ok: true,
    steps: Array.isArray(closed.steps) ? closed.steps : [],
    dropped: closed.dropped || 0,
    lost: new Set([...lost, ...(closed.lost || [])]).size,
    // Steps the worker saw and would not bank because they came from a tab outside the
    // session. Disjoint from `lost` by construction — the frame stops counting a step as
    // unacked once the worker tells it the step was refused rather than dropped.
    refused: closed.refused || 0,
    refusedHosts: Array.isArray(closed.refusedHosts) ? closed.refusedHosts : [],
    expired: closed.expired || '',
    host: closed.host || '',
    frameHosts: [...frameHosts],
    tabs: tabIds.length,
  };
}

/**
 * Replay one step in the frame that owns it (CONTRACT-V6 §8).
 *
 * The frame the step was RECORDED in goes first. "Exactly one visible match wins" is an
 * honest rule inside a frame, but it has no cross-frame tie-breaker — so a step
 * demonstrated in an embedded ATS form could be satisfied by a lookalike in the outer page
 * (a generic name=, a coincidental label, a CSS path that happens to fit) and would report
 * success having filled something else entirely.
 *
 * Falling through to the remaining frames is safe *because our failures are honest*: a
 * locator miss means resolveLocators found nothing and touched nothing. Any OTHER failure
 * happened after we acted on the page, so it stops the step where it is.
 */
async function replayStep(tabId, step) {
  const frames = await listFrames(tabId);
  const home = step.host ? frames.filter((f) => frameHost(f) === step.host).map((f) => f.frameId) : [];
  const order = [...new Set([...home, 0, ...frames.map((f) => f.frameId)])];

  let first = null;
  for (const frameId of order) {
    if (frameId !== 0 && !(await pingFrame(tabId, frameId))) continue;
    const resp = await execInFrame(tabId, frameId, 'replay_step', { step });
    if (resp.ok) return resp;
    if (!first) first = resp;
    if (!/page has changed/i.test(resp.error || '')) return resp;
  }
  return first || { ok: false, error: 'No frame in this tab could run the step.' };
}

/** Profile keys a recorded value may bind to (CONTRACT-V6 §4). Never judgment fields. */
// The employment fields belong here for the same reason the contact ones do: a
// demonstration that types "Senior Software Engineer" into a job-title box should replay
// as "whatever the profile says today", not as the title the user held when they recorded
// it. resumeText is deliberately absent — nobody types a whole resume into one field, and
// a paragraph-length binding would match by accident.
const BINDABLE = [
  'fullName', 'email', 'phone', 'location', 'linkedin', 'github', 'portfolio',
  'addressLine1', 'city', 'state', 'postalCode', 'country',
  'currentTitle', 'currentCompany',
];

/**
 * Bind literal values to the profile at RECORD time, so a macro stays correct when the
 * profile changes and the user's address does not sit in a blob we replay elsewhere.
 */
export async function bindStepsToProfile(steps) {
  const profile = await getProfile();
  const bindings = BINDABLE
    .map((key) => ({ key, value: String(profile[key] || '').trim() }))
    .filter((b) => b.value.length >= 4); // too-short values collide with real answers
  return steps.map((step) => {
    if (!step.value || step.action === 'request_secret') return step;
    const hit = bindings.find((b) => b.value.toLowerCase() === String(step.value).toLowerCase());
    if (!hit) return step;
    const { value, ...rest } = step;
    return { ...rest, valueFrom: `profile.${hit.key}` };
  });
}

/**
 * Replay a macro, step by step, stopping at the FIRST failure (CONTRACT-V6 §5.2).
 * A macro that half-works is worse than none: the agent must be told exactly which
 * step broke so it can ask for a fresh demonstration rather than carry on blind.
 *
 * @param {object} deps  {autoSubmit, onSecret} — onSecret(step, ref) collects a credential
 *                       through the vault and fills it; the value never comes back here.
 */
export async function runMacro(getTabId, macro, deps) {
  let tabId;
  try {
    tabId = await getTabId();
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    if (isRestrictedUrl(tab.url || tab.pendingUrl || '')) return { ok: false, error: RESTRICTED_ERROR };
  } catch {
    return { ok: false, error: 'The working tab was closed. Ask the user to open the job page again.' };
  }

  const profile = await getProfile();
  const done = [];

  for (let i = 0; i < macro.steps.length; i++) {
    const step = macro.steps[i];
    const where = `step ${i + 1}/${macro.steps.length} (${step.label || step.action})`;

    // §5.3: a demonstration is not standing consent to auto-submit.
    if (step.irreversible && !deps.autoSubmit) {
      // `byDesign` — the macro did exactly what it was built to do. Marking it broken here
      // would retire a working demonstration for the crime of respecting a setting, and no
      // amount of re-recording would help: the next run would stop in the same place.
      return {
        ok: false,
        byDesign: true,
        stoppedAt: i,
        error: `Macro "${macro.name}" stopped before ${where}: that step submits the form, and Auto-submit is off. ` +
          `${done.length} earlier step${done.length === 1 ? '' : 's'} completed. Tell the user the form is ready and let them submit.`,
      };
    }

    // A credential step never carries a value — it re-collects through the vault.
    if (step.action === 'request_secret') {
      const res = await deps.onSecret(step);
      if (!res.ok) {
        return { ok: false, byDesign: true, stoppedAt: i, error: `Macro "${macro.name}" stopped at ${where}: ${res.error}` };
      }
      done.push(where);
      continue;
    }

    const value = step.valueFrom
      ? String(profile[step.valueFrom.replace(/^profile\./, '')] || '')
      : step.value;
    if (step.valueFrom && !value) {
      return {
        ok: false,
        stoppedAt: i,
        error: `Macro "${macro.name}" stopped at ${where}: it fills this field from ${step.valueFrom}, which is empty in the profile.`,
      };
    }

    const resp = await replayStep(tabId, { ...step, value });
    if (!resp.ok) {
      return { ok: false, stoppedAt: i, error: `Macro "${macro.name}" failed at ${where}: ${resp.error}` };
    }
    done.push(`${where}: ${resp.result}`);
  }

  // A step can succeed as a MESSAGE and fail as a FACT: toolFill and toolSelectOption
  // return ok:true carrying "…but the value did not stick". Summarising those as "replayed
  // all N steps" is the unearned success V3 §7.1 names, and it is worse than usual here
  // because the agent turns this verdict into markMacroResult(…, true) — enshrining a
  // macro that half-works as one that works.
  //
  // The phrase list must cover EVERY soft-failure wording a replayable tool can return,
  // not just toolFill's: choose_option says "may not have registered", set_checkbox says
  // "is still checked=" / "aria-checked is still" / "is covering it". Each of those
  // slipping through turned a half-broken macro into one marked good forever.
  const shaky = done.filter((d) =>
    /did not stick|did not register|may not have registered|is still checked=|aria-checked is still|is covering it/i.test(d));
  if (shaky.length) {
    // No `byDesign`: unlike the auto-submit stop, this macro really is degraded, and the
    // caller marking it broken is the correct outcome.
    return {
      ok: false,
      error: `Macro "${macro.name}" ran all ${macro.steps.length} steps, but ${shaky.length} of them ` +
        `did NOT take effect on the page:\n${shaky.join('\n')}\n\nCall read_page and fix those fields yourself.`,
    };
  }
  return { ok: true, result: `Macro "${macro.name}" replayed all ${macro.steps.length} steps.\n${done.join('\n')}` };
}

export async function fillSecret(getTabId, ref, value, signal, expectHost) {
  let tabId;
  try {
    tabId = await getTabId();
  } catch {
    return { ok: false, error: 'Could not resolve the working tab. Ask the user to open the job page again.' };
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (isRestrictedUrl(tab.url || tab.pendingUrl || '')) {
      return { ok: false, error: RESTRICTED_ERROR };
    }
  } catch {
    return { ok: false, error: 'The working tab was closed. Ask the user to open the job page again.' };
  }

  const { frameId, ref: bare } = parseRef(ref);
  if (!/^e\d+$/.test(bare)) {
    return { ok: false, error: `"${ref}" is not a valid ref. Call read_page and use a ref like e3 or f381:e3.` };
  }

  // Re-resolve the destination frame's origin at fill time. This both blocks the
  // cross-origin-iframe exfiltration above and closes the gap between collecting
  // the secret and typing it (the frame may have navigated in between).
  let destHost = '';
  try { destHost = await frameHostFor(tabId, frameId); } catch { destHost = ''; }
  if (!expectHost || !destHost || destHost !== expectHost) {
    return {
      ok: false,
      error: `Refused: ${ref} is on ${destHost || 'an origin that could not be resolved'}, but the credential belongs to ${expectHost || 'an unknown origin'}. Credentials are only ever typed into the origin they belong to. Call read_page and target the field on the real login form.`,
    };
  }

  try {
    const resp = await sendToFrame(tabId, frameId, {
      kind: 'jobpilot:exec', tool: 'fill', args: { ref: bare, value, secret: true },
    });
    if (!resp || typeof resp.ok !== 'boolean') {
      return { ok: false, error: 'Content script gave no response. Reload the page and try again.' };
    }
    if (!resp.ok) {
      // Do NOT forward resp.error verbatim — a content-script error could echo
      // the value. Return a fixed, value-free message instead.
      return { ok: false, error: `Could not fill the credential into ${bare}. Call read_page and confirm the ref is a credential field.` };
    }
    // resp.result is "Filled (hidden) into eN." — value-free by construction.
    return { ok: true, result: String(resp.result || `Filled (hidden) into ${bare}.`) };
  } catch {
    // No err.message — it could embed the secret.
    return { ok: false, error: 'Could not reach the page to fill the credential. Reload the tab and try again.' };
  }
}

// -------------------------------------------- "controlled by JobPilot" indicator
//
// The panel tells the WORKER which tab it is driving, and the worker paints it. It does not
// message the tab itself, for the reason the recorder does not either: the agent navigates,
// and the page the panel spoke to is gone a step later. The worker holds the session so the
// page that REPLACES it can ask on load and come back showing the indicator.
//
// Both of these are fire-and-forget. The indicator is a courtesy to the user, and a run
// must never fail because a courtesy could not be delivered — the page takes it down by
// itself if the beats stop, so a dropped message costs at most a late disappearance.

/**
 * "I am driving this tab, and this is what I am doing." Called on a timer while a run is
 * live, so it is the heartbeat as well: the worker's session, and the indicator in the
 * page, both expire when these stop arriving.
 *
 * @param {string} runId  which run is driving — the worker keys its sessions by this
 * @param {number} tabId
 * @param {'acting'|'watching'} mode  'watching' is request_demo — the user is driving and
 *                                    we are recording, which the page must not call control
 * @param {string} status  the current step, as the activity card words it
 */
/**
 * The mechanical half of request_captcha: bring the run's tab to the FRONT (the one time
 * a run may steal focus — the user has to interact with the page and was just told so),
 * then have every frame point at its challenge. Returns what was found, for the dialog.
 */
export async function showCaptchaInTab(getTabId) {
  let tabId;
  try {
    tabId = await getTabId();
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
  try {
    const tab = await chrome.tabs.get(tabId);
    await chrome.tabs.update(tabId, { active: true });
    if (typeof tab.windowId === 'number' && chrome.windows && chrome.windows.update) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    }
  } catch { /* focusing is a courtesy; the dialog still says which page */ }
  // execAllFrames yields {frame, text} for each frame that had something to say.
  const { results } = await execAllFrames(tabId, 'show_captcha', {});
  const shown = results.find((r) => /highlighted/.test(r.text || ''));
  if (shown) return { ok: true, found: shown.text };
  if (results.length) return { ok: true, found: results[0].text }; // an invisible kind, described
  return { ok: true, found: '' }; // nothing detected — the dialog still asks, honestly
}

export function showControl(runId, tabId, mode, status) {
  return chrome.runtime
    .sendMessage({ kind: 'jobpilot:ctrl-on', runId, tabId, mode, status })
    .catch(() => {});
}

/**
 * This run is over.
 *
 * A runId, deliberately, and NOT a tab id. The worker knows which tab this run last
 * painted, and a tab id from here would be the stale one whenever the run re-targeted —
 * that is why this took no argument at all when there was a single session. But "no
 * argument" stopped being right the moment two runs could end at different times: it
 * cleared the one session, so the first application to finish took the indicator down off
 * every other tab still being filled. The runId keeps the original property (the worker
 * resolves the tab) while naming whose indicator to drop.
 */
export function hideControl(runId) {
  return chrome.runtime.sendMessage({ kind: 'jobpilot:ctrl-off', runId }).catch(() => {});
}

/** §5.2 — Hostname of the working tab's top frame, `www.` stripped. '' if unresolvable. */
export async function getTabHost(getTabId) {
  return frameHostFor(await getTabId(), 0);
}

/**
 * Hostname of the frame a ref actually lives in. A credential must be looked up
 * and typed under THIS host, not the top frame's — an embedded cross-origin
 * iframe must never receive the top page's password.
 */
export async function getRefHost(getTabId, ref) {
  const tabId = await getTabId();
  return frameHostFor(tabId, parseRef(ref).frameId);
}

/** Origin host of one frame (frameId 0 = top). '' when it cannot be resolved. */
async function frameHostFor(tabId, frameId) {
  let url = '';
  if (!frameId) {
    const tab = await chrome.tabs.get(tabId);
    url = tab.url || tab.pendingUrl || '';
  } else {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId });
    url = (frame && frame.url) || '';
  }
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** Short human label for the activity row, e.g. `fill "First Name"`. */
export function toolLabel(name, args) {
  args = args && typeof args === 'object' ? args : {};
  switch (name) {
    case 'read_page':
      if (args.mode === 'text') return 'read_page (text)';
      if (args.mode === 'changes') return 'read_page (what changed)';
      if (args.within) return `read_page inside ${args.within}`;
      return 'read_page';
    case 'find': return `find ${truncate(args.text, 34)}${args.role && args.role !== 'any' ? ` (${args.role})` : ''}`;
    // Safe to echo args.value here: after the §5.4 guard a `fill` can no longer
    // carry a secret (executeTool strips the flag, and the content script
    // rejects a non-secret fill on a credential field). Secrets flow through
    // request_secret/fillSecret, never through fill.
    case 'fill': return `fill ${args.ref || ''} = ${truncate(args.value, 30)}`;
    case 'select_option': return `select ${args.ref || ''} → ${truncate(args.option, 30)}`;
    case 'choose_option': return `choose ${args.ref || ''} → ${truncate(args.option, 30)}`;
    case 'click': return `click ${args.ref || ''}`;
    case 'set_checkbox': return `checkbox ${args.ref || ''} → ${args.checked}`;
    case 'upload_file': return `upload_file → ${args.ref || ''}`;
    case 'read_errors': return 'read_errors';
    case 'autofill': return 'autofill contact fields';
    case 'inspect_dom': return `inspect DOM ${truncate(args.ref || args.selector, 40)}`;
    case 'dom_act': {
      const ops = Array.isArray(args.actions)
        ? args.actions.map((a) => (a && a.op ? String(a.op) : '?')).slice(0, 4).join(' → ')
        : '';
      const more = Array.isArray(args.actions) && args.actions.length > 4 ? ' →…' : '';
      return `dom_act: ${ops || 'no actions'}${more}`;
    }
    case 'navigate': return `navigate → ${truncate(args.url, 50)}`;
    case 'wait': return args.until_text ? `wait for "${truncate(args.until_text, 30)}"` : `wait ${args.seconds}s`;
    case 'ask_user': return 'ask user';
    // §5 — label the credential kind + target ref, NEVER a value.
    case 'request_secret': return `provide ${args.kind || 'secret'} → ${args.ref || ''}`;
    case 'propose_plan': return planLabel(args);
    case 'confirm_submit': return `confirm submit → ${truncate(args.label || args.ref, 30)}`;
    case 'remember': return `remember → ${args.platform || 'this portal'}`;
    case 'request_demo': return `ask the user to demonstrate: ${truncate(args.goal, 40)}`;
    case 'request_captcha': return `captcha → waiting for you${args.reason ? ` (${truncate(args.reason, 36)})` : ''}`;
    case 'run_macro': return `run macro "${truncate(args.name, 30)}"`;
    case 'done': return `done (${args.status || '?'})`;
    default: return name;
  }
}

function truncate(v, n) {
  const s = String(v ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
