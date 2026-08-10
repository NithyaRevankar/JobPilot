// llm.js — provider clients (contract §7). OpenAI-compatible + Anthropic, both streaming.
//
// Neutral message format:
//   { role: 'system'|'user'|'assistant'|'tool', content: string,
//     toolCalls?: [{id, name, argsJson}],   // assistant only
//     toolCallId?: string }                 // tool role only

export async function* chatStream({ settings, messages, tools, signal }) {
  validateSettings(settings);
  if (settings.provider === 'anthropic') {
    yield* anthropicStream({ settings, messages, tools, signal });
  } else {
    yield* openaiStream({ settings, messages, tools, signal });
  }
}

export async function listModels(settings) {
  validateSettings(settings, { requireModel: false });
  const url = settings.provider === 'anthropic'
    ? `${anthropicRoot(settings.baseUrl)}/v1/models`
    : `${stripSlash(settings.baseUrl)}/models`;
  const res = await fetch(url, {
    headers: settings.provider === 'anthropic'
      ? anthropicHeaders(settings)
      : openaiHeaders(settings),
  });
  if (!res.ok) throw await httpError(res, 'Could not list models');
  const body = await res.json();
  const ids = (Array.isArray(body.data) ? body.data : [])
    .map((m) => m.id)
    .filter((id) => typeof id === 'string');
  return ids.sort((a, b) => a.localeCompare(b));
}

export async function testConnection(settings) {
  try {
    validateSettings(settings);
    const messages = [{ role: 'user', content: 'Say "ok"' }];
    const probe = { ...settings, maxTokens: 1 }; // 1-token round-trip

    // Only OUTPUT counts. Both providers yield a `usage` event unconditionally — the
    // Anthropic path even synthesises one from estimates — so accepting usage as proof of
    // life made this guard unreachable, and the wrong-model-id case it exists to catch
    // reported "Connected — <model> responded." while every real run produced nothing.
    let sawOutput = false;
    for await (const ev of chatStream({ settings: probe, messages, tools: [], signal: undefined })) {
      if (ev.type === 'text' || ev.type === 'tool_call') sawOutput = true;
    }
    if (!sawOutput) {
      return { ok: false, message: 'Connected, but the model returned an empty stream — no text came back. Check the model id.' };
    }
    return { ok: true, message: `Connected — ${settings.model} responded.` };
  } catch (err) {
    return { ok: false, message: err.message || String(err) };
  }
}

// ---------------------------------------------------------------- validation

function validateSettings(settings, { requireModel = true } = {}) {
  if (!settings || !settings.baseUrl) {
    throw new Error('No Base URL configured. Open Settings and set your provider Base URL (e.g. https://api.openai.com/v1).');
  }
  // Key-less local servers (Ollama, LM Studio, vLLM) are fine on the OpenAI
  // path; only the Anthropic API strictly requires x-api-key.
  if (settings.provider === 'anthropic' && !settings.apiKey) {
    throw new Error('No API key configured. The Anthropic API requires one — open Settings and paste your API key.');
  }
  if (requireModel && !settings.model) {
    throw new Error('No model selected. Open Settings and pick or type a model id.');
  }
}

// Authorization header only when a key exists — local servers reject nothing,
// but sending "Bearer " (empty) breaks some proxies.
function openaiHeaders(settings, json = false) {
  const h = json ? { 'content-type': 'application/json' } : {};
  if (settings.apiKey) h.Authorization = `Bearer ${settings.apiKey}`;
  return h;
}

async function httpError(res, prefix) {
  let snippet = '';
  try {
    snippet = (await res.text()).slice(0, 300);
  } catch { /* body unreadable — status alone will have to do */ }
  let hint = '';
  if (res.status === 401 || res.status === 403) hint = ' — check your API key in Settings.';
  else if (res.status === 404) hint = ' — check the Base URL (it may need or must not have a /v1 suffix) and the model id.';
  else if (res.status === 429) hint = ' — rate limited or out of credits; wait and retry.';
  else if (res.status >= 500) hint = ' — provider-side error; retry shortly.';
  return new Error(`${prefix}: HTTP ${res.status}${hint}${snippet ? ` Response: ${snippet}` : ''}`);
}

function stripSlash(url) {
  return String(url).trim().replace(/\/+$/, '');
}

// Anthropic paths are `${root}/v1/messages`; tolerate baseUrl already ending in /v1.
function anthropicRoot(baseUrl) {
  return stripSlash(baseUrl).replace(/\/v1$/, '');
}

function anthropicHeaders(settings) {
  return {
    'x-api-key': settings.apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
    'content-type': 'application/json',
  };
}

// ------------------------------------------------------------- SSE plumbing

// Yields SSE event payload strings (the `data:` value; event name attached for Anthropic).
async function* sseLines(res, signal) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal && signal.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        yield line;
      }
    }
    if (buffer) yield buffer.replace(/\r$/, '');
  } finally {
    try { reader.cancel(); } catch { /* stream already closed */ }
  }
}

// -------------------------------------------------------------------- OpenAI

async function* openaiStream({ settings, messages, tools, signal }) {
  const body = {
    model: settings.model,
    messages: messages.map(toOpenAIMessage),
    temperature: settings.temperature,
    max_tokens: settings.maxTokens,
    stream: true,
    // Without this, a streaming OpenAI response carries NO usage block at all and the
    // session stats have nothing to count. Not every OpenAI-compatible server knows the
    // field, hence the retry below.
    stream_options: { include_usage: true },
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const url = `${stripSlash(settings.baseUrl)}/chat/completions`;
  const post = (payload) => fetchOrExplain(url, {
    method: 'POST',
    headers: openaiHeaders(settings, true),
    body: JSON.stringify(payload),
    signal,
  });

  let res = await post(body);
  if (!res.ok && res.status === 400) {
    // Some local servers (older Ollama / LM Studio builds) reject unknown body fields.
    // Usage stats are a nice-to-have; being able to talk to the model is not. Drop the
    // field and retry once rather than failing the run over telemetry.
    const snippet = await res.clone().text().catch(() => '');
    if (/stream_options|include_usage|unknown|unrecognized|unexpected/i.test(snippet)) {
      const { stream_options: _omit, ...noUsage } = body;
      res = await post(noUsage);
    }
  }
  if (!res.ok) throw await httpError(res, 'LLM request failed');

  // Tool-call fragments accumulate by stream index until [DONE]/finish.
  const pending = new Map(); // index → {id, name, args}
  let usage = null;
  let outChars = 0; // for the estimate when the server reports no usage

  for await (const line of sseLines(res, signal)) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6).trim();
    if (data === '[DONE]') break;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      continue; // partial/keepalive line
    }
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices && chunk.choices[0];
    if (!choice) continue;
    const delta = choice.delta || {};
    if (typeof delta.content === 'string' && delta.content) {
      outChars += delta.content.length;
      yield { type: 'text', delta: delta.content };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index ?? 0;
        if (!pending.has(idx)) pending.set(idx, { id: '', name: '', args: '' });
        const slot = pending.get(idx);
        if (tc.id) slot.id = tc.id;
        if (tc.function) {
          if (tc.function.name) slot.name += tc.function.name;
          if (tc.function.arguments) slot.args += tc.function.arguments;
        }
      }
    }
  }

  if (signal && signal.aborted) return;

  let i = 0;
  for (const [, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
    outChars += (slot.name || '').length + (slot.args || '').length;
    yield {
      type: 'tool_call',
      id: slot.id || `call_${i}_${Date.now()}`,
      name: slot.name,
      argsJson: slot.args || '{}',
    };
    i++;
  }
  if (usage) {
    // A PARTIAL usage block is not a measurement. Several OpenAI-compatible servers
    // (llama.cpp, some vLLM builds) emit prompt_tokens only, and `?? 0` turned that into a
    // hard "0 output tokens" labelled `estimated:false` — halving the cost readout and the
    // context gauge with no marker to say so. The Anthropic path guards exactly this; so
    // does this one now, per side.
    const sawIn = Number.isFinite(usage.prompt_tokens);
    const sawOut = Number.isFinite(usage.completion_tokens);
    // OpenAI counts cached tokens INSIDE prompt_tokens; Anthropic reports them alongside
    // input_tokens. Subtracting here gives both providers one meaning — `inputTokens` is
    // the UNCACHED part — so stats.js can add the three together without knowing which
    // provider it is talking to. Reporting the split also stops costOf billing a cache
    // read at the full input rate, which on a cached provider is ~10x the real price.
    const details = usage.prompt_tokens_details || {};
    const cachedIn = Number.isFinite(details.cached_tokens) ? details.cached_tokens : 0;
    yield {
      type: 'usage',
      inputTokens: sawIn
        ? Math.max(0, usage.prompt_tokens - cachedIn)
        : estimateTokens(JSON.stringify(body.messages) + JSON.stringify(tools || [])),
      outputTokens: sawOut ? usage.completion_tokens : estimateTokens('x'.repeat(outChars)),
      cacheReadTokens: cachedIn,
      estimated: !(sawIn && sawOut),
    };
  } else {
    // The server told us nothing. An estimate keeps the context gauge and the cost
    // readout alive on local models; `estimated` lets the UI say so rather than pass
    // a guess off as a measurement.
    yield {
      type: 'usage',
      inputTokens: estimateTokens(JSON.stringify(body.messages) + JSON.stringify(tools || [])),
      outputTokens: estimateTokens('x'.repeat(outChars)),
      estimated: true,
    };
  }
}

/** ~4 chars per token. Crude, but the right order of magnitude for every common model. */
export function estimateTokens(text) {
  return Math.max(0, Math.ceil(String(text || '').length / 4));
}

function toOpenAIMessage(m) {
  if (m.role === 'tool') {
    return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
  if (m.role === 'assistant') {
    // null content is only valid alongside tool_calls; otherwise send ''.
    const out = {
      role: 'assistant',
      content: m.content || (m.toolCalls && m.toolCalls.length ? null : ''),
    };
    if (m.toolCalls && m.toolCalls.length) {
      out.tool_calls = m.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argsJson },
      }));
    }
    return out;
  }
  return { role: m.role, content: m.content };
}

// ----------------------------------------------------------------- Anthropic

async function* anthropicStream({ settings, messages, tools, signal }) {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
  const body = {
    model: settings.model,
    max_tokens: settings.maxTokens,
    temperature: settings.temperature,
    stream: true,
    messages: toAnthropicMessages(messages),
  };
  if (system) body.system = system;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }

  const res = await fetchOrExplain(`${anthropicRoot(settings.baseUrl)}/v1/messages`, {
    method: 'POST',
    headers: anthropicHeaders(settings),
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) throw await httpError(res, 'LLM request failed');

  let currentEvent = '';
  const blocks = new Map(); // content-block index → {type, id, name, args}
  let usage = { inputTokens: 0, outputTokens: 0 };
  // Tracked SEPARATELY. `message_start` always carries input_tokens, so a single shared
  // flag would go true on essentially every stream — and a proxy that omits the
  // `message_delta.usage` block would then ship outputTokens:0 as a MEASURED value,
  // silently zeroing the output side of the cost (usually the dominant side) while the
  // "these numbers are estimated" notice never fires.
  let sawInputUsage = false;
  let sawOutputUsage = false;
  let outChars = 0;

  for await (const line of sseLines(res, signal)) {
    if (line.startsWith('event: ')) {
      currentEvent = line.slice(7).trim();
      continue;
    }
    if (!line.startsWith('data: ')) continue;
    let data;
    try {
      data = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    const type = data.type || currentEvent;

    if (type === 'message_start') {
      const u = data.message && data.message.usage;
      if (u) {
        usage.inputTokens = u.input_tokens ?? 0;
        // Cached input is billed at a different rate; keep it separate so the cost
        // readout is not silently wrong on providers that cache.
        usage.cacheReadTokens = u.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens = u.cache_creation_input_tokens ?? 0;
        sawInputUsage = true;
      }
    } else if (type === 'content_block_start') {
      const cb = data.content_block || {};
      if (cb.type === 'tool_use') {
        blocks.set(data.index, { type: 'tool_use', id: cb.id, name: cb.name, args: '' });
      } else {
        blocks.set(data.index, { type: cb.type || 'text' });
      }
    } else if (type === 'content_block_delta') {
      const d = data.delta || {};
      if (d.type === 'text_delta' && d.text) {
        outChars += d.text.length;
        yield { type: 'text', delta: d.text };
      } else if (d.type === 'input_json_delta') {
        const slot = blocks.get(data.index);
        if (slot && slot.type === 'tool_use') slot.args += d.partial_json || '';
      }
    } else if (type === 'content_block_stop') {
      const slot = blocks.get(data.index);
      if (slot && slot.type === 'tool_use') {
        yield {
          type: 'tool_call',
          id: slot.id || `call_${data.index}_${Date.now()}`,
          name: slot.name,
          argsJson: slot.args || '{}',
        };
        blocks.delete(data.index);
      }
    } else if (type === 'message_delta') {
      const u = data.usage;
      if (u && u.output_tokens != null) {
        usage.outputTokens = u.output_tokens;
        sawOutputUsage = true;
      }
    } else if (type === 'message_stop') {
      break;
    } else if (type === 'error') {
      const msg = (data.error && data.error.message) || 'unknown streaming error';
      throw new Error(`LLM stream error: ${msg}`);
    }
  }

  if (signal && signal.aborted) return;

  // Any part we did not actually receive is estimated, and SAID to be estimated. A bare
  // 0 output-token count reported as fact would quietly halve the cost readout.
  const tool_args_chars = [...blocks.values()].reduce((n, b) => n + ((b.args || '').length), 0);
  yield {
    type: 'usage',
    // `body.system` belongs in the estimate: on this extension it is the LARGEST block in
    // the request (profile, documents, playbook, macros, site notes), so leaving it out
    // made the context gauge read far below the truth on exactly the runs closest to the
    // limit — the ones where the number matters.
    inputTokens: sawInputUsage
      ? usage.inputTokens
      : estimateTokens(String(body.system || '') +
          JSON.stringify(body.messages) + JSON.stringify(body.tools || [])),
    outputTokens: sawOutputUsage
      ? usage.outputTokens
      : estimateTokens('x'.repeat(outChars + tool_args_chars)),
    cacheReadTokens: usage.cacheReadTokens || 0,
    cacheWriteTokens: usage.cacheWriteTokens || 0,
    estimated: !(sawInputUsage && sawOutputUsage),
  };
}

function toAnthropicMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      // Anthropic requires tool_result blocks in user messages; merge consecutive ones.
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content) && last.content.every((b) => b.type === 'tool_result')) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
    } else if (m.role === 'assistant') {
      const content = [];
      if (m.content) content.push({ type: 'text', text: m.content });
      for (const tc of m.toolCalls || []) {
        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: safeJson(tc.argsJson),
        });
      }
      // Anthropic rejects empty text blocks — drop empty assistant turns
      // entirely (consecutive same-role messages are not produced this way
      // because the agent loop never stores two assistant turns in a row).
      if (content.length) out.push({ role: 'assistant', content });
    } else {
      out.push({ role: 'user', content: m.content });
    }
  }
  return out;
}

function safeJson(str) {
  try {
    const v = JSON.parse(str);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// ------------------------------------------------------------ rate limiting
//
// Several job applications now run at once, which multiplies the request rate by the
// number of runs and makes 429 an ordinary event rather than a rare one. Left alone, a
// rate-limited run simply fails — and it fails halfway through a form, which is the
// expensive place to fail.
//
// Retries are jittered on purpose. Three runs that hit the same limit at the same moment
// and back off by the same amount arrive together again on every attempt; the jitter is
// what breaks that lockstep. Retry-After is honoured when the provider sends it, because
// a guess is worse than the number they actually gave us.
export const RETRY_STATUSES = Object.freeze([429, 503]);
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 20000;

/** How long to wait before retrying, or null when we should not. Exported for the tests. */
export function retryDelayMs(res, attempt, now = Date.now()) {
  const header = res.headers && typeof res.headers.get === 'function'
    ? res.headers.get('retry-after')
    : null;
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    const at = Date.parse(header); // the other legal form is an HTTP date
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - now), MAX_BACKOFF_MS);
  }
  const backoff = Math.min(BASE_BACKOFF_MS * (2 ** attempt), MAX_BACKOFF_MS);
  // Full jitter over the window, so concurrent runs spread out instead of retrying together.
  return Math.round(backoff * (0.5 + Math.random() * 0.5));
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function fetchOrExplain(url, init, retries = MAX_RETRIES) {
  const signal = init && init.signal;
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await fetch(url, init);
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      throw new Error(
        `Could not reach ${url}: ${err.message}. Check the Base URL in Settings, your network, ` +
        'and (for local servers like Ollama) that the server is running and allows CORS.'
      );
    }
    // Anything else — including a 401 or a 500 — is the caller's to report. Retrying a bad
    // key or a malformed request just delays the message the user needs.
    if (!RETRY_STATUSES.includes(res.status) || attempt >= retries) return res;
    await sleep(retryDelayMs(res, attempt), signal); // an abort here propagates, as it should
  }
}
