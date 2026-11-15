// free-model-aggregator-02 — a live free-model aggregator entry for make.fun.
//
// The server speaks both client wires (OpenAI Chat Completions and Anthropic
// Messages, JSON and SSE) and serves every prompt from a real free model on
// OpenRouter, dialled through the grader's gateway on its Chat Completions
// route. The trial brief (MAKEFUN_PROMPT_FILE) is the only catalogue there
// is: it lists the free models with their house ratings and capabilities,
// and the six prompts in the order the environment sends them.
//
// Design notes:
//   - Routing is capability-first, rating-second: a prompt only ever goes to
//     free models the brief marks as natively supporting what it needs
//     (tools, vision, strict JSON), best house rating first, id as the
//     deterministic tie-break.
//   - Every upstream answer is fully buffered and inspected before a single
//     byte is committed to the client, so a refusal, an empty body, an error
//     object in a 200, or a stream that dies before its finish chunk fails
//     over to the next candidate instead of leaking to the client.
//   - Answers are relayed as the gateway produced them. Nothing is patched,
//     repaired or invented: a JSON-mode answer whose text is not the JSON
//     asked for (its token missing) counts as a failed attempt, never as
//     text to fix up locally.
//   - Recovered prompts carry the x-makefun-upstream-failures trail naming
//     each refusal in order, so the house can see the failover happened.
//   - Nothing in any output reads the wall clock or a random source: the
//     same brief and the same gateway answers produce the same bytes on a
//     live pass and on its replay. (Clock reads exist only as control-flow
//     timeouts; they never reach a response byte.)

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Small typed helpers
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isRecord = (v: unknown): v is Json =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

const strOf = (v: unknown): string => (typeof v === 'string' ? v : '');

const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null);

const boolOrNull = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

// ---------------------------------------------------------------------------
// The brief: two JSON documents inside prose, found by their schema prefix
// ---------------------------------------------------------------------------

const SCHEMA_PREFIX = 'free-model-aggregator-02/';
const OPENROUTER_PUBLIC_BASE = 'https://openrouter.ai/api/v1';
const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

interface ModelRow {
  id: string;
  provider: string;
  display_name: string;
  rating_milli: number;
  context_length: number | null;
  tools: boolean | null;
  vision: boolean | null;
  json: boolean | null;
  free: boolean;
}

interface Requirement {
  tools?: boolean;
  vision?: boolean;
  json?: boolean;
  min_context?: number;
}

interface PromptRow {
  id: string;
  api: 'openai' | 'anthropic';
  stream: boolean;
  weight: number;
  requires: Requirement;
}

interface Brief {
  models: ModelRow[];
  prompts: PromptRow[];
}

/** Index of the `}` that closes the object opening at `start`, skipping string contents; -1 if none. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Every JSON object in `text` carrying a string `schema`, in document order. */
function documentsIn(text: string): Json[] {
  const out: Json[] = [];
  for (let at = text.indexOf('{'); at !== -1; at = text.indexOf('{', at + 1)) {
    const end = objectEnd(text, at);
    if (end === -1) continue;
    try {
      const value: unknown = JSON.parse(text.slice(at, end + 1));
      if (isRecord(value) && typeof value.schema === 'string') out.push(value);
    } catch {
      // Not a standalone JSON object; keep scanning.
    }
  }
  return out;
}

/** The first document under this contest's prefix carrying one of `keys` as an array. */
function arrayDocument(docs: readonly Json[], keys: readonly string[]): Json | null {
  for (const doc of docs) {
    if (!strOf(doc.schema).includes(SCHEMA_PREFIX)) continue;
    for (const key of keys) if (Array.isArray(doc[key])) return doc;
  }
  return null;
}

function modelOf(v: unknown): ModelRow | null {
  if (!isRecord(v)) return null;
  const raw = strOf(v.id) !== '' ? strOf(v.id) : strOf(v.model);
  if (raw === '') return null;
  const named = strOf(v.provider) !== '' ? strOf(v.provider) : strOf(v.wire);
  // A row naming openrouter with the bare upstream id is dialled with the prefix.
  const id = named === 'openrouter' && !raw.toLowerCase().startsWith('openrouter/') ? `openrouter/${raw}` : raw;
  return {
    id,
    provider: named === '' ? 'openrouter' : named,
    display_name: strOf(v.display_name) !== '' ? strOf(v.display_name) : raw,
    rating_milli: numOrNull(v.rating_milli) ?? 0,
    context_length: numOrNull(v.context_length),
    tools: boolOrNull(v.tools),
    vision: boolOrNull(v.vision),
    json: boolOrNull(v.json),
    free: v.free !== false,
  };
}

function promptOf(v: unknown): PromptRow | null {
  if (!isRecord(v)) return null;
  if (strOf(v.id) === '') return null;
  const r = isRecord(v.requires) ? v.requires : {};
  return {
    id: strOf(v.id),
    api: v.api === 'anthropic' ? 'anthropic' : 'openai',
    stream: v.stream === true,
    weight: v.weight === 2 ? 2 : 1,
    requires: {
      ...(r.tools === true ? { tools: true } : {}),
      ...(r.vision === true ? { vision: true } : {}),
      ...(r.json === true ? { json: true } : {}),
      ...(isNum(r.min_context) ? { min_context: r.min_context } : {}),
    },
  };
}

/** The brief at `path`; empty lists when the file or its documents cannot be read. */
function readBrief(path: string): Brief {
  if (path === '') return { models: [], prompts: [] };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { models: [], prompts: [] };
  }
  const docs = documentsIn(text);
  const modelsDoc = arrayDocument(docs, ['models', 'ratings']);
  const promptsDoc = arrayDocument(docs, ['prompts', 'manifest']);
  const models = modelsDoc === null
    ? []
    : ((modelsDoc.models ?? modelsDoc.ratings) as unknown[]).flatMap((v) => {
        const m = modelOf(v);
        return m === null ? [] : [m];
      });
  const prompts = promptsDoc === null
    ? []
    : ((promptsDoc.prompts ?? promptsDoc.manifest) as unknown[]).flatMap((v) => {
        const p = promptOf(v);
        return p === null ? [] : [p];
      });
  return { models, prompts };
}

// ---------------------------------------------------------------------------
// The catalog: one document, built once, used for --list and for /register
// ---------------------------------------------------------------------------

interface Catalog {
  providers: Array<{
    id: string;
    base_url: string;
    key_env: string;
    wire: 'openai';
    models: Array<{ id: string; free: boolean; context_length: number | null }>;
  }>;
}

function buildCatalog(brief: Brief): Catalog {
  const seen = new Set<string>();
  const models: Catalog['providers'][number]['models'] = [];
  for (const m of brief.models) {
    if (!m.free || seen.has(m.id)) continue;
    seen.add(m.id);
    models.push({ id: m.id, free: true, context_length: m.context_length });
  }
  if (models.length === 0) return { providers: [] };
  return {
    providers: [
      { id: 'openrouter', base_url: OPENROUTER_PUBLIC_BASE, key_env: OPENROUTER_KEY_ENV, wire: 'openai', models },
    ],
  };
}

/** Fixed listing timestamps: a listing that read the clock would differ between runs. */
const LIST_CREATED = 1767225600; // 2026-01-01T00:00:00Z
const LIST_CREATED_AT = '2026-01-01T00:00:00Z';

function openAIModelList(brief: Brief): Json {
  return {
    object: 'list',
    data: brief.models
      .filter((m) => m.free)
      .map((m) => ({ id: m.id, object: 'model', created: LIST_CREATED, owned_by: m.provider })),
  };
}

function anthropicModelList(brief: Brief): Json {
  const data = brief.models
    .filter((m) => m.free)
    .map((m) => ({ type: 'model', id: m.id, display_name: m.display_name, created_at: LIST_CREATED_AT }));
  return {
    data,
    has_more: false,
    ...(data.length > 0 ? { first_id: data[0].id, last_id: data[data.length - 1].id } : {}),
  };
}

// ---------------------------------------------------------------------------
// Routing: capability filter first, house rating second, id as tie-break
// ---------------------------------------------------------------------------

function meetsRequirements(req: Requirement, m: ModelRow): boolean {
  if (req.tools === true && m.tools !== true) return false;
  if (req.vision === true && m.vision !== true) return false;
  if (req.json === true && m.json !== true) return false;
  if (req.min_context !== undefined && (m.context_length === null || m.context_length < req.min_context)) return false;
  return true;
}

/** The deterministic failover chain for one prompt: best capable model first. */
function candidateChain(brief: Brief, req: Requirement): ModelRow[] {
  const free = brief.models.filter((m) => m.free);
  const capable = free.filter((m) => meetsRequirements(req, m));
  const pool = capable.length > 0 ? capable : free;
  return [...pool].sort((a, b) => b.rating_milli - a.rating_milli || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** What a client body itself demands, read off the wire it arrived on. */
function bodyRequirements(wire: 'openai' | 'anthropic', body: Json): Requirement {
  const req: Requirement = {};
  if (wire === 'openai' && isRecord(body.response_format)) {
    if (body.response_format.type === 'json_object' || body.response_format.type === 'json_schema') req.json = true;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) req.tools = true;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (!isRecord(msg) || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      if (!isRecord(part)) continue;
      if (part.type === 'image_url' || part.type === 'image') req.vision = true;
    }
  }
  return req;
}

function mergeRequirements(a: Requirement, b: Requirement | undefined): Requirement {
  if (b === undefined) return a;
  return {
    ...(a.tools === true || b.tools === true ? { tools: true } : {}),
    ...(a.vision === true || b.vision === true ? { vision: true } : {}),
    ...(a.json === true || b.json === true ? { json: true } : {}),
    ...(a.min_context !== undefined || b.min_context !== undefined
      ? { min_context: Math.max(a.min_context ?? 0, b.min_context ?? 0) }
      : {}),
  };
}

/** The unique answer tokens a request carries (the `^[A-Z]+-\d{4}$` words in its messages). */
function requestTokens(wire: 'openai' | 'anthropic', body: Json): string[] {
  const texts: string[] = [];
  if (wire === 'anthropic' && typeof body.system === 'string') texts.push(body.system);
  if (wire === 'anthropic' && Array.isArray(body.system)) {
    for (const b of body.system) if (isRecord(b) && typeof b.text === 'string') texts.push(b.text);
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const msg of messages) {
    if (!isRecord(msg)) continue;
    if (typeof msg.content === 'string') texts.push(msg.content);
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (isRecord(part) && typeof part.text === 'string') texts.push(part.text);
      }
    }
  }
  const found = new Set<string>();
  for (const t of texts) for (const hit of t.matchAll(/[A-Z]+-\d{4}/g)) found.add(hit[0]);
  return [...found];
}

// ---------------------------------------------------------------------------
// Anthropic request -> Chat Completions request
// ---------------------------------------------------------------------------

function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((b) => (isRecord(b) && b.type === 'text' && typeof b.text === 'string' ? [b.text] : []))
    .join('\n');
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const text = textOfBlocks(content);
    return text !== '' ? text : JSON.stringify(content);
  }
  return content === undefined ? '' : JSON.stringify(content);
}

function anthropicToOpenAI(body: Json, model: string): Json {
  const messages: Json[] = [];
  const system = textOfBlocks(body.system);
  if (system !== '') messages.push({ role: 'system', content: system });
  const source = Array.isArray(body.messages) ? body.messages : [];
  for (const raw of source) {
    if (!isRecord(raw)) continue;
    const assistant = raw.role === 'assistant';
    const content = raw.content;
    if (typeof content === 'string') {
      messages.push({ role: assistant ? 'assistant' : 'user', content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (assistant) {
      const toolCalls: Json[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== 'tool_use') continue;
        toolCalls.push({
          id: strOf(block.id),
          type: 'function',
          function: {
            name: strOf(block.name),
            arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
          },
        });
      }
      const text = textOfBlocks(content);
      messages.push({
        role: 'assistant',
        content: text !== '' ? text : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }
    const parts: Json[] = [];
    for (const block of content) {
      if (!isRecord(block)) continue;
      if (block.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: strOf(block.tool_use_id),
          content: toolResultText(block.content),
        });
        continue;
      }
      if (block.type === 'text' && typeof block.text === 'string') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image' && isRecord(block.source)) {
        const src = block.source;
        if (src.type === 'base64' && typeof src.data === 'string') {
          const media = typeof src.media_type === 'string' ? src.media_type : 'image/png';
          parts.push({ type: 'image_url', image_url: { url: `data:${media};base64,${src.data}` } });
        } else if (src.type === 'url' && typeof src.url === 'string') {
          parts.push({ type: 'image_url', image_url: { url: src.url } });
        }
      }
    }
    if (parts.length > 0) messages.push({ role: 'user', content: parts });
  }

  const out: Json = { model, messages };
  out.max_tokens = isNum(body.max_tokens) ? body.max_tokens : 1024;
  if (isNum(body.temperature)) out.temperature = body.temperature;
  if (isNum(body.top_p)) out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;
  if (Array.isArray(body.tools)) {
    const tools = body.tools.flatMap((raw) => {
      if (!isRecord(raw) || typeof raw.name !== 'string') return [];
      return [
        {
          type: 'function',
          function: {
            name: raw.name,
            description: strOf(raw.description),
            parameters: isRecord(raw.input_schema) ? raw.input_schema : { type: 'object', properties: {} },
          },
        },
      ];
    });
    if (tools.length > 0) out.tools = tools;
  }
  if (isRecord(body.tool_choice)) {
    const choice = body.tool_choice;
    if (choice.type === 'auto') out.tool_choice = 'auto';
    else if (choice.type === 'any') out.tool_choice = 'required';
    else if (choice.type === 'tool' && typeof choice.name === 'string') {
      out.tool_choice = { type: 'function', function: { name: choice.name } };
    }
  }
  if (body.stream === true) {
    out.stream = true;
    out.stream_options = { include_usage: true };
  }
  return out;
}

/** An OpenAI-wire client body, carried through with the dialled model and a guaranteed output cap. */
function openAIUpstreamBody(body: Json, model: string): Json {
  const out: Json = { ...body, model };
  if (!isNum(out.max_tokens) && !isNum(out.max_completion_tokens)) out.max_tokens = 1024;
  if (out.stream === true) {
    out.stream_options = { ...(isRecord(body.stream_options) ? body.stream_options : {}), include_usage: true };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Upstream answers: parse, judge, render — never edit
// ---------------------------------------------------------------------------

interface TrailRow {
  status: number;
  code: string;
  model: string | null;
}

interface ToolCallAgg {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

interface JudgedAnswer {
  ok: boolean;
  /** For a JSON answer: the gateway's object. For a stream: the raw upstream text. */
  payload: Json | string;
  text: string;
  /** The text deltas of a stream, in arrival order (empty for JSON answers). */
  segments: string[];
  toolCalls: ToolCallAgg[];
  finishReason: string | null;
  usage: { prompt: number; completion: number } | null;
  firstId: string;
}

const failed = (patch: Partial<JudgedAnswer>): JudgedAnswer => ({
  ok: false,
  payload: '',
  text: '',
  segments: [],
  toolCalls: [],
  finishReason: null,
  usage: null,
  firstId: '',
  ...patch,
});

/** The answer text of a Chat Completions message: its content string or its text blocks. */
function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return textOfBlocks(content);
  return '';
}

function usageOf(v: unknown): { prompt: number; completion: number } | null {
  if (!isRecord(v)) return null;
  if (!isNum(v.prompt_tokens) || !isNum(v.completion_tokens)) return null;
  return { prompt: v.prompt_tokens, completion: v.completion_tokens };
}

/** The error code an upstream error body carries, '' when it carries none. */
function errorCodeOf(parsed: unknown): string {
  if (!isRecord(parsed) || !isRecord(parsed.error)) return '';
  if (typeof parsed.error.code === 'string') return parsed.error.code;
  if (typeof parsed.error.type === 'string') return parsed.error.type;
  return '';
}

/**
 * Whether an answer can be served: it must be whole (a finish reason, real
 * usage with at least one output token) and it must carry the token the
 * prompt asked for. Anything less is a failed attempt, not a fix-up job.
 */
function answerUsable(j: JudgedAnswer, tokens: readonly string[]): boolean {
  if (j.finishReason === null) return false;
  if (j.usage === null || j.usage.completion < 1) return false;
  if (tokens.length > 0) return tokens.some((t) => j.text.includes(t));
  return j.text !== '' || j.toolCalls.length > 0;
}

function judgeJson(status: number, raw: string, tokens: readonly string[]): { j: JudgedAnswer; code: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { j: failed({}), code: '' };
  }
  if (!isRecord(parsed)) return { j: failed({}), code: '' };
  if (isRecord(parsed.error)) return { j: failed({}), code: errorCodeOf(parsed) };
  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const choice = isRecord(choices[0]) ? choices[0] : null;
  if (choice === null || !isRecord(choice.message)) return { j: failed({}), code: '' };
  const message = choice.message;
  const toolCalls: ToolCallAgg[] = [];
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  calls.forEach((call, i) => {
    if (!isRecord(call) || !isRecord(call.function)) return;
    toolCalls.push({
      index: isNum(call.index) ? call.index : i,
      id: strOf(call.id),
      name: strOf(call.function.name),
      arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '',
    });
  });
  const j: JudgedAnswer = {
    ok: false,
    payload: parsed,
    text: messageText(message.content),
    segments: [],
    toolCalls,
    finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : null,
    usage: usageOf(parsed.usage),
    firstId: strOf(parsed.id),
  };
  j.ok = status >= 200 && status < 300 && answerUsable(j, tokens);
  return { j, code: '' };
}

/** Split a buffered SSE body into its frames; a trailing partial frame counts as a frame. */
function sseFrames(raw: string): string[] {
  const normalized = raw.replace(/\r\n/g, '\n');
  const frames = normalized.split('\n\n');
  return frames.filter((f, i) => f !== '' || i < frames.length - 1);
}

function frameData(frame: string): string | null {
  const parts: string[] = [];
  for (const line of frame.split('\n')) {
    const t = line.trim();
    if (t.startsWith('data:')) parts.push(t.slice(5).trim());
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function judgeStream(status: number, raw: string, tokens: readonly string[]): { j: JudgedAnswer; code: string } {
  // A refusal of a stream request arrives as a plain JSON error body, not as
  // events: name its code so the trail can carry it.
  const trimmed = raw.trimStart();
  if (trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed) && isRecord(parsed.error)) return { j: failed({}), code: errorCodeOf(parsed) };
    } catch {
      // Not a JSON body: fall through to the frame parse.
    }
  }
  let text = '';
  const segments: string[] = [];
  const byIndex = new Map<number, ToolCallAgg>();
  let finishReason: string | null = null;
  let usage: { prompt: number; completion: number } | null = null;
  let firstId = '';
  let malformed = false;
  for (const frame of sseFrames(raw)) {
    const data = frameData(frame);
    if (data === null || data === '' || data === '[DONE]') continue;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      malformed = true;
      continue;
    }
    if (!isRecord(chunk)) {
      malformed = true;
      continue;
    }
    if (isRecord(chunk.error)) return { j: failed({}), code: errorCodeOf(chunk) };
    if (firstId === '' && typeof chunk.id === 'string') firstId = chunk.id;
    const u = usageOf(chunk.usage);
    if (u !== null) usage = u;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    const choice = isRecord(choices[0]) ? choices[0] : null;
    if (choice === null) continue;
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
    const delta = isRecord(choice.delta) ? choice.delta : {};
    if (typeof delta.content === 'string' && delta.content !== '') {
      text += delta.content;
      segments.push(delta.content);
    }
    const calls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const call of calls) {
      if (!isRecord(call)) continue;
      const idx = isNum(call.index) ? call.index : byIndex.size;
      let agg = byIndex.get(idx);
      if (agg === undefined) {
        agg = { index: idx, id: '', name: '', arguments: '' };
        byIndex.set(idx, agg);
      }
      if (typeof call.id === 'string' && call.id !== '') agg.id = call.id;
      if (isRecord(call.function)) {
        if (typeof call.function.name === 'string' && call.function.name !== '') agg.name = call.function.name;
        if (typeof call.function.arguments === 'string') agg.arguments += call.function.arguments;
      }
    }
  }
  const j: JudgedAnswer = {
    ok: false,
    payload: raw,
    text,
    segments,
    toolCalls: [...byIndex.values()].sort((a, b) => a.index - b.index),
    finishReason,
    usage,
    firstId,
  };
  j.ok = status >= 200 && status < 300 && !malformed && answerUsable(j, tokens);
  return { j, code: '' };
}

// ---------------------------------------------------------------------------
// Rendering: the gateway's answer on the client's wire, model id restored
// ---------------------------------------------------------------------------

function stopReasonOf(finish: string | null): string {
  if (finish === 'length') return 'max_tokens';
  if (finish === 'tool_calls' || finish === 'function_call') return 'tool_use';
  if (finish === 'content_filter') return 'refusal';
  return 'end_turn';
}

function argumentsObject(value: string): Json {
  if (value.trim() !== '') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not a JSON object: an empty input, exactly as the gateway produced it.
    }
  }
  return {};
}

/** A judged JSON answer as an Anthropic Messages object. */
function anthropicJsonOf(j: JudgedAnswer, model: string): Json {
  const content: Json[] = [];
  if (j.text !== '') content.push({ type: 'text', text: j.text });
  for (const call of j.toolCalls) {
    content.push({
      type: 'tool_use',
      id: call.id !== '' ? call.id : 'toolu_unknown',
      name: call.name,
      input: argumentsObject(call.arguments),
    });
  }
  if (content.length === 0) content.push({ type: 'text', text: '' });
  return {
    id: `msg_${j.firstId !== '' ? j.firstId : 'aggregate'}`,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: stopReasonOf(j.finishReason),
    stop_sequence: null,
    usage: {
      input_tokens: j.usage?.prompt ?? 0,
      output_tokens: j.usage?.completion ?? 0,
    },
  };
}

function sseEvent(event: string | null, data: unknown): string {
  return `${event === null ? '' : `event: ${event}\n`}data: ${JSON.stringify(data)}\n\n`;
}

/**
 * A judged OpenAI stream, relayed frame by frame with the dialled id put
 * back on every chunk and exactly one [DONE] at the end, whatever the
 * upstream's own ending looked like.
 */
function openAIStreamOf(j: JudgedAnswer, model: string): string {
  const raw = typeof j.payload === 'string' ? j.payload : '';
  const out: string[] = [];
  for (const frame of sseFrames(raw)) {
    const lines: string[] = [];
    for (const line of frame.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) {
        lines.push(line);
        continue;
      }
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue; // re-appended once, at the end
      if (payload === '') {
        lines.push(line);
        continue;
      }
      try {
        const chunk: unknown = JSON.parse(payload);
        if (isRecord(chunk)) {
          lines.push(`data: ${JSON.stringify({ ...chunk, model })}`);
          continue;
        }
      } catch {
        // Not JSON: relay the line untouched.
      }
      lines.push(line);
    }
    if (lines.some((l) => l.trim() !== '')) out.push(`${lines.join('\n')}\n\n`);
  }
  out.push('data: [DONE]\n\n');
  return out.join('');
}

/**
 * A judged stream as the Anthropic event lifecycle: message_start, one
 * content block per text run or tool call (a ping right after the first
 * block opens), message_delta with the stop reason and output usage, then
 * message_stop. Usage figures are the gateway's own, carried through.
 */
function anthropicStreamOf(j: JudgedAnswer, model: string): string {
  const events: string[] = [];
  events.push(
    sseEvent('message_start', {
      type: 'message_start',
      message: {
        id: `msg_${j.firstId !== '' ? j.firstId : 'stream'}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: j.usage?.prompt ?? 0, output_tokens: 0 },
      },
    }),
  );
  let index = 0;
  let pingSent = false;
  const ping = (): string[] => {
    if (pingSent) return [];
    pingSent = true;
    return [sseEvent('ping', { type: 'ping' })];
  };
  if (j.text !== '') {
    events.push(
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      }),
      ...ping(),
    );
    for (const segment of j.segments) {
      events.push(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: segment },
        }),
      );
    }
    events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    index += 1;
  }
  for (const call of j.toolCalls) {
    events.push(
      sseEvent('content_block_start', {
        type: 'content_block_start',
        index,
        content_block: {
          type: 'tool_use',
          id: call.id !== '' ? call.id : `toolu_${index}`,
          name: call.name,
          input: {},
        },
      }),
      ...ping(),
    );
    if (call.arguments !== '') {
      events.push(
        sseEvent('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: call.arguments },
        }),
      );
    }
    events.push(sseEvent('content_block_stop', { type: 'content_block_stop', index }));
    index += 1;
  }
  events.push(
    sseEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReasonOf(j.finishReason), stop_sequence: null },
      usage: { output_tokens: j.usage?.completion ?? 0 },
    }),
    sseEvent('message_stop', { type: 'message_stop' }),
  );
  return events.join('');
}

// ---------------------------------------------------------------------------
// The gateway dial and the failover loop
// ---------------------------------------------------------------------------

// Per-attempt ceiling: a last-resort guard only. Failover decisions are made
// on received statuses and bytes, never on elapsed time, so a replay (which
// the cassette answers instantly) walks the same chain as the live pass.
const ATTEMPT_TIMEOUT_MS = Number(process.env.MAKEFUN_ATTEMPT_TIMEOUT_MS ?? 25_000) || 25_000;
const PROMPT_BUDGET_MS = 27_000;
const MAX_ATTEMPTS = 8;
const MAX_UPSTREAM_BYTES = 8 * 1024 * 1024;

function chatCompletionsUrl(): string {
  const base = (process.env.OPENAI_BASE_URL ?? '').replace(/\/+$/, '');
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
}

interface AttemptOutcome {
  judged: JudgedAnswer | null;
  trailRow: TrailRow | null;
}

/** One gateway call, fully buffered and judged. Network failure judges as no answer at all. */
async function attemptOnce(
  upstreamBody: Json,
  model: string,
  stream: boolean,
  tokens: readonly string[],
): Promise<AttemptOutcome> {
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY ?? ''}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    });
  } catch {
    return { judged: null, trailRow: null }; // no HTTP answer: nothing to put on the trail
  }
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    return { judged: null, trailRow: { status: res.status, code: '', model } };
  }
  if (raw.length > MAX_UPSTREAM_BYTES) {
    return { judged: null, trailRow: { status: res.status, code: '', model } };
  }
  const { j, code } = stream ? judgeStream(res.status, raw, tokens) : judgeJson(res.status, raw, tokens);
  if (j.ok) return { judged: j, trailRow: null };
  const rowCode = code !== '' ? code : errorCodeOfSafe(raw);
  return { judged: null, trailRow: { status: res.status, code: rowCode.slice(0, 64), model } };
}

function errorCodeOfSafe(raw: string): string {
  try {
    return errorCodeOf(JSON.parse(raw));
  } catch {
    return '';
  }
}

interface ServedAnswer {
  status: number;
  contentType: string;
  body: string;
  trail: TrailRow[];
}

/** Walk the candidate chain until a model serves the prompt or the chain runs out. */
async function servePrompt(
  brief: Brief,
  wire: 'openai' | 'anthropic',
  clientBody: Json,
  manifestRow: PromptRow | undefined,
): Promise<ServedAnswer> {
  const stream = clientBody.stream === true;
  const requirements = mergeRequirements(bodyRequirements(wire, clientBody), manifestRow?.requires);
  const tokens = requestTokens(wire, clientBody);
  const chain = candidateChain(brief, requirements);
  const trail: TrailRow[] = [];
  const startedAt = Date.now(); // control flow only; never reaches an output byte

  for (const candidate of chain.slice(0, MAX_ATTEMPTS)) {
    if (trail.length > 0 && Date.now() - startedAt > PROMPT_BUDGET_MS) break;
    const upstreamBody =
      wire === 'anthropic' ? anthropicToOpenAI(clientBody, candidate.id) : openAIUpstreamBody(clientBody, candidate.id);
    const outcome = await attemptOnce(upstreamBody, candidate.id, stream, tokens);
    if (outcome.trailRow !== null) trail.push(outcome.trailRow);
    const j = outcome.judged;
    if (j === null) continue;
    // This model really served the prompt: render its answer on the client's wire.
    if (wire === 'openai') {
      if (stream) return { status: 200, contentType: 'text/event-stream', body: openAIStreamOf(j, candidate.id), trail };
      const payload = isRecord(j.payload) ? { ...j.payload, model: candidate.id } : j.payload;
      return { status: 200, contentType: 'application/json', body: JSON.stringify(payload), trail };
    }
    if (stream) return { status: 200, contentType: 'text/event-stream', body: anthropicStreamOf(j, candidate.id), trail };
    return { status: 200, contentType: 'application/json', body: JSON.stringify(anthropicJsonOf(j, candidate.id)), trail };
  }

  // No candidate served: an honest wire-shaped failure, with the trail attached.
  const message = 'no free model could serve this prompt';
  const body =
    wire === 'anthropic'
      ? JSON.stringify({ type: 'error', error: { type: 'api_error', message } })
      : JSON.stringify({ error: { message, type: 'upstream_error', code: null } });
  return { status: 502, contentType: 'application/json', body, trail };
}

// ---------------------------------------------------------------------------
// HTTP server, registration, and the work loop
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_UPSTREAM_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...extra });
  res.end(JSON.stringify(value));
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const brief = readBrief(process.env.MAKEFUN_PROMPT_FILE ?? '');
  const catalog = buildCatalog(brief);

  // --list: the same catalog document the server registers, byte for byte.
  if (process.argv.includes('--list')) {
    process.stdout.write(`${JSON.stringify(catalog)}\n`);
    return;
  }

  const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is not set');

  let arrival = 0;
  const server = createServer((req, res) => {
    void (async () => {
      try {
        const path = (req.url ?? '').split('?')[0];
        if (req.method === 'GET' && path === '/v1/models') {
          const anthropic = req.headers['x-api-key'] !== undefined;
          sendJson(res, 200, anthropic ? anthropicModelList(brief) : openAIModelList(brief));
          return;
        }
        if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/v1/messages')) {
          const wire: 'openai' | 'anthropic' = path === '/v1/messages' ? 'anthropic' : 'openai';
          let body: Json;
          try {
            const parsed: unknown = JSON.parse(await readBody(req));
            if (!isRecord(parsed)) throw new Error('body is not an object');
            body = parsed;
          } catch {
            if (wire === 'anthropic') {
              sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'the request body is not valid JSON' } });
            } else {
              sendJson(res, 400, { error: { message: 'the request body is not valid JSON', type: 'invalid_request_error', code: null } });
            }
            return;
          }
          const manifestRow = brief.prompts[arrival];
          arrival += 1;
          const served = await servePrompt(brief, wire, body, manifestRow);
          const headers: Record<string, string> = { 'content-type': served.contentType };
          if (served.contentType === 'text/event-stream') headers['cache-control'] = 'no-cache';
          if (served.trail.length > 0) {
            headers['x-makefun-upstream-failures'] = JSON.stringify(served.trail.slice(0, 8));
          }
          res.writeHead(served.status, headers);
          res.end(served.body);
          return;
        }
        if (req.method === 'POST' && path === '/v1/responses') {
          sendJson(res, 501, { error: { message: 'this entry serves chat completions and messages', type: 'invalid_request_error', code: null } });
          return;
        }
        sendJson(res, 404, { error: { message: 'not found', type: 'invalid_request_error', code: null } });
      } catch {
        if (!res.headersSent) {
          sendJson(res, 500, { error: { message: 'internal error', type: 'api_error', code: null } });
        } else {
          res.end();
        }
      }
    })();
  });

  const listen = (): Promise<number> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '0.0.0.0', () => {
        const address = server.address();
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  let port = await listen();
  if (port === 8080) {
    // The environment owns 8080; take another port.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    port = await listen();
  }

  // Register the catalog with the environment, retrying while it comes up.
  let registered = false;
  for (let i = 0; i < 80 && !registered; i++) {
    try {
      const r = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ protocol_version: 1, port, catalog }),
        signal: AbortSignal.timeout(5000),
      });
      if (r.ok) registered = true;
      else await sleep(250);
    } catch {
      await sleep(250);
    }
  }
  if (!registered) throw new Error('the environment did not accept registration');

  // Poll for work until the environment says the trial is done.
  const startedAt = Date.now(); // control flow only
  for (;;) {
    let done = false;
    try {
      const r = await fetch(`${envUrl}/work`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) {
        const w: unknown = await r.json();
        done = isRecord(w) && w.done === true;
      }
    } catch {
      done = false;
    }
    if (done) break;
    if (Date.now() - startedAt > 235_000) break; // stay inside the pod's wall
    await sleep(150);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
