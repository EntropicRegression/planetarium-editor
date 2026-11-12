// Checks that each provider turns the assistant's neutral conversation into the right requests
// and reads the replies back correctly, against canned responses (no network, no keys).
//
//   node tests/providers.test.js
//
// The provider scripts are browser scripts; they are loaded here into a small stand-in for the
// page (window, fetch, location).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// Objects made inside the page stand-in have another realm's prototypes; compare them by value.
const same = (actual, expected, message) => assert.deepStrictEqual(JSON.parse(JSON.stringify(actual)), expected, message);

const root = path.join(__dirname, '..');
const requests = [];
let replies = [];

/** A Response whose body is a server-sent-event stream of the given events. */
function sse(events, split) {
  const text = events.map((e) => (e.event ? `event: ${e.event}\n` : '') + `data: ${JSON.stringify(e.data)}\n\n`).join('');
  // Delivered in awkward pieces, as a network would.
  const size = split || 37;
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(Buffer.from(text.slice(i, i + size)));
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((c) => controller.enqueue(c));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  TextDecoder,
  AbortController,
  Response,
  URL,
  location: { protocol: 'file:' }, // no helper: OpenAI requests go straight to api.openai.com
  fetch: async (url, init) => {
    requests.push({ url: String(url), init, body: init && init.body ? JSON.parse(init.body) : null });
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request to ${url}`);
    return typeof next === 'function' ? next() : next;
  },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
sandbox.navigator = { language: 'zh-TW' };
for (const file of ['js/i18n.js', 'js/ai/core.js', 'js/ai/gemini.js', 'js/ai/openai.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}
const AI = sandbox.WallAI;
const tools = AI.tools({ imageGeneration: true });
const system = AI.systemPrompt({ imageGeneration: true });

const watch = () => {
  const seen = { text: '', started: [], details: [] };
  return {
    seen,
    callbacks: {
      onText: (t) => { seen.text += t; },
      onToolStart: (id, name) => seen.started.push([id, name]),
      onToolDetail: (id, detail) => seen.details.push([id, detail]),
    },
  };
};

const PNG = 'iVBORw0KGgo=';
const userParts = [{ type: 'text', text: 'Picture ref:1 from the person (10×10 px):' }, { type: 'image', mediaType: 'image/png', data: PNG }, { type: 'text', text: '畫海邊' }];
const toolResults = [
  { id: 'c1', name: 'get_scene', isError: false, parts: [{ type: 'text', text: '{"layers":[]}' }] },
  { id: 'c2', name: 'view_canvas', isError: false, parts: [{ type: 'image', mediaType: 'image/jpeg', data: PNG }, { type: 'text', text: 'preview' }] },
  { id: 'c3', name: 'add_svg_layer', isError: true, parts: [{ type: 'text', text: 'SVG is not well-formed' }] },
];

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// ---------------------------------------------------------------- core

test('core: tool set and prompt depend on image generation', () => {
  const plain = AI.tools({});
  assert(!plain.some((t) => t.name === 'generate_image'));
  assert(tools.some((t) => t.name === 'generate_image'));
  assert(!AI.systemPrompt({}).includes('generate_image'));
  assert(system.includes('generate_image'));
  for (const tool of tools) {
    assert.strictEqual(tool.parameters.type, 'object', tool.name);
    for (const key of tool.parameters.required || []) assert(tool.parameters.properties[key], `${tool.name}.${key}`);
  }
});

test('core: invalid() catches missing, mistyped and out-of-enum inputs', () => {
  const tool = (name) => tools.find((t) => t.name === name);
  assert.strictEqual(AI.invalid(tool('add_svg_layer'), { name: 'a', depth: 1, svg: '<svg/>' }), null);
  assert.match(AI.invalid(tool('add_svg_layer'), { name: 'a', depth: 1 }), /svg/);
  assert.match(AI.invalid(tool('add_svg_layer'), { name: 'a', depth: '1', svg: '' }), /depth/);
  assert.match(AI.invalid(tool('add_image_layer'), { image: 'ref:1', name: 'a', depth: 1, fit: 'stretch' }), /fit/);
  assert.match(AI.invalid(tool('add_pixel_layer'), { name: 'a', depth: 1, pixel_size: 6, palette: [], rows: ['a', 3] }), /rows/);
  assert.match(AI.invalid(tool('get_scene'), null), /object/);
  assert.strictEqual(AI.invalid(tool('get_scene'), {}), null);
});

test('core: readSse reassembles events split across chunks', async () => {
  const got = [];
  await AI.readSse(sse([{ data: { a: 1 } }, { event: 'x', data: { b: '跨\n行' } }], 5), (data, name) => got.push([data, name]));
  same(got, [[{ a: 1 }, ''], [{ b: '跨\n行' }, 'x']]);
});

// ---------------------------------------------------------------- Gemini

test('gemini: request shape, streamed call with signature, results with a picture', async () => {
  requests.length = 0;
  const session = AI.providers.gemini.createSession({ credential: 'KEY', model: 'gemini-4-hydrogen', system, tools });
  session.addUser(userParts);
  replies = [sse([
    { data: { candidates: [{ content: { role: 'model', parts: [{ text: '我先' }] } }] } },
    { data: { candidates: [{ content: { role: 'model', parts: [{ text: '看看。' }, { functionCall: { name: 'get_scene', args: {}, id: 'c1' }, thoughtSignature: 'SIG' }] } }] } },
    { data: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'add_svg_layer', args: { name: '天空', depth: 1, svg: '<svg/>' } } }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 5 } } },
  ])];
  const w = watch();
  const reply = await session.run(w.callbacks);

  const first = requests[0];
  assert(first.url.endsWith('/v1beta/models/gemini-4-hydrogen:streamGenerateContent?alt=sse'));
  assert.strictEqual(first.init.headers['x-goog-api-key'], 'KEY');
  assert.strictEqual(first.body.systemInstruction.parts[0].text, system);
  same(first.body.contents[0].parts[1], { inlineData: { mimeType: 'image/png', data: PNG } });
  const declarations = first.body.tools[0].functionDeclarations;
  assert.strictEqual(declarations.length, tools.length);
  assert(!('parameters' in declarations.find((d) => d.name === 'get_scene')), 'no empty schema for a tool without arguments');
  assert(declarations.find((d) => d.name === 'add_svg_layer').parameters.required.includes('svg'));

  assert.strictEqual(w.seen.text, '我先看看。');
  assert.strictEqual(reply.stop, 'tools');
  same(reply.usage, { input: 100, output: 25 });
  assert.strictEqual(reply.toolCalls.length, 2);
  assert.strictEqual(reply.toolCalls[0].id, 'c1');
  assert(reply.toolCalls[1].id, 'a call without an id is given one');
  same(w.seen.details, [[reply.toolCalls[1].id, '天空']]);

  // Second turn: the model turn goes back part for part, then every result in one user turn.
  session.addToolResults(toolResults);
  replies = [sse([{ data: { candidates: [{ content: { role: 'model', parts: [{ text: '完成。' }] }, finishReason: 'STOP' }] } }])];
  const end = await session.run(watch().callbacks);
  assert.strictEqual(end.stop, 'end');
  const contents = requests[1].body.contents;
  assert.strictEqual(contents.length, 3);
  assert.strictEqual(contents[1].role, 'model');
  assert.strictEqual(contents[1].parts.find((p) => p.functionCall).thoughtSignature, 'SIG', 'the signature stays on its part');
  const results = contents[2].parts;
  assert.strictEqual(contents[2].role, 'user');
  assert.strictEqual(results.length, 3);
  same(results[0].functionResponse, { name: 'get_scene', id: 'c1', response: { result: '{"layers":[]}' } });
  assert.strictEqual(results[1].functionResponse.parts[0].inlineData.mimeType, 'image/jpeg');
  assert.strictEqual(results[1].functionResponse.response.image.$ref, results[1].functionResponse.parts[0].inlineData.displayName);
  assert.strictEqual(results[2].functionResponse.response.error, 'SVG is not well-formed');
});

test('gemini: pictures move beside the result if the nested form is rejected', async () => {
  requests.length = 0;
  const session = AI.providers.gemini.createSession({ credential: 'KEY', model: 'gemini-4-carbon', system, tools });
  session.addUser([{ type: 'text', text: 'hi' }]);
  replies = [sse([{ data: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'view_canvas', args: {}, id: 'c2' } }] }, finishReason: 'STOP' }] } }])];
  await session.run(watch().callbacks);
  session.addToolResults([toolResults[1]]);
  replies = [
    json(400, { error: { code: 400, message: 'functionResponse.parts is not supported', status: 'INVALID_ARGUMENT' } }),
    sse([{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }]),
  ];
  await session.run(watch().callbacks);
  const retried = requests[2].body.contents[2].parts;
  assert(!retried[0].functionResponse.parts);
  same(retried[1], { inlineData: { mimeType: 'image/jpeg', data: PNG } });
});

test('gemini: errors and stops are classified', async () => {
  const make = () => {
    const s = AI.providers.gemini.createSession({ credential: 'KEY', model: 'm', system, tools });
    s.addUser([{ type: 'text', text: 'hi' }]);
    return s;
  };
  replies = [json(400, { error: { message: 'API key not valid', status: 'INVALID_ARGUMENT', details: [{ reason: 'API_KEY_INVALID' }] } })];
  await assert.rejects(make().run(watch().callbacks), (e) => e.kind === 'auth');
  replies = [json(429, { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED' } })];
  await assert.rejects(make().run(watch().callbacks), (e) => e.kind === 'rate');
  replies = [sse([{ data: { promptFeedback: { blockReason: 'SAFETY' } } }])];
  assert.strictEqual((await make().run(watch().callbacks)).stop, 'refusal');
  replies = [sse([{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] } }])];
  assert.strictEqual((await make().run(watch().callbacks)).stop, 'max_tokens');
  // A malformed call is asked for again, then succeeds.
  replies = [
    sse([{ data: { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] } }]),
    sse([{ data: { candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] } }]),
  ];
  assert.strictEqual((await make().run(watch().callbacks)).stop, 'end');
});

// ---------------------------------------------------------------- OpenAI

const openaiTurn = [
  { data: { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' } } },
  { data: { type: 'response.output_text.delta', delta: '好,' } },
  { data: { type: 'response.output_text.delta', delta: '開始。' } },
  { data: { type: 'response.output_item.done', item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '好,開始。' }] } } },
  { data: { type: 'response.output_item.added', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'add_svg_layer' } } },
  { data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"name":"天' } },
  { data: { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '空","depth":1,"svg":"<svg/>"}' } },
  { data: { type: 'response.output_item.done', item: { type: 'function_call', id: 'fc_1', call_id: 'c1', name: 'add_svg_layer', arguments: '{"name":"天空","depth":1,"svg":"<svg/>"}' } } },
  { data: { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 200, output_tokens: 40 } } } },
];

test('openai: request shape, streamed call, results with a picture, items echoed', async () => {
  requests.length = 0;
  const session = AI.providers.openai.createSession({ credential: 'sk-test', model: 'gpt-6.1-sol', system, tools });
  session.addUser(userParts);
  replies = [sse(openaiTurn)];
  const w = watch();
  const reply = await session.run(w.callbacks);

  const first = requests[0];
  assert.strictEqual(first.url, 'https://api.openai.com/v1/responses');
  assert.strictEqual(first.init.headers.authorization, 'Bearer sk-test');
  assert.strictEqual(first.body.store, false);
  assert.strictEqual(first.body.stream, true);
  assert.strictEqual(first.body.instructions, system);
  assert(!('max_output_tokens' in first.body) && !('temperature' in first.body), 'parameters the ChatGPT plan rejects are never sent');
  same(first.body.input[0].content[1], { type: 'input_image', image_url: `data:image/png;base64,${PNG}`, detail: 'auto' });
  assert.strictEqual(first.body.tools[0].type, 'function');
  assert.strictEqual(first.body.tools.length, tools.length);

  assert.strictEqual(w.seen.text, '好,開始。');
  same(w.seen.started, [['c1', 'add_svg_layer']]);
  same(w.seen.details.pop(), ['c1', '天空']);
  same(reply.toolCalls, [{ id: 'c1', name: 'add_svg_layer', input: { name: '天空', depth: 1, svg: '<svg/>' } }]);
  same(reply.usage, { input: 200, output: 40 });

  session.addToolResults([toolResults[1], { ...toolResults[2], id: 'c9' }]);
  replies = [sse([{ data: { type: 'response.completed', response: { status: 'completed', usage: {}, output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }] } } }])];
  const end = await session.run(watch().callbacks);
  assert.strictEqual(end.stop, 'end');
  const input = requests[1].body.input;
  same(input.slice(1, 4).map((i) => i.type), ['reasoning', 'message', 'function_call'], 'the model\'s items go back in order');
  assert.strictEqual(input[1].encrypted_content, 'ENC');
  same(input[4], { type: 'function_call_output', call_id: 'c2', output: [{ type: 'input_image', image_url: `data:image/jpeg;base64,${PNG}`, detail: 'auto' }, { type: 'input_text', text: 'preview' }] });
  assert.strictEqual(input[5].output[0].text, 'ERROR:');
});

test('openai: errors, limits and incomplete turns are classified', async () => {
  const make = () => {
    const s = AI.providers.openai.createSession({ credential: 'sk-test', model: 'm', system, tools });
    s.addUser([{ type: 'text', text: 'hi' }]);
    return s;
  };
  replies = [json(401, { error: { message: 'Incorrect API key', code: 'invalid_api_key' } })];
  await assert.rejects(make().run(watch().callbacks), (e) => e.kind === 'auth');
  replies = [json(429, { error: { message: 'limit', code: 'subscription_sharing_usage_limit_exceeded' } })];
  await assert.rejects(make().run(watch().callbacks), (e) => e.kind === 'rate');
  // A rejected reasoning setting is dropped and the request sent again.
  requests.length = 0;
  replies = [json(400, { error: { message: 'unsupported reasoning effort' } }), sse([{ data: { type: 'response.completed', response: { status: 'completed', output: [] } } }])];
  await make().run(watch().callbacks);
  assert(requests[0].body.reasoning && !requests[1].body.reasoning);
  replies = [sse([{ data: { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } } }])];
  assert.strictEqual((await make().run(watch().callbacks)).stop, 'max_tokens');
  replies = [sse([{ data: { type: 'response.output_text.delta', delta: 'x' } }])];
  await assert.rejects(make().run(watch().callbacks), (e) => e.kind === 'network', 'a stream that ends without completion is not a turn');
  replies = [sse([{ data: { type: 'response.failed', response: { error: { message: 'boom' } } } }])];
  await assert.rejects(make().run(watch().callbacks), (e) => e.message === 'boom');
});

test('chatgpt: sign-in is unavailable without the helper', async () => {
  const status = await AI.providers.chatgpt.auth.status();
  assert.strictEqual(status.available, false);
  const session = AI.providers.chatgpt.createSession({ model: 'gpt-6.1-sol', system, tools });
  session.addUser([{ type: 'text', text: 'hi' }]);
  await assert.rejects(session.run(watch().callbacks), (e) => e.kind === 'auth');
});

// ---------------------------------------------------------------- image generators

test('image generators: request shapes', async () => {
  // Image() does not exist here; the generators only use it to measure the result.
  sandbox.Image = class {
    set src(value) {
      this.naturalWidth = 1024;
      this.naturalHeight = 1536;
      setTimeout(() => this.onload(), 0);
    }
  };
  requests.length = 0;
  replies = [json(200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG }, thought: true }, { inlineData: { mimeType: 'image/png', data: PNG } }] } }] })];
  const g = await AI.imageGenerators.gemini.generate({ credential: 'KEY', model: 'gemini-3.1-flash-image', prompt: 'a pine tree', shape: 'portrait', transparent: true, references: [{ type: 'image', mediaType: 'image/jpeg', data: PNG }] });
  assert.strictEqual(g.transparent, false);
  assert.strictEqual(g.width, 1024);
  const body = requests[0].body;
  same(body.generationConfig, { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '9:16', imageSize: '2K' } });
  assert.match(body.contents[0].parts[0].text, /magenta/, 'a green subject gets a magenta backdrop');
  assert.strictEqual(body.contents[0].parts[1].inlineData.mimeType, 'image/jpeg');

  replies = [json(200, { data: [{ b64_json: PNG }] })];
  const o = await AI.imageGenerators.openai.generate({ credential: 'sk-test', model: 'gpt-image-2.5-flare', prompt: 'a cat', shape: 'square', transparent: true, references: [] });
  assert.strictEqual(o.transparent, true);
  assert.strictEqual(requests[1].url, 'https://api.openai.com/v1/images/generations');
  same(requests[1].body, { model: 'gpt-image-2.5-flare', prompt: 'a cat', n: 1, size: '1024x1024', quality: 'medium', background: 'transparent', output_format: 'png' });

  replies = [json(200, { data: [{ b64_json: PNG }] })];
  await AI.imageGenerators.openai.generate({ credential: 'sk-test', model: 'gpt-image-2.5-flare', prompt: 'same', shape: 'portrait', transparent: false, references: [{ type: 'image', mediaType: 'image/png', data: PNG }] });
  assert.strictEqual(requests[2].url, 'https://api.openai.com/v1/images/edits');
  assert.strictEqual(requests[2].body.images[0].image_url, `data:image/png;base64,${PNG}`);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      replies = [];
      await fn();
      console.log(`ok    ${name}`);
    } catch (error) {
      failed++;
      console.log(`FAIL  ${name}\n      ${String(error.stack || error).split('\n').slice(0, 4).join('\n      ')}`);
    }
  }
  console.log(failed ? `\n${failed} of ${tests.length} failed` : `\nall ${tests.length} passed`);
  process.exit(failed ? 1 : 0);
})();
