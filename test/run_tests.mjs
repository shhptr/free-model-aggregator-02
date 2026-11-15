// Local test suite for the free-model-aggregator-02 entry.
//
// Hosts two in-process mocks — the environment (register/work) and the
// gateway (Chat Completions answers whose behaviour is keyed by the dialled
// model id) — then drives the real entry process over HTTP with the kit's
// own practice-trial client bodies. No network, no keys, no Docker.
//
// Run: node test/run_tests.mjs   (exit 0 = all checks passed)

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const KIT = join(ROOT, '..', 'agent-wallet-sol', 'free-model-aggregator-02-kit');
const TRIAL0_BRIEF = join(KIT, 'practice', 'trial-0', 'input', 'prompt.txt');
const workload = JSON.parse(readFileSync(join(KIT, 'practice', 'trial-0', 'input', 'env', 'workload.json'), 'utf8'));
const bodyOf = (id) => workload.bodies[id];

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : `  -- ${detail}`}`);
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Mock gateway: behaviour keyed by a substring of the dialled model id
// ---------------------------------------------------------------------------

const gatewayLog = [];
const tokenOf = (body) => {
  const text = JSON.stringify(body.messages ?? []);
  const m = text.match(/[A-Z]+-\d{4}/);
  return m ? m[0] : 'TOKEN-0000';
};

function goodPayload(body) {
  const token = tokenOf(body);
  return body.response_format ? `{"token": "${token}"}` : token;
}

function completionJson(body, overrides = {}) {
  const upstreamModel = String(body.model).replace('openrouter/', '');
  return {
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 1767225600,
    model: upstreamModel,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: goodPayload(body) },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    ...overrides,
  };
}

function sseFrame(data) {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function goodStream(body) {
  const upstreamModel = String(body.model).replace('openrouter/', '');
  const payload = goodPayload(body);
  const half = Math.ceil(payload.length / 2);
  const chunk = (delta, finish) => ({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 1767225600,
    model: upstreamModel,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  return [
    sseFrame(chunk({ role: 'assistant', content: '' }, null)),
    sseFrame(chunk({ content: payload.slice(0, half) }, null)),
    sseFrame(chunk({ content: payload.slice(half) }, null)),
    sseFrame(chunk({}, 'stop')),
    sseFrame({
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: 1767225600,
      model: upstreamModel,
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
    }),
    sseFrame('[DONE]'),
  ].join('');
}

const gateway = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* recorded below */
    }
    gatewayLog.push({ model: body.model ?? null, stream: body.stream === true, json: !!body.response_format });
    const model = String(body.model ?? '');
    const sendJson = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (model.includes('hang')) {
      return; // never answers: the entry's per-attempt timeout must fire
    }
    if (model.includes('bad429')) {
      return sendJson(429, { error: { message: 'Rate limit reached', code: 'rate_limited', type: 'rate_limit_error' } });
    }
    if (model.includes('bad500')) {
      return sendJson(500, { error: { message: 'Internal error', code: 'internal_error' } });
    }
    if (model.includes('err200')) {
      return sendJson(200, { error: { message: 'provider exploded', code: 'provider_error' } });
    }
    if (model.includes('abort') && body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(sseFrame({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1767225600, model: model.replace('openrouter/', ''), choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }));
      res.write(sseFrame({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 1767225600, model: model.replace('openrouter/', ''), choices: [{ index: 0, delta: { content: 'partial ' }, finish_reason: null }] }));
      // Mid-stream abort after the headers have flushed: no finish chunk, no [DONE].
      setTimeout(() => res.destroy(), 25);
      return;
    }
    if (body.stream === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      return res.end(goodStream(body));
    }
    if (model.includes('empty')) {
      const v = completionJson(body);
      v.choices[0].message.content = '';
      return sendJson(200, v);
    }
    if (model.includes('badjson')) {
      const v = completionJson(body);
      v.choices[0].message.content = '{"result": "completed", "detail": "no token in here"}';
      return sendJson(200, v);
    }
    if (model.includes('wrapjson')) {
      const v = completionJson(body);
      v.choices[0].message.content = '```json\n{"token": "' + tokenOf(body) + '"}\n```';
      return sendJson(200, v);
    }
    if (model.includes('nousage')) {
      const v = completionJson(body);
      delete v.usage;
      return sendJson(200, v);
    }
    if (model.includes('toolcall')) {
      const v = completionJson(body);
      v.choices[0].message = {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'lookup_account', arguments: '{"account_id":"A-1"}' } },
        ],
      };
      v.choices[0].finish_reason = 'tool_calls';
      return sendJson(200, v);
    }
    if (model.includes('tooltext')) {
      const v = completionJson(body);
      v.choices[0].message = {
        role: 'assistant',
        content: tokenOf(body),
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'lookup_account', arguments: '{"account_id":"A-1"}' } },
        ],
      };
      v.choices[0].finish_reason = 'tool_calls';
      return sendJson(200, v);
    }
    return sendJson(200, completionJson(body));
  });
});

// ---------------------------------------------------------------------------
// Mock environment: register + work
// ---------------------------------------------------------------------------

let registeredBody = null;
let workDone = false;
const mockEnv = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/register') {
      registeredBody = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, requests: 6 }));
    }
    if (req.method === 'GET' && req.url === '/work') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(workDone ? { done: true } : { done: false, next: null, pending: 6 }));
    }
    res.writeHead(404);
    res.end();
  });
});

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

// ---------------------------------------------------------------------------
// Brief + entry process management
// ---------------------------------------------------------------------------

const MANIFEST = [
  { id: 'p01', api: 'openai', stream: false, weight: 1, requires: { json: true } },
  { id: 'p02', api: 'openai', stream: true, weight: 2, requires: {} },
  { id: 'p03', api: 'anthropic', stream: true, weight: 2, requires: {} },
  { id: 'p04', api: 'openai', stream: false, weight: 1, requires: { json: true } },
  { id: 'p05', api: 'anthropic', stream: false, weight: 1, requires: { tools: true } },
  { id: 'p06', api: 'anthropic', stream: false, weight: 1, requires: {} },
];

const mockModel = (name, rating, caps = {}) => ({
  id: `openrouter/mock/${name}:free`,
  provider: 'openrouter',
  display_name: `Mock: ${name}`,
  rating_milli: rating,
  context_length: 1000000,
  tools: caps.tools !== false,
  vision: caps.vision !== false,
  json: caps.json !== false,
  free: true,
});

const tmp = mkdtempSync(join(tmpdir(), 'agg-test-'));
let briefCounter = 0;
function writeBrief(models) {
  briefCounter += 1;
  const path = join(tmp, `brief-${briefCounter}.txt`);
  const text = [
    'A test brief. The manifest, in the order the env sends them:',
    JSON.stringify({ schema: 'free-model-aggregator-02/prompts/v1', prompts: MANIFEST }),
    'The free models:',
    JSON.stringify({ schema: 'free-model-aggregator-02/models/v1', models }),
    '',
  ].join('\n\n');
  writeFileSync(path, text);
  return path;
}

let envPort = 0;
let gwPort = 0;

async function startEntry(briefPath, extraEnv = {}) {
  registeredBody = null;
  workDone = false;
  const child = spawn('node', ['main.ts'], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...extraEnv,
      MAKEFUN_ENV_URL: `http://127.0.0.1:${envPort}`,
      MAKEFUN_PROMPT_FILE: briefPath,
      MAKEFUN_TRIAL_SEED: 'test-seed',
      MAKEFUN_TRIAL_NOW: '2026-11-15T06:00:00.000Z',
      OPENAI_BASE_URL: `http://127.0.0.1:${gwPort}/v1`,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${gwPort}`,
      OPENAI_API_KEY: 'test-dummy-key',
      ANTHROPIC_API_KEY: 'test-dummy-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => process.stderr.write(`[entry] ${d}`));
  const deadline = Date.now() + 15000;
  while (registeredBody === null) {
    if (Date.now() > deadline) throw new Error('entry did not register in time');
    if (child.exitCode !== null) throw new Error(`entry exited early with ${child.exitCode}`);
    await new Promise((r) => setTimeout(r, 50));
  }
  return { child, port: registeredBody.port };
}

async function stopEntry(child) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill('SIGTERM');
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(child.exitCode ?? -1), 5000);
    child.on('exit', (code) => {
      clearTimeout(t);
      resolve(code);
    });
  });
}

async function call(port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, text: await res.text() };
}

async function models(port, headers) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { headers });
  return { status: res.status, json: JSON.parse(await res.text()) };
}

function runList(briefPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['main.ts', '--list'], {
      cwd: ROOT,
      env: { ...process.env, MAKEFUN_PROMPT_FILE: briefPath },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(`--list exit ${code}`))));
  });
}

const trailOf = (headers) => {
  const v = headers.get('x-makefun-upstream-failures');
  return v === null ? null : JSON.parse(v);
};

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioRealBrief() {
  console.log('\n== S1: real practice brief — routing by rating, catalog parity, model lists ==');
  gatewayLog.length = 0;
  const { child, port } = await startEntry(TRIAL0_BRIEF);

  const listed = await runList(TRIAL0_BRIEF);
  check('--list is byte-for-byte the registered catalog', listed === `${JSON.stringify(registeredBody.catalog)}\n`);
  check('register body has protocol_version 1', registeredBody.protocol_version === 1);
  check('catalog lists 14 free models', registeredBody.catalog.providers[0].models.length === 14);

  const openaiList = await models(port, { authorization: 'Bearer makefun-client' });
  const anthropicList = await models(port, { 'x-api-key': 'makefun-client', 'anthropic-version': '2023-06-01' });
  const catalogIds = registeredBody.catalog.providers[0].models.map((m) => m.id);
  check('/v1/models (Bearer) ids == catalog ids', eq(openaiList.json.data.map((m) => m.id), catalogIds));
  check('/v1/models (x-api-key) ids == catalog ids', eq(anthropicList.json.data.map((m) => m.id), catalogIds));

  gatewayLog.length = 0;
  const p01 = await call(port, '/v1/chat/completions', bodyOf('p01'));
  const p01Json = JSON.parse(p01.text);
  check('JSON prompt routed to best JSON-capable model (nemotron-3.5-super-vl, 1303)',
    gatewayLog[0]?.model === 'openrouter/nvidia/nemotron-3.5-super-vl:free', JSON.stringify(gatewayLog[0]));
  check('answer names the dialled id (prefix restored)', p01Json.model === 'openrouter/nvidia/nemotron-3.5-super-vl:free');
  check('JSON answer carries the token', p01Json.choices[0].message.content.includes('SPARROW-7435'));
  check('no failover trail on a clean serve', trailOf(p01.headers) === null);

  const p05 = await call(port, '/v1/messages', bodyOf('p05'), { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
  const p05Json = JSON.parse(p05.text);
  check('tools prompt routed to best tools-capable model (inkling-2-small, 1475)',
    gatewayLog.at(-1)?.model === 'openrouter/thinkingmachines/inkling-2-small:free', JSON.stringify(gatewayLog.at(-1)));
  check('anthropic answer shape: type message + text block with token',
    p05Json.type === 'message' && p05Json.content[0].type === 'text' && p05Json.content[0].text.includes('YARROW-4506'));
  check('anthropic usage mapped from gateway usage', p05Json.usage.input_tokens === 11 && p05Json.usage.output_tokens === 7);
  check('anthropic stop_reason mapped stop->end_turn', p05Json.stop_reason === 'end_turn');

  // Work-done exit: the entry must exit 0 when the environment says done.
  workDone = true;
  const code = await new Promise((resolve) => {
    const t = setTimeout(() => resolve(-1), 6000);
    child.on('exit', (c) => {
      clearTimeout(t);
      resolve(c);
    });
  });
  check('entry exits 0 when /work reports done', code === 0, `exit=${code}`);
}

async function scenarioFailover429() {
  console.log('\n== S2: failover on 429 ==');
  const brief = writeBrief([mockModel('bad429', 1700), mockModel('alpha', 1600)]);
  const { child, port } = await startEntry(brief);
  gatewayLog.length = 0;
  const r = await call(port, '/v1/chat/completions', bodyOf('p01'));
  const j = JSON.parse(r.text);
  check('served by the fallback after a 429', j.model === 'openrouter/mock/alpha:free');
  check('gateway saw [bad429, alpha] in order', eq(gatewayLog.map((g) => g.model), ['openrouter/mock/bad429:free', 'openrouter/mock/alpha:free']));
  const trail = trailOf(r.headers);
  check('trail has one row: status 429, code, failed model',
    Array.isArray(trail) && trail.length === 1 && trail[0].status === 429 && trail[0].code === 'rate_limited' && trail[0].model === 'openrouter/mock/bad429:free',
    JSON.stringify(trail));
  await stopEntry(child);
}

async function scenarioFailoverChain() {
  console.log('\n== S3: failover chain 500 -> empty 200 -> error-in-200 -> good ==');
  const brief = writeBrief([mockModel('bad500', 1700), mockModel('empty', 1650), mockModel('err200', 1600), mockModel('alpha', 1500)]);
  const { child, port } = await startEntry(brief);
  gatewayLog.length = 0;
  const plain = { model: 'auto', messages: [{ role: 'user', content: 'Reply with exactly the word ZEBRA-4721 and nothing else.' }], max_tokens: 300 };
  const r = await call(port, '/v1/chat/completions', plain);
  const j = JSON.parse(r.text);
  check('served by alpha after three failures', j.model === 'openrouter/mock/alpha:free');
  check('gateway order matches the rating chain', eq(gatewayLog.map((g) => g.model), [
    'openrouter/mock/bad500:free', 'openrouter/mock/empty:free', 'openrouter/mock/err200:free', 'openrouter/mock/alpha:free',
  ]));
  const trail = trailOf(r.headers);
  check('trail records all three failures in order', Array.isArray(trail) && eq(trail.map((t) => t.status), [500, 200, 200]), JSON.stringify(trail));
  check('error-in-200 trail row carries its code', trail?.[2]?.code === 'provider_error', JSON.stringify(trail));
  await stopEntry(child);
}

async function scenarioStreamAbort() {
  console.log('\n== S4: mid-stream abort fails over; OpenAI stream stays well-formed ==');
  const brief = writeBrief([mockModel('abort', 1700), mockModel('alpha', 1600)]);
  const { child, port } = await startEntry(brief);
  gatewayLog.length = 0;
  const r = await call(port, '/v1/chat/completions', bodyOf('p02'), { accept: 'text/event-stream' });
  check('stream served after abort failover', gatewayLog.length === 2 && gatewayLog[1].model === 'openrouter/mock/alpha:free');
  check('no partial frame of the aborted stream leaked', !r.text.includes('partial'));
  check('[DONE] appears exactly once and last', r.text.trimEnd().endsWith('data: [DONE]') && r.text.split('[DONE]').length === 2);
  const chunks = r.text.split('\n\n').filter((f) => f.includes('data: {')).map((f) => JSON.parse(f.split('data: ')[1]));
  check('every chunk names the dialled (fallback) model', chunks.every((c) => c.model === 'openrouter/mock/alpha:free'));
  const text = chunks.map((c) => c.choices?.[0]?.delta?.content ?? '').join('');
  check('streamed text carries the token', text.includes('COMET-3884'));
  const usageChunk = chunks.find((c) => c.usage);
  check('usage chunk relayed', usageChunk?.usage?.completion_tokens === 7);
  const trail = trailOf(r.headers);
  check('abort left a trail row with the gateway status', Array.isArray(trail) && trail.length === 1 && trail[0].status === 200, JSON.stringify(trail));
  await stopEntry(child);
}

async function scenarioAnthropicStream() {
  console.log('\n== S5: Anthropic SSE lifecycle ==');
  const brief = writeBrief([mockModel('alpha', 1600)]);
  const { child, port } = await startEntry(brief);
  const r = await call(port, '/v1/messages', bodyOf('p03'), { 'x-api-key': 'k', 'anthropic-version': '2023-06-01', accept: 'text/event-stream' });
  const events = r.text.split('\n\n').filter((f) => f.trim() !== '').map((f) => {
    const name = f.match(/^event: (.+)$/m)?.[1];
    const data = JSON.parse(f.split('\ndata: ')[1]);
    return { name, data };
  });
  check('event order is the Anthropic lifecycle', eq(events.map((e) => e.name), [
    'message_start', 'content_block_start', 'ping', 'content_block_delta', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop',
  ]), JSON.stringify(events.map((e) => e.name)));
  check('message_start carries the real input usage', events[0].data.message.usage.input_tokens === 11);
  check('message_delta carries stop_reason + output usage',
    events.at(-2).data.delta.stop_reason === 'end_turn' && events.at(-2).data.usage.output_tokens === 7);
  const text = events.filter((e) => e.name === 'content_block_delta').map((e) => e.data.delta.text).join('');
  check('streamed text carries the token', text.includes('FALCON-6712'));
  check('stream names the dialled model', events[0].data.message.model === 'openrouter/mock/alpha:free');
  await stopEntry(child);
}

async function scenarioZeroMutation() {
  console.log('\n== S6/S7: zero silent mutation — wrapped JSON served as-is, invalid JSON fails over ==');
  const brief = writeBrief([mockModel('wrapjson', 1700), mockModel('alpha', 1600)]);
  const { child, port } = await startEntry(brief);
  gatewayLog.length = 0;
  const r = await call(port, '/v1/chat/completions', bodyOf('p01'));
  const j = JSON.parse(r.text);
  check('markdown-wrapped JSON (token present) served by the first model, no failover',
    j.model === 'openrouter/mock/wrapjson:free' && gatewayLog.length === 1);
  check('answer text is byte-for-byte what the model produced (no unwrapping)',
    j.choices[0].message.content === '```json\n{"token": "SPARROW-7435"}\n```', JSON.stringify(j.choices[0].message.content));
  await stopEntry(child);

  const brief2 = writeBrief([mockModel('badjson', 1700), mockModel('alpha', 1600)]);
  const second = await startEntry(brief2);
  gatewayLog.length = 0;
  const r2 = await call(second.port, '/v1/chat/completions', bodyOf('p01'));
  const j2 = JSON.parse(r2.text);
  check('invalid JSON answer (token missing) is NOT repaired: fails over to alpha',
    j2.model === 'openrouter/mock/alpha:free' && gatewayLog.length === 2);
  check('the invalid text never reaches the client', !r2.text.includes('no token in here'));
  check('fallback answer is the gateway-produced JSON carrying the token',
    j2.choices[0].message.content === '{"token": "SPARROW-7435"}');
  await stopEntry(second.child);
}

async function scenarioTools() {
  console.log('\n== S8/S9/S10: tool traps ==');
  const brief = writeBrief([mockModel('toolcall', 1700), mockModel('alpha', 1600)]);
  const { child, port } = await startEntry(brief);
  gatewayLog.length = 0;
  const r = await call(port, '/v1/messages', bodyOf('p05'), { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
  const j = JSON.parse(r.text);
  check('tool-only answer to the tools prompt fails over (no token in text)',
    j.model === 'openrouter/mock/alpha:free' && gatewayLog.length === 2);
  check('fallback serves the token as a text block', j.content[0].type === 'text' && j.content[0].text.includes('YARROW-4506'));
  await stopEntry(child);

  const brief2 = writeBrief([mockModel('tooltext', 1700)]);
  const second = await startEntry(brief2);
  const toolsBody = {
    model: 'auto',
    messages: [{ role: 'user', content: 'Reply with exactly the word ZEBRA-4721 and nothing else.' }],
    tools: [{ type: 'function', function: { name: 'lookup_account', description: 'Look up', parameters: { type: 'object', properties: { account_id: { type: 'string' } } } } }],
    max_tokens: 300,
  };
  const r2 = await call(second.port, '/v1/chat/completions', toolsBody);
  const j2 = JSON.parse(r2.text);
  check('tool+text answer served as produced', j2.model === 'openrouter/mock/tooltext:free');
  check('tool_call arguments string passed through byte-for-byte (never fabricated or fixed)',
    j2.choices[0].message.tool_calls[0].function.arguments === '{"account_id":"A-1"}');
  check('finish_reason tool_calls preserved', j2.choices[0].finish_reason === 'tool_calls');

  const anthropicToolsBody = {
    model: 'auto',
    messages: [{ role: 'user', content: 'Reply with exactly the word ZEBRA-4721 and nothing else.' }],
    tools: [{ name: 'lookup_account', description: 'Look up', input_schema: { type: 'object', properties: { account_id: { type: 'string' } } } }],
    max_tokens: 300,
  };
  const r3 = await call(second.port, '/v1/messages', anthropicToolsBody, { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
  const j3 = JSON.parse(r3.text);
  const toolBlock = j3.content.find((b) => b.type === 'tool_use');
  check('anthropic tool_use input is the parsed JSON object', !!toolBlock && eq(toolBlock.input, { account_id: 'A-1' }), JSON.stringify(j3.content));
  check('anthropic stop_reason tool_calls->tool_use', j3.stop_reason === 'tool_use');
  await stopEntry(second.child);
}

async function scenarioCapabilityFilter() {
  console.log('\n== S11: strict capability filtering (json / tools) ==');
  const brief = writeBrief([
    mockModel('nojson', 1700, { json: false }),
    mockModel('notools', 1650, { tools: false }),
    mockModel('alpha', 1600),
  ]);
  const { child, port } = await startEntry(brief);
  gatewayLog.length = 0;
  await call(port, '/v1/chat/completions', bodyOf('p01'));
  check('JSON prompt skips the higher-rated json:false model, dials the best json-capable one',
    gatewayLog.length === 1 && gatewayLog[0].model === 'openrouter/mock/notools:free' && !gatewayLog.some((g) => g.model.includes('nojson')),
    JSON.stringify(gatewayLog));
  gatewayLog.length = 0;
  await call(port, '/v1/messages', bodyOf('p05'), { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
  check('tools prompt dials the best tools-capable model (nojson has tools, outranks alpha)',
    gatewayLog.length === 1 && gatewayLog[0].model === 'openrouter/mock/nojson:free', JSON.stringify(gatewayLog));
  await stopEntry(child);
}

async function scenarioNoUsageAndAllFail() {
  console.log('\n== S12: missing usage fails over; all-fail answers 502 and the server survives ==');
  const brief = writeBrief([mockModel('nousage', 1700), mockModel('alpha', 1600)]);
  const { child, port } = await startEntry(brief);
  gatewayLog.length = 0;
  const plain = { model: 'auto', messages: [{ role: 'user', content: 'Reply with exactly the word ZEBRA-4721 and nothing else.' }], max_tokens: 300 };
  const r = await call(port, '/v1/chat/completions', plain);
  check('answer without usage fails over', JSON.parse(r.text).model === 'openrouter/mock/alpha:free' && gatewayLog.length === 2);
  await stopEntry(child);

  const brief2 = writeBrief([mockModel('bad429', 1700), mockModel('bad500', 1600)]);
  const second = await startEntry(brief2);
  const r2 = await call(second.port, '/v1/chat/completions', bodyOf('p01'));
  check('all candidates failing -> 502 with a wire-shaped error', r2.status === 502 && !!JSON.parse(r2.text).error, `status=${r2.status}`);
  const list = await models(second.port, { authorization: 'Bearer x' });
  check('server still serves /v1/models after the failed prompt', list.status === 200 && list.json.data.length === 2);
  await stopEntry(second.child);
}

async function scenarioDeterminism() {
  console.log('\n== S13: determinism — same inputs twice, identical bytes ==');
  const brief = writeBrief([mockModel('alpha', 1600)]);
  const { child, port } = await startEntry(brief);
  const a = await call(port, '/v1/chat/completions', bodyOf('p01'));
  const b = await call(port, '/v1/chat/completions', bodyOf('p04'));
  check('two JSON prompts with the same shape answer identically modulo the token',
    a.text.replace('SPARROW-7435', 'T') === b.text.replace('MAPLE-3581', 'T'));
  const s1 = await call(port, '/v1/messages', bodyOf('p03'), { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
  const s2 = await call(port, '/v1/messages', bodyOf('p03'), { 'x-api-key': 'k', 'anthropic-version': '2023-06-01' });
  check('same streamed prompt twice -> byte-identical SSE', s1.text === s2.text);
  const l1 = await runList(brief);
  const l2 = await runList(brief);
  check('--list twice -> identical bytes', l1 === l2);
  check('--list matches the registered catalog in this scenario too', l1 === `${JSON.stringify(registeredBody.catalog)}\n`);
  await stopEntry(child);
}

async function scenarioTimeout() {
  console.log('\n== S14: a hanging model times out and fails over ==');
  const brief = writeBrief([mockModel('hang', 1700), mockModel('alpha', 1600)]);
  const { child, port } = await startEntry(brief, { MAKEFUN_ATTEMPT_TIMEOUT_MS: '800' });
  gatewayLog.length = 0;
  const plain = { model: 'auto', messages: [{ role: 'user', content: 'Reply with exactly the word ZEBRA-4721 and nothing else.' }], max_tokens: 300 };
  const started = Date.now();
  const r = await call(port, '/v1/chat/completions', plain);
  const elapsed = Date.now() - started;
  check('hanging first model is abandoned and the fallback serves',
    JSON.parse(r.text).model === 'openrouter/mock/alpha:free' && gatewayLog.length === 2, JSON.stringify(gatewayLog));
  check('the timeout fired promptly (no 25s stall)', elapsed < 10000, `elapsed=${elapsed}ms`);
  check('a timeout leaves no trail row (no HTTP answer was received)', trailOf(r.headers) === null);
  await stopEntry(child);
}

// ---------------------------------------------------------------------------

async function main() {
  envPort = await listen(mockEnv);
  gwPort = await listen(gateway);
  await scenarioRealBrief();
  await scenarioFailover429();
  await scenarioFailoverChain();
  await scenarioStreamAbort();
  await scenarioAnthropicStream();
  await scenarioZeroMutation();
  await scenarioTools();
  await scenarioCapabilityFilter();
  await scenarioNoUsageAndAllFail();
  await scenarioDeterminism();
  await scenarioTimeout();
  const failedCount = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failedCount}/${results.length} checks passed`);
  mockEnv.close();
  gateway.close();
  process.exit(failedCount === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
