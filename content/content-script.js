/**
 * JobPilot content script — executes in-page tools for the side-panel agent.
 * One self-contained IIFE; pollutes nothing beyond window.__jobpilotInjected.
 * Protocol + tool semantics: CONTRACT.md §3, §4, §5.1.
 */
(() => {
  'use strict';

  if (window.__jobpilotInjected) return;
  window.__jobpilotInjected = true;

  /** ref ("e12") → Element. Rebuilt from scratch on every read_page (contract §4). */
  let refMap = new Map();
  // Reverse of refMap (CONTRACT-V8 §1). A WeakMap so a detached element does not
  // outlive the page, and rebuilt with refMap on every full read.
  let refByEl = new WeakMap();
  // The last FULL inventory in this frame — the baseline read_page mode:"changes"
  // diffs against (V8 §3.3). Only a full read may set it.
  let lastInventory = null;

  const READ_CAP = 8000;
  const TEXT_CAP = 6000;
  const TRUNC_MARK = '…[truncated]';
  // Workday styles with emotion hashes (class="css-1ud5i8o"), so [class*=error]
  // never matches it — its validation text is only findable by automation id.
  const ERROR_SELECTOR =
    '[class*=error i], [role=alert], [data-automation-id="errorMessage"], [data-automation-id="errorBanner"]';

  // ------------------------------------------------------ credential guard
  // CONTRACT-V2 §5.4/§5.5. A credential value must never reach the snapshot,
  // an error string, or read_page text — the model must be structurally unable
  // to read or type one.

  /**
   * Names/ids/autocomplete tokens that mark a field as credential-bearing.
   * Substring match (not whole-string). Kept security-context-specific so the
   * common address footguns ("zipcode", "postal_code", "area code", "promo
   * code", CSRF "token") are NOT swept up — over-routing those to
   * request_secret would break ordinary form-filling.
   */
  // Security questions are named as secrets by CONTRACT-V2 §0 and were missing here, so a
  // pre-populated "mother's maiden name" came back verbatim in a read_page snapshot. The
  // patterns stay narrow for the same reason as the rest of this list: they name the
  // security context explicitly, so "question" or "answer" alone never matches.
  const CRED_TOKENS =
    /(one-?time|onetime|otp|otc|passcode|pass-?code|totp|\bmfa\b|\b2fa\b|verification|securitycode|security-code|auth-?code|access-?code|sms-?code|email-?code|confirmation-?code|passphrase|\bpin\b|\bpwd\b|password|current-password|new-password|security[\s_-]*(?:question|answer)|secret[\s_-]*(?:question|answer)|challenge[\s_-]*(?:question|answer)|mother'?s?[\s_-]*maiden|maiden[\s_-]*name)/i;

  /** True if el's name/id/autocomplete looks credential-bearing (any element). */
  function credentialAttrs(el) {
    if (!el || !el.getAttribute) return false;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/one-time-code|current-password|new-password/.test(ac)) return true;
    const name = el.getAttribute('name') || '';
    const id = el.id || '';
    return CRED_TOKENS.test(`${name} ${id}`);
  }

  /** §5.4 credential-field test used by the fill guard (inputs only). */
  function isCredentialField(el) {
    if (!(el instanceof HTMLInputElement)) return false;
    if (el.type === 'password') return true;
    return credentialAttrs(el);
  }

  /** Elements that have ever received a secret fill in this frame. Sticky —
   * even if the field's attributes would not flag it, its value stays hidden. */
  const secretFilledEls = new WeakSet();

  /** Raw secret values seen in this frame, kept ONLY to redact any page echo
   * (validation text / page text) of the same string. Never emitted anywhere.
   * The value already lives in the DOM's input.value, so this adds no exposure
   * beyond it. */
  const secretValues = new Set();

  /** True if el's value/text must be hidden from every snapshot emit site. */
  function isSecretEl(el) {
    return secretFilledEls.has(el) || isCredentialField(el) || credentialAttrs(el);
  }

  /** Replace any known secret substring with "(hidden)" in free text. */
  function redactSecrets(text) {
    if (!text || !secretValues.size) return text;
    let out = String(text);
    for (const v of secretValues) {
      if (v && v.length >= 3) out = out.split(v).join('(hidden)');
    }
    return out;
  }

  // ---------------------------------------------------------------- helpers

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function collapseWs(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  function truncate(s, max) {
    s = String(s == null ? '' : s);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  /** Quote a string for the LLM-facing inventory: q('a "b"') → '"a \"b\""'. */
  function q(s) {
    return JSON.stringify(String(s == null ? '' : s));
  }

  /** Hard-cap a result string, ending with the truncation marker. */
  function capString(s, max) {
    return s.length > max ? s.slice(0, max - TRUNC_MARK.length) + TRUNC_MARK : s;
  }

  function isFileInput(el) {
    return el instanceof HTMLInputElement && el.type === 'file';
  }

  // ------------------------------------------------------------ shadow DOM
  // CONTRACT-V7 §7. `document.querySelectorAll` does not cross a shadow boundary,
  // and a portal built out of web components (Salesforce/LWC, Vaadin, Phenom) puts
  // its entire form inside one. Without this, read_page reported an almost empty
  // page and the agent concluded the site was broken — a blind spot that looks
  // exactly like a page with nothing on it.
  //
  // CLOSED roots stay invisible: nothing can reach them, including us. That is not
  // a gap we can close, so where it matters we say so rather than implying we
  // looked everywhere.

  const MAX_SHADOW_ROOTS = 300;

  /** The Document or ShadowRoot an element lives in — where ITS ids and labels resolve. */
  function rootOf(el) {
    try {
      const root = el && el.getRootNode ? el.getRootNode() : document;
      return (root instanceof Document || root instanceof ShadowRoot) ? root : document;
    } catch {
      return document;
    }
  }

  /** Every OPEN shadow root reachable from `base`, breadth-first and capped. */
  function shadowRoots(base) {
    const out = [];
    const queue = [base];
    while (queue.length && out.length < MAX_SHADOW_ROOTS) {
      const node = queue.shift();
      let els;
      try { els = node.querySelectorAll('*'); } catch { continue; }
      for (const el of els) {
        if (el.shadowRoot) {
          out.push(el.shadowRoot);
          queue.push(el.shadowRoot);
        }
      }
    }
    return out;
  }

  /**
   * querySelectorAll that crosses open shadow boundaries. The first call is NOT
   * wrapped: an invalid selector must still throw, because callers report that to
   * the model as a different failure from "nothing matched".
   */
  function deepQueryAll(selector, base) {
    const root = base || document;
    const out = Array.from(root.querySelectorAll(selector));
    for (const shadow of shadowRoots(root)) {
      try { out.push(...shadow.querySelectorAll(selector)); } catch { /* per-root failure is not fatal */ }
    }
    return out;
  }

  /** An id lookup that tries the element's OWN root first — ids are root-scoped. */
  function deepGetElementById(id, from) {
    if (!id) return null;
    try {
      const local = rootOf(from || document).getElementById(id);
      if (local) return local;
    } catch { /* fall through to the deep search */ }
    let escaped;
    try { escaped = `#${CSS.escape(id)}`; } catch { return null; }
    try { return deepQueryAll(escaped, document)[0] || null; } catch { return null; }
  }

  /** True when this frame contains any open shadow root — used to qualify what we report. */
  function hasShadowContent() {
    try { return shadowRoots(document).length > 0; } catch { return false; }
  }

  /**
   * Visibility rule (contract §5.1.1): skip offsetParent===null elements,
   * EXCEPT file inputs (hidden behind styled buttons is the norm) and
   * position:fixed elements (offsetParent is null for those by spec).
   */
  /** SAP UI5's sap.m.Switch — a visibly rendered, user-clickable toggle DIV. */
  function isUi5Switch(el) {
    return el instanceof Element && el.classList.contains('sapMSwt');
  }

  /** Its checked state lives in a class, not in aria-checked (which it does not carry). */
  function ui5SwitchOn(el) {
    return el.classList.contains('sapMSwtOn');
  }

  function isVisible(el) {
    if (!(el instanceof Element)) return false;
    if (isFileInput(el)) return true;
    if (el === document.body || el === document.documentElement) return true;
    // aria-hidden subtrees used to be dropped outright — "a legitimate form control is
    // never aria-hidden", and honeypots love that wrapper. Two shipping ATS stacks then
    // falsified the rule in one week: SAP UI5 renders its consent switch aria-hidden
    // (SuccessFactors EasyApply), and P&I LOGA marks its ENTIRE form table aria-hidden —
    // every field of a real application, invisible to read_page, on a portal half of
    // German public-sector hiring runs on.
    //
    // The honest principle: a honeypot works by being invisible to REAL USERS. An element
    // that is visibly painted, at real size, on the page, is seen and operated by humans
    // no matter what its ARIA says — it cannot be a trap. So aria-hidden elements pass
    // exactly when they are actually painted; the unpainted ones remain the traps they
    // look like. Painted-but-aria-hidden controls are FLAGGED in the inventory (see the
    // describe call sites), so a model can still honor a field whose label says
    // "leave this blank".
    if (el.closest('[aria-hidden="true"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 8 || r.height < 8) return false; // painted to nothing — a trap
      if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return false; // parked off-page
      try {
        if (getComputedStyle(el).visibility === 'hidden') return false;
      } catch {
        return false;
      }
    }
    if (isHoneypotSized(el)) return false;
    if (el.offsetParent !== null) return true;
    try {
      const cs = getComputedStyle(el);
      return cs.position === 'fixed' && cs.display !== 'none' && cs.visibility !== 'hidden';
    } catch {
      return false;
    }
  }

  /**
   * Off-screen / clipped-to-nothing TEXT fields are honeypots (bots that fill
   * them get silently spam-binned). Only text-entry controls are candidates:
   * visually-hidden native radios/checkboxes (the sr-only styling pattern)
   * are legitimate controls and must stay reported.
   */
  function isHoneypotSized(el) {
    const textLike =
      (el instanceof HTMLInputElement &&
        !/^(radio|checkbox|file|submit|button|image|reset|hidden)$/.test(el.type)) ||
      el instanceof HTMLTextAreaElement;
    if (!textLike) return false;
    // Document coordinates: rect is viewport-relative, and a legitimate field
    // scrolled above the viewport must not read as off-page.
    const r = el.getBoundingClientRect();
    if (r.right + window.scrollX <= 0 || r.bottom + window.scrollY <= 0) return true; // parked past the document's top/left edge
    if (r.width <= 1 && r.height <= 1) return true; // clipped to nothing
    return false;
  }

  // ---------------------------------------------------------- label lookup

  /** Text of a <label>, minus any embedded controls (a wrapping label may contain a <select> full of options). */
  function labelNodeText(lab) {
    const clone = lab.cloneNode(true);
    for (const junk of clone.querySelectorAll('select, option, input, textarea, button, script, style')) {
      junk.remove();
    }
    return collapseWs(clone.textContent);
  }

  /** <label for=…> or wrapping <label> text. */
  function explicitLabelText(el) {
    if (el.id) {
      try {
        const lab = rootOf(el).querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lab) {
          const t = labelNodeText(lab);
          if (t) return t;
        }
      } catch {
        /* unmatchable id — fall through */
      }
    }
    const wrap = el.closest('label');
    if (wrap) {
      const t = labelNodeText(wrap);
      if (t) return t;
    }
    return '';
  }

  function ariaLabelledByText(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    const parts = [];
    for (const id of ids) {
      const node = deepGetElementById(id, el);
      if (node) {
        const t = collapseWs(node.textContent);
        if (t) parts.push(t);
      }
    }
    return collapseWs(parts.join(' '));
  }

  /**
   * Nearest preceding text/heading (≤60 chars) — last-resort label. Walks
   * previous siblings, then up to 4 ancestor levels.
   */
  function precedingText(el) {
    let node = el;
    for (let depth = 0; depth < 4 && node && node.parentElement; depth++) {
      let sib = node.previousSibling;
      let hops = 0;
      while (sib && hops < 8) {
        let text = '';
        if (sib.nodeType === Node.TEXT_NODE) {
          text = collapseWs(sib.textContent);
        } else if (sib instanceof Element && isVisible(sib)) {
          text = collapseWs(sib.textContent);
        }
        // Pure punctuation is a SEPARATOR, not a label. Table-layout forms (P&I LOGA)
        // put ":" in its own cell between the label cell and the field — returning it
        // here named every field ":" and hid the real label one hop further back.
        if (/^[:\-–—*·.\s]+$/.test(text)) text = '';
        if (text) {
          if (text.length <= 60) return text;
          const heading = sib instanceof Element && (/^H[1-6]$/.test(sib.tagName) || sib.matches('[role=heading]'));
          if (heading) return truncate(text, 60);
          break; // a long non-heading block precedes the field — not a label; try one level up
        }
        sib = sib.previousSibling;
        hops++;
      }
      node = node.parentElement;
    }
    return '';
  }

  /**
   * A CONTAINER's own name — its legend or heading, then aria-label.
   *
   * Deliberately NOT labelFor(): that ends at precedingText(), which for a <fieldset>
   * returns the text of the section BEFORE it. A scope header named after the wrong
   * section is worse than an unnamed one — it tells the model it is looking at
   * something it is not (CONTRACT-V8 §3.1).
   */
  function containerLabel(el) {
    if (!(el instanceof Element)) return '';
    let own = null;
    try { own = el.querySelector(':scope > legend, :scope > h1, :scope > h2, :scope > h3'); } catch { own = null; }
    if (!own) {
      try { own = el.querySelector('legend, h1, h2, h3'); } catch { own = null; }
    }
    const t = own ? collapseWs(own.textContent) : '';
    if (t) return truncate(t, 80);
    const aria = collapseWs(el.getAttribute('aria-label')) || ariaLabelledByText(el);
    return aria ? truncate(aria, 80) : '';
  }

  /** Contract label priority: label[for]/wrapping → aria-label → aria-labelledby → placeholder → preceding text. */
  function labelFor(el) {
    const explicit = explicitLabelText(el);
    if (explicit) return truncate(explicit, 80);
    const aria = collapseWs(el.getAttribute('aria-label'));
    if (aria) return truncate(aria, 80);
    const by = ariaLabelledByText(el);
    if (by) return truncate(by, 80);
    const ph = collapseWs(el.getAttribute('placeholder'));
    if (ph) return truncate(ph, 80);
    const prev = precedingText(el);
    if (prev) return truncate(prev, 80);
    return '';
  }

  /** Visible name for buttons/links: textContent → value → aria-label → title. */
  function buttonName(el) {
    // §5.5 (threat model P1): the secret check comes FIRST, unconditionally. A void <input>
    // has no textContent, so putting it after the textContent branch happened to be safe —
    // but only by luck of the call graph. A contenteditable used as a password box has its
    // secret sitting right there in textContent, and one edit to a selector list elsewhere
    // is all it takes to reach this with one. isSecretEl, not isCredentialField: a field
    // that received a secret fill stays hidden even when its attributes never looked
    // credential-ish.
    if (isSecretEl(el)) return '(credential field)';
    const own = collapseWs(el.textContent);
    if (own) return truncate(own, 80);
    if (el instanceof HTMLInputElement && el.value) return truncate(collapseWs(el.value), 80);
    const aria = collapseWs(el.getAttribute('aria-label'));
    if (aria) return truncate(aria, 80);
    const title = collapseWs(el.getAttribute('title'));
    if (title) return truncate(title, 80);
    return '(unnamed)';
  }

  /** Per-option label for a radio: its own label / aria-label / value. */
  function radioOptionLabel(radio) {
    const own = explicitLabelText(radio) || collapseWs(radio.getAttribute('aria-label'));
    return truncate(own || radio.value || '(unlabeled)', 60);
  }

  // ---------------------------------------------------------- error lookup

  /** All currently-visible validation/alert text (innermost matches, deduped). */
  function collectErrorTexts() {
    const texts = [];
    const seen = new Set();
    const push = (t) => {
      t = redactSecrets(collapseWs(t)); // §5.5: strip any echoed secret before it reaches the model
      if (!t) return;
      t = truncate(t, 300); // long consolidated banners still count — truncate, never drop
      const key = t.toLowerCase();
      if (seen.has(key) || texts.length >= 25) return;
      seen.add(key);
      texts.push(t);
    };
    for (const el of deepQueryAll(ERROR_SELECTOR)) {
      if (!isVisible(el)) continue;
      if (el.querySelector(ERROR_SELECTOR)) continue; // keep innermost only
      push(el.textContent);
    }
    for (const el of deepQueryAll('[aria-invalid=true]')) {
      if (!isVisible(el)) continue;
      const label = labelFor(el) || el.getAttribute('name') || el.id || el.tagName.toLowerCase();
      let msg = `Field ${q(label)} is marked invalid`;
      const described = (el.getAttribute('aria-describedby') || '')
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => {
          const node = deepGetElementById(id, el);
          return node ? collapseWs(node.textContent) : '';
        })
        .filter(Boolean)
        .join(' ');
      if (described) msg += `: ${described}`;
      push(msg);
    }
    return texts;
  }

  // ------------------------------------------------------------------ CAPTCHA
  // Ported from ApplyPilot's detect script (the reference implementation this borrows
  // its detection order from). Order matters: hCaptcha containers also carry
  // data-sitekey, so hCaptcha must be tested BEFORE reCAPTCHA or it is misreported.
  //
  // The agent never solves one — this exists so a captcha is REPORTED instead of the
  // form reading as one that silently refuses to submit. The invisible kinds
  // (reCAPTCHA v3, Turnstile) show no widget at all and block submissions with no
  // error text, which the model would otherwise diagnose as anything but a captcha.

  /**
   * @returns {{desc: string, visible: boolean, el: Element|null}|null} what is on this
   * page, if anything. `el` is the visible widget itself — show_captcha scrolls to and
   * spotlights it; the text-building consumers ignore it.
   */
  function detectCaptcha() {
    const firstVisible = (els) => els.find((el) => isVisible(el)) || null;
    const found = (name, els, invisibleNote) => {
      const el = firstVisible(els);
      return {
        desc: el ? name : `${name} (no visible widget${invisibleNote ? ` — ${invisibleNote}` : ''})`,
        visible: el != null,
        el,
      };
    };

    const hc = deepQueryAll('.h-captcha, [data-hcaptcha-sitekey], iframe[src*="hcaptcha.com"]');
    if (hc.length) return found('hCaptcha', hc);
    // FriendlyCaptcha — the SAP EasyApply portals ship it (measured on a live one).
    const fr = deepQueryAll('.frc-captcha, iframe[src*="friendlycaptcha"]');
    if (fr.length) return found('FriendlyCaptcha', fr);
    const ts = deepQueryAll('.cf-turnstile, [data-turnstile-sitekey], iframe[src*="challenges.cloudflare.com"]');
    if (ts.length) return found('Cloudflare Turnstile', ts, 'it can block a submit with no error shown');
    const fc = deepQueryAll('#FunCaptcha, [data-pkey], iframe[src*="arkoselabs"]');
    if (fc.length) return found('FunCaptcha (Arkose)', fc);
    // The v3 badge (bottom-corner "protected by reCAPTCHA") is an iframe matching
    // src*="recaptcha" and it IS visible — but it is telemetry, not a challenge, and
    // calling it a solvable captcha sends the model to ask the user to "solve" a widget
    // that requires no action. Exclude it here; its presence is classified as invisible
    // v3 below, which is what it actually means.
    const rc = deepQueryAll('.g-recaptcha, iframe[src*="recaptcha"]')
      .filter((el) => !(el.closest && el.closest('.grecaptcha-badge')));
    if (rc.length) return found('reCAPTCHA', rc);
    if (deepQueryAll('.grecaptcha-badge').length) {
      return { desc: 'reCAPTCHA v3 (invisible — it can block a submit with no error shown)', visible: false, el: null };
    }
    // reCAPTCHA v3 loads as a script with a render= key and never shows a widget.
    for (const s of document.querySelectorAll('script[src*="recaptcha"][src*="render="]')) {
      const m = /[?&]render=([^&]+)/.exec(s.src || '');
      if (m && m[1] !== 'explicit') {
        return { desc: 'reCAPTCHA v3 (invisible — it can block a submit with no error shown)', visible: false, el: null };
      }
    }
    return null;
  }

  /**
   * show_captcha — point the USER at the challenge. Called (in every frame) when the
   * agent hands a captcha over: scrolls the widget to center and spotlights it for a few
   * seconds, so the person arriving from the side panel does not have to hunt the page
   * for a small checkbox. Read-only as far as the page is concerned — the outline is
   * inline style, restored on a timer, and never part of what read_page reports.
   */
  function toolShowCaptcha() {
    const captcha = detectCaptcha();
    // A frame with no captcha throws — like every other tool impl, the message listener
    // turns it into {ok:false}; execAllFrames treats subframe misses as the normal case.
    if (!captcha) throw new Error('No captcha in this frame.');
    if (!captcha.el) {
      return `${captcha.desc}. Nothing to click here — an invisible check verifies on its own; ` +
        'the user only needs to retry the action that was blocked.';
    }
    const el = captcha.el;
    try { el.scrollIntoView({ block: 'center' }); } catch { /* detached mid-flight */ }
    const prevOutline = el.style.outline;
    const prevOffset = el.style.outlineOffset;
    el.style.outline = '3px solid #e0a03a';
    el.style.outlineOffset = '3px';
    setTimeout(() => {
      try { el.style.outline = prevOutline; el.style.outlineOffset = prevOffset; } catch { /* gone */ }
    }, 8000);
    return `${captcha.desc} is on screen and highlighted.`;
  }

  /** Visible error text in/around a field (its container, up to 3 ancestor levels). */
  function nearbyErrorTexts(el) {
    const texts = new Set();
    let node = el;
    for (let depth = 0; depth < 3 && node && node !== document.body; depth++) {
      for (const err of node.querySelectorAll(ERROR_SELECTOR)) {
        if (!isVisible(err)) continue;
        const t = redactSecrets(collapseWs(err.textContent));
        if (t && t.length <= 300) texts.add(t);
      }
      node = node.parentElement;
    }
    return texts;
  }

  // -------------------------------------------------------- Workday prompts
  // CONTRACT-V5 §1. Workday's two prompt widgets carry NONE of the ARIA the
  // generic dropdown code keys on — no role=combobox, no aria-haspopup on the
  // multiselect, no aria-controls anywhere. Verbatim from a live apply flow
  // (autodesk.wd1.myworkdayjobs.com, "My Information"):
  //
  //   <div data-automation-id="multiSelectContainer" data-uxi-widget-type="multiselect">
  //     <input placeholder="Search" autocomplete="off" id="source--source">   <-- looks like a text input
  //     <ul data-automation-id="selectedItemList">                            <-- the chosen values, as pills
  //       <div role="option" data-automation-id="selectedItem" title="Autodesk Careers">
  //         <p data-automation-id="promptOption" data-automation-label="Autodesk Careers">…
  //
  //   <button aria-haspopup="listbox" name="country" id="country--country">India</button>
  //   <input type="text" class="css-77hcv" value="c4f78be1…">                 <-- hidden value mirror
  //
  // Two consequences the rest of this file depends on:
  //   1. read_page must NOT present the multiselect input as a text field, or the
  //      model fills it, no value is ever selected, and Workday reports the field
  //      as empty — the failure the user hit.
  //   2. The pills are role=option too. Collecting them as "options" would make
  //      choose_option click a chip that is really a delete control.

  const WD_MULTISELECT = '[data-automation-id="multiSelectContainer"]';
  const WD_SELECTED_LIST = '[data-automation-id="selectedItemList"]';
  const WD_PILL = '[data-automation-id="selectedItem"]';

  /** The multiselect container this element belongs to, or null. */
  function wdPromptContainer(el) {
    return el && el.closest ? el.closest(WD_MULTISELECT) : null;
  }

  /** The "Search" input of a Workday multiselect — a dropdown wearing a text input's clothes. */
  function isWdPromptInput(el) {
    return el instanceof HTMLInputElement && Boolean(wdPromptContainer(el));
  }

  /** <button aria-haspopup="listbox"> — Workday's single-select prompt (also generic ARIA). */
  function isListboxButton(el) {
    return el instanceof HTMLButtonElement && (el.getAttribute('aria-haspopup') || '').toLowerCase() === 'listbox';
  }

  /**
   * The hidden text input Workday parks beside a prompt button to mirror the value id
   * (`<input type="text" class="css-77hcv" value="c4f78be1…">`). Identified by what it
   * LACKS — no name, no id, no label — rather than by sitting immediately after the
   * button: one validation icon rendered between the two would break an adjacency test
   * and leak an internal id to the model as a fillable field. A real form field always
   * carries at least one of those three.
   */
  function isPromptValueMirror(el) {
    if (!(el instanceof HTMLInputElement) || el.type !== 'text') return false;
    if (el.id || el.name || (el.labels && el.labels.length)) return false;
    if (el.getAttribute('aria-label') || el.getAttribute('placeholder')) return false;
    const parent = el.parentElement;
    return Boolean(parent && parent.querySelector('button[aria-haspopup="listbox"]'));
  }

  function isWdPrompt(el) {
    return isWdPromptInput(el) || isListboxButton(el);
  }

  /**
   * The values a prompt currently HOLDS, as a list — pill titles for a multiselect,
   * the button's own text otherwise. A list, not a joined string: a value may itself
   * contain a comma ("India (+91)" is tame, "Dallas, TX" is not), and every caller
   * here compares whole values, never substrings.
   */
  function wdPromptValues(el) {
    const container = wdPromptContainer(el);
    if (container) {
      return Array.from(container.querySelectorAll(WD_PILL))
        .map((p) => collapseWs(p.getAttribute('title')) || collapseWs(p.textContent))
        .filter(Boolean);
    }
    if (isListboxButton(el)) {
      const text = collapseWs(el.textContent);
      // An unset Workday prompt reads "Select One" — a placeholder, not a value.
      return /^select one$/i.test(text) || !text ? [] : [text];
    }
    return [];
  }

  /** wdPromptValues as one human-readable string, for display only. */
  function wdPromptValue(el) {
    return wdPromptValues(el).join(', ');
  }

  /** Does the prompt already hold this exact value? (Case-insensitive, whole-value.) */
  function wdHolds(el, value) {
    const v = value.toLowerCase();
    return wdPromptValues(el).some((held) => held.toLowerCase() === v);
  }

  // ------------------------------------------------------------------ refs

  /**
   * A ref for an element we resolved ourselves (macro replay, CONTRACT-V6 §5.2) rather
   * than one the model picked off a read_page. Numbered far above the read_page counter
   * so the two can never collide, and short-lived: the next read_page clears refMap.
   */
  let tempRefSeq = 90000;
  function assignTempRef(el) {
    // CONTRACT-V8 §1 — an element that already carries a valid ref KEEPS it. Minting a
    // second one and overwriting refByEl is a renumbering, and a renumbered ref is the
    // failure this whole section exists to prevent: the model's old ref still resolves,
    // to the right element, but the next `changes` report calls it by a different name and
    // reads as though the page swapped it. Callers that want a raw new ref do not exist.
    const existing = refByEl.get(el);
    if (existing && refMap.get(existing) === el) return existing;
    const ref = `e${++tempRefSeq}`;
    refMap.set(ref, el);
    refByEl.set(el, ref);
    return ref;
  }

  /**
   * CONTRACT-V8 §1 — the ref an element ALREADY has, or a fresh temp ref.
   *
   * Every partial view of the page (find, a scoped read, a changes diff) goes through
   * here, and the reason is the failure it prevents: if those renumbered, a ref the
   * model is still holding would point at a different element and would *still
   * resolve*. A stale ref throws; a renumbered one silently fills the wrong field.
   */
  function refFor(el) {
    const existing = refByEl.get(el);
    if (existing && refMap.get(existing) === el) return existing;
    return assignTempRef(el);
  }

  function resolveRef(ref) {
    if (typeof ref !== 'string' || !/^e\d+$/.test(ref)) {
      throw new Error(`Invalid ref ${q(ref)} — expected a bare ref like "e12" from the latest read_page.`);
    }
    const el = refMap.get(ref);
    if (!el || !el.isConnected) {
      throw new Error(`Stale ref ${ref} — the page changed. Call read_page again.`);
    }
    return el;
  }

  // ------------------------------------------------------------- read_page

  const DISCOVERY_SELECTOR = [
    'input',
    'textarea',
    'select',
    'button',
    'a[href]',
    '[role=button]',
    '[role=combobox]',
    '[role=listbox]',
    '[role=option]',
    '[role=checkbox]',
    '[role=radio]',
    // A proper ARIA switch is a checkbox in different clothes; it was simply missing.
    '[role=switch]',
    // SAP UI5's switch carries NO role at all (and is aria-hidden — see isVisible), so
    // only its class can find it. Framework-specific, like isWdPrompt above, and for the
    // same reason: without it the consent toggle gating a SuccessFactors submission does
    // not exist as far as read_page is concerned.
    '.sapMSwt',
    // P&I LOGA (pi-asp.de Bewerber-Web): every button — including "JETZT BEWERBEN",
    // the submit — is a role-less DIV with this class. Same precedent as .sapMSwt.
    '.LG-Button',
    '[role=textbox]',
    '[contenteditable=true]',
    '[contenteditable=""]',
    '[contenteditable=plaintext-only]',
  ].join(', ');

  const MAX_ELEMENT_LINES = 400;
  const MAX_LINKS = 60;

  function selectOptionsSummary(options, labelOf) {
    const shown = options.slice(0, 20).map((o) => q(truncate(labelOf(o), 40)));
    const extra = options.length > 20 ? `,…+${options.length - 20} more` : '';
    return `[${shown.join(',')}${extra}]`;
  }

  /** One line per radio name-group; per-option refs stay bracketed so the panel's [eN] frame rewrite catches them. */
  function describeRadioGroup(first, assign) {
    let radios;
    try {
      radios = Array.from(rootOf(first).querySelectorAll(`input[type=radio][name="${CSS.escape(first.name)}"]`))
        .filter((r) => r.form === first.form);
    } catch {
      radios = [first];
    }
    if (!radios.length) radios = [first];

    let groupLabel = '';
    const fieldset = first.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector('legend');
      if (legend) groupLabel = collapseWs(legend.textContent);
    }
    if (!groupLabel) {
      const rg = first.closest('[role=radiogroup]');
      if (rg) groupLabel = collapseWs(rg.getAttribute('aria-label')) || ariaLabelledByText(rg);
    }
    if (!groupLabel) groupLabel = precedingText(first);
    if (!groupLabel) groupLabel = first.name;

    // Every ref is minted ONCE, in option order. The group used to mint its own ref for
    // `first` and then mint a second one for the same element in the map below: refMap held
    // two refs for one radio, refByEl kept only the later, and the group ref silently
    // meant "the first option". Clicking [group] answered the question with its first
    // choice — a coin flip wearing a group handle (V6 §3.1) — and the leftover refByEl
    // entry made every radio group report as renumbered in the next `changes` read.
    const parts = radios.map((r) => `${q(radioOptionLabel(r))} [${assign(r)}]`);
    const checked = radios.find((r) => r.checked);
    // No ref of its own: a radio group is not something you can click. The options are the
    // handles, and naming them is the whole point of this line.
    let line = `radio group label=${q(truncate(groupLabel, 80))}`;
    if (radios.some((r) => r.required)) line += ' required';
    line += ` options=[${parts.join(',')}] value=${q(checked ? radioOptionLabel(checked) : '')}`;
    line += ' (pick one by its own ref)';
    return line;
  }

  /** Returns an inventory line for el, or null to skip it. */
  function describeElement(el, assign, seenRadioGroups) {
    if (!isVisible(el)) return null;
    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();

    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
      const key = `${el.form ? 'f' + Array.prototype.indexOf.call(document.forms, el.form) : 'doc'}::${el.name}`;
      if (seenRadioGroups.has(key)) return null;
      seenRadioGroups.add(key);
      return describeRadioGroup(el, assign);
    }

    if (el instanceof HTMLSelectElement) {
      const ref = assign(el);
      const labelOf = (o) => collapseWs(o.label || o.textContent) || o.value;
      const options = Array.from(el.options);
      const selected = el.selectedIndex >= 0 ? labelOf(el.options[el.selectedIndex]) : '';
      let line = `[${ref}] select label=${q(labelFor(el))}`;
      if (el.required) line += ' required';
      if (el.multiple) line += ' multiple';
      if (el.disabled) line += ' disabled';
      line += ` value=${q(selected)} options=${selectOptionsSummary(options, labelOf)}`;
      return line;
    }

    // Custom autocomplete comboboxes (often <input role=combobox>) — surface the role so the model clicks then re-reads.
    // §5.5: this branch runs BEFORE the input-type checks, so redact here too or
    // an input[role=combobox][type=password] would bypass password redaction.
    if (role === 'combobox') {
      const ref = assign(el);
      const expanded = el.getAttribute('aria-expanded') === 'true';
      const raw = el instanceof HTMLInputElement ? el.value : collapseWs(el.textContent);
      if (isSecretEl(el)) {
        let line = `[${ref}] combobox label=${q(labelFor(el))}`;
        if (raw) line += ` value=${q('(hidden)')}`;
        return `${line} expanded=${expanded} — use request_secret`;
      }
      return `[${ref}] combobox label=${q(labelFor(el))} value=${q(truncate(raw, 60))} expanded=${expanded}`;
    }

    // Workday prompts (CONTRACT-V5 §1). Reported as dropdowns even though the DOM
    // says "input"/"button", because that is what they ARE — describing the search
    // box as a text field is what makes the model fill it and lose the value.
    if (isPromptValueMirror(el)) return null; // internal id mirror — never the model's business
    if (isWdPrompt(el)) {
      const ref = assign(el);
      // §5.5: mask the VALUE, never drop the element. isSecretEl matches on bare
      // substrings ("verification" hits an id like "verificationMethod"), so a
      // dropped element here would leave a required field with no ref at all —
      // invisible to read_page, unreachable by every tool, and still failing
      // validation. Every other branch masks and keeps the ref; so does this one.
      const value = isSecretEl(el) ? '(hidden)' : wdPromptValue(el);
      let line = `[${ref}] dropdown label=${q(labelFor(el) || buttonName(el))}`;
      if (el.getAttribute('aria-required') === 'true' || el.required) line += ' required';
      // The hint is worded for any listbox widget: this branch also catches non-Workday
      // <button aria-haspopup=listbox> prompts, and calling those "Workday" would be a lie.
      line += ` value=${q(truncate(value, 60))} — use choose_option (typing into it selects nothing)`;
      return line;
    }

    if (el instanceof HTMLInputElement) {
      const type = el.type;
      if (type === 'hidden') return null;
      if (type === 'file') {
        const ref = assign(el);
        let line = `[${ref}] file input label=${q(labelFor(el))}`;
        if (el.required) line += ' required';
        const accept = el.getAttribute('accept');
        if (accept) line += ` accept=${q(accept)}`;
        const names = el.files && el.files.length ? Array.from(el.files).map((f) => f.name).join(', ') : '(empty)';
        line += ` value=${q(names)}`;
        return line;
      }
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') {
        const ref = assign(el);
        let line = `[${ref}] button ${q(buttonName(el))}`;
        if (el.disabled) line += ' disabled';
        return line;
      }
      if (type === 'checkbox') {
        const ref = assign(el);
        let line = `[${ref}] checkbox label=${q(labelFor(el))}`;
        if (el.required) line += ' required';
        line += ` checked=${el.checked}`;
        return line;
      }
      if (type === 'radio') {
        const ref = assign(el); // unnamed radio — no group to collapse into
        return `[${ref}] radio label=${q(radioOptionLabel(el))} checked=${el.checked}`;
      }
      const ref = assign(el);
      let line = `[${ref}] ${type} input label=${q(labelFor(el))}`;
      if (el.required) line += ' required';
      if (el.disabled) line += ' disabled';
      if (el.readOnly) line += ' readonly';
      if (isSecretEl(el)) {
        // §5.5 L1: never the real value; mark the field so the model reaches
        // for request_secret instead of fill.
        if (el.value) line += ` value=${q('(hidden)')}`; // omit value entirely when empty
        const ac = collapseWs(el.getAttribute('autocomplete'));
        if (ac) line += ` autocomplete=${ac}`;
        line += ' — use request_secret';
      } else {
        line += ` value=${q(truncate(el.value, 60))}`;
      }
      const maxlength = el.getAttribute('maxlength');
      if (maxlength) line += ` maxlength=${maxlength}`;
      return line;
    }

    if (el instanceof HTMLTextAreaElement) {
      const ref = assign(el);
      let line = `[${ref}] textarea label=${q(labelFor(el))}`;
      if (el.required) line += ' required';
      if (el.disabled) line += ' disabled';
      if (isSecretEl(el)) {
        if (el.value) line += ` value=${q('(hidden)')}`;
        line += ' — use request_secret';
      } else {
        line += ` value=${q(truncate(el.value, 60))}`;
      }
      const maxlength = el.getAttribute('maxlength');
      if (maxlength) line += ` maxlength=${maxlength}`;
      return line;
    }

    if (el instanceof HTMLButtonElement || role === 'button'
      || (el instanceof Element && el.classList.contains('LG-Button'))) {
      const ref = assign(el);
      let line = `[${ref}] button ${q(buttonName(el))}`;
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') line += ' disabled';
      return line;
    }

    if (tag === 'a') {
      const ref = assign(el);
      const href = el.getAttribute('href') || '';
      return `[${ref}] link ${q(buttonName(el))} href=${q(truncate(href, 100))}`;
    }

    if (role === 'listbox') {
      const ref = assign(el);
      return `[${ref}] listbox label=${q(labelFor(el))}`;
    }
    if (role === 'option') {
      const ref = assign(el);
      const selected = el.getAttribute('aria-selected') === 'true';
      return `[${ref}] option ${q(buttonName(el))} selected=${selected}`;
    }
    if (role === 'checkbox' || role === 'switch') {
      const ref = assign(el);
      return `[${ref}] checkbox label=${q(labelFor(el) || buttonName(el))} checked=${el.getAttribute('aria-checked') === 'true'}`;
    }
    if (isUi5Switch(el)) {
      const ref = assign(el);
      // No label plumbing at all on these — no <label for>, no aria. The id is often the
      // one descriptive string the page gives us ("privacy-switch"), so it is the fallback.
      const name = labelFor(el) || collapseWs(el.id) || buttonName(el);
      return `[${ref}] checkbox label=${q(name)} checked=${ui5SwitchOn(el)} (toggle switch — use set_checkbox)`;
    }
    if (role === 'radio') {
      const ref = assign(el);
      return `[${ref}] radio label=${q(labelFor(el) || buttonName(el))} checked=${el.getAttribute('aria-checked') === 'true'}`;
    }
    if (role === 'textbox' || el.hasAttribute('contenteditable')) {
      if (el.getAttribute('contenteditable') === 'false') return null;
      const ref = assign(el);
      // §5.5: a contenteditable is not an HTMLInputElement, so isCredentialField
      // is false — isSecretEl still catches secret-filled ones and any element
      // whose name/autocomplete looks credential-bearing.
      if (isSecretEl(el)) {
        const raw = collapseWs(el.textContent);
        let line = `[${ref}] editable text label=${q(labelFor(el))}`;
        if (raw) line += ` value=${q('(hidden)')}`;
        return `${line} — use request_secret`;
      }
      return `[${ref}] editable text label=${q(labelFor(el))} value=${q(truncate(collapseWs(el.textContent), 60))}`;
    }

    return null;
  }

  /**
   * Walk the inventory once and return one entry per described element.
   *
   * Factored out of readInteractive because CONTRACT-V8 needs the same walk three more
   * times — scoped, diffed, and searched — and a second implementation of "what counts
   * as an element and how is it described" would drift from this one within a release.
   *
   * @param {Element|Document} root
   * @param {(el: Element) => string} assign  ref allocator — §1 decides which one
   */
  function collectEntries(root, assign) {
    const entries = [];
    const seenRadioGroups = new Set();
    let linkCount = 0;
    let linksSkipped = 0;

    const candidates = deepQueryAll(DISCOVERY_SELECTOR, root);
    // querySelectorAll never returns the root itself, and a scoped read aimed straight
    // at a control would otherwise come back empty.
    if (root instanceof Element && root.matches(DISCOVERY_SELECTOR)) candidates.unshift(root);

    for (const el of candidates) {
      if (entries.length >= MAX_ELEMENT_LINES) break;
      // Plain links are the least valuable and can crowd a job board page; keep the form visible under the cap.
      const isPlainLink = el.tagName === 'A' && !el.getAttribute('role');
      if (isPlainLink && linkCount >= MAX_LINKS) {
        linksSkipped++;
        continue;
      }
      let line = null;
      try {
        line = describeElement(el, assign, seenRadioGroups);
      } catch (err) {
        console.debug('[jobpilot] describe failed:', err);
      }
      if (!line) continue;
      // A visible control inside an aria-hidden subtree is operable (see isVisible), but
      // the page DID mark it — usually framework noise (SAP UI5, P&I LOGA), occasionally
      // a visible trap whose label says "leave blank". The flag hands the model the fact;
      // the label carries the judgment.
      if (el.closest('[aria-hidden="true"]')) line += ' (aria-hidden)';
      if (isPlainLink) linkCount++;
      entries.push({ el, line });
    }
    return { entries, linksSkipped };
  }

  function emptyInventoryNote() {
    // V7 §7 — an empty inventory has two very different causes, and the model cannot
    // tell them apart. Say which one this is.
    return hasShadowContent()
      ? '(no interactive elements found — this page is built from web components. Open shadow roots WERE searched. ' +
        'If you can see a control that is not listed here, it is inside a CLOSED shadow root, which no extension can reach: ' +
        'tell the user rather than guessing.)'
      : '(no interactive elements found in this frame)';
  }

  /**
   * @param {object} [opts]
   * @param {Element} [opts.within]  CONTRACT-V8 §3.1 — inventory one subtree only. A
   *   scoped read NEVER renumbers and never sets the diff baseline (§1, §3.3).
   */
  function readInteractive(opts) {
    const within = opts && opts.within ? opts.within : null;
    const lines = [];
    let assign;

    if (within) {
      // Temp refs: the full-page numbering must survive a scoped read untouched, or
      // every ref the model is already holding starts pointing somewhere else (§1).
      assign = (el) => refFor(el);
      const label = containerLabel(within) ||
        (within.matches(DISCOVERY_SELECTOR) ? labelFor(within) || buttonName(within) : '');
      lines.push(`SCOPE: ${nodeTag(within)}${label && label !== '(unnamed)' ? ` ${q(truncate(label, 80))}` : ''}`);
      lines.push('(Only this section. Refs from your last full read_page are still valid.)');
    } else {
      refMap = new Map();
      refByEl = new WeakMap();
      let counter = 0;
      assign = (el) => {
        const ref = `e${++counter}`;
        refMap.set(ref, el);
        refByEl.set(el, ref);
        return ref;
      };
      lines.push(`URL: ${location.href}`);
      lines.push(`TITLE: ${truncate(collapseWs(document.title), 120)}`);

      const headings = [];
      for (const h of deepQueryAll('h1, h2, h3, [role=heading]')) {
        if (headings.length >= 15) break;
        if (!isVisible(h)) continue;
        const t = collapseWs(h.textContent);
        if (t) headings.push(`- ${truncate(t, 100)}`);
      }
      if (headings.length) {
        lines.push('HEADINGS:');
        lines.push(...headings);
      }
    }

    const errors = within ? [] : collectErrorTexts();
    // Only a VISIBLE captcha widget is announced on an ordinary read: a v3/Turnstile
    // script rides along on plenty of pages and may never fire, and announcing it on
    // every read would send the model chasing a blocker that is not blocking anything.
    // The invisible kinds surface in read_errors, which is where a dead submit is
    // investigated.
    const captcha = within ? null : detectCaptcha();
    if (errors.length || (captcha && captcha.visible)) {
      lines.push('ERRORS:');
      for (const e of errors) lines.push(`- ${truncate(e, 200)}`);
      if (captcha && captcha.visible) {
        lines.push(`- CAPTCHA on this page: ${captcha.desc}. The user must solve it — never attempt it yourself.`);
      }
    }

    lines.push('ELEMENTS:');
    const { entries, linksSkipped } = collectEntries(within || document, assign);
    for (const { line } of entries) lines.push(line);
    if (linksSkipped) lines.push(`(+${linksSkipped} more links not shown)`);
    if (!entries.length) lines.push(within ? '(nothing interactive in this section)' : emptyInventoryNote());

    // §3.3 — ONLY a full read sets the baseline. A scoped one would make the next
    // `changes` report the whole rest of the page as GONE.
    if (!within) lastInventory = entries;

    return capString(lines.join('\n'), READ_CAP);
  }

  // ------------------------------------------------ CONTRACT-V8 §3.2: changes

  /** `value="…"` out of an inventory line, for the `(was …)` note. */
  function valuePart(line) {
    const m = /\bvalue=("(?:[^"\\]|\\.)*")/.exec(line || '');
    return m ? m[1] : '';
  }

  const MAX_CHANGE_LINES = 40;

  function readChanges() {
    if (!lastInventory) {
      // No baseline is not "nothing changed" — saying so would be indistinguishable
      // from a page that did not move (V3 §7.1).
      return 'No previous read_page in this frame, so there is nothing to compare against. ' +
        'Full inventory follows — call read_page mode:"changes" again after your next action.\n\n' +
        readInteractive();
    }

    const before = new Map(lastInventory.map(({ el, line }) => [el, line]));
    const { entries } = collectEntries(document, (el) => refFor(el));

    const fresh = [];
    const changed = [];
    let unchanged = 0;
    for (const { el, line } of entries) {
      if (!before.has(el)) {
        fresh.push(line);
      } else if (before.get(el) !== line) {
        const wasValue = valuePart(before.get(el));
        const nowValue = valuePart(line);
        const was = wasValue && wasValue !== nowValue
          ? `(was value=${wasValue})`
          : `(was: ${truncate(before.get(el), 70)})`;
        changed.push(`${line}  ${was}`);
      } else {
        unchanged++;
      }
      before.delete(el);
    }

    // An element missing from the new inventory has THREE possible causes, and calling
    // them all "GONE" would tell the model a control was removed when it is still on
    // the page — a confident wrong answer, which is the failure V3 §7.1 exists to stop.
    // The cap case is the one that bites: adding two fields near the top pushes two
    // elements off the end of a 400-element inventory.
    const gone = [];
    const hidden = [];
    let pastCap = 0;
    for (const [el, line] of before) {
      // Strip the ref: it is dead, and printing it invites the model to use it.
      const name = `- ${truncate(line.replace(/^\[e\d+\] /, ''), 90)}`;
      if (!el.isConnected) {
        if (gone.length < 10) gone.push(name);
      } else if (!isVisible(el)) {
        if (hidden.length < 10) hidden.push(name);
      } else {
        pastCap++;
      }
    }

    lastInventory = entries;

    // A captcha widget is not a form control collectEntries tracks, so one appearing
    // right after a Submit click — the exact moment rule 11 sends the model to
    // mode:"changes" — registered as no change at all. "No changes" with a fresh
    // challenge on screen is the confident wrong answer §7.1 exists to prevent, so the
    // diff checks for a visible captcha the same way a full read does.
    const captcha = detectCaptcha();
    const captchaLine = captcha && captcha.visible
      ? `CAPTCHA on this page: ${captcha.desc}. The user must solve it — never attempt it yourself.`
      : '';

    if (!fresh.length && !changed.length && !gone.length && !hidden.length) {
      return `No changes since the last read. (${unchanged} elements, all unchanged.)` +
        (captchaLine ? `\n${captchaLine}` : '');
    }

    const out = [`CHANGES since the last read — ${unchanged} unchanged elements are NOT repeated.`];
    if (captchaLine) out.push(captchaLine);
    if (fresh.length) {
      out.push(`NEW (${fresh.length}):`);
      out.push(...fresh.slice(0, MAX_CHANGE_LINES));
      if (fresh.length > MAX_CHANGE_LINES) out.push(`(+${fresh.length - MAX_CHANGE_LINES} more — call read_page for the full picture)`);
    }
    if (changed.length) {
      out.push(`CHANGED (${changed.length}):`);
      out.push(...changed.slice(0, MAX_CHANGE_LINES));
      if (changed.length > MAX_CHANGE_LINES) out.push(`(+${changed.length - MAX_CHANGE_LINES} more)`);
    }
    if (gone.length) {
      out.push(`GONE (${gone.length}${gone.length >= 10 ? '+' : ''}) — removed from the page, these refs are dead:`);
      out.push(...gone);
    }
    if (hidden.length) {
      out.push(`HIDDEN (${hidden.length}${hidden.length >= 10 ? '+' : ''}) — still in the page but no longer visible:`);
      out.push(...hidden);
    }
    if (pastCap) {
      // This bucket is a catch-all: still connected, still visible, but produced no line
      // this pass. The cap is the usual reason and not the only one (an element that stops
      // matching DISCOVERY_SELECTOR, or whose describeElement threw, lands here too), so
      // the note says what is actually known rather than naming a cause it did not check.
      out.push(`(${pastCap} element${pastCap === 1 ? '' : 's'} from the last read ${pastCap === 1 ? 'was' : 'were'} ` +
        `not listed this time — STILL on the page and visible, not removed. Most likely past the ` +
        `${MAX_ELEMENT_LINES}-element cap. Use find or read_page within: to reach them.)`);
    }
    const errors = collectErrorTexts();
    if (errors.length) {
      out.push('ERRORS NOW VISIBLE:');
      for (const e of errors.slice(0, 5)) out.push(`- ${truncate(e, 200)}`);
    }
    return capString(out.join('\n'), READ_CAP);
  }

  // ------------------------------------------------------- CONTRACT-V8 §2: find

  const FIND_DEFAULT_LIMIT = 8;
  const FIND_MAX_LIMIT = 20;

  /** Every name a human might use for this control, for matching. */
  function searchNames(el) {
    const names = [];
    const push = (s) => { const v = collapseWs(s); if (v) names.push(v); };
    push(labelFor(el));
    const bn = buttonName(el);
    if (bn && bn !== '(unnamed)') push(bn);
    push(el.getAttribute('aria-label'));
    push(el.getAttribute('placeholder'));
    push(el.getAttribute('name'));
    push(el.getAttribute('data-automation-id'));
    return names;
  }

  const FIND_ROLES = {
    button: (el) => el instanceof HTMLButtonElement ||
      (el instanceof HTMLInputElement && /^(submit|button|reset|image)$/.test(el.type)) ||
      (el.getAttribute('role') || '').toLowerCase() === 'button',
    link: (el) => el instanceof HTMLAnchorElement && el.hasAttribute('href'),
    textbox: (el) => (el instanceof HTMLInputElement && TEXT_LIKE_TYPES.has(el.type) && !isWdPrompt(el)) ||
      el instanceof HTMLTextAreaElement || el.isContentEditable === true,
    dropdown: (el) => el instanceof HTMLSelectElement || isWdPrompt(el) ||
      ['combobox', 'listbox'].includes((el.getAttribute('role') || '').toLowerCase()),
    checkbox: (el) => (el instanceof HTMLInputElement && el.type === 'checkbox') ||
      ['checkbox', 'switch'].includes((el.getAttribute('role') || '').toLowerCase()) ||
      isUi5Switch(el),
    radio: (el) => (el instanceof HTMLInputElement && el.type === 'radio') ||
      (el.getAttribute('role') || '').toLowerCase() === 'radio',
    file: (el) => isFileInput(el),
  };

  /** exact → case-insensitive → prefix → substring, mirroring select_option (§2). */
  function nameScore(names, want) {
    const wl = want.toLowerCase();
    let best = 0;
    for (const name of names) {
      const nl = name.toLowerCase();
      let score = 0;
      if (name === want) score = 100;
      else if (nl === wl) score = 90;
      else if (nl.startsWith(wl)) score = 70;
      else if (nl.includes(wl)) score = 50;
      if (score > best) best = score;
    }
    return best;
  }

  /**
   * Is this element a SECTION of the page, rather than the page wearing a section's name?
   *
   * Two tests, because either alone lets something through: the tag rules out the obvious
   * page-level wrappers, and the share of controls rules out a <div> that happens to wrap
   * everything. A scope holding most of the form is not a scope.
   */
  function isPlausibleSection(el) {
    if (!(el instanceof Element)) return false;
    if (/^(BODY|HTML|MAIN|FORM)$/.test(el.tagName)) return false;
    const mine = deepQueryAll(DISCOVERY_SELECTOR, el).length;
    const all = deepQueryAll(DISCOVERY_SELECTOR).length;
    if (!all) return true;               // nothing to be a fraction of; the label is all we have
    return mine < all * 0.7;
  }

  /** Headings/fieldsets whose text matches — the scopes for read_page within (§2.1). */
  function findContainers(want, limit) {
    const out = [];
    for (const el of deepQueryAll('fieldset, section, [role=group], [role=region], h1, h2, h3, legend')) {
      if (out.length >= limit) break;
      if (!isVisible(el)) continue;
      const own = el instanceof HTMLFieldSetElement || el.tagName === 'SECTION' || el.getAttribute('role')
        ? containerLabel(el)
        : collapseWs(el.textContent);
      if (!own || !nameScore([own], want)) continue;
      const scope = /^(H[1-6]|LEGEND)$/.test(el.tagName)
        ? (el.closest('fieldset, section, [role=group], [role=region]') || el.parentElement)
        : el;
      if (!scope || out.some((o) => o.el === scope)) continue;
      // A heading with no sectioning ancestor lands on whatever wraps it — often the <form>
      // or <body>. Offering that as "the Work Experience section" and letting read_page
      // within: scope to it returns the WHOLE PAGE under a section's name, which is worse
      // than offering nothing: the model narrows its attention to something that never
      // narrowed. Only offer a scope that is genuinely a part of the page.
      if (!isPlausibleSection(scope)) continue;
      out.push({ el: scope, label: truncate(own, 60) });
    }
    return out;
  }

  function toolFind(args) {
    const want = collapseWs(String(args.text == null ? '' : args.text));
    if (!want) throw new Error('find needs {text} — the visible label or button text to look for.');
    const role = collapseWs(String(args.role || '')).toLowerCase();
    if (role && role !== 'any' && !FIND_ROLES[role]) {
      throw new Error(`Unknown role ${q(role)}. Use one of: ${Object.keys(FIND_ROLES).join(', ')}, or omit it.`);
    }
    const limit = Math.min(FIND_MAX_LIMIT, Math.max(1, Number(args.limit) || FIND_DEFAULT_LIMIT));
    const roleTest = role && role !== 'any' ? FIND_ROLES[role] : null;

    const scored = [];
    const nearMisses = [];
    let searched = 0;
    for (const el of deepQueryAll(DISCOVERY_SELECTOR)) {
      if (!isVisible(el)) continue;
      searched++;
      if (roleTest && !roleTest(el)) continue;
      const names = searchNames(el);
      if (!names.length) continue;
      const score = nameScore(names, want);
      if (score) scored.push({ el, score, name: names[0] });
      else if (nearMisses.length < 60) nearMisses.push(names[0]);
    }

    if (!scored.length) {
      // "Nothing matched" and "I could not look" must never read the same (V6 §8).
      const wl = want.toLowerCase().split(/\s+/)[0];
      const close = nearMisses.filter((n) => wl && n.toLowerCase().includes(wl)).slice(0, 6);
      const sample = (close.length ? close : nearMisses.slice(0, 8)).map((n) => q(truncate(n, 40)));
      // Section refs are offered HERE too, not only beside a hit. §2.1 exists for the name
      // that labels a group rather than a control — "Work Experience", "Voluntary
      // Disclosures" — and that name matches no control by definition, so returning early
      // meant the one case the feature was written for never reached it.
      const orphanSections = findContainers(want, 3);
      const sectionNote = orphanSections.length
        ? `\nBut there ARE sections with that name — pass one to read_page within: to inventory just it:\n` +
          orphanSections.map(({ el, label }) => `[${refFor(el)}] section ${q(label)}`).join('\n')
        : '';
      return `No ${role && role !== 'any' ? role + ' ' : ''}control named ${q(want)} — searched ${searched} visible elements in this frame. ` +
        (sample.length
          ? `Names that ARE here: ${sample.join(', ')}${nearMisses.length > sample.length ? ' …' : ''}.`
          : 'This frame has no named controls at all.') +
        ' (Try a shorter fragment, drop the role filter, or call read_page.)' + sectionNote;
    }

    // Best first; a stable document-order tiebreak so two runs agree.
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    const seenRadioGroups = new Set();
    const lines = [];
    for (const { el } of top) {
      let line = null;
      try {
        line = describeElement(el, (e) => refFor(e), seenRadioGroups);
      } catch { line = null; }
      if (line && el.closest('[aria-hidden="true"]')) line += ' (aria-hidden)'; // same flag as read_page
      if (line) lines.push(line);
    }
    const out = [`FOUND ${lines.length} match${lines.length === 1 ? '' : 'es'} for ${q(want)}${role && role !== 'any' ? ` (role=${role})` : ''}, best first:`];
    out.push(...lines);
    if (scored.length > top.length) out.push(`(+${scored.length - top.length} weaker matches not shown)`);

    const containers = findContainers(want, 3);
    if (containers.length) {
      out.push('SECTIONS with that name — pass one to read_page within: to inventory just it:');
      for (const { el, label } of containers) out.push(`[${refFor(el)}] section ${q(label)}`);
    }
    return capString(out.join('\n'), 3000);
  }

  function readTextMode() {
    const root = document.querySelector('main') || document.body;
    let text = root ? root.innerText || root.textContent || '' : '';
    text = text
      .replace(/[ \t ]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    const head = `URL: ${location.href}\nTITLE: ${collapseWs(document.title)}\n\n`;
    // §5.5: text mode dumps innerText outside any per-field redaction — strip
    // any known secret substring before returning.
    return capString(redactSecrets(head + (text || '(page has no readable text)')), TEXT_CAP);
  }

  function toolReadPage(args) {
    if (args.mode === 'text') return readTextMode();
    if (args.mode === 'changes') return readChanges();     // CONTRACT-V8 §3.2
    if (args.within) return readInteractive({ within: resolveRef(args.within) }); // §3.1
    return readInteractive();
  }

  // ------------------------------------------------------------------ fill

  const TEXT_LIKE_TYPES = new Set([
    'text', 'email', 'tel', 'url', 'search', 'number', 'password',
    'date', 'datetime-local', 'time', 'month', 'week',
  ]);

  /** Framework-safe native value setter (React et al. patch the value property). */
  function nativeSetValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  }

  /** document.activeElement, descended through open shadow roots to the real focused node. */
  function deepActiveElement(doc) {
    let node = (doc || document).activeElement;
    while (node && node.shadowRoot && node.shadowRoot.activeElement) node = node.shadowRoot.activeElement;
    return node;
  }

  /**
   * Park focus somewhere harmless, the way clicking whitespace does.
   *
   * el.blur() and "the user clicked outside" are NOT the same event sequence, and Workday
   * can tell. blur() drops focus into nothing: relatedTarget is null and no focusin follows,
   * so a widget whose commit handler reads the element focus moved TO — or that waits for
   * the document to have a focused element again before validating — sees a half-finished
   * gesture and keeps the field's committed value at empty. Focusing <body> produces the
   * whole pair (blur/focusout with relatedTarget=body, then focusin on body), which is what
   * a click on blank page area produces, WITHOUT dispatching a click that a page-level
   * outside-click handler would act on — that would close the very dialog we are filling.
   *
   * <body> is not focusable by default, so it is lent a tabindex for the duration and has it
   * taken straight back off: the page is left byte-identical to how we found it.
   */
  function parkFocusOnBody(doc) {
    const body = doc && doc.body;
    if (!body || typeof body.focus !== 'function') return false;
    const borrowed = !body.hasAttribute('tabindex');
    try {
      if (borrowed) body.setAttribute('tabindex', '-1');
      body.focus({ preventScroll: true });
    } catch {
      return false;
    } finally {
      if (borrowed) body.removeAttribute('tabindex');
    }
    return true;
  }

  /**
   * Genuinely release focus after a fill (CONTRACT-V4 §6). Workday only REGISTERS a typed
   * value when the field loses focus — a value that never blurs is discarded and produces
   * phantom "required" validation errors on a field the model watched itself fill.
   *
   * Three things happen here, in the order a real outside click produces them:
   *   1. focus moves to <body> (see parkFocusOnBody), falling back to el.blur();
   *   2. when focus refused to move — a widget that never took it, or that grabs it straight
   *      back — the focus-loss pair is emitted by hand, `composed` so it crosses a shadow
   *      boundary the way the native events would;
   *   3. `change` fires AFTER focus loss. That is where browsers really fire it for a text
   *      input, and a framework that commits on change-at-blur gets the one event it waits
   *      for. setTextRaw fires an earlier change for frameworks that read it during typing;
   *      both dedupe on value, so the pair is harmless.
   */
  function releaseFocus(el) {
    const doc = el.ownerDocument || document;
    const holds = () => {
      const active = deepActiveElement(doc);
      return active === el || Boolean(el.contains && active && el.contains(active));
    };
    const hadFocus = holds();

    // Short-circuit on purpose: an element that never held focus must not have focus TAKEN
    // somewhere on its behalf — that would steal it from whatever really has it.
    if (!hadFocus || !parkFocusOnBody(doc)) {
      try { el.blur(); } catch { /* not focusable */ }
    }

    if (!hadFocus || holds()) {
      el.dispatchEvent(new FocusEvent('blur', { bubbles: false, composed: true }));
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Set a text value with the full framework-safe event sequence, WITHOUT blurring
   * (typeaheads filter on input and close their list on blur). */
  function setTextRaw(el, value) {
    try { el.focus(); } catch { /* not focusable */ }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      nativeSetValue(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      el.textContent = value;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    }
  }

  /** setTextRaw + focus release: the commit sequence every ordinary fill uses. */
  function setTextCommitted(el, value) {
    setTextRaw(el, value);
    releaseFocus(el);
  }

  async function toolFill(args) {
    const el = resolveRef(args.ref);
    const secret = args.secret === true;

    // §5.4 guard (closes L3): a credential field can ONLY be filled through
    // request_secret, which is the only caller that sets secret:true (the panel
    // strips any `secret` a model tries to forge). A model-driven fill on a
    // credential field is rejected so the model calls request_secret instead.
    if (isCredentialField(el) && !secret) {
      throw new Error(`${args.ref} is a credential field. Never type credentials yourself — call request_secret with ref="${args.ref}" and the right kind. The extension will collect the value from the user and fill it.`);
    }

    // CONTRACT-V5 §2. Typing into a Workday prompt puts text in its search box and
    // selects NOTHING: the field stays empty as far as Workday is concerned, and
    // the page fails validation on a control the model believes it filled. Refuse
    // rather than "succeed" — CONTRACT-V3 §7.1.
    if (isWdPrompt(el)) {
      // The `secret` path used to be exempt, which left the one case with no way out: a
      // combobox whose attributes read as credential-ish is refused by choose_option, fill
      // and dom_act, so read_page sends the model to request_secret — and request_secret
      // typed the user's credential into a SEARCH BOX, selected nothing, and reported
      // success. Refusing here is the honest answer; a credential does not belong in a
      // dropdown, and if the field is genuinely a picker the model should pick.
      throw new Error(secret
        ? `${args.ref} (${q(labelFor(el) || buttonName(el))}) is a dropdown, not a text field. Typing a ` +
          'credential into its search box would select nothing and leave the field empty, so nothing was ' +
          'entered. If this really is a picker, call choose_option; if the user must type a secret here, ask ' +
          'them to do it themselves.'
        : `${args.ref} (${q(labelFor(el) || buttonName(el))}) is a dropdown, not a text field — on Workday its ` +
          'search box looks exactly like one. Typing into it selects nothing and the field stays empty. ' +
          'Call choose_option with the option label instead.');
    }

    const value = args.value == null ? '' : String(args.value);
    const label = labelFor(el) || buttonName(el);
    const displayLabel = label && label !== '(unnamed)' ? label : args.ref;
    const errorsBefore = nearbyErrorTexts(el);

    let type = '';
    if (el instanceof HTMLSelectElement) {
      throw new Error(`${args.ref} is a <select> — use select_option instead of fill.`);
    }
    if (el instanceof HTMLInputElement) {
      type = el.type;
      if (type === 'checkbox') throw new Error(`${args.ref} is a checkbox — use set_checkbox instead of fill.`);
      if (type === 'radio') throw new Error(`${args.ref} is a radio — use click on the option instead of fill.`);
      if (type === 'file') throw new Error(`${args.ref} is a file input — use upload_file instead of fill.`);
      if (!TEXT_LIKE_TYPES.has(type)) {
        throw new Error(`${args.ref} is an input of type "${type}" which fill does not support. Use click or set_checkbox as appropriate.`);
      }
    }

    const editable =
      el.isContentEditable === true ||
      (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') ||
      (el.getAttribute('role') || '').toLowerCase() === 'textbox';

    el.scrollIntoView({ block: 'center' });
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || editable) {
      // CONTRACT-V4 §6: commit = set + input/change + genuine focus loss. Workday
      // discards values that never blur (releaseFocus documents this).
      setTextCommitted(el, value);
    } else {
      throw new Error(`${args.ref} (<${el.tagName.toLowerCase()}>) is not a fillable field — fill works on text inputs, textareas and contenteditable elements. Use click for buttons/options.`);
    }

    // §5.4/§5.5 (threat model P0/P1): a secret fill returns WITHOUT reading the
    // value back and WITHOUT appending nearby validation text (a site could echo
    // the entered value). Mark the element sticky-secret so any later read_page
    // hides it even if isCredentialField would not recognise the field.
    if (secret) {
      secretFilledEls.add(el);
      if (value) secretValues.add(value);
      // Reporting success without checking anything is the unearned success V3 §7.1 names,
      // and it bites hardest here: the model tells the user "I entered your password", the
      // page discarded it, and the login silently fails with nobody able to say why.
      //
      // The value itself is never read back or compared — §5.4/§5.5 stand. LENGTH is not
      // the secret: it distinguishes "the field holds what we typed" from "the field is
      // empty" without the value, or any substring of it, ever leaving the page.
      await sleep(60);
      const landed = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
        ? el.value.length
        : collapseWs(el.textContent).length;
      if (value && landed === 0) {
        throw new Error(
          `The ${args.ref} field is EMPTY after the fill — the page discarded the value (a masked input that ` +
          'rejects programmatic writes, or a field that was replaced as you typed). Nothing was entered. Call ' +
          'read_page, then ask the user to type it themselves.'
        );
      }
      return `Filled (hidden) into ${args.ref}.`;
    }

    await sleep(60); // let framework state settle before reading back
    const readBack = () => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? el.value
      : collapseWs(el.textContent));
    let current = readBack();

    // A masked/formatting field ACCEPTS the write and reformats it — "5551234567"
    // becomes "(555) 123-4567" before the read-back ever runs, and no retry can make
    // the strings equal because the mask reformats every attempt the same way. Exact
    // equality alone therefore reported a working phone/salary/date mask as "did not
    // stick" and sent the model into a retry loop on a field that was already correct.
    // Case/whitespace tolerance catches uppercase transforms; the digit comparison
    // (guarded to ≥4 digits so short values cannot false-match) catches every numeric
    // mask. The read-back stays the judge — this only widens what counts as a match.
    const digitsOf = (s) => String(s).replace(/\D+/g, '');
    const landed = (cur) =>
      cur === value ||
      (editable && cur === collapseWs(value)) ||
      collapseWs(cur).toLowerCase() === collapseWs(value).toLowerCase() ||
      (digitsOf(value).length >= 4 && digitsOf(cur) === digitsOf(value));

    // CONTRACT-V4 §6 — ONE keyboard-style retry when the native setter did not
    // stick: focus → select-all → execCommand('insertText') fires the
    // beforeinput/input sequence a real keystroke does, which masked inputs and
    // exotic editors listen for. Best-effort; the read-back below stays the judge.
    if (!landed(current)) {
      try {
        el.focus();
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          if (typeof el.select === 'function') el.select();
        } else {
          const range = document.createRange();
          range.selectNodeContents(el);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        if (document.execCommand('insertText', false, value)) {
          releaseFocus(el);
          await sleep(60);
          current = readBack();
        }
      } catch { /* fallback failed — report the honest mismatch below */ }
    }

    let result;
    if (landed(current)) {
      result = `Filled ${q(displayLabel)} with ${q(value)}. Current value: ${q(current)}`;
      if (current !== value && current !== collapseWs(value)) {
        result += ' (the field reformatted the value — normal for masked inputs).';
      }
    } else {
      let hint = ' The field may be script-controlled — try clicking it first and filling again, or read_page to find the real editable element.';
      if (type === 'date') hint = ' Date inputs require ISO format YYYY-MM-DD.';
      else if (type === 'datetime-local') hint = ' Datetime inputs require ISO format YYYY-MM-DDTHH:MM.';
      else if (type === 'number' && current === '') hint = ' Number inputs only accept plain numeric values.';
      result = `Tried to fill ${q(displayLabel)} with ${q(value)} but the value did not stick. Current value: ${q(truncate(current, 80))}.${hint}`;
    }

    const freshErrors = [...nearbyErrorTexts(el)].filter((t) => !errorsBefore.has(t));
    if (freshErrors.length) {
      result += ` Validation: ${freshErrors.map((t) => q(truncate(t, 120))).join(' ')}`;
    }
    return result;
  }

  // --------------------------------------------------------- select_option

  function toolSelectOption(args) {
    const el = resolveRef(args.ref);
    if (!(el instanceof HTMLSelectElement)) {
      throw new Error(`${args.ref} is not a native select. Use click to open the custom dropdown, then read_page to see its options, then click the option.`);
    }
    // collapseWs on BOTH sides, as choose_option already does: option markup is often
    // templated with internal newlines, and a `want` carrying a stray space failed every
    // tier including the substring one — refusing a visibly present option on the EASY
    // (native) path.
    const want = collapseWs(String(args.option == null ? '' : args.option));
    const wantLower = want.toLowerCase();
    const options = Array.from(el.options);
    const labelOf = (o) => collapseWs(o.label || o.textContent) || o.value;

    // Match priority (contract): exact label → case-insensitive label → value → label substring.
    // Every rule is guarded on a non-empty want. `o.value === ''` matches the ubiquitous
    // <option value="">Select…</option>, so an empty want used to "succeed" by choosing the
    // placeholder — leaving a required field blank while passing the read-back below.
    // Nothing is worth selecting under an empty name: say so instead.
    const match = !want.trim() ? undefined : (
      options.find((o) => labelOf(o) === want) ||
      options.find((o) => labelOf(o).toLowerCase() === wantLower) ||
      options.find((o) => o.value === want) ||
      options.find((o) => labelOf(o).toLowerCase().includes(wantLower))
    );

    const fieldLabel = labelFor(el) || args.ref;
    if (!match) {
      if (!want.trim()) {
        throw new Error(`select_option was given no option to choose for ${q(fieldLabel)}. Pass {option:"…"} with the visible label you want.`);
      }
      const shown = options.slice(0, 20).map((o) => q(truncate(labelOf(o), 40)));
      const extra = options.length > 20 ? ` …+${options.length - 20} more` : '';
      throw new Error(`No option matching ${q(want)} in ${q(fieldLabel)}. Available options: ${shown.join(', ')}${extra}`);
    }

    el.scrollIntoView({ block: 'center' });
    el.focus();
    el.value = match.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.blur();

    if (el.value !== match.value) {
      const currentLabel = el.selectedIndex >= 0 ? labelOf(el.options[el.selectedIndex]) : '';
      return `Tried to select ${q(labelOf(match))} in ${q(fieldLabel)} but the selection did not stick (current: ${q(currentLabel)}). The select may be script-controlled — try click, then read_page.`;
    }
    return `Selected ${q(labelOf(match))} in ${q(fieldLabel)}.`;
  }

  // ----------------------------------------------------------------- click

  /**
   * Best-effort detection of "this click opens a native file picker":
   * the element itself, its label's control, a descendant, or an adjacent
   * sibling file input (contract §5.1.4 safety rule).
   */
  function findFilePickerTarget(el) {
    if (isFileInput(el)) return el;
    const isSubmit =
      (el instanceof HTMLButtonElement && (el.getAttribute('type') || 'submit').toLowerCase() === 'submit') ||
      (el instanceof HTMLInputElement && el.type === 'submit');
    const label = el.tagName === 'LABEL' ? el : el.closest('label');
    if (label) {
      const control = label.control || (label.htmlFor ? deepGetElementById(label.htmlFor, label) : null);
      if (control && isFileInput(control)) return control;
      const inner = label.querySelector('input[type=file]');
      if (inner) return inner;
    }
    if (isSubmit) return null; // submit buttons submit forms; they never open pickers
    if (el.querySelector) {
      const inner = el.querySelector('input[type=file]');
      if (inner) return inner;
    }
    for (const sib of [el.previousElementSibling, el.nextElementSibling]) {
      if (sib && isFileInput(sib)) return sib;
    }
    return null;
  }

  /** Full pointer/mouse sequence for non-native controls (React/Vue listeners often need pointer events). */
  function dispatchClickSequence(el, mods) {
    const rect = el.getBoundingClientRect();
    const cx = Math.max(0, rect.left + rect.width / 2);
    const cy = Math.max(0, rect.top + rect.height / 2);
    const m = mods || {};
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, button: 0, detail: 1,
      // CONTRACT-V9 §2 — shift/ctrl-click is how multi-select lists and tables work.
      ctrlKey: !!m.ctrlKey, metaKey: !!m.metaKey, shiftKey: !!m.shiftKey, altKey: !!m.altKey,
    };
    try { el.focus(); } catch { /* not focusable */ }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse', buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse', buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', base));
  }

  // -------------------------------------------------------- click blocking
  // CONTRACT-V7 §8. A cookie banner, a sticky header or a modal backdrop over the
  // target eats the click, and every click tool reported success — the page took
  // the click, it just went somewhere else. That is an unearned success (V3 §7.1),
  // and the model has no way to see it: the DOM still says the button is there,
  // visible and enabled.

  /** elementFromPoint, descending through open shadow roots to the real top element. */
  function topElementAt(x, y) {
    let node = null;
    try { node = document.elementFromPoint(x, y); } catch { return null; }
    for (let depth = 0; depth < 10; depth++) {
      if (!node || !node.shadowRoot) break;
      let inner = null;
      try { inner = node.shadowRoot.elementFromPoint(x, y); } catch { break; }
      if (!inner || inner === node) break;
      node = inner;
    }
    return node;
  }

  /**
   * What a real click at el's centre would actually land on, or null when el would
   * get it. Deliberately LENIENT — a false positive would refuse a click that works:
   *   - an ancestor is fine: a real click bubbles there, and many widgets keep the
   *     handler on the wrapper
   *   - a descendant is fine: that is el's own content
   *   - a <label> that points at el is fine: clicking it activates el
   *   - no layout box, or a centre outside the viewport, means there is nothing to
   *     hit-test, not that something is in the way
   */
  function clickBlocker(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return null;
    const hit = topElementAt(x, y);
    if (!hit || hit === el) return null;
    try {
      if (containsDeep(el, hit) || containsDeep(hit, el)) return null;
    } catch { return null; }
    if (hit instanceof HTMLLabelElement && hit.control === el) return null;
    return hit;
  }

  /**
   * `contains` that crosses shadow boundaries, in the direction that matters here.
   *
   * topElementAt deliberately descends INTO open shadow roots, so for a web component the
   * hit is almost always a node inside the host's shadow tree — and Node.contains() returns
   * false across that boundary, because shadow content is not in the light DOM. The plain
   * check therefore called a component's own internals an obstruction and refused every
   * click on a custom element, pointing at the very thing it was trying to click.
   */
  function containsDeep(ancestor, node) {
    let cur = node;
    for (let hops = 0; cur && hops < 50; hops++) {
      if (cur === ancestor) return true;
      if (ancestor.contains(cur)) return true;
      const root = cur.getRootNode ? cur.getRootNode() : null;
      cur = root && root.host ? root.host : cur.parentNode;
      if (cur && cur.nodeType !== 1) cur = null;
    }
    return false;
  }

  /**
   * Refuse a click that would land somewhere else, and say where.
   *
   * Retried once: a loading veil or an animating modal is genuinely in the way for a
   * moment and then is not, and failing on that would be its own false alarm.
   */
  async function assertNotBlocked(el, what) {
    let blocker = clickBlocker(el);
    if (!blocker) return;
    await sleep(350);
    blocker = clickBlocker(el);
    if (!blocker) return;
    const name = buttonName(blocker);
    const named = name && name !== '(unnamed)' ? ` ${q(truncate(name, 60))}` : '';
    const text = truncate(collapseWs(blocker.textContent || ''), 100);
    throw new Error(
      `${what} would land on ${nodeTag(blocker)}${named}, not on the target — something is covering it ` +
      `(cookie banner, sticky header, modal backdrop). Nothing was clicked. ` +
      `The thing in the way reads: ${q(text)}. Deal with it first (accept/close it), then try again.`
    );
  }

  function isNavigatingClick(el) {
    if (el instanceof HTMLAnchorElement) {
      const href = el.getAttribute('href') || '';
      return !!href && !href.startsWith('#') && !/^javascript:/i.test(href);
    }
    if (el instanceof HTMLButtonElement) {
      return (el.getAttribute('type') || 'submit').toLowerCase() === 'submit' && !!el.form;
    }
    if (el instanceof HTMLInputElement) return el.type === 'submit' || el.type === 'image';
    return /\bsubmit\b/i.test(buttonName(el));
  }

  async function toolClick(args) {
    const el = resolveRef(args.ref);
    if (findFilePickerTarget(el)) {
      throw new Error(`${args.ref} opens a native file picker which cannot be automated. Use upload_file on the file input instead.`);
    }
    el.scrollIntoView({ block: 'center' });
    await assertNotBlocked(el, 'click');
    let name = buttonName(el);
    if (name === '(unnamed)') name = labelFor(el) || args.ref;

    // CONTRACT-V4 §5: diff visible errors across the click so a wizard "Next"
    // that trips validation tells the model in the SAME result.
    const errorsBefore = new Set(collectErrorTexts().map((t) => t.toLowerCase()));

    const native =
      el instanceof HTMLButtonElement ||
      el instanceof HTMLAnchorElement ||
      el instanceof HTMLInputElement ||
      el instanceof HTMLLabelElement ||
      el instanceof HTMLSelectElement ||
      el instanceof HTMLOptionElement;
    if (native) el.click();
    else dispatchClickSequence(el);
    await sleep(150);

    let result = `Clicked ${q(truncate(name, 80))}`;
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      result += ` — now checked=${el.checked}`;
    } else {
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role === 'checkbox' || role === 'radio' || role === 'switch') {
        result += ` — now checked=${el.getAttribute('aria-checked') === 'true'}`;
      }
    }
    result += '.';
    const freshErrors = collectErrorTexts()
      .filter((t) => !errorsBefore.has(t.toLowerCase()))
      .slice(0, 3);
    if (freshErrors.length) {
      result += ` New validation errors: ${freshErrors.map((t) => q(truncate(t, 120))).join(' ')}`;
    }
    if (isNavigatingClick(el)) result += ' (page may be navigating)';
    return result;
  }

  // ---------------------------------------------------------- set_checkbox

  async function toolSetCheckbox(args) {
    const el = resolveRef(args.ref);
    let desired = args.checked;
    if (desired === 'true') desired = true;
    if (desired === 'false') desired = false;
    if (typeof desired !== 'boolean') {
      throw new Error('set_checkbox needs {ref, checked: true|false}.');
    }
    const label = labelFor(el) || buttonName(el);
    const displayLabel = label && label !== '(unnamed)' ? label : args.ref;

    if (el instanceof HTMLInputElement && el.type === 'checkbox') {
      if (el.checked === desired) return `Checkbox ${q(displayLabel)} was already checked=${el.checked} — no change.`;
      el.scrollIntoView({ block: 'center' });
      el.click();
      await sleep(40);
      if (el.checked !== desired) {
        // set_checkbox already verifies, so a covered box fails honestly either way —
        // but "something is on top of it" is a fixable diagnosis and "script-controlled"
        // is not. Checked AFTER the fact here, so a false positive can never refuse a
        // click that would have worked (V7 §8).
        const blocker = clickBlocker(el);
        if (blocker) {
          return `Clicked checkbox ${q(displayLabel)} but it is still checked=${el.checked} — ${nodeTag(blocker)} is covering it. Dismiss that first (cookie banner, modal, sticky bar), then try again.`;
        }
        return `Clicked checkbox ${q(displayLabel)} but it is still checked=${el.checked}. It may be disabled or script-controlled — try click on its label instead.`;
      }
      return `Checkbox ${q(displayLabel)} is now checked=${el.checked}.`;
    }

    // BEFORE the role branch: a UI5 switch has no role and no aria-checked, so the state
    // that must be read and verified is its class. Verified against the live control: a
    // synthetic click sequence flips sapMSwtOff <-> sapMSwtOn.
    if (isUi5Switch(el)) {
      const current = ui5SwitchOn(el);
      if (current === desired) return `Checkbox ${q(displayLabel)} was already checked=${current} — no change.`;
      el.scrollIntoView({ block: 'center' });
      dispatchClickSequence(el);
      await sleep(150); // the flip is animated (sapMSwtTrans); give the class time to land
      const now = ui5SwitchOn(el);
      if (now !== desired) {
        return `Clicked toggle ${q(displayLabel)} but it is still ${now ? 'on' : 'off'}. Try click on it, then read_page to verify.`;
      }
      return `Checkbox ${q(displayLabel)} is now checked=${now}.`;
    }

    const role = (el.getAttribute('role') || '').toLowerCase();
    if (role === 'checkbox' || role === 'switch') {
      const current = el.getAttribute('aria-checked') === 'true';
      if (current === desired) return `Checkbox ${q(displayLabel)} was already checked=${current} — no change.`;
      el.scrollIntoView({ block: 'center' });
      dispatchClickSequence(el);
      await sleep(60);
      const now = el.getAttribute('aria-checked') === 'true';
      if (now !== desired) {
        return `Clicked ${q(displayLabel)} but aria-checked is still "${el.getAttribute('aria-checked')}". Try click on it, then read_page to verify.`;
      }
      return `Checkbox ${q(displayLabel)} is now checked=${now}.`;
    }

    throw new Error(`${args.ref} is not a checkbox. Use click for buttons/radios/options, or fill for text fields.`);
  }

  // ----------------------------------------------------------- upload_file

  /** Nearest ancestor that looks like a drag-and-drop zone (react-dropzone etc.). */
  function findDropzone(input) {
    // Class names alone miss every CSS-in-JS widget (emotion/styled-components render
    // `css-1a2b3c`, and this file already documents that trap for ERROR_SELECTOR) — so
    // the attributes real dropzones carry are checked too.
    const zoneish = (node) => {
      const cls = typeof node.className === 'string' ? node.className : '';
      const hints = [
        cls, node.id || '',
        node.getAttribute('data-testid') || '',
        node.getAttribute('data-automation-id') || '',
        node.getAttribute('aria-label') || '',
      ].join(' ');
      return /drop|drag|upload|attach/i.test(hints);
    };
    let node = input.parentElement;
    for (let depth = 0; depth < 5 && node && node !== document.body; depth++) {
      if (zoneish(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  async function toolUploadFile(args) {
    const payload = args.file;
    if (!payload || typeof payload.dataBase64 !== 'string' || !payload.dataBase64) {
      throw new Error('upload_file received no file payload — expected {ref, file:{name, mime, dataBase64}}. Add a resume in the Profile tab if none is stored.');
    }
    const el = resolveRef(args.ref);

    let bytes;
    try {
      const binary = atob(payload.dataBase64.replace(/\s+/g, ''));
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    } catch {
      throw new Error('Could not decode the document data (invalid base64). Re-upload the document in the Profile tab.');
    }
    const name = String(payload.name || 'document');
    const mime = String(payload.mime || 'application/octet-stream');
    const file = new File([bytes], name, { type: mime });

    // Resolution chain (contract §5.1.6): ref itself → label[for] → descendant → same form/upload container → first on page.
    let input = null;
    let via = '';
    if (isFileInput(el)) {
      input = el;
    } else {
      const label = el.tagName === 'LABEL' ? el : el.closest('label');
      if (label) {
        const control = label.control || (label.htmlFor ? deepGetElementById(label.htmlFor, label) : null);
        if (control && isFileInput(control)) {
          input = control;
          via = ' (resolved via its <label>)';
        }
      }
      if (!input && el.querySelector) {
        const inner = el.querySelector('input[type=file]');
        if (inner) {
          input = inner;
          via = ` (resolved via a file input inside ${args.ref})`;
        }
      }
      if (!input) {
        // Start from the parent: closest() would match el itself (upload
        // buttons routinely carry class "upload-btn"), skipping the real
        // surrounding dropzone/form and falling through to the page-wide input.
        const container = el.parentElement
          ? el.parentElement.closest('form, [class*=upload i], [class*=attach i], [class*=resume i]')
          : null;
        const near = container ? container.querySelector('input[type=file]') : null;
        if (near) {
          input = near;
          via = ' (resolved via the surrounding form/upload container)';
        }
      }
      if (!input) {
        const any = deepQueryAll('input[type=file]')[0] || null;
        if (any) {
          input = any;
          via = ' (resolved via the first file input on the page — verify it is the right one)';
        }
      }
    }
    if (!input) {
      throw new Error(`No file input found for ${args.ref} (checked its label, descendants, surrounding container, and the whole page). Call read_page and target a "file input" element.`);
    }

    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const zone = findDropzone(input);
    if (zone) {
      try {
        zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
      } catch (err) {
        console.debug('[jobpilot] dropzone drop dispatch failed:', err);
      }
    }

    // A longer beat than other tools: upload widgets run their own handlers off the
    // change/drop events and only then render the filename.
    await sleep(300);
    const kb = Math.max(1, Math.round(bytes.length / 1024));
    const inputLabel = labelFor(input) || 'file input';
    const count = input.files ? input.files.length : 0;
    let result = `Attached ${q(name)} (${kb} KB) to file input ${q(inputLabel)}${via}. input.files.length=${count}`;
    if (count === 0) {
      result += ' — the attach did NOT stick; the page may use a custom uploader. Call read_errors, or ask the user to attach manually.';
    } else {
      // input.files holding the file proves only that WE set it — it says nothing about
      // whether the page's own uploader noticed (V3 §7.1: a react-dropzone wired to the
      // drop event alone never reads the input). The filename appearing in the widget is
      // the page's own acknowledgement, so report which of the two facts we actually have.
      let scope = zone || input;
      if (!zone) {
        for (let up = 0; up < 4 && scope.parentElement && scope.parentElement !== document.body; up++) {
          scope = scope.parentElement;
        }
      }
      // Full filename only: a basename like "resume" appears in every "upload your
      // resume" instruction, and matching it would fake the acknowledgement.
      const shown = (scope.textContent || '').toLowerCase();
      if (shown.includes(name.toLowerCase())) {
        result += ' — the page now shows the filename, so the upload registered.';
      } else {
        result += ' — the page does NOT yet show the filename near the input. Some uploaders render it after processing: call read_page (mode "changes") to confirm it registered before moving on.';
      }
    }
    return result;
  }

  // --------------------------------------------------------- choose_option
  // CONTRACT-V4 §2 — the whole custom-dropdown dance (open, wait for the list,
  // match, click, verify) as ONE tool call instead of 3–4 fragile steps.

  const OPTION_ROLES = [
    '[role=option]',
    '[role=menuitem]',
    '[role=treeitem]',
    // Workday's own option marker. Its popup options are plain <div>/<li> with
    // this id; leaf nodes of a hierarchical prompt ("How Did You Hear About Us?")
    // carry promptLeafNode.
    '[data-automation-id="promptOption"]',
    '[data-automation-id="promptLeafNode"]',
  ].join(', ');

  // CONTRACT-V9 §1.1 — how many page-steps choose_option will walk down a virtualized
  // list before giving up. A real country prompt is ~250 rows, which is roughly 35 steps;
  // 60 clears that with room to spare and still ends in seconds rather than minutes.
  const OPTION_SCROLL_HOPS = 60;

  /**
   * Real, choosable options only. A Workday multiselect renders each ALREADY-CHOSEN
   * value as role=option inside its selectedItemList — clicking one of those is a
   * delete affordance, not a selection, so they are never candidates.
   */
  function visibleOptionEls(root) {
    return Array.from(deepQueryAll(OPTION_ROLES, root || document))
      .filter((o) => isVisible(o) && !o.closest(WD_SELECTED_LIST) && !o.closest(WD_PILL));
  }

  /** Options inside the container(s) the trigger names via aria-controls/aria-owns. */
  function ownedOptionEls(el) {
    const ids = `${el.getAttribute('aria-controls') || ''} ${el.getAttribute('aria-owns') || ''}`
      .split(/\s+/).filter(Boolean);
    const out = [];
    for (const id of ids) {
      let container = null;
      container = deepGetElementById(id, el);
      if (!container || !isVisible(container)) continue;
      const opts = visibleOptionEls(container);
      if (opts.length) {
        out.push(...opts);
      } else {
        // Role-less list items (plain <li>/<div> menus) — children with real text.
        out.push(...Array.from(container.children).filter((c) => isVisible(c) && collapseWs(c.textContent)));
      }
    }
    return out;
  }

  function optionText(o) {
    // Workday puts the clean label on data-automation-label; textContent can carry
    // icon/counter noise from the row around it.
    return collapseWs(o.getAttribute('data-automation-label')) ||
      collapseWs(o.textContent) ||
      collapseWs(o.getAttribute('aria-label')) ||
      collapseWs(o.getAttribute('data-value'));
  }

  /** Poll until option elements appear: owned (aria-controls/owns) beat "newly visible". */
  async function waitForOptionEls(el, before, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const owned = ownedOptionEls(el);
      if (owned.length) return owned;
      const fresh = visibleOptionEls().filter((o) => !before.has(o));
      if (fresh.length) return fresh;
      if (Date.now() >= deadline) return [];
      await sleep(100);
    }
  }

  /** Match priority mirrors select_option: exact → ci → data-value → prefix → substring. */
  function matchOptionEl(options, want) {
    const wl = want.toLowerCase();
    return (
      options.find((o) => optionText(o) === want) ||
      options.find((o) => optionText(o).toLowerCase() === wl) ||
      options.find((o) => (o.getAttribute('data-value') || '') === want) ||
      options.find((o) => optionText(o).toLowerCase().startsWith(wl)) ||
      options.find((o) => optionText(o).toLowerCase().includes(wl))
    );
  }

  function pressEscape(el) {
    const opts = { bubbles: true, cancelable: true, key: 'Escape', code: 'Escape', keyCode: 27 };
    const target = document.activeElement || el;
    target.dispatchEvent(new KeyboardEvent('keydown', opts));
    target.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  async function toolChooseOption(args) {
    const el = resolveRef(args.ref);
    // Wrong tool, right intent — a native select must not cost the model a step.
    if (el instanceof HTMLSelectElement) return toolSelectOption(args);
    const want = collapseWs(String(args.option == null ? '' : args.option));
    if (!want) throw new Error('choose_option needs {ref, option}.');
    const fieldLabel = labelFor(el) || buttonName(el) || args.ref;
    const textEntry =
      (el instanceof HTMLInputElement && TEXT_LIKE_TYPES.has(el.type)) ||
      el.isContentEditable === true;

    // CONTRACT-V2 §5.4 bars TYPING a credential, and the typeahead fallback types.
    // A non-text trigger (a <button> prompt) cannot receive a typed value, so
    // picking from its list leaks nothing — and refusing it would strand a field
    // that isSecretEl only flagged on a substring ("verificationMethod"), with
    // request_secret unable to help because you cannot type into a dropdown.
    if (textEntry && (isCredentialField(el) || isSecretEl(el))) {
      throw new Error(`${args.ref} is a credential field — call request_secret instead.`);
    }

    // CONTRACT-V5 §3. Workday's prompts are server-filtered (the option list arrives
    // over the network) and its multiselect TOGGLES: clicking an option that is
    // already chosen removes it. Re-choosing a value that is already set would
    // therefore silently clear the field.
    const wd = isWdPrompt(el);
    const multi = Boolean(wdPromptContainer(el));
    // Cheap exact-match skip. The real toggle guard is below, after the option is
    // resolved — asking for "India" when the pill reads "India (+91)" does not
    // match here, but it WOULD click that pill's option and remove it.
    if (wd && wdHolds(el, want)) {
      return `${q(fieldLabel)} already holds ${q(truncate(want, 60))} — nothing to do.`;
    }
    const openWait = wd ? 3000 : 2000;
    const filterWait = wd ? 3500 : 2500;

    el.scrollIntoView({ block: 'center' });
    // A covered trigger produces "no options appeared", which sends the model looking
    // for the wrong problem. Name the thing in the way instead (V7 §8).
    await assertNotBlocked(el, 'opening this dropdown');
    const before = new Set(visibleOptionEls());
    // Remember the trigger's value so a failed typeahead probe can put it back —
    // otherwise a plain text field mistaken for a dropdown is left holding the
    // option text with only "no options appeared" to explain it.
    const originalValue = textEntry
      ? (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent)
      : null;
    let typed = false;
    const undoTyping = () => {
      if (typed) setTextRaw(el, originalValue == null ? '' : originalValue);
    };

    // Open. Native controls take .click(); custom widgets need the pointer sequence.
    if (el instanceof HTMLButtonElement || el instanceof HTMLInputElement || el instanceof HTMLLabelElement) {
      el.click();
    } else {
      dispatchClickSequence(el);
    }

    let options = await waitForOptionEls(el, before, openWait);

    // Typeahead fallback (React-select, location autocompletes, every Workday
    // multiselect): the list only populates once you type. No blur here — blur
    // closes the list.
    if (!options.length && textEntry) {
      setTextRaw(el, want);
      typed = true;
      options = await waitForOptionEls(el, before, filterWait);
    }
    if (!options.length) {
      undoTyping();
      throw new Error(
        `Clicked ${q(fieldLabel)} but no dropdown options appeared within ${Math.round(filterWait / 1000)}s. ` +
        'It may not be a dropdown — call read_page to see what this control is. (If it IS an option in an ' +
        'already-open list, use click on it. If it is a plain text field, use fill.)'
      );
    }

    let match = matchOptionEl(options, want);
    if (!match && textEntry && !typed) {
      // A pre-populated list without our option — type to filter, then re-match.
      // This is the normal path for a Workday hierarchical prompt, whose first
      // list shows CATEGORIES ("Job Boards", "Social Media") and only reveals the
      // leaf you asked for once the search box narrows it.
      setTextRaw(el, want);
      typed = true;
      const filtered = await waitForOptionEls(el, new Set(), filterWait);
      if (filtered.length) {
        options = filtered;
        match = matchOptionEl(options, want);
      }
    }
    // CONTRACT-V9 §1. A virtualized list holds only the rows in view, so the option may
    // not be in the DOM at all yet — no selector finds it and no wait produces it. Scroll
    // the list the way a human would and look again. This stays in choose_option rather
    // than becoming the model's problem: rung 1 should still handle an ordinary long list.
    let scrolledFor = 0;
    let reachedEnd = false;
    if (!match) {
      // `isScrollable` accepts horizontal-only overflow, so a container that cannot move
      // vertically still qualifies — and the loop below would then "scroll" it zero pixels
      // and report having reached the end of a list it never touched.
      const container = options.length ? scrollContainer(options[0]) : null;
      if (container && scrollState(container).max > 1) {
        // A page at a time, because the rendered window is a little larger than a page —
        // a bigger stride would jump clean over the rows it is looking for.
        for (let hop = 0; hop < OPTION_SCROLL_HOPS; hop++) {
          const wasAt = container.scrollTop;
          scrollBy(container, pageStep(container));
          await sleep(120); // let the virtualizer render the rows that came into range
          // A scroll that did not move is not a hop. Counting it before this check both
          // overstated how far we looked and let the budget run out one step early, so a
          // row that was one scroll away came back as "no option matching".
          if (container.scrollTop === wasAt) { reachedEnd = true; break; }
          scrolledFor++;
          // Scoped to the popup this control owns. Falling back to a document-wide query
          // meant that a list which re-rendered empty for a single frame mid-scroll could
          // match an option belonging to a DIFFERENT open dropdown, and click it while
          // reporting the one that was asked for.
          const owned = ownedOptionEls(el);
          if (!owned.length) continue;
          options = owned;
          match = matchOptionEl(options, want);
          if (match) break;
        }
      }
    }

    if (!match) {
      const shown = options.slice(0, 20).map((o) => q(truncate(optionText(o), 40)));
      const extra = options.length > 20 ? ` …+${options.length - 20} more` : '';
      undoTyping();
      pressEscape(el);
      releaseFocus(el); // Escape closes the list; focus would otherwise stay parked in the search box
      throw new Error(
        `No option matching ${q(want)} in ${q(fieldLabel)}` +
        // How far it looked is half the answer: "not in this list" and "not in the part
        // of the list that exists" are different facts (V6 §8).
        (scrolledFor
          ? ` (scrolled the list ${scrolledFor}× ${reachedEnd ? 'to the end' : 'without reaching the end'}; ` +
            `it renders only ${options.length} row${options.length === 1 ? '' : 's'} at a time)`
          : '') +
        `. Options seen: ${shown.join(', ')}${extra}`
      );
    }

    const chosen = optionText(match);

    // The toggle guard. We now know EXACTLY which option a click would hit, so we
    // can ask the only question that matters: is that value already selected? A
    // Workday multiselect deselects on re-pick, so clicking here would silently
    // clear a field the user already had set — asking for "India" against a pill
    // reading "India (+91)" is the way this happens in practice.
    if (multi && wdHolds(el, chosen)) {
      undoTyping();
      pressEscape(el); // this branch returns BEFORE the click, so the list is still open
      releaseFocus(el);
      return `${q(fieldLabel)} already holds ${q(truncate(chosen, 60))} — nothing to do. ` +
        'Clicking it again in a Workday multiselect would remove it.';
    }

    match.scrollIntoView({ block: 'nearest' });
    dispatchClickSequence(match);
    await sleep(wd ? 350 : 150);

    // CONTRACT-V5 §3. A Workday prompt only COMMITS on focus loss — the same trap
    // fill hits — and it does not echo the choice back into its search box, so the
    // search box is the wrong thing to read. Release focus (this also closes the
    // popup), then read the real value: the pills for a multiselect, the button's
    // own text for a single-select.
    if (wd) {
      releaseFocus(el);
      await sleep(150);
    }

    // CONTRACT-V3 §7.1 — "Chose X" may only be claimed when the control READS BACK
    // as X (mirrors select_option's did-not-stick branch). The click alone proves
    // nothing: a widget with its listener on another node ignores it entirely.
    const shows = wd
      ? wdPromptValue(el)
      : (el instanceof HTMLInputElement ? el.value : collapseWs(el.textContent));
    const stillOpen = match.isConnected && isVisible(match);
    const showsLower = shows.toLowerCase();
    const chosenLower = chosen.toLowerCase();
    const registered = wd
      // A prompt's value is a discrete list drawn from a closed set, so membership
      // is exact — the same test the two toggle guards use. Containment would let a
      // PRE-EXISTING pill vouch for a pick that never landed: with "Guinea-Bissau"
      // already chosen, a failed click on "Guinea" would report success.
      ? wdHolds(el, chosen)
      : Boolean(shows) && (
        showsLower === chosenLower ||
        showsLower.includes(chosenLower) ||
        // A typeahead may display a fuller form ("Austin, TX, USA" for "Austin") —
        // but require ≥3 chars before trusting the reverse containment.
        (shows.length >= 3 && chosenLower.includes(showsLower))
      );
    if (registered) {
      // The selection lives in the pills; the search box is only a filter. Most
      // Workday builds clear it themselves, but a stale probe string left behind
      // re-filters the list and reads to a human as if it were the value — so
      // clear it ourselves rather than trust the widget to.
      if (wd && typed && el instanceof HTMLInputElement && el.value && wdPromptContainer(el)) {
        setTextRaw(el, '');
        releaseFocus(el);
      }
      let result = `Chose ${q(chosen)} in ${q(fieldLabel)}. The control now shows: ${q(truncate(shows, 60))}`;
      if (stillOpen) result += ' The option list still looks open — call read_page to verify.';
      return result;
    }
    // Not registered: leave nothing behind. A Workday search box still holding the
    // probe text looks filled to a human and is empty to Workday — exactly the
    // confusion this whole change exists to end. The list is also most likely to
    // still be open on THIS path (the click did not take), so close it too.
    undoTyping();
    if (stillOpen) pressEscape(el);
    if (wd) releaseFocus(el);
    let failed = `Clicked option ${q(chosen)} in ${q(fieldLabel)}, but the control ${shows ? `still shows ${q(truncate(shows, 60))}` : 'reads back empty'} — the selection may not have registered.`;
    if (stillOpen) failed += ' The option list was still open, so the click may not have reached the widget.';
    return `${failed} Call read_page to verify before moving on.`;
  }

  // -------------------------------------------------------------- autofill
  // CONTRACT-V4 §7 — deterministic identity-field pass. Judgment fields (work
  // auth, salary, notice, screening answers) are deliberately NOT here; the
  // panel never sends them.

  /**
   * `re` claims a field; `not` disowns it. The exclusions are not decoration —
   * every one of them is a field a real portal put next to the one we want, that
   * the bare pattern would otherwise swallow (see the Workday names in comments).
   */
  const AUTOFILL_MATCHERS = [
    // (?<![a-z]) guards fname/lname: "fullname" contains "lname", and matcher order
    // would hand a full-name field to lastName and fill it with just the surname.
    { key: 'firstName', ac: ['given-name'], re: /first[\s_-]*name|(?<![a-z])fname|given[\s_-]*name|forename/i, not: /middle|last|family|surname|local|maiden|preferred/i },
    { key: 'lastName', ac: ['family-name'], re: /last[\s_-]*name|(?<![a-z])lname|surname|family[\s_-]*name/i, not: /first|given|middle|local|maiden|preferred/i },
    // "legalName" appears in EVERY Workday name field (legalName--middleName…), so
    // the legal-name pattern must be anchored and the middle-name field disowned —
    // unanchored, fullName lands the whole name in "Middle Name".
    { key: 'fullName', ac: ['name'], re: /full[\s_-]*name|your[\s_-]*name|applicant[\s_-]*name|^legal[\s_-]*name$|^name$/i, not: /first|last|middle|given|family|surname|initial|local|user|company|employer|school/i },
    // "verif" not "verify": /verify/ misses "emailVerification" and "email_verified".
    { key: 'email', ac: ['email'], re: /e[\s_-]*mail/i, not: /confirm|verif|re[\s_-]*(?:enter|type)/i },
    // \b guards: "cell" is inside "miscellaneous", "city" inside "capacity".
    // Workday's "Country Phone Code" and "Phone Extension" both contain "phone".
    { key: 'phone', ac: ['tel', 'tel-national'], re: /phone|mobile|\bcell\b/i, not: /code|country|extension|\bext\b|type|device/i },
    // Address, before `location`, so a real profile city claims the City box and the
    // one-line location does not have to be split to get there.
    // "Address" is a word three other fields use: "Email Address", "IP Address" and
    // Address Line 2 all contain it, and all three are disowned here.
    { key: 'addressLine1', ac: ['address-line1', 'street-address'], re: /address[\s_-]*(?:line[\s_-]*)?0*1\b|^address$|street[\s_-]*address|^street$|addr(?:ess)?1/i, not: /e[\s_-]*mail|\bip\b|line[\s_-]*0*2|city|state|province|region|country|postal|\bzip\b|apartment|\bapt\b|suite/i },
    { key: 'addressLine2', ac: ['address-line2'], re: /address[\s_-]*(?:line[\s_-]*)?0*2\b|addr(?:ess)?2|apartment|\bapt\b|\bsuite\b|\bunit\b/i, not: /e[\s_-]*mail|\bip\b|line[\s_-]*0*1|business[\s_-]*unit|organi[sz]ational[\s_-]*unit/i },
    { key: 'city', ac: ['address-level2'], re: /\bcity\b|\btown\b|municipality/i, not: /local|country|state|province|region|postal|\bzip\b|birth/i },
    // \bstate\b only: "Employment Status" and "United States" must not be read as a
    // State box, and a bare /state/ swallows both.
    // `code` disowns both of these: a State/Country *Code* box wants "KA" and "IN", and
    // writing "Karnataka" into it is exactly the silent corruption §7.1 forbids. Losing a
    // genuine one costs a fill call; getting it wrong costs a wrong application.
    { key: 'state', ac: ['address-level1'], re: /\bstate\b|province|\bregion\b|county/i, not: /country|united|status|statement|estate|real[\s_-]*state|birth|code/i },
    { key: 'postalCode', ac: ['postal-code'], re: /postal|post[\s_-]*code|\bzip\b|\bpin[\s_-]*code\b|pincode/i, not: /country|city|state|province/i },
    // Workday's "Country Phone Code" is a prompt (already excluded from candidates), but
    // plenty of other forms put a plain "Country code" text box next to the phone.
    { key: 'country', ac: ['country', 'country-name'], re: /\bcountry\b|\bnation\b/i, not: /phone|dial|code|citizen|nationality|birth|region/i },
    { key: 'location', ac: ['address-level2'], re: /\bcity\b|^location$|current[\s_-]*location/i, not: /local|country|state|region|postal|\bzip\b/i },
    { key: 'linkedin', ac: [], re: /linked[\s_-]*in/i },
    { key: 'github', ac: [], re: /git[\s_-]*hub/i },
    { key: 'portfolio', ac: [], re: /portfolio|personal[\s_-]*(?:web)?site|^website$|web[\s_-]*site/i },
  ];

  /** Empty, visible, writable, non-credential, non-dropdown text inputs. */
  function autofillCandidates() {
    const out = [];
    for (const el of deepQueryAll('input')) {
      if (!/^(text|email|tel|url|search)$/.test(el.type)) continue;
      if (!isVisible(el) || el.disabled || el.readOnly) continue;
      if (el.value.trim()) continue; // NEVER overwrite
      if (isCredentialField(el) || isSecretEl(el) || credentialAttrs(el)) continue; // CONTRACT-V2 §5.4
      // Typeaheads stay with choose_option — a typed value with no selected
      // suggestion is usually invalid.
      const role = (el.getAttribute('role') || '').toLowerCase();
      if (role === 'combobox' || el.getAttribute('aria-autocomplete') === 'list' || el.hasAttribute('aria-haspopup')) continue;
      // CONTRACT-V5 §4: a Workday prompt's search box declares none of the above —
      // it is a bare <input placeholder="Search">. Typing a phone number into the
      // "Country Phone Code" prompt is exactly the silent corruption §7.1 forbids.
      if (isWdPromptInput(el) || isPromptValueMirror(el)) continue;
      out.push(el);
    }
    return out;
  }

  function autofillHaystack(el) {
    return [
      el.getAttribute('name') || '',
      el.id || '',
      labelFor(el),
      el.getAttribute('placeholder') || '',
      el.getAttribute('aria-label') || '',
    ].filter(Boolean);
  }

  async function toolAutofill(args) {
    const fields = args.fields && typeof args.fields === 'object' ? args.fields : {};
    const candidates = autofillCandidates();
    const claimed = new Set();
    const filled = [];
    const notStuck = [];
    const unmatched = [];

    // When the profile carries a real city, the `city` matcher owns the City box and
    // `location` must stop claiming city fields entirely: the next thing it would find
    // is some OTHER city on the page — an employer's, a school's — and fill it with the
    // applicant's. Without a city value, `location` keeps its old behaviour.
    const hasCity = Boolean(collapseWs(String(fields.city || '')));
    const matchers = hasCity
      ? AUTOFILL_MATCHERS.map((m) => (m.key === 'location'
        ? { ...m, ac: [], re: /^location$|current[\s_-]*location/i }
        : m))
      : AUTOFILL_MATCHERS;

    for (const m of matchers) {
      let value = collapseWs(String(fields[m.key] || ''));
      if (!value) continue;

      let target = null;
      // An explicit autocomplete token beats every text heuristic — but NOT the
      // exclusions. Forms mislabel: autocomplete="tel" on a phone-extension box,
      // autocomplete="name" on "Preferred Name". A wrong token must not buy a field
      // an exemption from the very guard written to keep that field out.
      const excluded = (el) => Boolean(m.not) && autofillHaystack(el).some((part) => m.not.test(part));
      for (const el of candidates) {
        if (claimed.has(el) || excluded(el)) continue;
        const ac = (el.getAttribute('autocomplete') || '').toLowerCase().trim();
        if (m.ac.includes(ac)) { target = el; break; }
      }
      if (!target) {
        for (const el of candidates) {
          if (claimed.has(el) || excluded(el)) continue;
          if (autofillHaystack(el).some((part) => m.re.test(part))) { target = el; break; }
        }
      }
      if (!target) { unmatched.push(m.key); continue; }

      claimed.add(target);
      const label = labelFor(target) || target.getAttribute('name') || m.key;
      // A profile location is "Bengaluru, India"; Workday's City field wants just
      // "Bengaluru". Split ONLY for a field that is a city field — one labelled
      // "Location (city)" is asking for the whole string, so match the start of the
      // label (minus its required marker) rather than a "city" substring anywhere.
      if (m.key === 'location' && value.includes(',')) {
        const label = collapseWs(labelFor(target)).replace(/\*$/, '').trim();
        const name = collapseWs(target.getAttribute('name') || '');
        if (/^city\b/i.test(label) || /^city$/i.test(name)) value = collapseWs(value.split(',')[0]);
      }
      setTextCommitted(target, value);
      await sleep(30);
      // §7.1: the counts below are post-verification — a value that did not
      // stick is reported as NOT filled, never as success.
      if (target.value === value) {
        filled.push(`${q(truncate(label, 40))} = ${q(truncate(value, 40))}`);
      } else {
        notStuck.push(q(truncate(label, 40)));
      }
    }

    const parts = [];
    parts.push(filled.length
      ? `Autofilled ${filled.length} field${filled.length === 1 ? '' : 's'}: ${filled.join('; ')}.`
      : 'Autofilled 0 fields.');
    if (notStuck.length) parts.push(`Did NOT stick (fill individually): ${notStuck.join(', ')}.`);
    if (unmatched.length) parts.push(`No matching empty field for: ${unmatched.join(', ')}.`);
    return parts.join(' ');
  }

  // ------------------------------------------------------------ check_text
  // CONTRACT-V4 §3 — internal probe behind wait({until_text}). Not in TOOL_DEFS.

  function toolCheckText(args) {
    const want = collapseWs(String(args.text || '')).toLowerCase();
    if (!want) throw new Error('check_text needs {text}.');
    const root = document.body;
    const hay = collapseWs(root ? root.innerText || root.textContent || '' : '').toLowerCase();
    return hay.includes(want) ? 'found' : 'not-found';
  }

  // -------------------------------------------------------------- recorder
  // CONTRACT-V6. The user shows us how; we store the INTENT, not the events.
  //
  // Two hard rules, both structural rather than best-effort:
  //   §4  A secret is never read. Not buffered, not redacted afterwards — a
  //       credential field records the SHAPE of the step (request_secret) and its
  //       value is never touched. Grep this section: there is no path from a
  //       credential field's .value into a step.
  //   §3.1 A target is stored as an ordered LIST of locators. One CSS path is a
  //       recording that breaks on the next render.

  /**
   * The recorder's secret test, DELIBERATELY BROADER than the agent's isCredentialField.
   *
   * The two error directions are not symmetric here, and that asymmetry is the whole
   * design. A false positive costs one step: the field records as `request_secret` and
   * the model collects it through the vault, as it would anyway. A false negative writes
   * a LIVE credential — in plaintext, unencrypted — into a macro that is then re-typed on
   * every future application on that portal, at every employer.
   *
   * isCredentialField is tuned the other way on purpose (CONTRACT-V2 §5.4: it must not
   * sweep up "postal code" / "area code" and break ordinary form-filling), and the agent
   * path has a second line of defence the recorder does not: secretFilledEls, the sticky
   * WeakSet that only `toolFill` populates — and only when the AGENT fills a secret, never
   * when a human types one during a demonstration. So a `<input type="text" name="code">`
   * OTP box (see test/mock-login.html, which says as much) is invisible to the agent's
   * test and must not be invisible to this one.
   */
  const RECORD_SECRET_TOKENS =
    /password|passcode|passphrase|\bpin\b|\botp\b|\bmfa\b|\b2fa\b|one-?time|verification|verify|authenticat|\bcvv\b|\bcvc\b|\bssn\b|social[\s_-]*security|security[\s_-]*(?:code|answer|question)|account[\s_-]*number|routing|card[\s_-]*number|\bsecret\b|\btoken\b/i;

  // "code" means a credential ONLY when it is not one of the everyday codes. Flagging a
  // postal code as a secret would be a silly, visible failure; missing a 2FA code is a
  // quiet, permanent one — so the exclusions are named explicitly rather than guessed at.
  const CODE_WORD = /\bcode\b/i;
  const EVERYDAY_CODE = /postal|\bzip\b|post[\s_-]*code|area[\s_-]*code|country|phone|dial|promo|coupon|discount|referral|voucher|currency/i;

  function looksSecretToRecord(el) {
    if (isCredentialField(el) || isSecretEl(el)) return true;
    const hay = [
      el.getAttribute('name') || '', el.id || '', labelFor(el),
      el.getAttribute('placeholder') || '', el.getAttribute('aria-label') || '',
      el.getAttribute('autocomplete') || '',
    ].join(' ');
    if (RECORD_SECRET_TOKENS.test(hay)) return true;
    if (CODE_WORD.test(hay) && !EVERYDAY_CODE.test(hay)) return true;
    // Whatever it is called, a field sharing a form with a password box is part of a
    // credential flow. Replaying a recorded literal into one is never right.
    if (el.form && el.form.querySelector('input[type=password]')) return true;
    return false;
  }

  /** Generated ids are worse than useless as locators — they change every render. */
  function looksGeneratedId(id) {
    return (
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i.test(id) || // uuid (Workday's widget ids)
      /^:r[0-9a-z]+:$/i.test(id) ||                       // React useId
      /^(mui|radix|headlessui|ember|ext-gen)[-_]?\d+/i.test(id) ||
      /^[a-z]{1,4}\d{5,}$/i.test(id)
    );
  }

  /** A short, human-meaningful structural path — the locator of last resort. */
  function cssPath(el) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 6 && node !== document.body; depth++) {
      const tag = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) { parts.unshift(tag); break; }
      const sibs = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return parts.join(' > ');
  }

  /** Every stable handle we have on el, best first (CONTRACT-V6 §3.1). */
  function buildLocators(el) {
    const out = [];
    const tag = el.tagName.toLowerCase();
    const auto = el.getAttribute('data-automation-id');
    if (auto) out.push({ by: 'automation', value: auto });
    if (el.id && !looksGeneratedId(el.id)) out.push({ by: 'id', value: el.id });
    const name = el.getAttribute('name');
    if (name) out.push({ by: 'name', value: name });
    const label = labelFor(el);
    if (label && label !== '(unnamed)' && label !== '(credential field)') {
      out.push({ by: 'label', value: truncate(label, 120), tag });
    }
    // Accessible name — for BUTTONS and links only. buttonName() falls back to an
    // input's .value, which is the user's typed data, not an identity: storing it here
    // would be a useless locator AND would smuggle the value back into a macro that
    // §4 just took care to bind to the profile instead.
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
      const text = buttonName(el);
      if (text && text !== '(unnamed)' && text !== '(credential field)') {
        out.push({ by: 'text', value: truncate(text, 120), tag });
      }
    }
    out.push({ by: 'path', value: cssPath(el) });
    return out;
  }

  /** Candidates for one locator. Ambiguity is NOT resolved here — the caller rejects it. */
  function matchLocator(loc) {
    let els = [];
    try {
      if (loc.by === 'automation') {
        els = deepQueryAll(`[data-automation-id="${CSS.escape(loc.value)}"]`);
      } else if (loc.by === 'id') {
        els = deepQueryAll(`#${CSS.escape(loc.value)}`);
      } else if (loc.by === 'name') {
        els = deepQueryAll(`[name="${CSS.escape(loc.value)}"]`);
      } else if (loc.by === 'label') {
        els = deepQueryAll(loc.tag || '*')
          .filter((e) => labelFor(e) === loc.value);
      } else if (loc.by === 'text') {
        els = deepQueryAll(loc.tag || '*')
          .filter((e) => buttonName(e) === loc.value);
      } else if (loc.by === 'path') {
        els = deepQueryAll(loc.value);
      }
    } catch {
      return []; // a malformed stored locator must not take the whole replay down
    }
    return els.filter(isVisible);
  }

  /**
   * Resolve a locator LIST. Exactly one visible match wins; two matches means the
   * locator has gone ambiguous since it was recorded, so we fall through to the next
   * one rather than pick a coin-flip element and call it a success (§7.1).
   */
  function resolveLocators(locators) {
    const tried = [];
    for (const loc of locators || []) {
      const els = matchLocator(loc);
      if (els.length === 1) return { el: els[0], by: loc.by };
      tried.push(`${loc.by}=${q(truncate(String(loc.value), 40))}${els.length ? ` (${els.length} matches)` : ' (no match)'}`);
    }
    return { el: null, tried };
  }

  let recorder = null;

  function stepLabel(action, target, value) {
    // A control you CLICK is named by its own text; a field you fill is named by its label.
    // labelFor() falls back to precedingText(), which for a bare button or a <div> control
    // returns whatever copy happens to sit above it — so a button reading "Absenden", and a
    // div reading "Add Another", were both shown to the user as "Save and Continue". The
    // review modal is the one place the user decides what to keep; it must not name the
    // wrong control. Form controls are exempt: a clicked radio is still named by its label.
    const formControl = target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement;
    const clickable = action === 'click' && !formControl;
    // CONTRACT-V2 §0. buttonName() falls back to an input's own .value when it has no text,
    // and for an UNLABELLED one-time-code box that value is the code the user just typed.
    // The label is shown in the review modal and stored in the macro forever, so a
    // credential step may never be named from anything the user entered.
    const nameOf = (el) => (isSecretEl(el) || isCredentialField(el) ? '' : buttonName(el));
    const where = clickable
      ? (nameOf(target) || labelFor(target))
      : (labelFor(target) || nameOf(target)) ||
        collapseWs(target.getAttribute && target.getAttribute('name')) ||
        target.tagName.toLowerCase();
    if (action === 'click') return `Click ${q(truncate(where, 50))}`;
    if (action === 'request_secret') return `Ask the user for the credential in ${q(truncate(where, 50))}`;
    if (action === 'set_checkbox') return `${value ? 'Check' : 'Uncheck'} ${q(truncate(where, 50))}`;
    return `${action === 'fill' ? 'Fill' : 'Choose'} ${q(truncate(where, 50))} = ${q(truncate(String(value), 40))}`;
  }

  /**
   * Does this click submit the thing? It is the ONLY guard between a replayed macro and a
   * silent auto-submit when the user has autoSubmit off, so it must not rest on an English
   * word list alone: a wizard's real final control is often captioned "Continue", or
   * "Absenden", or nothing at all (an icon).
   */
  const IRREVERSIBLE_TEXT =
    /\b(submit|send|apply now|confirm|finish|complete application|pay|delete|absenden|bewerben|postuler|enviar|envoyer|inviare|candidatar)\b/i;

  function looksIrreversible(el) {
    if (IRREVERSIBLE_TEXT.test(buttonName(el) || '')) return true;
    // A submit button that really is inside a <form> WILL submit it. Guard on el.form:
    // a bare <button> defaults to type="submit" even with no form around it, and Workday's
    // wizard "Save and Continue" is exactly that — flagging it would stall every macro.
    if ((el instanceof HTMLButtonElement || el instanceof HTMLInputElement) &&
        el.type === 'submit' && el.form) return true;
    if (/submit|apply/i.test(el.getAttribute('data-automation-id') || '')) return true;
    return false;
  }

  /**
   * CONTRACT-V6 §8. A step is BANKED IN THE SERVICE WORKER the instant the user
   * performs it, never held here until the demonstration ends. This page is the
   * one thing guaranteed not to survive the demonstration: the user is showing us
   * how to get past an obstacle, and getting past it navigates.
   *
   * `el` is scratch — a live node, not serializable and not the worker's business.
   */
  function postStep(step) {
    const rec = recorder;
    if (!rec) return;
    const { el, ...wire } = step; // eslint-disable-line no-unused-vars
    // The most important step in a demonstration is usually the LAST one — the click that
    // finally got the user past the obstacle — and it is also the one whose page is about
    // to be torn down by the navigation it causes. This runs in a capture-phase listener,
    // so the message is handed to the browser process BEFORE the default action begins;
    // delivery does not depend on this page surviving. The catch swallows only the
    // response, which nobody is waiting on.
    // Where the step happened. A demonstration can legitimately cross hosts (a portal
    // bounces you through SSO), but it can also be dragged somewhere you never meant to
    // demonstrate — the page can open a tab while you are recording. The user cannot
    // consent to what they are not shown, so every step carries its origin.
    wire.host = location.hostname;
    // The worker answers {ok:false} when it will not bank a step. Discarding that answer
    // would throw away the only honest signal we get — the user would approve a
    // demonstration with a hole in it and never be told. Count it instead.
    const post = chrome.runtime
      .sendMessage({ kind: 'jobpilot:rec-step', step: wire })
      .then((resp) => {
        // "There is no recording" is not a dropped step, it is an ORPHANED recorder — this
        // frame outlived the session it belonged to (bfcache restores a frozen page with
        // its listeners intact and never re-runs the content script, so it is never told).
        // Stand down rather than keep watching a user who thinks nobody is.
        if (resp && resp.recording === false) {
          if (recorder === rec) { detachRecorder(); recorder = null; }
          return;
        }
        // The worker is watching a different tab and said so. The step is gone either way,
        // but it is not LOST — the worker counted it and knows where it came from, which is
        // strictly better than what this side could report. Counting it here as well would
        // have the panel report the same six steps twice, once as lost and once as refused.
        if (resp && resp.refused) return;
        if (!resp || !resp.ok) rec.unacked.push(wire.id);
      })
      .catch(() => { rec.unacked.push(wire.id); });
    rec.inflight.push(post);
  }

  function pushStep(step) {
    // A runaway guard, NOT the §2 cap. The cap is 30 and the worker enforces it — and it
    // has to, because it is the only place that sees every frame. Capping here as well
    // would mean the 31st step never left the page, so the worker could never count what
    // it dropped, and an over-long demonstration would truncate in silence.
    if (!recorder || recorder.steps.length >= 200) return null;
    step.id = `${recorder.frame}:${recorder.n++}`;
    recorder.steps.push(step);
    postStep(step);
    return step;
  }

  /** Re-post a step the coalescer revised in place; the worker upserts on id. */
  function revise(step) {
    postStep(step);
    return step;
  }

  /**
   * @param {string} [reuseId]  Take over an already-banked step's id, so this one
   *   REPLACES it in the session instead of being appended after it. That is how
   *   "click the dropdown, click an option" collapses to one choose_option that
   *   lands where the click was, keeping the steps in the order the user acted.
   */
  function recordTarget(action, el, value, reuseId) {
    const step = {
      action,
      locators: buildLocators(el),
      label: stepLabel(action, el, value),
    };
    if (action === 'set_checkbox') step.checked = Boolean(value);
    else if (value != null && action !== 'click') step.value = truncate(String(value), 200);
    if (action === 'click' && looksIrreversible(el)) step.irreversible = true;
    if (reuseId) {
      step.id = reuseId;
      recorder.steps.push(step);
      return revise(step);
    }
    return pushStep(step);
  }

  /**
   * §4. A credential field records its SHAPE and nothing else. el.value is never read
   * on this path — that is the whole guarantee, and it is why this is a separate
   * function rather than a branch that "skips the value".
   */
  function recordSecretStep(el) {
    const locators = buildLocators(el);
    const first = locators[0] ? locators[0].value : '';
    // The user may type, correct, and retype. One step per field, not per keystroke run.
    const already = recorder.steps.some(
      (s) => s.action === 'request_secret' && s.locators[0] && s.locators[0].value === first);
    if (already) return;

    // The LABEL is where a one-time code usually announces itself ("Verification code"),
    // so it belongs in the haystack — the kind decides which prompt the user sees.
    const hay = [
      el.getAttribute('name') || '', el.id || '', labelFor(el),
      el.getAttribute('placeholder') || '', el.getAttribute('autocomplete') || '',
    ].join(' ');
    const kind = el.type === 'password' ? 'password'
      : /one-time-code|\botp\b|one-?time|passcode|\bmfa\b|\b2fa\b|verif|authenticat|\bcode\b/i.test(hay) ? 'otp'
        : 'other';
    pushStep({ action: 'request_secret', locators, secretKind: kind, label: stepLabel('request_secret', el) });
  }

  /**
   * Only what the USER actually did. A page can dispatch click/change events at will, and
   * a recording window is exactly when it would want to: synthetic events could bury a
   * step the user never performed in a list they are about to approve. Untrusted events
   * are not recorded — the demonstration is the human's, or it is nothing.
   */
  function userDid(e) {
    return Boolean(recorder && e && e.isTrusted);
  }

  function onRecFocusIn(e) {
    if (!userDid(e)) return;
    const el = e.target;
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      // Baseline for the coalescer — for a credential field we store a marker, never
      // the characters (§4). WeakMap: no strong refs into a page we are leaving.
      recorder.before.set(el, looksSecretToRecord(el) ? null : el.value);
    }
  }

  function commitTextIfChanged(el) {
    if (!recorder) return;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    if (looksSecretToRecord(el)) { recordSecretStep(el); return; } // §4 — value never read
    if (el.type === 'checkbox' || el.type === 'radio' || el.type === 'file') return;
    if (isWdPromptInput(el)) return; // a prompt's search box is a filter; the pick is recorded on the option click
    const before = recorder.before.has(el) ? recorder.before.get(el) : '';
    if (el.value === before) return;
    recorder.before.set(el, el.value);
    // Coalesce: the same field typed into twice is ONE fill with the final value.
    const prior = [...recorder.steps].reverse().find((s) => s.action === 'fill' && s.el === el);
    if (prior) {
      prior.value = truncate(el.value, 200);
      prior.label = stepLabel('fill', el, el.value);
      revise(prior); // same id → the worker overwrites it rather than banking a second fill
      return;
    }
    const step = recordTarget('fill', el, el.value);
    if (step) step.el = el; // scratch only; never posted
  }

  function onRecChange(e) {
    if (!userDid(e)) return;
    const el = e.target;
    if (el instanceof HTMLSelectElement) {
      const opt = el.selectedIndex >= 0 ? el.options[el.selectedIndex] : null;
      recordTarget('select_option', el, opt ? collapseWs(opt.label || opt.textContent) : '');
      return;
    }
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      if (el.type === 'radio') recordTarget('click', el, null);
      else recordTarget('set_checkbox', el, el.checked);
      return;
    }
    commitTextIfChanged(el);
  }

  function onRecFocusOut(e) {
    if (!userDid(e)) return;
    commitTextIfChanged(e.target);
  }

  /**
   * The control the user clicked when it declares itself as no control at all.
   *
   * Workday and every React portal build controls out of bare <div>s with click
   * handlers — no role, no tag, nothing our selector can name. Those clicks used to
   * be dropped in silence, which is one of the ways a demonstration recorded nothing.
   *
   * `cursor: pointer` is the honest signal: the UA sets it on real controls (which we
   * already matched), so a plain <div> only has it because the page put it there to
   * tell the user "this is clickable". Read it walking up from the target — the styled
   * element is often an ancestor of the text node actually hit. Bounded, because a
   * full-page overlay can carry it too and is not what the user meant to click.
   */
  function pointerTarget(from) {
    const viewport = Math.max(1, innerWidth * innerHeight);
    let el = from;
    for (let up = 0; el && up < 4; up++, el = el.parentElement) {
      // A <label> is pointer-cursored almost by definition, and clicking one only focuses
      // or toggles the control it names — whose own fill/change we already record. Taking
      // it here would put back exactly the redundant step the actionable list drops.
      if (el instanceof HTMLLabelElement) return null;
      if (getComputedStyle(el).cursor !== 'pointer') continue;
      // A pointer-cursored WRAPPER around a real control is not the control: recording it
      // would double up with the control's own change event.
      if (el.querySelector('input, select, textarea, button, a[href]')) return null;
      const box = el.getBoundingClientRect();
      if (box.width * box.height > viewport * 0.6) return null; // an overlay, not a control
      return el;
    }
    return null;
  }

  /**
   * §3.2. The click that matters is the INTENT, not the DOM node. Clicking a dropdown
   * and then an option in its popup is ONE choose_option on the trigger — recording two
   * anonymous div clicks would replay as nothing at all.
   */
  function onRecClick(e) {
    if (!userDid(e)) return;
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;

    const option = el.closest(OPTION_ROLES);
    if (option && !option.closest(WD_SELECTED_LIST) && recorder.trigger) {
      const chosen = optionText(option);
      // The trigger's own click was "open the list", not a step. Take over its id so
      // the choose_option overwrites it in the session, in place.
      let reuse;
      if (recorder.triggerStep) {
        const i = recorder.steps.indexOf(recorder.triggerStep);
        if (i >= 0) recorder.steps.splice(i, 1);
        reuse = recorder.triggerStep.id;
      }
      recordTarget('choose_option', recorder.trigger, chosen, reuse);
      recorder.trigger = null;
      recorder.triggerStep = null;
      return;
    }

    // No <label>: clicking one only focuses (or toggles) the control it names, and that
    // control's own fill / change is already recorded. Keeping it would add a redundant
    // step for every field the user clicked into on their way to typing.
    const actionable = el.closest(
      'button, a[href], input, select, textarea, summary, [role=button], [role=combobox],' +
      '[role=checkbox], [role=radio], [role=link], [role=tab], [role=switch], [role=menuitem],' +
      '[role=menuitemcheckbox], [role=menuitemradio]') || pointerTarget(el);
    // Every early return past this point clears the pending trigger first. It marks "the
    // last click opened a dropdown, so the NEXT option click belongs to it" — and a trigger
    // left armed after the user walked away from that dropdown made the next unrelated
    // [role=option] click anywhere on the page record as a choice from a list they had
    // already abandoned.
    const dropTrigger = () => { recorder.trigger = null; recorder.triggerStep = null; };
    if (!actionable) { dropTrigger(); return; }
    if (actionable instanceof HTMLInputElement &&
        /^(checkbox|radio)$/.test(actionable.type)) { dropTrigger(); return; } // handled on `change`
    if (actionable instanceof HTMLSelectElement) { dropTrigger(); return; }    // handled on `change`

    // A dropdown-ish target: remember it, in case the next click is one of its options.
    if (isWdPrompt(actionable) || (actionable.getAttribute('role') || '') === 'combobox' ||
        actionable.hasAttribute('aria-haspopup')) {
      recorder.trigger = actionable;
      recorder.triggerStep = recordTarget('click', actionable, null);
      return;
    }
    if (actionable instanceof HTMLInputElement || actionable instanceof HTMLTextAreaElement) {
      dropTrigger();
      return; // typing, not clicking
    }

    dropTrigger();
    recordTarget('click', actionable, null);
  }

  /**
   * Idempotent: a frame can be armed twice — once by the panel arming every frame
   * that already exists, once by the frame itself on load (§8) — and a second arm
   * must not wipe the steps the first one is holding.
   */
  function toolRecordStart() {
    if (recorder) return 'Already recording.';
    recorder = {
      steps: [],
      before: new WeakMap(),
      trigger: null,
      triggerStep: null,
      inflight: [],
      unacked: [],   // ids the worker never confirmed — reported, never swallowed
      n: 0,
      // Step ids must be unique across every frame and page in the session, since
      // they all bank into one list. A per-frame token plus a counter is enough.
      frame: Math.random().toString(36).slice(2, 8),
    };
    document.addEventListener('focusin', onRecFocusIn, true);
    document.addEventListener('focusout', onRecFocusOut, true);
    document.addEventListener('change', onRecChange, true);
    document.addEventListener('click', onRecClick, true);
    return 'Recording. Perform the action in the page, then stop.';
  }

  function detachRecorder() {
    document.removeEventListener('focusin', onRecFocusIn, true);
    document.removeEventListener('focusout', onRecFocusOut, true);
    document.removeEventListener('change', onRecChange, true);
    document.removeEventListener('click', onRecClick, true);
  }

  /**
   * Flush and stand down. The steps are NOT returned from here — they were banked
   * in the session as they happened, and this frame holds only its own share of
   * them. The panel collects the whole demonstration from the worker.
   */
  async function toolRecordStop() {
    if (!recorder) return JSON.stringify({ flushed: 0, unacked: [] });
    // The focused field may hold a value the user typed and never blurred.
    if (document.activeElement) commitTextIfChanged(document.activeElement);
    detachRecorder();
    const rec = recorder;
    recorder = null;
    await Promise.all(rec.inflight); // every step is banked before the panel reads the session
    return JSON.stringify({ flushed: rec.steps.length, unacked: rec.unacked });
  }

  // §6: not a background keylogger — listeners die with the page. The steps are already in
  // the session, so a navigation mid-demonstration costs nothing; the next page arms itself
  // on load and keeps appending to the same list.
  //
  // Except when the page is only FROZEN. A bfcache-eligible page comes back with its
  // JavaScript intact, so the content script never re-runs and never greets — tearing the
  // recorder down here would silently stop the recording for the rest of that tab, with no
  // way to notice. Leave it armed; nothing fires while frozen.
  window.addEventListener('pagehide', (e) => {
    if (recorder && !e.persisted) { detachRecorder(); recorder = null; }
  });

  window.addEventListener('pageshow', async (e) => {
    if (!e.persisted) return;                 // a fresh document greets at init instead
    if (!recorder) { greetRecorder(); return; }
    // Restored still armed — but the demonstration may have ended while we were frozen.
    // Stand down rather than keep listening into a session nobody owns any more.
    try {
      const resp = await chrome.runtime.sendMessage({ kind: 'jobpilot:rec-hello' });
      if (!resp || !resp.recording) { detachRecorder(); recorder = null; }
    } catch { /* the worker rejects orphan steps anyway */ }
  });

  /**
   * §8. "Am I inside a recording?" Asked on load by every frame — including a frame
   * that did not exist when the user clicked Show me how, which is every frame of the
   * page they navigate to and every frame of a tab they open. That question is what
   * carries a demonstration across the navigation it causes.
   *
   * It runs on every frame of every page the user visits, so the NO answer must be
   * cheap: read the session flag straight from storage, and only talk to the worker
   * when a recording actually exists. Otherwise a page with thirty ad iframes would
   * wake the service worker thirty times to be told nothing is happening.
   *
   * If the flag cannot be read we ASK rather than assume — a silent "no" here would
   * be indistinguishable from the bug this whole section exists to fix.
   */
  async function greetRecorder() {
    // We used to read the session key straight from chrome.storage.session to skip this
    // message on the overwhelmingly common "no recording" path. That key holds the live
    // demonstration — every label and value the user typed — and reading it from here meant
    // it was readable from every frame of every page we inject into. The worker owns it now
    // and answers a question instead of exposing a record, so this always asks.

    // A recording may be running and this frame may belong in it, so a dropped hello is not a
    // no-op — it is the original bug, silently. Worth one retry: the worker may simply
    // have been mid-restart when we asked.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const resp = await chrome.runtime.sendMessage({ kind: 'jobpilot:rec-hello' });
        if (resp && resp.recording) toolRecordStart();
        return;
      } catch {
        if (attempt) return; // extension reloaded under us — there is nothing to record into
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  /** Replay ONE step. The panel drives the sequence so it can bind profile values
   *  and route credentials through the vault (CONTRACT-V6 §5.2). */
  async function toolReplayStep(args) {
    const step = args.step && typeof args.step === 'object' ? args.step : null;
    if (!step) throw new Error('replay_step needs {step}.');
    const { el, tried } = resolveLocators(step.locators);
    if (!el) {
      throw new Error(
        `Could not find the element for step ${q(step.label || step.action)} — the page has changed. ` +
        `Tried: ${(tried || []).join('; ')}`);
    }
    el.scrollIntoView({ block: 'center' });
    const ref = assignTempRef(el);
    switch (step.action) {
      case 'fill': return toolFill({ ref, value: step.value });
      case 'choose_option': return toolChooseOption({ ref, option: step.value });
      // `option`, not `value` — toolSelectOption reads args.option. Passing the wrong key
      // made `want` the empty string, which matches the ubiquitous <option value="">
      // placeholder, sets it, and passes its own read-back check. Every recorded native
      // <select> replayed as "chose the blank option" and reported success.
      case 'select_option': return toolSelectOption({ ref, option: step.value });
      case 'set_checkbox': return toolSetCheckbox({ ref, checked: step.checked });
      case 'click': return toolClick({ ref });
      default:
        throw new Error(`Step action ${q(step.action)} cannot be replayed in the page.`);
    }
  }

  // ----------------------------------------------------------- read_errors

  function toolReadErrors() {
    const texts = collectErrorTexts();
    // read_errors is the tool the model reaches for when a submit went nowhere, which is
    // exactly when an invisible captcha is the answer — so here EVERY kind is reported,
    // including the ones read_page stays quiet about because they may never fire.
    const captcha = detectCaptcha();
    if (captcha) {
      texts.push(
        `CAPTCHA on this page: ${captcha.desc}. A captcha can block submission even when no ` +
        'error text is shown. It is the USER\'s to solve, never yours — ask them to solve it in the tab.'
      );
    }
    if (!texts.length) return 'No visible errors.';
    return capString(texts.map((t) => `- ${t}`).join('\n'), 2000);
  }

  // =========================================================== CONTRACT-V7
  // The rung between "my recipe fits this control" and "a human must do it":
  // look at the real DOM (inspect_dom), then drive it with primitives (dom_act).
  // No eval anywhere — the vocabulary is closed (V7 §1).

  const INSPECT_CAP = 6000;
  const INSPECT_MAX_NODES = 60;
  const INSPECT_MAX_DEPTH = 3;
  const INSPECT_ATTR_CAP = 120;

  /**
   * The affordance test, shared with the recorder (V6 §8 DoD 3): a native control,
   * anything carrying a role, anything focusable — or anything the page gave
   * `cursor: pointer`, because that is what tells the USER it is a control, and a
   * `<div>` that looks clickable to a human is one.
   */
  function looksActionable(el) {
    if (!(el instanceof Element)) return false;
    const tag = el.tagName.toLowerCase();
    if (/^(input|select|textarea|button|a|summary|option|label)$/.test(tag)) return true;
    if (el.getAttribute('role')) return true;
    if (el.hasAttribute('onclick')) return true;
    if (el.isContentEditable === true) return true;
    if (el.tabIndex >= 0) return true;
    try { return getComputedStyle(el).cursor === 'pointer'; } catch { return false; }
  }

  /** Compact identity of a node: `<div#foo.bar[role=button][auto=promptOption]>`. */
  function nodeTag(el) {
    if (!(el instanceof Element)) return '<?>';
    const tag = el.tagName.toLowerCase();
    const id = el.id && !looksGeneratedId(el.id) ? `#${el.id}` : '';
    const cls = Array.from(el.classList).slice(0, 2).map((c) => `.${c}`).join('');
    const role = el.getAttribute('role') ? `[role=${collapseWs(el.getAttribute('role'))}]` : '';
    const auto = el.getAttribute('data-automation-id')
      ? `[auto=${truncate(collapseWs(el.getAttribute('data-automation-id')), 40)}]` : '';
    return `<${tag}${id}${cls}${role}${auto}>`;
  }

  /** Every attribute verbatim — this is the half read_page throws away. `style` is noise. */
  function attrDump(el) {
    const hide = isSecretEl(el) || isCredentialField(el);
    const parts = [];
    for (const a of Array.from(el.attributes)) {
      if (a.name === 'style') continue;
      const raw = a.name === 'value' && hide ? '(hidden)' : a.value;
      parts.push(`${a.name}=${q(truncate(collapseWs(raw), INSPECT_ATTR_CAP))}`);
    }
    return parts.join(' ');
  }

  /** The value a control currently holds — never a credential's (V7 §2). */
  function safeValue(el) {
    if (isSecretEl(el) || isCredentialField(el)) return '(hidden)';
    if (el instanceof HTMLSelectElement) {
      const o = el.options[el.selectedIndex];
      return o ? collapseWs(o.label || o.textContent) : '';
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value;
    if (el.isContentEditable === true) return collapseWs(el.textContent);
    return '';
  }

  function shortText(el) {
    return truncate(redactSecrets(collapseWs(el.textContent || '')), 80);
  }

  /** aria-selected / checked / expanded / disabled — the state a widget answers with. */
  function ariaState(el) {
    const bits = [];
    for (const name of ['aria-selected', 'aria-checked', 'aria-expanded', 'aria-disabled', 'aria-current']) {
      const v = el.getAttribute(name);
      if (v != null) bits.push(`${name.slice(5)}=${v}`);
    }
    if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      bits.push(`checked=${el.checked}`);
    }
    if (el.disabled === true) bits.push('disabled');
    return bits.length ? ` ${bits.join(' ')}` : '';
  }

  /** One inspect line, with a ref when the model could act on it. */
  function inspectLine(el, indent, budget) {
    const ref = looksActionable(el) && isVisible(el) && budget.refs-- > 0
      ? ` [${assignTempRef(el)}]` : '';
    const text = shortText(el);
    const val = safeValue(el);
    return `${' '.repeat(indent)}${nodeTag(el)}${ref}` +
      `${text ? ` ${q(text)}` : ''}${val ? ` value=${q(truncate(val, 60))}` : ''}` +
      `${ariaState(el)}${isVisible(el) ? '' : ' (not visible)'}`;
  }

  function inspectSubtree(root, out, budget) {
    const walk = (el, depth) => {
      // A web component keeps its real contents in a shadow root, and `children` stops at
      // that boundary — so inspecting the one kind of element you most need to look inside
      // printed an empty subtree and read as "there is nothing in here". deepQueryAll
      // crosses shadow roots everywhere else in this file; the inspector has to as well.
      const kids = Array.from(el.children);
      if (el.shadowRoot) kids.unshift(...Array.from(el.shadowRoot.children));
      for (const child of kids) {
        if (budget.nodes <= 0) return;
        budget.nodes--;
        out.push(inspectLine(child, 2 + depth * 2, budget));
        if (depth + 1 < INSPECT_MAX_DEPTH) walk(child, depth + 1);
      }
    };
    walk(root, 0);
  }

  const ID_REF_ATTRS = ['aria-controls', 'aria-owns', 'aria-activedescendant',
    'aria-labelledby', 'aria-describedby', 'list', 'popovertarget'];

  /** Whatever the element POINTS AT — the honest half of a combobox (V7 §2). */
  function relatedElements(el) {
    const out = [];
    const seen = new Set();
    for (const attr of ID_REF_ATTRS) {
      const raw = el.getAttribute(attr);
      if (!raw) continue;
      for (const id of collapseWs(raw).split(' ').filter(Boolean)) {
        let target = null;
        target = deepGetElementById(id, el);
        if (!target || seen.has(target)) continue;
        seen.add(target);
        out.push({ attr, id, el: target });
      }
    }
    return out;
  }

  const LAYER_SELECTOR = '[role=listbox], [role=dialog], [role=menu], [role=tree], [role=grid], [aria-modal=true], dialog[open]';

  /**
   * Where a portalled option list actually lives. Two sources, because the second is
   * the one that matters: a widget that declares itself (role=listbox/dialog), and a
   * bare absolutely-positioned child of <body> — which declares nothing, is reachable
   * from no attribute on the trigger, and is exactly what defeats choose_option.
   */
  function openLayers(exclude) {
    const found = [];
    const push = (el) => {
      if (!el || found.includes(el) || !isVisible(el)) return;
      if (exclude && (el.contains(exclude) || el === exclude)) return;
      found.push(el);
    };
    for (const el of deepQueryAll(LAYER_SELECTOR)) push(el);
    for (const el of Array.from(document.body ? document.body.children : [])) {
      if (found.includes(el)) continue;
      // A layer is a CONTAINER. A pinned button — a fixed "Apply now" bar, a
      // back-to-top — is positioned the same way and is not a popup; listing it
      // would bury the one thing this section exists to surface.
      if (!el.children.length) continue;
      if (/^(button|a|input|select|textarea|label)$/.test(el.tagName.toLowerCase())) continue;
      let pos = '';
      try { pos = getComputedStyle(el).position; } catch { pos = ''; }
      if (pos !== 'absolute' && pos !== 'fixed') continue;
      // Empty means "not a popup". LONG does not: a 500-row country list is exactly the
      // layer this exists to surface, and discarding it made inspect_dom say "OPEN LAYERS:
      // none visible right now" about the open dropdown the model was staring at. The cap
      // belongs on what is PRINTED, not on what is found.
      const text = collapseWs(el.textContent);
      if (!text) continue;
      push(el);
    }
    return found.slice(0, 4);
  }

  /** ref | selector → one element. Ambiguity is failure, never a coin flip (V6 §3.1). */
  function uniqueBySelector(sel, what) {
    let all;
    try {
      all = deepQueryAll(sel);
    } catch {
      throw new Error(`Invalid CSS selector ${q(sel)}.`);
    }
    if (!all.length) {
      // Sentinel: nothing was found and — for dom_act's first action — nothing was
      // performed, so the panel may safely retry this in another frame (V7 §4).
      throw new Error(`NO_TARGET_IN_FRAME: no element matches ${q(sel)} in this frame.`);
    }
    const visible = all.filter(isVisible);
    if (visible.length > 1) {
      const shown = visible.slice(0, 6).map((el) => `${nodeTag(el)} ${q(shortText(el))}`);
      throw new Error(
        `${q(sel)} matches ${visible.length} visible elements — narrow it, ${what} needs exactly one. ` +
        `Matched: ${shown.join(' | ')}${visible.length > 6 ? ' …' : ''}`
      );
    }
    return { el: visible[0] || all[0], hidden: visible.length === 0 };
  }

  function toolInspectDom(args) {
    let el;
    let how;
    let hidden = false;
    if (args.ref) {
      el = resolveRef(args.ref);
      how = `ref ${args.ref}`;
    } else {
      const sel = collapseWs(String(args.selector || ''));
      if (!sel) throw new Error('inspect_dom needs {ref} or {selector}.');
      const found = uniqueBySelector(sel, 'inspect_dom');
      el = found.el;
      hidden = found.hidden;
      how = `selector ${q(sel)}`;
    }

    const budget = { nodes: INSPECT_MAX_NODES, refs: 40 };
    const out = [];

    out.push(`TARGET (${how})${hidden ? ' — NOT VISIBLE to a user' : ''}`);
    out.push(`  ${inspectLine(el, 0, budget).trim()}`);
    out.push(`  attrs: ${attrDump(el) || '(none)'}`);
    const label = labelFor(el) || buttonName(el);
    if (label && label !== '(unnamed)') out.push(`  label: ${q(truncate(label, 100))}`);
    const rect = el.getBoundingClientRect();
    let cursor = '';
    try { cursor = getComputedStyle(el).cursor; } catch { cursor = ''; }
    out.push(`  box: ${Math.round(rect.width)}x${Math.round(rect.height)}` +
      ` cursor=${cursor || '?'} tabindex=${el.tabIndex}`);
    // V7 §8 — the reason a click "did nothing", stated before it happens.
    const blocker = clickBlocker(el);
    if (blocker) {
      out.push(`  COVERED BY: ${nodeTag(blocker)} ${q(truncate(collapseWs(blocker.textContent || ''), 80))}` +
        ' — a click here would land on that, not on the target. Deal with it first.');
    }
    if (rootOf(el) !== document) {
      out.push('  inside a shadow root (a web component) — CSS selectors from the main document will not reach it; use the ref.');
    }

    // Step OUT of a shadow root at its host rather than stopping there. An element inside a
    // web component has no parentElement at the boundary, so the chain used to come back
    // empty for exactly the widgets whose open/closed state lives on the host — the state
    // this section exists to show.
    const upFrom = (node) => {
      if (node.parentElement) return { el: node.parentElement, host: false };
      const root = node.getRootNode ? node.getRootNode() : null;
      return root && root.host ? { el: root.host, host: true } : null;
    };
    const ancestors = [];
    for (let step = upFrom(el), n = 0; step && n < 5; step = upFrom(step.el), n++) {
      const p = step.el;
      if (p === document.body || p === document.documentElement) break;
      ancestors.push(`  ${n + 1} ${nodeTag(p)}${step.host ? ' (shadow host)' : ''}${ariaState(p)}` +
        `${p.className && typeof p.className === 'string' ? ` class=${q(truncate(p.className, 80))}` : ''}`);
    }
    if (ancestors.length) {
      out.push('ANCESTORS (nearest first — custom widgets keep their open/closed state up here)');
      out.push(...ancestors);
    }

    const subtree = [];
    inspectSubtree(el, subtree, budget);
    if (subtree.length) {
      out.push(`SUBTREE (depth ${INSPECT_MAX_DEPTH}, ${subtree.length} nodes)`);
      out.push(...subtree);
    }

    const related = relatedElements(el);
    if (related.length) {
      out.push('RELATED (what this element points at)');
      for (const { attr, id, el: target } of related) {
        out.push(`  ${attr}="${id}" → ${inspectLine(target, 0, budget).trim()}`);
        const kids = [];
        budget.nodes = Math.max(budget.nodes, 20);
        inspectSubtree(target, kids, budget);
        out.push(...kids.slice(0, 15));
      }
    }

    const layers = openLayers(el);
    if (layers.length) {
      out.push('OPEN LAYERS (popups/menus rendered elsewhere in the document — a portalled option list is here)');
      for (const layer of layers) {
        out.push(`  ${inspectLine(layer, 0, budget).trim()}`);
        const kids = [];
        budget.nodes = Math.max(budget.nodes, 24);
        inspectSubtree(layer, kids, budget);
        out.push(...kids.slice(0, 20));
      }
    } else {
      out.push('OPEN LAYERS: none visible right now. (If this is a dropdown, dom_act a click on it and inspect again.)');
    }

    return capString(out.join('\n'), INSPECT_CAP);
  }

  // -------------------------------------------------------------- dom_act

  const DOM_ACT_MAX_ACTIONS = 12;
  const DOM_ACT_BUDGET_MS = 30000;
  const DOM_ACT_OPS = 'click, key, type, paste, hover, drag, scroll, focus, blur, scroll_into_view, wait_for, read';
  const MODIFIER_OPS = new Set(['click', 'key']);

  const KEY_CODES = {
    Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46,
    ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
    Home: 36, End: 35, PageUp: 33, PageDown: 34, ' ': 32,
  };

  // ------------------------------------------------- CONTRACT-V9: scrolling
  // A virtualized list (react-window, AG-Grid, most long Workday prompts) renders
  // only the rows in view. The option you want does not exist in the DOM until its
  // container scrolls — so no selector finds it, and no amount of waiting helps.

  function isScrollable(el) {
    if (!(el instanceof Element)) return false;
    let cs;
    try { cs = getComputedStyle(el); } catch { return false; }
    const y = (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1;
    const x = (cs.overflowX === 'auto' || cs.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1;
    return y || x;
  }

  /** The scroll container for an element — itself, an ancestor, or null for the page. */
  function scrollContainer(el) {
    for (let n = el; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      if (isScrollable(n)) return n;
    }
    return null;
  }

  function scrollState(container) {
    if (!container) {
      return { top: window.scrollY, max: Math.max(0, document.documentElement.scrollHeight - window.innerHeight) };
    }
    return { top: container.scrollTop, max: Math.max(0, container.scrollHeight - container.clientHeight) };
  }

  function scrollBy(container, delta) {
    if (!container) {
      window.scrollBy(0, delta);
      return;
    }
    container.scrollTop = Math.max(0, Math.min(container.scrollHeight, container.scrollTop + delta));
  }

  /** One "page" of the thing being scrolled — the step a human's wheel or key makes. */
  function pageStep(container) {
    const h = container ? container.clientHeight : window.innerHeight;
    return Math.max(80, Math.round(h * 0.85));
  }

  function keyInfo(raw) {
    let key = String(raw == null ? '' : raw);
    if (key === 'Space') key = ' ';
    if (key === 'Esc') key = 'Escape';
    if (!key) throw new Error('key needs {key}, e.g. "ArrowDown" or "Enter".');
    const keyCode = KEY_CODES[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    if (!keyCode) {
      throw new Error(`unsupported key ${q(key)}. Use a single character or one of: ${Object.keys(KEY_CODES).join(', ')}.`);
    }
    let code = key;
    if (key === ' ') code = 'Space';
    else if (/^[a-z]$/i.test(key)) code = `Key${key.toUpperCase()}`;
    else if (/^[0-9]$/.test(key)) code = `Digit${key}`;
    return { key, code, keyCode };
  }

  /** CONTRACT-V9 §2 — modifier flags, read off the action and used by keys and clicks. */
  function modifiersOf(a) {
    return {
      ctrlKey: a.ctrl === true,
      metaKey: a.meta === true,
      shiftKey: a.shift === true,
      altKey: a.alt === true,
    };
  }

  function modifierNote(mods) {
    const on = [];
    if (mods.ctrlKey) on.push('Ctrl');
    if (mods.metaKey) on.push('Meta');
    if (mods.shiftKey) on.push('Shift');
    if (mods.altKey) on.push('Alt');
    return on.length ? `${on.join('+')}+` : '';
  }

  function dispatchKey(el, raw, mods) {
    const { key, code, keyCode } = keyInfo(raw);
    const m = mods || {};
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      key, code, keyCode, which: keyCode,
      ctrlKey: !!m.ctrlKey, metaKey: !!m.metaKey, shiftKey: !!m.shiftKey, altKey: !!m.altKey,
    };
    el.dispatchEvent(new KeyboardEvent('keydown', base));
    // keypress is for character input, which a Ctrl/Meta/Alt chord is not.
    if (key.length === 1 && !base.ctrlKey && !base.metaKey && !base.altKey) {
      el.dispatchEvent(new KeyboardEvent('keypress', base));
    }
    el.dispatchEvent(new KeyboardEvent('keyup', base));
  }

  // ---------------------------------------------------- CONTRACT-V9 §4: drag

  function centreOf(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  /** Where this element sits among its siblings — the cheapest honest proof a reorder happened. */
  function siblingIndex(el) {
    return el.parentElement ? Array.prototype.indexOf.call(el.parentElement.children, el) : -1;
  }

  /**
   * A pointer drag, dispatched along the path rather than only at the ends.
   *
   * Sortable libraries (SortableJS, dnd-kit, react-beautiful-dnd) decide where a thing
   * lands from the moves in between, and several refuse to start at all until the
   * pointer has travelled a few pixels. A down-then-up with nothing between reads as a
   * click, which is why the naive version silently does nothing.
   */
  async function pointerDrag(source, to) {
    const from = centreOf(source);
    const pointer = (type, x, y, buttons) => new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      pointerId: 1, isPrimary: true, pointerType: 'mouse',
      clientX: x, clientY: y, buttons, button: 0,
    });
    const mouse = (type, x, y, buttons) => new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, buttons, button: 0, detail: 1,
    });

    try { source.focus(); } catch { /* not focusable */ }
    source.dispatchEvent(pointer('pointerdown', from.x, from.y, 1));
    source.dispatchEvent(mouse('mousedown', from.x, from.y, 1));

    const STEPS = 10;
    let last = source;
    for (let i = 1; i <= STEPS; i++) {
      const x = from.x + (to.x - from.x) * (i / STEPS);
      const y = from.y + (to.y - from.y) * (i / STEPS);
      // Dispatch on whatever is under the pointer, as the browser would — a sortable
      // list works out its drop slot from the element the move lands on.
      const under = topElementAt(x, y) || source;
      last = under;
      under.dispatchEvent(pointer('pointermove', x, y, 1));
      under.dispatchEvent(mouse('mousemove', x, y, 1));
      await sleep(20);
    }
    last.dispatchEvent(pointer('pointerup', to.x, to.y, 0));
    last.dispatchEvent(mouse('mouseup', to.x, to.y, 0));
  }

  /**
   * The HTML5 drag-and-drop protocol, for elements that opt into it with draggable.
   *
   * Returns what the TARGET said, because a drop leaves no trace on the source: the chip
   * does not move and keeps its place among its siblings, so the geometric checks a
   * pointer drag is verified with would call a perfectly good drop a failure. The
   * standard already provides the signal — `dragover.preventDefault()` is how a target
   * declares itself droppable, and cancelling `drop` is how it says it took the payload.
   */
  function html5Drag(source, target) {
    let dt = null;
    try { dt = new DataTransfer(); } catch { dt = null; }
    const drag = (type, el) => !el.dispatchEvent(new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window, dataTransfer: dt,
    })); // true when the listener called preventDefault
    drag('dragstart', source);
    drag('dragenter', target);
    const accepted = drag('dragover', target);
    const taken = drag('drop', target);
    drag('dragend', source);
    return { accepted, taken };
  }

  /**
   * A click as the hardware produces one.
   *
   * toolClick calls `el.click()` on native controls, which is right for activation and
   * WRONG for the controls dom_act exists for: `.click()` emits no pointer or mouse
   * events at all, so a `<button>` whose widget opens on `mousedown` — Workday's prompts,
   * most React comboboxes — never opens, and the tool reports a click that did nothing.
   * Dispatching the sequence by hand fixes that, but a synthetic `click` event does not
   * run every default action a real one would, so native elements still get `.click()`
   * afterwards for the submit/navigate/toggle behaviour.
   */
  function dispatchHumanClick(el, native, mods) {
    const m = mods || {};
    if (!native) {
      dispatchClickSequence(el, m);
      return;
    }
    const rect = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: Math.max(0, rect.left + rect.width / 2),
      clientY: Math.max(0, rect.top + rect.height / 2),
      button: 0, detail: 1,
      ctrlKey: !!m.ctrlKey, metaKey: !!m.metaKey, shiftKey: !!m.shiftKey, altKey: !!m.altKey,
    };
    try { el.focus(); } catch { /* not focusable */ }
    el.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse', buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, isPrimary: true, pointerType: 'mouse', buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...base, buttons: 0 }));
    el.click();
  }

  function dispatchHover(el) {
    const rect = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: Math.max(0, rect.left + rect.width / 2),
      clientY: Math.max(0, rect.top + rect.height / 2),
    };
    el.dispatchEvent(new PointerEvent('pointerover', { ...base, pointerId: 1, pointerType: 'mouse' }));
    el.dispatchEvent(new MouseEvent('mouseover', base));
    el.dispatchEvent(new MouseEvent('mouseenter', { ...base, bubbles: false }));
    el.dispatchEvent(new MouseEvent('mousemove', base));
  }

  /**
   * V7 §3.1 — an acting op may only touch what a human could touch. isVisible already
   * excludes aria-hidden subtrees and honeypot-sized text fields, and this is the first
   * feature able to aim at something read_page deliberately never showed the model.
   */
  function actTarget(a, opName) {
    let el;
    if (a.ref) {
      el = resolveRef(a.ref);
    } else if (a.selector) {
      el = uniqueBySelector(collapseWs(String(a.selector)), opName).el;
    } else {
      throw new Error(`${opName} needs {ref} or {selector}.`);
    }
    if (!isVisible(el)) {
      throw new Error(
        `${nodeTag(el)} is not visible to a user, so ${opName} will not touch it — JobPilot only operates ` +
        'controls a human could operate. If this is a hidden or honeypot field, leave it alone.'
      );
    }
    return el;
  }

  function describeActed(el) {
    let name = buttonName(el);
    if (name === '(unnamed)') name = labelFor(el) || shortText(el);
    return `${nodeTag(el)}${name ? ` ${q(truncate(name, 60))}` : ''}`;
  }

  function clampNum(v, lo, hi, dflt) {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(hi, Math.max(lo, n));
  }

  /** Select everything in a field, so the next insertion REPLACES rather than appends. */
  function selectAllIn(el) {
    try {
      if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
          typeof el.select === 'function') {
        el.select();
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch { /* nothing to select — the caller's own write still stands */ }
  }

  async function runDomAction(op, a) {
    // CONTRACT-V9 §2. Modifiers mean something to a click and to a key and nothing at
    // all to the other ten ops. Ignoring them silently would let the model believe it
    // sent a chord it never sent — so an op that cannot hold one says so.
    if (!MODIFIER_OPS.has(op)) {
      const stray = ['ctrl', 'meta', 'shift', 'alt'].filter((k) => a[k] === true);
      if (stray.length) {
        throw new Error(`${stray.join('/')} ${stray.length > 1 ? 'are' : 'is'} only meaningful on click and key, not on ${op}.`);
      }
    }
    switch (op) {
      case 'click': {
        const el = actTarget(a, 'click');
        if (findFilePickerTarget(el)) {
          throw new Error('that control opens a native file picker, which cannot be automated. Use upload_file on the file input.');
        }
        el.scrollIntoView({ block: 'center' });
        await assertNotBlocked(el, 'click');
        const native =
          el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement ||
          el instanceof HTMLInputElement || el instanceof HTMLLabelElement ||
          el instanceof HTMLSelectElement || el instanceof HTMLOptionElement;
        const mods = modifiersOf(a);
        dispatchHumanClick(el, native, mods);
        await sleep(150);
        return `${modifierNote(mods)}clicked ${describeActed(el)}`;
      }
      case 'key': {
        const el = actTarget(a, 'key');
        const times = clampNum(a.times, 1, 10, 1);
        const mods = modifiersOf(a);
        for (let n = 0; n < times; n++) {
          dispatchKey(el, a.key, mods);
          await sleep(60);
        }
        await sleep(120);
        return `pressed ${q(modifierNote(mods) + String(a.key))}${times > 1 ? ` ×${times}` : ''} on ${describeActed(el)}`;
      }
      case 'type': {
        const el = actTarget(a, 'type');
        // V7 §3.2 — request_secret keeps its monopoly. Same test, same message as fill.
        if (isCredentialField(el) || isSecretEl(el)) {
          throw new Error(
            'that is a credential field. dom_act never types credentials — call request_secret with that ref ' +
            'and the extension will collect the value from the user and fill it.'
          );
        }
        const value = String(a.value == null ? '' : a.value);
        if (a.clear) setTextRaw(el, '');
        setTextRaw(el, value);
        if (a.commit) releaseFocus(el);
        await sleep(120);
        // The same read-back discipline as toolFill (V3 §7.1). dom_act is the tool the
        // model reaches for AFTER fill already failed — exactly the fields most likely to
        // fight a raw write — so an unverified "typed X" here is the least earned success
        // in the file. The sequence continues either way; the verdict rides on this line.
        const now = (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
          ? el.value : collapseWs(el.textContent);
        if (now !== value && now !== collapseWs(value)) {
          return `typed ${q(truncate(value, 60))} into ${describeActed(el)}, but it now reads ` +
            `${now ? q(truncate(now, 60)) : 'EMPTY'} — the value did not stick. The field is ` +
            'script-controlled or masked: try fill on this ref (it retries with a real keystroke ' +
            'sequence), or paste — rich editors often accept only a paste event.';
        }
        return `typed ${q(truncate(value, 60))} into ${describeActed(el)}${a.commit ? ' and released focus' : ''}`;
      }
      case 'hover': {
        const el = actTarget(a, 'hover');
        el.scrollIntoView({ block: 'center' });
        dispatchHover(el);
        await sleep(150);
        return `hovered ${describeActed(el)}`;
      }
      case 'focus': {
        const el = actTarget(a, 'focus');
        try { el.focus(); } catch { throw new Error('that element cannot take focus.'); }
        return `focused ${describeActed(el)}`;
      }
      case 'blur': {
        const el = actTarget(a, 'blur');
        releaseFocus(el);
        await sleep(120);
        return `released focus from ${describeActed(el)}`;
      }
      case 'scroll_into_view': {
        const el = actTarget(a, 'scroll_into_view');
        el.scrollIntoView({ block: 'center' });
        await sleep(120);
        return `scrolled ${describeActed(el)} into view`;
      }
      case 'wait_for': {
        const sel = collapseWs(String(a.selector || ''));
        if (!sel) throw new Error('wait_for needs {selector}.');
        const gone = a.state === 'gone';
        const timeout = clampNum(a.timeout, 0.5, 10, 5) * 1000;
        const deadline = Date.now() + timeout;
        let everSeen = false;
        for (;;) {
          let n;
          try {
            n = deepQueryAll(sel).filter(isVisible).length;
          } catch {
            throw new Error(`invalid CSS selector ${q(sel)}.`);
          }
          if (n > 0) everSeen = true;
          if (gone ? n === 0 : n > 0) {
            // "It is gone" and "it was never here" are different claims, and only the first
            // one is evidence. A spinner living in the ATS iframe would otherwise be
            // declared gone by the main frame, which never had it (V6 §8).
            if (gone) {
              return everSeen
                ? `${q(sel)} is gone`
                : `${q(sel)} is gone — but it was never present in this frame, so this is not evidence that it ` +
                  'disappeared. If you expected it here, check the other frames with read_page.';
            }
            return `${q(sel)} is visible (${n} match${n > 1 ? 'es' : ''})`;
          }
          if (Date.now() >= deadline) {
            // Nothing was performed and nothing resolved, so the panel may try the next
            // frame — which is the whole point when the form lives in an iframe.
            if (!gone && !everSeen) {
              throw new Error(`NO_TARGET_IN_FRAME: ${q(sel)} never became visible within ${Math.round(timeout / 1000)}s.`);
            }
            throw new Error(`${q(sel)} ${gone ? 'was still visible' : 'never became visible'} within ${Math.round(timeout / 1000)}s.`);
          }
          await sleep(100);
        }
      }
      // ------------------------------------------------------- CONTRACT-V9
      case 'scroll': {
        const el = (a.ref || a.selector) ? actTarget(a, 'scroll') : null;
        const container = el ? (isScrollable(el) ? el : scrollContainer(el)) : null;
        const what = container ? describeActed(container) : 'the page';
        const before = scrollState(container);
        const countable = container || document;
        // IDENTITY, not cardinality. A virtualizer renders a constant-size window — 21 rows
        // before the scroll, 21 rows after, none of them the same node — so counting was
        // blind to exactly the case the warning below exists for. Hold a sample of the real
        // elements and ask afterwards whether they are still in the document.
        const beforeEls = deepQueryAll(DISCOVERY_SELECTOR, countable);
        const beforeCount = beforeEls.length;
        const sample = beforeEls.filter((_, i) => i % Math.ceil(beforeCount / 8 || 1) === 0).slice(0, 8);

        const times = clampNum(a.times, 1, 20, 1);
        if (a.to === 'top') {
          scrollBy(container, -(before.max + 1000));
        } else if (a.to === 'bottom') {
          scrollBy(container, before.max + 1000);
        } else {
          const step = a.by != null ? clampNum(a.by, -20000, 20000, 0) : pageStep(container);
          for (let n = 0; n < times; n++) {
            scrollBy(container, step);
            await sleep(80);
          }
        }
        await sleep(200); // let a virtualizer render the rows that just came into range
        const after = scrollState(container);
        const afterCount = deepQueryAll(DISCOVERY_SELECTOR, countable).length;

        if (after.top === before.top) {
          return `${what} did not move (already at ${before.top >= before.max ? 'the end' : 'that position'}, ` +
            `scroll ${Math.round(before.top)}/${Math.round(before.max)}).`;
        }
        // Rows that scrolled OUT of a virtualized list are gone from the DOM, and any
        // ref into them is dead. Saying so beats letting the model find out by acting.
        //
        // Two independent signals, because they catch different lists: `recycled` (a
        // sampled element is no longer in the document) catches the fixed-window
        // virtualizer that rebuilds its rows — the common shape, and the one a count
        // misses entirely — while a changed count catches a list that simply grew or shrank.
        const gone = sample.filter((elm) => !elm.isConnected).length;
        const recycled = gone > 0;
        const delta = afterCount - beforeCount;
        const churn = (recycled || delta !== 0)
          ? ` The rendered elements changed (${beforeCount} → ${afterCount}` +
            `${recycled ? `, and ${gone} of ${sample.length} sampled rows were REPLACED` : ''}) — ` +
            'this list renders only what is in view, so refs into it may now be stale; re-read or find again.'
          : '';
        return `scrolled ${what} to ${Math.round(after.top)}/${Math.round(after.max)}` +
          `${after.top >= after.max ? ' (the end)' : ''}.${churn}`;
      }
      case 'paste': {
        const el = actTarget(a, 'paste');
        // Same guard as type (V7 §3.2): a paste is still typing a credential.
        if (isCredentialField(el) || isSecretEl(el)) {
          throw new Error(
            'that is a credential field. dom_act never enters credentials — call request_secret with that ref ' +
            'and the extension will collect the value from the user and fill it.'
          );
        }
        const value = String(a.value == null ? '' : a.value);
        const readBack = () => (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)
          ? el.value : collapseWs(el.textContent);
        try { el.focus(); } catch { /* not focusable */ }
        // CONTRACT-V9 §3 puts `clear?` in paste's signature and the panel forwards it, but
        // nothing here ever read it — the flag was accepted end to end and discarded, so a
        // paste meant to REPLACE a value quietly appended to it. Select-all first: an
        // editor that handles the paste replaces the selection, and the direct-set fallback
        // below overwrites anyway.
        if (a.clear === true) selectAllIn(el);
        const before = readBack();

        let dt = null;
        try { dt = new DataTransfer(); dt.setData('text/plain', value); } catch { dt = null; }
        let handled = false;
        if (dt) {
          const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
          // preventDefault means the editor took it; a changed value means it took it anyway.
          const notCancelled = el.dispatchEvent(evt);
          await sleep(80);
          handled = !notCancelled || readBack() !== before;
        }
        if (!handled) {
          // A synthetic paste performs no default action, so nothing has been inserted.
          // Fall back to an ordinary set — and SAY which path ran, because "pasted" and
          // "typed" are different things to an editor that only listens for one.
          setTextRaw(el, value);
        }
        if (a.commit) releaseFocus(el);
        await sleep(120);
        // The fallback path gets the fill read-back (V3 §7.1): an editor that ignored the
        // paste event is exactly the kind that also ignores a raw set, and "the value was
        // set directly" was being said without ever looking. The handled path is left to
        // the page's own acknowledgement — rich editors legitimately transform what they
        // ingest, so a strict compare there would call every WYSIWYG a failure.
        if (!handled) {
          const now = readBack();
          if (now !== value && now !== collapseWs(value)) {
            return `tried to paste into ${describeActed(el)}, but the page ignored the paste event ` +
              `AND the direct set did not stick — it now reads ${now ? q(truncate(now, 60)) : 'EMPTY'}. ` +
              'The editor is script-controlled: try click on it first, then type, and verify with read.';
          }
        }
        return `pasted ${q(truncate(value, 60))} into ${describeActed(el)} — ` +
          (handled ? 'the page handled the paste event.' : 'the page ignored the paste event, so the value was set directly.');
      }
      case 'drag': {
        const source = actTarget(a, 'drag');
        await assertNotBlocked(source, 'drag');
        let target = null;
        if (a.to_ref || a.to_selector) {
          target = actTarget({ ref: a.to_ref, selector: a.to_selector }, 'drag onto');
        }
        const dx = clampNum(a.dx, -5000, 5000, 0);
        const dy = clampNum(a.dy, -5000, 5000, 0);
        if (!target && !dx && !dy) {
          throw new Error('drag needs somewhere to go: to_ref/to_selector, or dx/dy pixels.');
        }

        source.scrollIntoView({ block: 'center' });
        const startIndex = siblingIndex(source);
        const startRect = source.getBoundingClientRect();

        // OPTED IN, not merely draggable. `draggable` is true by default on <a href> and
        // <img>, so testing the property sent every link- or image-based sortable down the
        // HTML5 path — where its pointer handlers hear nothing and the drag silently does
        // nothing. Only an explicit attribute is a statement of intent.
        const optedIn = source.hasAttribute('draggable') &&
          String(source.getAttribute('draggable')).toLowerCase() !== 'false';
        if (target && optedIn) {
          // The element opted into the HTML5 protocol; pointer events would be ignored.
          // This path is verified by what the target said, not by where the source is.
          const { accepted, taken } = html5Drag(source, target);
          await sleep(150);
          if (accepted || taken) {
            return `dragged ${describeActed(source)} onto ${describeActed(target)} — the target accepted the drop.`;
          }
          return `dragged ${describeActed(source)} onto ${describeActed(target)}, but the target NEVER ACCEPTED it — ` +
            'it did not mark itself as a drop zone, so nothing was dropped. That is usually the wrong target, or a ' +
            'zone that only accepts files (use upload_file for those).';
        } else {
          const from = centreOf(source);
          const to = target ? centreOf(target) : { x: from.x + dx, y: from.y + dy };
          await pointerDrag(source, to);
        }
        await sleep(200);

        const where = target ? `onto ${describeActed(target)}` : `by ${dx},${dy}`;
        // A detached source is not a reorder. siblingIndex returns -1 for a node with no
        // parent, and -1 !== startIndex reads as "its position changed" — so a list that
        // REMOVES the dragged node (a rejected drop, a re-render, a drag out of the list)
        // reported a confident reorder that never happened. Say what is actually known.
        if (!source.isConnected) {
          return `dragged ${describeActed(source)} ${where}, but the element was REMOVED from the page during ` +
            'the drag, so where it ended up is unknown. Call read_page to see the current order before ' +
            'assuming this worked.';
        }
        const endIndex = siblingIndex(source);
        const endRect = source.getBoundingClientRect();
        const moved = Math.round(Math.abs(endRect.left - startRect.left) + Math.abs(endRect.top - startRect.top));
        if (endIndex !== startIndex) {
          return `dragged ${describeActed(source)} ${where} — its position among its siblings changed (${startIndex} → ${endIndex}).`;
        }
        if (moved > 2) {
          return `dragged ${describeActed(source)} ${where} — it moved ${moved}px on screen.`;
        }
        // The pointer protocol produced nothing. If the element is draggable only by
        // DEFAULT (<a>, <img>), the page may still be listening for the HTML5 protocol —
        // try the other one before declaring failure, and say which one worked.
        if (target && !optedIn && source.draggable === true) {
          const second = html5Drag(source, target);
          await sleep(150);
          if (second.accepted || second.taken) {
            return `dragged ${describeActed(source)} ${where} — pointer events did nothing, but the target ` +
              'accepted an HTML5 drop.';
          }
        }
        // A drag is the least verifiable action there is, so an unobservable one must
        // not be reported as a success (V3 §7.1).
        return `dragged ${describeActed(source)} ${where}, but NOTHING observably changed — ` +
          'the element did not move and its position among its siblings is the same. The page may not accept ' +
          'this kind of drag. Use read to check the real state before assuming it worked.';
      }
      case 'read': {
        // Looking is not touching (V7 §3.1): read may observe hidden nodes, and says so.
        let els;
        if (a.ref) {
          els = [resolveRef(a.ref)];
        } else {
          const sel = collapseWs(String(a.selector || ''));
          if (!sel) throw new Error('read needs {selector} or {ref}.');
          try {
            els = deepQueryAll(sel);
          } catch {
            throw new Error(`invalid CSS selector ${q(sel)}.`);
          }
          // A miss is a MISS, not a result. Returning success here ended the sequence in
          // this frame, so the panel's cross-frame fallthrough never ran and "nothing
          // matches" was said about one document as though it were the page (V6 §8).
          // read performs nothing, so the sentinel is always safe for it.
          if (!els.length) throw new Error(`NO_TARGET_IN_FRAME: nothing matches ${q(sel)}`);
        }
        const budget = { nodes: 0, refs: 20 };
        const lines = els.slice(0, 20).map((el) => `    ${inspectLine(el, 0, budget).trim()}`);
        const more = els.length > 20 ? `\n    …+${els.length - 20} more` : '';
        return `${els.length} match${els.length > 1 ? 'es' : ''}\n${lines.join('\n')}${more}`;
      }
      default:
        throw new Error(`unknown op ${q(op)}. Supported ops: ${DOM_ACT_OPS}.`);
    }
  }

  async function toolDomAct(args) {
    const actions = Array.isArray(args.actions) ? args.actions : [];
    if (!actions.length) {
      throw new Error(`dom_act needs {actions:[…]} with at least one action. Ops: ${DOM_ACT_OPS}.`);
    }
    if (actions.length > DOM_ACT_MAX_ACTIONS) {
      throw new Error(`dom_act takes at most ${DOM_ACT_MAX_ACTIONS} actions; you sent ${actions.length}. Split it into two calls.`);
    }

    // CONTRACT-V4 §5 — surface validation the sequence tripped, in the same result.
    const errorsBefore = new Set(collectErrorTexts().map((t) => t.toLowerCase()));
    const done = [];
    const deadline = Date.now() + DOM_ACT_BUDGET_MS;

    for (let i = 0; i < actions.length; i++) {
      const a = actions[i] && typeof actions[i] === 'object' ? actions[i] : {};
      const op = collapseWs(String(a.op || ''));
      try {
        if (Date.now() > deadline) {
          throw new Error(`dom_act ran out of its ${DOM_ACT_BUDGET_MS / 1000}s budget.`);
        }
        done.push(`${i + 1}. ${op}: ${await runDomAction(op, a)}`);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        // Nothing has run yet and nothing resolved: the panel may retry the whole
        // sequence in another frame (V7 §4). Only action 1 may claim this.
        if (i === 0 && msg.startsWith('NO_TARGET_IN_FRAME: ')) throw err;
        // V7 §3.3 — a half-performed sequence must say what it already did. The page
        // is now in the middle of something and the model's next move depends on it.
        throw new Error(
          `Stopped at action ${i + 1} (${op || 'missing op'}): ${msg.replace(/^NO_TARGET_IN_FRAME: /, '')}\n` +
          (done.length
            ? `Actions that DID run — their effects are on the page:\n${done.join('\n')}`
            : 'Nothing was performed.')
        );
      }
    }

    let out = done.join('\n');
    const fresh = collectErrorTexts().filter((t) => !errorsBefore.has(t.toLowerCase())).slice(0, 3);
    if (fresh.length) {
      out += `\nNew validation errors: ${fresh.map((t) => q(truncate(t, 120))).join(' ')}`;
    }
    return capString(out, 4000);
  }

  // ------------------------------------------------- "controlled by JobPilot"
  //
  // The page says, in the page, that it is not the user's right now.
  //
  // Everything the agent does happens with no cursor moving and no window focused: fields
  // fill themselves, a dropdown opens and closes, a wizard advances. Until now the only
  // account of that was in the side panel — which the user may have collapsed, or be
  // looking away from, or have open on another window. This is the answer to "why did that
  // just happen", put where the thing happened.
  //
  // FOUR CONSTRAINTS, and every one of them is load-bearing:
  //
  //  1. The page must not be able to read it. The pill names the step the agent is on, and
  //     that text can carry what the user is applying with. A CLOSED shadow root is the
  //     only construction where `host.shadowRoot` is null for page script.
  //  2. WE must not be able to read it either. read_page crosses OPEN shadow roots and
  //     dumps document.body — so an indicator built the obvious way would come back to the
  //     model as part of the page it is describing, and "JobPilot is controlling this tab"
  //     would be inventoried as page content. Closed root, appended OUTSIDE body.
  //  3. It must never absorb a click. `click` refuses to fire when something covers its
  //     target (a cookie banner eating a Submit is how a run "submits" an application that
  //     was never submitted) — a full-viewport overlay would trip that on every click in
  //     the top strip of the page. pointer-events:none keeps it out of hit testing
  //     entirely, for the agent and for the user.
  //  4. It must take itself down. The run ends, the panel is closed, the panel crashes —
  //     the first two send a message and the third cannot, so the page stops trusting the
  //     indicator on its own once the beats stop. A tab left claiming to be driven by
  //     something that no longer exists is worse than no indicator at all.

  const CTRL_TTL_MS = 30 * 1000;    // no beat for this long → nobody is driving this tab
  const CTRL_CHECK_MS = 5 * 1000;
  const CTRL_STATUS_CAP = 70;

  /** Only the top frame draws. A Workday form is three iframes deep; each would draw its
   *  own copy, two of them clipped inside a box in the middle of the page. */
  const IS_TOP_FRAME = (() => {
    try { return window.top === window; } catch { return false; }
  })();

  // "acting" is the agent driving. "watching" is request_demo: the run is still live, but
  // the USER is doing it and we are recording — and a pill claiming to control the tab
  // while the user types into it would be a plain lie.
  const CTRL_LABELS = {
    acting: 'JobPilot is controlling this tab',
    watching: 'JobPilot is watching — recording your demonstration',
  };

  // Everything is inside the shadow root, including the host's own layout (`:host`). No
  // style ATTRIBUTE anywhere: a page whose CSP omits 'unsafe-inline' for style-src would
  // drop one, and the indicator would be a full-viewport transparent nothing.
  // `!important` on the host's geometry because the page CAN style our host element even
  // though it cannot reach inside it.
  const CTRL_CSS = `
    :host{
      all: initial;
      position: fixed !important;
      inset: 0 !important;
      display: block !important;
      z-index: 2147483647 !important;
      pointer-events: none !important;
    }
    .ring{
      position: absolute; inset: 0; box-sizing: border-box;
      border: 2px solid rgba(91, 141, 239, .55);
      box-shadow: inset 0 0 22px rgba(91, 141, 239, .16);
    }
    :host([data-mode="watching"]) .ring{
      border-color: rgba(224, 83, 59, .55);
      box-shadow: inset 0 0 22px rgba(224, 83, 59, .16);
    }
    .pill{
      position: absolute; top: 12px; left: 50%; transform: translateX(-50%);
      display: flex; align-items: center; gap: 9px;
      box-sizing: border-box; max-width: calc(100vw - 32px);
      padding: 7px 15px 7px 12px; border-radius: 999px;
      background: rgba(16, 17, 20, .93); color: #eef0f5;
      border: 1px solid rgba(255, 255, 255, .10);
      box-shadow: 0 6px 22px rgba(0, 0, 0, .35);
      font: 500 12.5px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      white-space: nowrap;
    }
    .dot{
      width: 8px; height: 8px; border-radius: 50%; flex: none;
      background: #5b8def; animation: jp-pulse 2s infinite;
    }
    :host([data-mode="watching"]) .dot{ background: #e0533b; animation-duration: 1.4s; }
    .what{
      color: #98a1b2; font-size: 12px;
      border-left: 1px solid rgba(255, 255, 255, .14); padding-left: 9px;
      overflow: hidden; text-overflow: ellipsis; min-width: 0;
    }
    .what:empty{ display: none; }
    @keyframes jp-pulse{
      0%{ box-shadow: 0 0 0 0 rgba(91, 141, 239, .55); }
      70%{ box-shadow: 0 0 0 7px rgba(91, 141, 239, 0); }
      100%{ box-shadow: 0 0 0 0 rgba(91, 141, 239, 0); }
    }
    @media (prefers-reduced-motion: reduce){ .dot{ animation: none; } }
  `;

  let ctrlHost = null;   // the host element, or null whenever the indicator is down
  let ctrlWho = null;    // "JobPilot is controlling this tab" — inside the closed root
  let ctrlWhat = null;   // the live step
  let ctrlBeatAt = 0;    // last time the panel said it was still driving
  let ctrlTimer = null;

  /**
   * Built node by node rather than from an HTML string. `innerHTML` is a Trusted Types
   * sink, and on a site that enforces `require-trusted-types-for` it throws — which would
   * mean the indicator is missing on exactly the kind of large, strict employer portal
   * this extension exists to drive.
   */
  function buildIndicator() {
    const host = document.createElement('jobpilot-indicator');
    host.setAttribute('aria-hidden', 'true'); // decoration for a screen reader; the panel narrates
    const root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = CTRL_CSS;
    const ring = document.createElement('div');
    ring.className = 'ring';
    const pill = document.createElement('div');
    pill.className = 'pill';
    const dot = document.createElement('span');
    dot.className = 'dot';
    const who = document.createElement('span');
    who.className = 'who';
    const what = document.createElement('span');
    what.className = 'what';

    pill.append(dot, who, what);
    root.append(style, ring, pill);
    return { host, who, what };
  }

  /** Show it, or refresh what it says. Also the heartbeat — see checkIndicator. */
  function showIndicator(mode, status) {
    if (!IS_TOP_FRAME || !document.documentElement) return;
    ctrlBeatAt = Date.now();
    const key = mode === 'watching' ? 'watching' : 'acting';

    if (!ctrlHost) {
      const built = buildIndicator();
      ctrlHost = built.host;
      ctrlWho = built.who;
      ctrlWhat = built.what;
    }
    // documentElement, NOT body — constraint 2. Also re-appended if it is not connected:
    // a single-page app that swaps out the document takes the indicator with it, and the
    // tab is still being driven.
    if (!ctrlHost.isConnected) document.documentElement.appendChild(ctrlHost);

    ctrlHost.setAttribute('data-mode', key);
    ctrlWho.textContent = CTRL_LABELS[key];
    ctrlWhat.textContent = truncate(collapseWs(status), CTRL_STATUS_CAP);
    if (!ctrlTimer) ctrlTimer = setInterval(checkIndicator, CTRL_CHECK_MS);
  }

  function hideIndicator() {
    if (ctrlTimer) { clearInterval(ctrlTimer); ctrlTimer = null; }
    if (ctrlHost) { try { ctrlHost.remove(); } catch { /* went with the document */ } }
    ctrlHost = null;
    ctrlWho = null;
    ctrlWhat = null;
    ctrlBeatAt = 0;
  }

  /**
   * Constraint 4, and the only part of it that survives the panel dying.
   *
   * A run that ends normally — done, an error, Stop — sends ctrl-off, and closing the panel
   * sends one on its way out. A panel that CRASHES sends nothing, and the indicator would
   * then sit on the page for the rest of the tab's life announcing that a dead process is
   * typing into it. So the page stops believing it on its own.
   */
  function checkIndicator() {
    if (Date.now() - ctrlBeatAt > CTRL_TTL_MS) { hideIndicator(); return; }
    if (ctrlHost && !ctrlHost.isConnected && document.documentElement) {
      document.documentElement.appendChild(ctrlHost);
    }
  }

  /**
   * On load: "is this tab being driven?"
   *
   * The one thing the agent does constantly is navigate, and every navigation destroys this
   * script along with the indicator it was showing. Without this the indicator would vanish
   * at the exact moment the run got interesting and the new page would be driven in silence.
   * Only the top frame asks, so an ad-heavy page still wakes the worker exactly once.
   */
  async function greetControl() {
    if (!IS_TOP_FRAME) return;
    try {
      const resp = await chrome.runtime.sendMessage({ kind: 'jobpilot:ctrl-hello' });
      if (resp && resp.controlled) showIndicator(resp.mode, resp.status);
    } catch { /* worker restarting — the panel's next beat arms us instead */ }
  }

  // ------------------------------------------------------ dispatch + wire

  async function execTool(tool, args) {
    const a = args && typeof args === 'object' ? args : {};
    switch (tool) {
      case 'read_page': return toolReadPage(a);
      case 'find': return toolFind(a);
      case 'fill': return toolFill(a);
      case 'select_option': return toolSelectOption(a);
      case 'choose_option': return toolChooseOption(a);
      case 'click': return toolClick(a);
      case 'set_checkbox': return toolSetCheckbox(a);
      case 'upload_file': return toolUploadFile(a);
      case 'read_errors': return toolReadErrors();
      case 'autofill': return toolAutofill(a);
      case 'check_text': return toolCheckText(a);
      // CONTRACT-V7 — the DOM escape hatch: look, then drive it by hand.
      case 'inspect_dom': return toolInspectDom(a);
      case 'dom_act': return toolDomAct(a);
      // Internal: driven by the agent's request_captcha handoff, never called by the
      // model directly.
      case 'show_captcha': return toolShowCaptcha();
      // CONTRACT-V6 — internal: driven by the panel's recording UI and run_macro,
      // never exposed to the model in TOOL_DEFS.
      case 'record_start': return toolRecordStart();
      case 'record_stop': return toolRecordStop();
      case 'replay_step': return toolReplayStep(a);
      default:
        throw new Error(`Unknown content-script tool ${q(tool)}. Supported: read_page, find, fill, select_option, choose_option, click, set_checkbox, upload_file, read_errors, autofill, check_text, inspect_dom, dom_act.`);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg.kind !== 'string' || !msg.kind.startsWith('jobpilot:')) {
      return; // not ours — stay silent (contract §3)
    }
    if (msg.kind === 'jobpilot:ping') {
      sendResponse({ ok: true, ready: true });
      return;
    }
    // CONTRACT-V6 §6 — the worker ending a session must be able to end the RECORDERS.
    // pagehide is not enough: it is skipped for bfcache, and it never fires at all when the
    // session dies while the page stays open (the panel closed, the idle timer expired).
    if (msg.kind === 'jobpilot:rec-stop') {
      if (recorder) { detachRecorder(); recorder = null; }
      sendResponse({ ok: true });
      return;
    }
    // The worker driving the "controlled by JobPilot" indicator. Frame 0 only receives
    // these, and showIndicator refuses anyway if this is not the top frame.
    if (msg.kind === 'jobpilot:ctrl-show') {
      showIndicator(msg.mode, msg.status);
      sendResponse({ ok: true });
      return;
    }
    if (msg.kind === 'jobpilot:ctrl-hide') {
      hideIndicator();
      sendResponse({ ok: true });
      return;
    }
    if (msg.kind === 'jobpilot:exec') {
      Promise.resolve()
        .then(() => execTool(msg.tool, msg.args))
        .then((result) => sendResponse({ ok: true, result: String(result) }))
        .catch((err) => {
          const message = err && err.message ? err.message : String(err);
          console.debug('[jobpilot] tool failed:', msg.tool, message);
          sendResponse({ ok: false, error: message });
        });
      return true; // keep the channel open for the async response
    }
    // Unknown jobpilot:* kind — answer so the panel never hangs on a bad message.
    sendResponse({ ok: false, error: `Unknown message kind ${q(msg.kind)}.` });
  });

  greetRecorder(); // CONTRACT-V6 §8 — re-arm if this frame loaded into a live recording
  greetControl();  // …and re-show the indicator if the agent navigated us here

  console.debug('[jobpilot] content script ready in', location.href);
})();
