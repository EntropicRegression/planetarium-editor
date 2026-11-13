// OpenAI, through the Responses API. Two ways in:
//
//   "openai"   an API key, billed to the API account;
//   "chatgpt"  Sign in with ChatGPT, which uses the person's ChatGPT plan. That needs the local
//              helper (serve.py): OpenAI redirects the sign-in to a loopback address, and the
//              helper keeps the tokens out of the page.
//
// Requests go through the helper when it is there (api.openai.com then never sees a browser
// origin), and straight to api.openai.com otherwise, which works for the API-key mode only.
// Also registers OpenAI's image models as an image generator (API key only).
(function () {
  'use strict';

  const t = window.WallI18n.t;

  const { AiError, httpError, readSse, request } = window.WallAI;

  const DIRECT = 'https://api.openai.com';
  const KEY = {
    kind: 'key',
    name: 'openai',
    label: t`OpenAI API 金鑰`,
    placeholder: 'sk-...',
    help: t`在 platform.openai.com 建立。只會傳送到 api.openai.com。`,
  };

  // ---------------------------------------------------------------- the local helper

  let helperCheck = null;
  /** Whether this page was served by serve.py, which then answers /api/status. */
  function helper() {
    if (!helperCheck) {
      helperCheck = (location.protocol === 'file:' ? Promise.reject() : fetch('/api/status', { headers: { 'x-wall-editor': '1' } }))
        .then((response) => (response.ok ? response.json() : null))
        .then((status) => !!(status && status.helper))
        .catch(() => false);
    }
    return helperCheck;
  }

  async function helperCall(path, method) {
    const response = await request(path, { method: method || 'GET', headers: { 'x-wall-editor': '1' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new AiError('other', body.error || `HTTP ${response.status}`, response.status);
    return body;
  }

  /**
   * Sends a request to the OpenAI API. `auth` is { key } or { session: true }; the helper adds
   * the signed-in session's token itself, so the page never holds it.
   */
  async function api(path, auth, init) {
    const viaHelper = await helper();
    if (auth.session && !viaHelper) throw new AiError('auth', t`用 ChatGPT 登入需要以 serve.py 啟動編輯器。`);
    const headers = { ...(init.headers || {}) };
    if (init.body) headers['content-type'] = 'application/json';
    if (auth.key) headers.authorization = `Bearer ${auth.key}`;
    if (viaHelper) {
      headers['x-wall-editor'] = '1';
      headers['x-wall-auth'] = auth.session ? 'session' : 'key';
    }
    const response = await request(viaHelper ? `/api/openai${path}` : `${DIRECT}${path}`, { ...init, headers });
    if (!response.ok) throw await failure(response);
    return response;
  }

  const LIMIT_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'subscription_sharing_usage_limit_exceeded']);

  async function failure(response) {
    let message = `HTTP ${response.status}`;
    let code = '';
    try {
      const body = await response.json();
      if (body.error && typeof body.error === 'object') {
        message = body.error.message || message;
        code = body.error.code || '';
      } else if (body.error || body.detail) {
        message = String(body.error || body.detail);
      }
    } catch (error) {
      // No JSON body: the status is all there is.
    }
    if (LIMIT_CODES.has(code)) return new AiError('rate', message, response.status);
    if (code === 'subscription_sharing_user_not_eligible') return new AiError('permission', message, response.status);
    return httpError(response.status, message);
  }

  // ---------------------------------------------------------------- conversation

  function toContent(part) {
    return part.type === 'image'
      ? { type: 'input_image', image_url: `data:${part.mediaType};base64,${part.data}`, detail: 'auto' }
      : { type: 'input_text', text: part.text };
  }

  function createSession({ model, system, tools }, auth) {
    /** The conversation as Responses API input items. The model's items go back unchanged. */
    const input = [];
    const toolParams = tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      strict: false, // the schemas have optional fields, which strict mode does not allow
    }));
    let controller = null;
    /** Dropped if a model does not accept the reasoning setting. */
    let reasoning = { effort: 'high' };

    return {
      addUser(parts) {
        input.push({ role: 'user', content: parts.map(toContent) });
      },

      addToolResults(results) {
        for (const result of results) {
          const output = result.parts.map(toContent);
          if (result.isError) output.unshift({ type: 'input_text', text: 'ERROR:' });
          input.push({ type: 'function_call_output', call_id: result.id, output });
        }
      },

      async run({ onText, onToolStart, onToolDetail }) {
        for (;;) {
          controller = new AbortController();
          const body = {
            model,
            stream: true,
            store: false, // nothing is kept on OpenAI's side, so each request carries the whole conversation
            instructions: system,
            input,
            tools: toolParams,
            tool_choice: 'auto',
            parallel_tool_calls: true,
            include: ['reasoning.encrypted_content'], // lets the model's reasoning carry over between turns
          };
          if (reasoning) body.reasoning = reasoning;
          let response;
          try {
            response = await api('/v1/responses', auth, { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
          } catch (error) {
            if (error instanceof AiError && error.kind === 'request' && reasoning) {
              reasoning = null;
              continue;
            }
            throw error;
          }

          const items = [];
          const partial = new Map(); // item id -> { callId, json }
          let final = null;
          let failed = null;
          try {
            await readSse(response, (event) => {
              if (!event || typeof event !== 'object') return;
              switch (event.type) {
                case 'response.output_text.delta':
                  onText(event.delta);
                  break;
                case 'response.output_item.added':
                  if (event.item && event.item.type === 'function_call') {
                    partial.set(event.item.id, { callId: event.item.call_id, json: '' });
                    onToolStart(event.item.call_id, event.item.name);
                  }
                  break;
                case 'response.function_call_arguments.delta': {
                  const call = partial.get(event.item_id);
                  if (!call) break;
                  call.json += event.delta;
                  // Lets the interface say which layer is being drawn as soon as its name is written.
                  const name = /"name"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(call.json);
                  if (name) {
                    try {
                      onToolDetail(call.callId, JSON.parse(`"${name[1]}"`));
                    } catch (error) {
                      // A half-written escape; the next delta completes it.
                    }
                  }
                  break;
                }
                case 'response.output_item.done':
                  items.push(event.item);
                  break;
                case 'response.completed':
                case 'response.incomplete':
                  final = event.response;
                  break;
                case 'response.failed':
                  failed = (event.response && event.response.error && event.response.error.message) || 'the response failed';
                  break;
                case 'error':
                  failed = event.message || (event.error && event.error.message) || 'stream error';
                  break;
                default:
              }
            });
          } catch (error) {
            if (error instanceof AiError) throw error;
            if (error && error.name === 'AbortError') throw new AiError('aborted', 'stopped');
            throw new AiError('network', String((error && error.message) || error));
          } finally {
            controller = null;
          }
          if (failed) throw new AiError('other', failed);
          // A turn counts only once the API says it is complete.
          if (!final) throw new AiError('network', t`回覆中斷了,請再試一次。`);

          const used = final.usage || {};
          const usage = { input: used.input_tokens || 0, output: used.output_tokens || 0 };
          if (final.status === 'incomplete') {
            const reason = final.incomplete_details && final.incomplete_details.reason;
            return { toolCalls: [], stop: reason === 'content_filter' ? 'refusal' : 'max_tokens', usage };
          }
          const output = items.length ? items : (final.output || []);
          const refused = output.some((item) => item.type === 'message' && (item.content || []).some((c) => c.type === 'refusal'));
          if (refused) return { toolCalls: [], stop: 'refusal', usage };

          const toolCalls = [];
          for (const item of output) {
            if (item.type !== 'function_call') continue;
            let parsed = null;
            try {
              parsed = JSON.parse(item.arguments || '{}');
            } catch (error) {
              // Left null: the assistant reports it to the model as an invalid input.
            }
            toolCalls.push({ id: item.call_id, name: item.name, input: parsed });
          }
          input.push(...output);
          return { toolCalls, stop: toolCalls.length ? 'tools' : 'end', usage };
        }
      },

      abort() {
        if (controller) controller.abort();
      },
    };
  }

  const MODELS = [
    ['gpt-6.1-sol', t`GPT-6.1 Sol(建議)`],
    ['gpt-6-astra', t`GPT-6 Astra(最強,最貴)`],
    ['gpt-6.1-terra', t`GPT-6.1 Terra(較快)`],
    ['gpt-6-luna', t`GPT-6 Luna(最便宜)`],
  ];

  window.WallAI.providers.openai = {
    id: 'openai',
    label: t`OpenAI(API 金鑰)`,
    models: MODELS,
    credential: KEY,
    createSession: (options) => createSession(options, { key: options.credential }),
  };

  const chatgpt = {
    id: 'chatgpt',
    label: t`ChatGPT(登入,使用訂閱方案)`,
    /** Replaced by the models this account may use, once signed in. */
    models: MODELS.slice(),
    credential: {
      kind: 'signin',
      help: t`用你的 ChatGPT 帳號登入,用量算在訂閱方案上,不需要 API 金鑰。需要以 serve.py 啟動編輯器。`,
    },
    createSession: (options) => createSession(options, { session: true }),
    auth: {
      async status() {
        if (!(await helper())) {
          return { available: false, reason: t`用 ChatGPT 登入需要本機輔助程式:請關閉這個分頁,在編輯器資料夾執行 python serve.py,再開啟它顯示的網址。` };
        }
        const status = (await helperCall('/api/status')).openai;
        if (status.signedIn) {
          try {
            const listed = await (await api('/v1/models', { session: true }, { method: 'GET' })).json();
            const usable = (listed.models || listed.data || [])
              .filter((m) => !m.visibility || m.visibility === 'list')
              .map((m) => [m.slug || m.id, m.display_name || m.slug || m.id])
              .filter(([id]) => id);
            if (usable.length) chatgpt.models = usable;
          } catch (error) {
            // The built-in list stays; an unusable model is reported when it is tried.
          }
        }
        return { available: true, signedIn: status.signedIn, account: status.account };
      },
      /** Opens OpenAI's sign-in page in a new tab and waits until the helper has the tokens. */
      async signIn() {
        // The desktop program and the phone app open the sign-in in the system browser themselves.
        const tab = window.WALL_DESKTOP || window.WALL_APP ? null : window.open('about:blank', '_blank');
        let started;
        try {
          started = await helperCall('/api/openai/signin', 'POST');
        } catch (error) {
          if (tab) tab.close();
          throw error;
        }
        if (started.opened) {
          // Already open in the system browser.
        } else if (tab) tab.location = started.url;
        else window.location.assign(started.url); // pop-ups are blocked: sign in in this tab instead
        const deadline = Date.now() + 5 * 60 * 1000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          const status = (await helperCall('/api/status')).openai;
          if (status.signedIn) return;
          if (status.error) throw new AiError('auth', status.error);
        }
        throw new AiError('auth', t`等候登入逾時。`);
      },
      async signOut() {
        await helperCall('/api/openai/signout', 'POST');
      },
    },
  };
  window.WallAI.providers.chatgpt = chatgpt;

  // ---------------------------------------------------------------- image generation

  const SIZE = { portrait: '1024x1536', square: '1024x1024', landscape: '1536x1024' };

  function sizeOf(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new AiError('other', t`生成的圖片無法讀取。`));
      img.src = dataUrl;
    });
  }

  async function generate({ credential, model, prompt, shape, transparent, references }) {
    const body = {
      model,
      prompt,
      n: 1,
      size: SIZE[shape] || SIZE.portrait,
      quality: 'medium',
      background: transparent ? 'transparent' : 'opaque',
      output_format: 'png',
    };
    // With pictures to stay consistent with, the same request goes to the edits endpoint.
    let path = '/v1/images/generations';
    if (references.length) {
      path = '/v1/images/edits';
      body.images = references.map((r) => ({ image_url: `data:${r.mediaType};base64,${r.data}` }));
    }
    const response = await api(path, { key: credential }, { method: 'POST', body: JSON.stringify(body) });
    const data = await response.json();
    const b64 = data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) throw new AiError('other', 'The image model returned no picture. Rephrase the prompt.');
    const dataUrl = `data:image/png;base64,${b64}`;
    return { dataUrl, transparent: !!transparent, ...(await sizeOf(dataUrl)) };
  }

  window.WallAI.imageGenerators.openai = {
    id: 'openai',
    label: 'GPT Image(OpenAI)',
    models: [
      ['gpt-image-2.5-flare', t`GPT Image 2.5 Flare(建議)`],
      ['gpt-image-2.5-sunburst', 'GPT Image 2.5 Sunburst'],
      ['gpt-image-2.6-flare', t`GPT Image 2.6 Flare(最新)`],
      ['gpt-image-2.6-sunburst', t`GPT Image 2.6 Sunburst(最新)`],
    ],
    credential: KEY,
    help: t`原生支援透明背景,去背素材最乾淨。需要 OpenAI API 金鑰(用 ChatGPT 登入不能生成圖片),且帳號要通過組織驗證。`,
    generate,
  };
})();
