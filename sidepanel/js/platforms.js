// platforms.js — ATS portal detection (CONTRACT-V3 §2).
//
// Memory is keyed by PORTAL, not by employer: nvidia.wd5.myworkdayjobs.com and
// cisco.wd1.myworkdayjobs.com are the same Workday product with the same wizard.
// This module answers "which portal am I looking at?" so a playbook learned at one
// company applies at every other company on the same portal.

/**
 * @typedef {{platform: string|null, label: string, host: string,
 *            via: 'url'|'dom'|null, error: boolean}} Detection
 *
 * `error: true` means detection could not RUN (a blocked probe, a policy-restricted
 * origin) — which is not the same as "this page is not a job portal". Collapsing the two
 * is how a permanently broken detector hides forever, looking exactly like an ordinary
 * page. The chip surfaces it, and it is never cached, so the next tick retries.
 */

// rank 10 = a real ATS (the thing that owns the application form).
// rank  5 = an aggregator that usually wraps or links out to one. A Greenhouse form
//           embedded in a Glassdoor page must resolve to greenhouse, not glassdoor.
export const PLATFORMS = [
  {
    key: 'workday', label: 'Workday', rank: 10,
    hosts: [/(^|\.)myworkdayjobs\.com$/i, /(^|\.)myworkdaysite\.com$/i, /(^|\.)workday\.com$/i],
    // Specific automation-ids only. A bare `[data-automation-id]` matches a single element
    // anywhere in the DOM, so any page carrying one attribute — including inside an
    // unrelated third-party widget — would be labelled Workday and get Workday's
    // account-creation/credential steps injected into the prompt.
    dom: ['[data-automation-id="jobPostingHeader"]', '[data-automation-id="applyFlowContainer"]', '[data-automation-id="bottom-navigation-next-button"]'],
  },
  {
    key: 'greenhouse', label: 'Greenhouse', rank: 10,
    hosts: [/(^|\.)greenhouse\.io$/i],
    // Greenhouse's newer embed injects into the host page with no iframe, so the URL
    // pass misses it entirely — these selectors are the only way to see it.
    dom: ['#grnhse_app', '#grnhse_iframe', '#application_form', 'form[action*="greenhouse.io"]'],
  },
  {
    key: 'lever', label: 'Lever', rank: 10,
    hosts: [/(^|\.)lever\.co$/i],
    dom: ['.application-form[action*="lever"]', 'form[action*="jobs.lever.co"]', '[data-qa="application-form"]'],
  },
  {
    key: 'ashby', label: 'Ashby', rank: 10,
    hosts: [/(^|\.)ashbyhq\.com$/i],
    dom: ['#ashby_embed', '[class*="ashby-job-posting"]'],
  },
  {
    key: 'icims', label: 'iCIMS', rank: 10,
    hosts: [/(^|\.)icims\.com$/i],
    dom: ['#icims_content_iframe', '.iCIMS_MainWrapper', '[id^="icims_"]'],
  },
  {
    key: 'taleo', label: 'Taleo', rank: 10,
    hosts: [/(^|\.)taleo\.net$/i],
    dom: ['#requisitionDescriptionInterface', '[id^="requisitionDescriptionInterface"]'],
  },
  {
    key: 'successfactors', label: 'SAP SuccessFactors', rank: 10,
    hosts: [/(^|\.)successfactors\.(com|eu)$/i, /(^|\.)sapsf\.(com|eu)$/i, /(^|\.)jobs2web\.com$/i],
    // "EasyApply---" is the component id prefix of SAP's EasyApply recruiting app — every
    // control on those pages carries it. It is the fingerprint that matters most here:
    // employers deploy EasyApply on their own SAP BTP hosts (cfapps.<region>.hana.ondemand.com),
    // where no host rule can reasonably fire — hana.ondemand.com hosts every kind of SAP
    // app, so matching the HOST would label half of SAP's cloud as a job portal. The DOM
    // prefix is precise, employer-independent, and survives the custom domain entirely.
    dom: ['[id^="careerSite"]', '.jobDescription[data-careersite]', '[id^="EasyApply---"]'],
  },
  {
    key: 'pi_loga', label: 'P&I LOGA', rank: 10,
    // pi-asp.de is P&I's own ASP hosting (…/bewerber-web/). Tenants on custom domains are
    // caught by the DOM pass: "LG-" is LOGA's CSS namespace, and the form table plus the
    // div-buttons carry it on every deployment.
    hosts: [/(^|\.)pi-asp\.de$/i],
    dom: ['.LG-FormBox', '.LG-Button', 'input.LG-TextBox'],
  },
  {
    key: 'smartrecruiters', label: 'SmartRecruiters', rank: 10,
    hosts: [/(^|\.)smartrecruiters\.com$/i],
    dom: ['#sr-app', '[class*="smartrecruiters"]'],
  },
  {
    key: 'workable', label: 'Workable', rank: 10,
    hosts: [/(^|\.)workable\.com$/i],
    dom: ['#workable-embed', '[data-ui="application-form"]'],
  },
  {
    key: 'jobvite', label: 'Jobvite', rank: 10,
    hosts: [/(^|\.)jobvite\.com$/i],
    dom: ['.jv-page', '[class^="jv-"]'],
  },
  {
    key: 'bamboohr', label: 'BambooHR', rank: 10,
    hosts: [/(^|\.)bamboohr\.com$/i],
    dom: ['#BambooHR-ATS', '[class*="BambooHR"]'],
  },
  {
    key: 'eightfold', label: 'Eightfold', rank: 10,
    hosts: [/(^|\.)eightfold\.ai$/i],
    dom: ['[class*="eightfold"]', '#pcs-body-container'],
  },
  {
    key: 'phenom', label: 'Phenom', rank: 10,
    hosts: [/(^|\.)phenompeople\.com$/i],
    dom: ['[class*="phenom"]', '#ph-job-description'],
  },
  {
    key: 'recruitee', label: 'Recruitee', rank: 10,
    hosts: [/(^|\.)recruitee\.com$/i],
    dom: ['[class*="recruitee"]'],
  },
  {
    key: 'teamtailor', label: 'Teamtailor', rank: 10,
    hosts: [/(^|\.)teamtailor\.com$/i],
    dom: ['[class*="teamtailor"]'],
  },
  {
    key: 'linkedin', label: 'LinkedIn', rank: 5,
    hosts: [/(^|\.)linkedin\.com$/i],
    dom: [],
  },
  {
    key: 'indeed', label: 'Indeed', rank: 5,
    hosts: [/(^|\.)indeed\.com$/i, /(^|\.)indeed\.co\.[a-z]{2}$/i],
    dom: [],
  },
  {
    key: 'glassdoor', label: 'Glassdoor', rank: 5,
    hosts: [/(^|\.)glassdoor\.(com|co\.[a-z]{2}|[a-z]{2})$/i],
    dom: [],
  },
];

const BY_KEY = new Map(PLATFORMS.map((p) => [p.key, p]));

export function platformLabel(key) {
  const p = BY_KEY.get(key);
  return p ? p.label : String(key || '');
}

// Cache on tabId + top-frame URL. detectPlatform runs once per agent step, so without
// this every step would re-probe the DOM of an unchanged page for nothing.
const cache = new Map(); // tabId -> {url, detection}

export function clearDetectionCache(tabId) {
  if (tabId === undefined) cache.clear();
  else cache.delete(tabId);
}

const NONE = { platform: null, label: '', host: '', via: null, error: false };

/**
 * Which ATS portal is this tab on? (CONTRACT-V3 §2)
 *
 * Best-effort by contract: a restricted page, a closed tab, or a failed probe all
 * resolve to {platform:null}. It never throws — a detection failure must never break
 * a run, it just means no playbook.
 *
 * @param {number} tabId
 * @returns {Promise<Detection>}
 */
export async function detectPlatform(tabId) {
  let topUrl = '';
  try {
    const tab = await chrome.tabs.get(tabId);
    topUrl = tab.url || tab.pendingUrl || '';
  } catch (err) {
    console.debug('[JobPilot] could not read tab', tabId, err);
    return { ...NONE };
  }
  if (!topUrl || isRestrictedUrl(topUrl)) return { ...NONE };

  const cached = cache.get(tabId);
  if (cached && cached.url === topUrl && !cachedIsStale(cached)) return { ...cached.detection };

  // The host is always the TOP frame's, even when the platform came from an iframe:
  // it keys site notes, so it must name the employer, not the ATS vendor.
  const host = hostOf(topUrl);

  let detection = { platform: null, label: '', host, via: null, error: false };

  const byUrl = await detectByFrameUrls(tabId, topUrl);
  // A LOW-RANK match from a SUBFRAME is not evidence about the page. Every company careers
  // page carries a LinkedIn follow widget or a Facebook pixel in an iframe, and taking that
  // as the answer both mislabelled the page and skipped the DOM pass — which is the only
  // thing that finds the whitelabeled Workday the user is actually looking at. A top-frame
  // match still wins outright: there you really are on the aggregator.
  const weakEmbed = byUrl && byUrl.rank < 10 && byUrl.frameId !== 0;
  if (byUrl && !weakEmbed) {
    detection = { platform: byUrl.entry.key, label: byUrl.entry.label, host, via: 'url', error: false };
  } else {
    const { entry, error } = await detectByDom(tabId, topUrl);
    if (entry) detection = { platform: entry.key, label: entry.label, host, via: 'dom', error: false };
    else if (byUrl) detection = { platform: byUrl.entry.key, label: byUrl.entry.label, host, via: 'url', error: false };
    else detection = { platform: null, label: '', host, via: null, error };
  }

  // Never cache a failure: a transient block would otherwise pin "no portal" for the whole
  // life of the tab, and the user would never see the feature come back.
  if (!detection.error) cache.set(tabId, { url: topUrl, detection, at: Date.now() });
  return { ...detection };
}

// A HIT is a fact about the page and keeps for the life of the URL. A MISS is a fact about
// one MOMENT: an SPA careers page mounts its Greenhouse iframe a second after document_idle,
// and caching "no portal" against a URL that never changes pinned that answer forever — no
// playbook, no macros, blank chip, for the rest of the tab. So a miss expires and a hit
// does not.
const NEGATIVE_TTL_MS = 8000;

function cachedIsStale(cached) {
  if (cached.detection && cached.detection.platform) return false;
  return Date.now() - (cached.at || 0) > NEGATIVE_TTL_MS;
}

/**
 * Pass 1 — frame URLs. Reuses the same getAllFrames() call tools.js already makes.
 * This is what catches the embed case for free: a company careers page that iframes
 * Greenhouse names greenhouse.io in a frame URL, so no DOM work is needed.
 */
async function detectByFrameUrls(tabId, topUrl) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch (err) {
    // Never fatal — but without a trace here, a permanently broken detection looks
    // exactly like "this page is not a job portal", and nobody can tell the difference.
    console.debug('[JobPilot] getAllFrames failed for tab', tabId, err);
    frames = null;
  }
  if (!frames || !frames.length) frames = [{ frameId: 0, url: topUrl }];

  let best = null; // {entry, rank, frameId}
  for (const frame of frames) {
    const fHost = hostOf(frame.url || '');
    if (!fHost) continue;
    const entry = matchHost(fHost);
    if (!entry) continue;
    const frameId = Number(frame.frameId) || 0;
    if (!best || entry.rank > best.rank || (entry.rank === best.rank && frameId < best.frameId)) {
      best = { entry, rank: entry.rank, frameId };
    }
  }
  return best;
}

/**
 * Pass 2 — DOM signals, only when no frame URL matched. Covers whitelabeled portals on
 * a company domain (careers.acme.com fronting Workday) and Greenhouse's script-injected
 * embed, which has no iframe to give it away.
 *
 * Probes the top frame and SAME-ORIGIN subframes only. Probing every frame would let an
 * unrelated third-party iframe (an ad, a chat widget) decide what portal the user is on
 * just by happening to carry a matching class or attribute — and a mislabelled page gets
 * that portal's playbook, including its account-creation and credential steps, injected
 * into the prompt. Both cases this pass exists for live in the page's own origin, so
 * nothing is lost by refusing to listen to foreign frames.
 */
async function detectByDom(tabId, topUrl) {
  const probes = PLATFORMS
    .filter((p) => p.dom.length)
    .map((p) => ({ key: p.key, rank: p.rank, dom: p.dom }));

  const topHost = hostOf(topUrl);
  const frameIds = [0];
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    for (const f of frames || []) {
      if (!f.frameId) continue;
      if (f.url && hostOf(f.url) === topHost) frameIds.push(f.frameId);
    }
  } catch { /* top frame alone will do */ }

  let results;
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, frameIds },
      func: domProbe,
      args: [probes],
    });
  } catch (err) {
    console.debug('[JobPilot] DOM platform probe failed for tab', tabId, err);
    return { entry: null, error: true }; // blocked/restricted — NOT "no portal here"
  }

  let best = null;
  for (const r of results || []) {
    const key = r && r.result;
    if (!key) continue;
    const entry = BY_KEY.get(key);
    if (!entry) continue;
    if (!best || entry.rank > best.rank) best = entry;
  }
  return { entry: best, error: false };
}

// Runs in the page (serialized — no closure over module scope, no imports).
// Returns the highest-ranked platform key whose selectors match, or null.
function domProbe(probes) {
  let best = null;
  for (const p of probes) {
    for (const sel of p.dom) {
      let hit = false;
      try { hit = Boolean(document.querySelector(sel)); } catch { hit = false; }
      if (hit) {
        if (!best || p.rank > best.rank) best = p;
        break;
      }
    }
  }
  return best ? best.key : null;
}

function matchHost(host) {
  let best = null;
  for (const entry of PLATFORMS) {
    if (entry.hosts.some((re) => re.test(host))) {
      if (!best || entry.rank > best.rank) best = entry;
    }
  }
  return best;
}

/** Hostname, `www.` stripped. '' when the URL is not parseable. */
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function isRestrictedUrl(url) {
  return /^(chrome|chrome-extension|edge|about|devtools|view-source):/i.test(url) ||
    /^https:\/\/chrome\.google\.com\/webstore/i.test(url) ||
    /^https:\/\/chromewebstore\.google\.com/i.test(url);
}
