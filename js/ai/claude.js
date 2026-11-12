// Claude (Anthropic API), through the official JavaScript SDK bundled in js/vendor.
(function () {
  'use strict';

  const t = window.WallI18n.t;

  const { AiError } = window.WallAI;

  /** Models whose declined requests the API can hand to another model inside the same call. */
  const HAS_SERVER_FALLBACK = new Set(['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5']);

  let sdkLoading = null;
  /** The SDK is a 370 KB script; it is loaded the first time Claude is used. */
  function loadSdk() {
    if (window.AnthropicSDK) return Promise.resolve(window.AnthropicSDK.default);
    if (!sdkLoading) {
      sdkLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'js/vendor/anthropic-sdk.js';
        script.onload = () => resolve(window.AnthropicSDK.default);
        script.onerror = () => {
          sdkLoading = null;
          reject(new AiError('other', t`無法載入 js/vendor/anthropic-sdk.js`));
        };
        document.head.appendChild(script);
      });
    }
    return sdkLoading;
  }

  function toBlock(part) {
    return part.type === 'image'
      ? { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }
      : { type: 'text', text: part.text };
  }

  function createSession({ credential, model, system, tools, clientFactory }) {
    /** The conversation in API form. Assistant turns are kept exactly as received. */
    const messages = [];
    const toolParams = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
      eager_input_streaming: true, // large SVG arguments stream as they are written
    }));
    let activeStream = null;
    /** Set when the API rejects the optional request extras, so they are not sent again. */
    let plain = false;

    function params() {
      const p = {
        model,
        max_tokens: 64000,
        system,
        tools: toolParams,
        messages,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
      };
      if (plain) return p;
      // The instructions and tools never change, so they are cached; each turn then pays full
      // price only for what was added since the last one.
      p.cache_control = { type: 'ephemeral' };
      if (HAS_SERVER_FALLBACK.has(model)) {
        // If a safety classifier declines the request, the API retries it on another model.
        p.betas = ['server-side-fallback-2026-07-01'];
        p.fallbacks = 'default';
      }
      return p;
    }

    function translate(Anthropic, error) {
      if (error instanceof AiError) return error;
      if (error instanceof Anthropic.APIUserAbortError) return new AiError('aborted', 'stopped');
      if (error instanceof Anthropic.AuthenticationError) return new AiError('auth', error.message, 401);
      if (error instanceof Anthropic.PermissionDeniedError) return new AiError('permission', error.message, 403);
      if (error instanceof Anthropic.RateLimitError) return new AiError('rate', error.message, 429);
      if (error instanceof Anthropic.BadRequestError) return new AiError('request', error.message, 400);
      if (error instanceof Anthropic.APIConnectionError) return new AiError('network', error.message);
      if (error instanceof Anthropic.APIError) return new AiError('other', error.message, error.status);
      return null;
    }

    return {
      addUser(parts) {
        messages.push({ role: 'user', content: parts.map(toBlock) });
      },

      // Every result of a turn goes back in one message.
      addToolResults(results) {
        messages.push({
          role: 'user',
          content: results.map((result) => {
            const block = { type: 'tool_result', tool_use_id: result.id, content: result.parts.map(toBlock) };
            if (result.isError) block.is_error = true;
            return block;
          }),
        });
      },

      async run({ onText, onToolStart, onToolDetail }) {
        const Anthropic = await loadSdk();
        const client = clientFactory ? clientFactory() : new Anthropic({ apiKey: credential, dangerouslyAllowBrowser: true });
        let jsonRetries = 0;
        for (;;) {
          const p = params();
          const stream = p.betas ? client.beta.messages.stream(p) : client.messages.stream(p);
          activeStream = stream;
          let current = null;
          stream.on('text', (delta) => onText(delta));
          stream.on('streamEvent', (event) => {
            if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
              current = event.content_block.id;
              onToolStart(current, event.content_block.name);
            }
          });
          stream.on('inputJson', (delta, snapshot) => {
            // Lets the interface say which layer is being drawn as soon as its name is written.
            if (current && snapshot && typeof snapshot === 'object' && typeof snapshot.name === 'string') onToolDetail(current, snapshot.name);
          });

          let message;
          try {
            message = await stream.finalMessage();
          } catch (error) {
            const known = translate(Anthropic, error);
            if (known && known.kind === 'request' && !plain) {
              // The optional extras (caching, refusal fallback) are the likeliest thing an
              // account or model does not accept; try once more without them.
              plain = true;
              continue;
            }
            if (known) throw known;
            // Not an API error: a tool input that could not be parsed as JSON at all. Ask again.
            if (jsonRetries++ >= 2) throw new AiError('other', String(error.message || error));
            continue;
          } finally {
            activeStream = null;
          }

          const usage = {
            input: (message.usage.input_tokens || 0) + (message.usage.cache_read_input_tokens || 0) + (message.usage.cache_creation_input_tokens || 0),
            output: message.usage.output_tokens || 0,
          };
          const toolCalls = message.content
            .filter((block) => block.type === 'tool_use')
            .map((block) => ({ id: block.id, name: block.name, input: block.input }));
          if (message.stop_reason === 'refusal') return { toolCalls: [], stop: 'refusal', usage };
          // A tool input cut off at the limit can still look complete; it is never run or kept.
          if (message.stop_reason === 'max_tokens') return { toolCalls: [], stop: 'max_tokens', usage };
          messages.push({ role: 'assistant', content: message.content });
          if (message.stop_reason === 'pause_turn') continue;
          return { toolCalls, stop: toolCalls.length ? 'tools' : 'end', usage };
        }
      },

      abort() {
        if (activeStream) activeStream.abort();
      },
    };
  }

  window.WallAI.providers.claude = {
    id: 'claude',
    label: 'Claude(Anthropic)',
    models: [
      ['claude-opus-5-5', t`Claude Opus 5.5(建議)`],
      ['claude-fable-5-2', t`Claude Fable 5.2(最強,最貴)`],
      ['claude-sonnet-5-5', t`Claude Sonnet 5.5(較快、較便宜)`],
      ['claude-haiku-5-5', t`Claude Haiku 5.5(最便宜)`],
    ],
    credential: {
      kind: 'key',
      name: 'anthropic',
      label: t`Anthropic API 金鑰`,
      placeholder: 'sk-ant-...',
      help: t`在 console.anthropic.com 建立。只會傳送到 api.anthropic.com。`,
    },
    createSession,
  };
})();
