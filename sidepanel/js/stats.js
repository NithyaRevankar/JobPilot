// stats.js — live throughput, context-window usage, and session cost.
//
// Three questions this answers, and where each number actually comes from:
//   tokens/sec  — measured over wall-clock while the reply streams. During the stream it
//                 is estimated from characters (the provider only sends token counts at
//                 the end); when the usage event lands, the final rate is exact.
//   context     — the input tokens of the most recent request, CACHED ONES INCLUDED. That
//                 is, by definition, how full the window is right now: the whole
//                 conversation is re-sent every turn, so the last request's input is the
//                 current occupancy. A cached token is cheaper, not absent, so it counts.
//   cost        — accumulated per request from a price table, with settings overrides.
//
// Scope: every figure here except `context` is a total for THIS conversation — they are
// reset together when a new chat starts. Mixing a conversation-scoped gauge with totals
// that outlived the conversation is how this HUD came to show a context of 24k beside
// 6.08M of input.
//
// Honesty rule: anything derived from a character estimate is flagged `estimated`, and
// the UI must say so. A guessed number presented as a measurement is worse than no number.

const PER_MILLION = 1e6;

// Below this, a stream is a single burst rather than a rate worth measuring.
const MIN_RATE_WINDOW_MS = 200;

/**
 * Known models: context window (tokens) and price per 1M tokens (USD).
 * Matched by longest substring, so "claude-opus-4-8[1m]" hits "claude-opus-4".
 * Unknown models fall back to the settings overrides, then to a null price (cost hidden
 * rather than fabricated).
 */
const MODELS = [
  // Anthropic
  { match: 'claude-opus-4', context: 200000, in: 5, out: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: 'claude-sonnet-5', context: 200000, in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: 'claude-sonnet-4', context: 200000, in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: 'claude-haiku-4', context: 200000, in: 1, out: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  { match: 'claude-3-5-haiku', context: 200000, in: 0.8, out: 4 },
  { match: 'claude-3-5-sonnet', context: 200000, in: 3, out: 15 },
  { match: 'claude-3-opus', context: 200000, in: 15, out: 75 },
  { match: 'claude-fable-5', context: 200000, in: 3, out: 15 },
  { match: 'claude', context: 200000, in: 3, out: 15 },

  // OpenAI
  { match: 'gpt-4o-mini', context: 128000, in: 0.15, out: 0.6 },
  { match: 'gpt-4o', context: 128000, in: 2.5, out: 10 },
  { match: 'gpt-4.1-mini', context: 1047576, in: 0.4, out: 1.6 },
  { match: 'gpt-4.1-nano', context: 1047576, in: 0.1, out: 0.4 },
  { match: 'gpt-4.1', context: 1047576, in: 2, out: 8 },
  { match: 'gpt-4-turbo', context: 128000, in: 10, out: 30 },
  { match: 'gpt-4', context: 8192, in: 30, out: 60 },
  { match: 'gpt-3.5-turbo', context: 16385, in: 0.5, out: 1.5 },
  { match: 'o4-mini', context: 200000, in: 1.1, out: 4.4 },
  { match: 'o3-mini', context: 200000, in: 1.1, out: 4.4 },
  { match: 'o3', context: 200000, in: 2, out: 8 },
  { match: 'o1-mini', context: 128000, in: 1.1, out: 4.4 },
  { match: 'o1', context: 200000, in: 15, out: 60 },

  // Google
  { match: 'gemini-2.5-pro', context: 1048576, in: 1.25, out: 10 },
  { match: 'gemini-2.5-flash', context: 1048576, in: 0.3, out: 2.5 },
  { match: 'gemini-2.0-flash', context: 1048576, in: 0.1, out: 0.4 },
  { match: 'gemini', context: 1048576, in: 0.3, out: 2.5 },

  // Open weights — free when self-hosted, hence price 0 (context is what matters).
  { match: 'deepseek-r1', context: 128000, in: 0.55, out: 2.19 },
  { match: 'deepseek', context: 128000, in: 0.27, out: 1.1 },
  { match: 'llama-3.3', context: 128000, in: 0, out: 0 },
  { match: 'llama-3.1', context: 128000, in: 0, out: 0 },
  { match: 'llama', context: 128000, in: 0, out: 0 },
  { match: 'qwen', context: 32768, in: 0, out: 0 },
  { match: 'mistral', context: 32768, in: 0, out: 0 },
  { match: 'mixtral', context: 32768, in: 0, out: 0 },
  { match: 'gemma', context: 8192, in: 0, out: 0 },
  { match: 'phi', context: 128000, in: 0, out: 0 },
];

/**
 * Price + context for a model id. Settings overrides always win — that is the escape
 * hatch for a proxy, a fine-tune, or any model this table has never heard of.
 * @returns {{context:number|null, in:number|null, out:number|null,
 *            cacheRead:number|null, cacheWrite:number|null, known:boolean}}
 */
export function modelInfo(model, settings = {}) {
  const id = String(model || '').toLowerCase();
  let best = null;
  for (const m of MODELS) {
    if (id.includes(m.match) && (!best || m.match.length > best.match.length)) best = m;
  }

  const ovContext = positiveOrNull(settings.contextWindow);
  const ovIn = zeroOrPositiveOrNull(settings.priceIn);
  const ovOut = zeroOrPositiveOrNull(settings.priceOut);

  return {
    context: ovContext ?? (best ? best.context : null),
    in: ovIn ?? (best ? best.in : null),
    out: ovOut ?? (best ? best.out : null),
    cacheRead: best && best.cacheRead != null ? best.cacheRead : null,
    cacheWrite: best && best.cacheWrite != null ? best.cacheWrite : null,
    known: Boolean(best) || ovContext != null || ovIn != null,
  };
}

/**
 * USD for one request.
 *
 * @returns {{usd: number|null, approx: boolean}}
 *   usd    — null when the model has no known price and none is set. Never a fabricated 0.
 *   approx — true when the number is real but derived from a rate we had to substitute,
 *            so the UI can say so instead of presenting it as exact.
 */
export function costOf(usage, info) {
  if (!info || info.in == null || info.out == null) return { usd: null, approx: false };
  const inTok = num(usage.inputTokens);
  const outTok = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWriteTokens);

  // Anthropic reports cache tokens SEPARATELY from input_tokens, so they are added, not
  // subtracted. When a model has cache tokens but no known cache rate, fall back to the
  // plain input rate — conservative rather than free — and FLAG it: a cache read is
  // normally ~90% cheaper, so billing it at full input price is materially wrong and must
  // not be presented as an exact figure.
  const cacheRateMissing = (cacheRead > 0 && info.cacheRead == null) ||
                           (cacheWrite > 0 && info.cacheWrite == null);
  const cacheReadRate = info.cacheRead ?? info.in;
  const cacheWriteRate = info.cacheWrite ?? info.in;

  const usd = (
    (inTok * info.in) +
    (outTok * info.out) +
    (cacheRead * cacheReadRate) +
    (cacheWrite * cacheWriteRate)
  ) / PER_MILLION;

  return { usd, approx: cacheRateMissing };
}

/**
 * Session-wide accumulator. One per panel; survives runs, resets on New chat.
 *
 * Wall-clock for tokens/sec is the STREAMING time, not the whole run — waiting on a page
 * to load is not the model being slow, and charging it against throughput would make the
 * number meaningless.
 */
export class SessionStats {
  constructor() {
    this.reset();
  }

  reset() {
    this.requests = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.cacheReadTokens = 0;
    this.cacheWriteTokens = 0;
    this.cost = 0;
    this.costKnown = true;   // false once any request had no price at all
    this.costApprox = false; // true once any request used a substituted cache rate
    this.estimated = false;  // true once any usage was a character estimate
    this.contextTokens = 0;  // input tokens of the most recent request
    this.startedAt = Date.now();

    // Only streams long enough to be a real rate feed the average (see MIN_RATE_WINDOW_MS).
    // Folding one-burst turns in here would drag the session average toward nonsense.
    this.ratedMs = 0;
    this.ratedTokens = 0;

    // live stream state
    this.streaming = false;
    this.liveStartedAt = 0;
    this.liveChars = 0;
    this.liveTokensPerSec = 0;
  }

  /** A model call started streaming. */
  beginStream() {
    this.streaming = true;
    this.liveStartedAt = Date.now();
    this.liveChars = 0;
    this.liveTokensPerSec = 0;
  }

  /**
   * Text arrived. Returns the live tokens/sec estimate.
   * Estimated from characters because token counts do not exist until the stream ends —
   * this is the only way to show a live rate at all, and it is reconciled at endStream.
   */
  onDelta(text) {
    if (!this.streaming) return this.liveTokensPerSec;
    this.liveChars += String(text || '').length;
    const elapsedMs = Date.now() - this.liveStartedAt;
    // Same gate as endStream — a separate hardcoded threshold here would let a stream
    // count toward the average that the live gauge never showed a rate for.
    if (elapsedMs >= MIN_RATE_WINDOW_MS) {
      this.liveTokensPerSec = (this.liveChars / 4) / (elapsedMs / 1000);
    }
    return this.liveTokensPerSec;
  }

  /**
   * The stream ended WITHOUT a usage event — the user pressed Stop, or the provider
   * aborted. Both streams return early on abort before yielding usage, so without this the
   * session would stay `streaming:true` forever: the HUD would keep displaying the frozen
   * live estimate as if it were the current rate, and the request's tokens would never be
   * counted. Fold in what we can actually stand behind (a character estimate) and say it
   * is an estimate.
   */
  abandonStream() {
    if (!this.streaming) return;
    const elapsedMs = Math.max(1, Date.now() - this.liveStartedAt);
    const outTok = Math.ceil(this.liveChars / 4);
    this.streaming = false;

    if (outTok > 0) {
      this.requests += 1;
      this.outputTokens += outTok;
      this.estimated = true; // partial and character-derived — never pass this off as measured
      if (elapsedMs >= MIN_RATE_WINDOW_MS) {
        this.ratedMs += elapsedMs;
        this.ratedTokens += outTok;
      }
    }
    this.liveTokensPerSec = 0;
  }

  /**
   * The usage event landed. Folds it into the session totals and replaces the
   * character-estimated rate with the exact one.
   * @returns {{tokensPerSec:number, cost:number|null}}
   */
  endStream(usage, info) {
    const elapsedMs = this.streaming ? Math.max(1, Date.now() - this.liveStartedAt) : 0;
    this.streaming = false;

    const u = usage || {};
    const inTok = num(u.inputTokens);
    const outTok = num(u.outputTokens);

    this.requests += 1;
    this.inputTokens += inTok;
    this.outputTokens += outTok;
    this.cacheReadTokens += num(u.cacheReadTokens);
    this.cacheWriteTokens += num(u.cacheWriteTokens);
    if (u.estimated) this.estimated = true;
    if (elapsedMs >= MIN_RATE_WINDOW_MS && outTok > 0) {
      this.ratedMs += elapsedMs;
      this.ratedTokens += outTok;
    }

    // The whole conversation is re-sent every turn, so the newest request's input token
    // count IS how full the context window currently is.
    //
    // Cached tokens OCCUPY the window exactly like uncached ones — they are only cheaper,
    // not absent. Both providers hand them over separately (Anthropic natively; the OpenAI
    // path subtracts them out of prompt_tokens so the two agree), so all three have to be
    // added back here or the gauge under-reads by however much was cached. That error is
    // largest on long runs, which are precisely the runs where the number matters.
    const occupied = inTok + num(u.cacheReadTokens) + num(u.cacheWriteTokens);
    if (occupied > 0) this.contextTokens = occupied;

    const { usd, approx } = costOf(u, info);
    if (usd == null) this.costKnown = false;
    else this.cost += usd;
    if (approx) this.costApprox = true;

    // A rate needs a real sampling window. A reply that arrives in one burst (cached, or
    // a tiny tool-call-only turn) would otherwise divide by ~1ms and report six-figure
    // tokens/sec — a number that is not just wrong but obviously broken to the user.
    const tps = outTok > 0 && elapsedMs >= MIN_RATE_WINDOW_MS
      ? outTok / (elapsedMs / 1000)
      : 0;
    this.liveTokensPerSec = tps;
    return { tokensPerSec: tps, cost: usd };
  }

  /** Average output tokens/sec across the requests that streamed long enough to measure. */
  get avgTokensPerSec() {
    if (!this.ratedMs || !this.ratedTokens) return 0;
    return this.ratedTokens / (this.ratedMs / 1000);
  }

  get totalTokens() {
    return this.inputTokens + this.outputTokens + this.cacheReadTokens + this.cacheWriteTokens;
  }

  /** Context occupancy as a 0-1 fraction, or null when the window size is unknown. */
  contextFraction(info) {
    if (!info || !info.context) return null;
    return Math.min(1, this.contextTokens / info.context);
  }
}

// ------------------------------------------------------------------ formatting

/** 1234 → "1.2k", 1234567 → "1.2M". */
export function formatTokens(n) {
  const v = num(n);
  if (v < 1000) return String(v);
  if (v < 1e6) return `${(v / 1000).toFixed(v < 10000 ? 1 : 0)}k`;
  return `${(v / 1e6).toFixed(2)}M`;
}

/** Sub-cent costs still deserve a real number — "$0.00" reads as free, which is a lie. */
export function formatCost(usd) {
  if (usd == null) return '—';
  if (usd === 0) return '$0';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatRate(tps) {
  const v = num(tps);
  if (v <= 0) return '—';
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} tok/s`;
}

export function formatDuration(ms) {
  const s = Math.floor(num(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function positiveOrNull(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function zeroOrPositiveOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
