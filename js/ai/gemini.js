// Google Gemini, through the generateContent REST API (v1beta), called directly from the page.
// Also registers Gemini's image models as an image generator.
(function () {
  'use strict';

  const t = window.WallI18n.t;

  const { AiError, httpError, readSse, request } = window.WallAI;

  const BASE = 'https://generativelanguage.googleapis.com';
  const CREDENTIAL = {
    kind: 'key',
    name: 'google',
    label: t`Google Gemini API 金鑰`,
    placeholder: 'AIza...',
    help: t`在 aistudio.google.com 建立。只會傳送到 generativelanguage.googleapis.com。`,
  };

  /** Turns an error response into an AiError. An invalid key comes back as 400, not 401. */
  async function failure(response) {
    let message = `HTTP ${response.status}`;
    let invalidKey = false;
    try {
      const body = await response.json();
      if (body.error) {
        message = body.error.message || message;
        invalidKey = (body.error.details || []).some((d) => d.reason === 'API_KEY_INVALID');
      }
    } catch (error) {
      // No JSON body: the status is all there is.
    }
    if (invalidKey) return new AiError('auth', message, response.status);
    if (response.status === 402) return new AiError('rate', message, 402);
    return httpError(response.status, message);
  }

  function toPart(part) {
    return part.type === 'image'
      ? { inlineData: { mimeType: part.mediaType, data: part.data } }
      : { text: part.text };
  }

  /** A function declaration; a tool without arguments must not carry an empty schema. */
  function toDeclaration(tool) {
    const declaration = { name: tool.name, description: tool.description };
    if (Object.keys(tool.parameters.properties || {}).length) declaration.parameters = tool.parameters;
    return declaration;
  }

  const REFUSALS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'LANGUAGE']);
  const MALFORMED = new Set(['MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'MALFORMED_RESPONSE', 'MISSING_THOUGHT_SIGNATURE']);

  function createSession({ credential, model, system, tools }) {
    /** The conversation as `contents`. Model turns are kept part for part, signatures included. */
    const contents = [];
    let controller = null;
    /**
     * How pictures in tool results are sent. Nested inside the functionResponse is the documented
     * form; if a model rejects it they go beside it instead, as ordinary picture parts.
     */
    let nestedPictures = true;
    /** The last tool results in neutral form, kept so they can be re-encoded the other way. */
    let lastResults = null;

    function encodeResults(results) {
      const parts = [];
      const loose = [];
      results.forEach((result, r) => {
        const texts = result.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        const pictures = result.parts.filter((p) => p.type === 'image');
        const response = result.isError ? { error: texts } : { result: texts };
        const functionResponse = { name: result.name, id: result.id, response };
        if (pictures.length && nestedPictures) {
          functionResponse.parts = pictures.map((p, i) => {
            const displayName = `result${r}_${i}.${p.mediaType === 'image/png' ? 'png' : 'jpg'}`;
            response[`image${i ? i + 1 : ''}`] = { $ref: displayName };
            return { inlineData: { displayName, mimeType: p.mediaType, data: p.data } };
          });
        } else if (pictures.length) {
          response.note = 'The picture follows this result.';
          pictures.forEach((p) => loose.push(toPart(p)));
        }
        parts.push({ functionResponse });
      });
      return { role: 'user', parts: parts.concat(loose) };
    }

    async function call() {
      controller = new AbortController();
      const response = await request(`${BASE}/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': credential },
        signal: controller.signal,
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents,
          tools: [{ functionDeclarations: tools.map(toDeclaration) }],
          generationConfig: { maxOutputTokens: 32768, thinkingConfig: { thinkingLevel: 'high' } },
        }),
      });
      if (!response.ok) throw await failure(response);
      return response;
    }

    return {
      addUser(parts) {
        contents.push({ role: 'user', parts: parts.map(toPart) });
      },

      // All results of a turn go back together, in one user turn.
      addToolResults(results) {
        lastResults = results;
        contents.push(encodeResults(results));
      },

      async run({ onText, onToolStart, onToolDetail }) {
        let malformedRetries = 0;
        for (;;) {
          let response;
          try {
            response = await call();
          } catch (error) {
            const last = contents[contents.length - 1];
            const sentPictures = lastResults && last && last.parts.some((p) => p.functionResponse && p.functionResponse.parts);
            if (error instanceof AiError && error.kind === 'request' && nestedPictures && sentPictures) {
              // This model does not take pictures inside a function response: send them beside it.
              nestedPictures = false;
              contents[contents.length - 1] = encodeResults(lastResults);
              continue;
            }
            throw error;
          }

          const parts = [];
          const toolCalls = [];
          let finish = '';
          let blocked = '';
          let usage = { input: 0, output: 0 };
          try {
            await readSse(response, (chunk) => {
              if (!chunk || typeof chunk !== 'object') return;
              if (chunk.error) throw new AiError('other', chunk.error.message || 'stream error');
              if (chunk.promptFeedback && chunk.promptFeedback.blockReason) blocked = chunk.promptFeedback.blockReason;
              if (chunk.usageMetadata) {
                usage = {
                  input: chunk.usageMetadata.promptTokenCount || 0,
                  output: (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0),
                };
              }
              const candidate = chunk.candidates && chunk.candidates[0];
              if (!candidate) return;
              if (candidate.finishReason) finish = candidate.finishReason;
              for (const part of (candidate.content && candidate.content.parts) || []) {
                // Kept exactly as received: a signature must go back on the part it came with.
                parts.push(part);
                if (part.functionCall) {
                  const id = part.functionCall.id || `call_${contents.length}_${toolCalls.length}`;
                  part.functionCall.id = id;
                  const input = part.functionCall.args || {};
                  toolCalls.push({ id, name: part.functionCall.name, input });
                  onToolStart(id, part.functionCall.name);
                  if (typeof input.name === 'string') onToolDetail(id, input.name);
                } else if (part.text && !part.thought) {
                  onText(part.text);
                }
              }
            });
          } catch (error) {
            if (error instanceof AiError) throw error;
            if (error && error.name === 'AbortError') throw new AiError('aborted', 'stopped');
            throw new AiError('network', String((error && error.message) || error));
          } finally {
            controller = null;
          }

          if (blocked || REFUSALS.has(finish)) return { toolCalls: [], stop: 'refusal', usage };
          if (MALFORMED.has(finish) || (!parts.length && finish !== 'MAX_TOKENS')) {
            // The model produced a call the API could not parse, or nothing at all: ask again.
            if (malformedRetries++ >= 2) throw new AiError('other', t`Gemini 回覆無法使用(${finish || t`空白回覆`})。`);
            continue;
          }
          if (finish === 'MAX_TOKENS') return { toolCalls: [], stop: 'max_tokens', usage };
          contents.push({ role: 'model', parts });
          return { toolCalls, stop: toolCalls.length ? 'tools' : 'end', usage };
        }
      },

      abort() {
        if (controller) controller.abort();
      },
    };
  }

  window.WallAI.providers.gemini = {
    id: 'gemini',
    label: 'Gemini(Google)',
    models: [
      ['gemini-4-hydrogen', t`Gemini 4 Hydrogen(建議,有免費額度)`],
      ['gemini-4-carbon', t`Gemini 4 Carbon(最強,需付費)`],
      ['gemini-4-argon', t`Gemini 4 Argon(高階,需付費)`],
      ['gemini-3.8-flash', t`Gemini 3.8 Flash(較快)`],
      ['gemini-3.5-flash-lite', t`Gemini 3.5 Flash-Lite(最便宜)`],
    ],
    credential: CREDENTIAL,
    createSession,
  };

  // ---------------------------------------------------------------- image generation

  const ASPECT = { portrait: '9:16', square: '1:1', landscape: '16:9' };
  /** Models that take an output size; the Lite model makes 1K only. */
  const SIZED = new Set(['gemini-3.1-flash-image', 'gemini-nano-banana-2.1', 'gemini-3-pro-image']);

  function sizeOf(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
      img.onerror = () => reject(new AiError('other', t`生成的圖片無法讀取。`));
      img.src = dataUrl;
    });
  }

  /**
   * These models cannot make transparent pictures, so a cut-out is asked for on a flat backdrop
   * that the editor then removes. Green unless the subject itself is likely to be green.
   */
  function backdropFor(prompt) {
    return /green|grass|leaf|leaves|tree|plant|forest|jungle|fern|moss|bamboo|綠|草|樹|葉|森林|植物|竹/i.test(prompt)
      ? 'magenta (#FF00FF)'
      : 'green (#00FF00)';
  }

  async function generate({ credential, model, prompt, shape, transparent, references }) {
    let text = prompt;
    if (transparent) {
      text += `\n\nShow only this subject, complete and uncropped, on a perfectly flat, uniform pure ${backdropFor(prompt)} background that fills the rest of the frame. No shadow on the background, no gradient, no floor, no border, and none of that colour on the subject.`;
    }
    const imageConfig = { aspectRatio: ASPECT[shape] || ASPECT.portrait };
    if (SIZED.has(model)) imageConfig.imageSize = '2K';
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text }].concat(references.map(toPart)) }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig },
    });
    const post = (version) => request(`${BASE}/${version}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': credential },
      body,
    });
    let response = await post('v1beta');
    // Some image models are published on the v1 endpoint only.
    if (response.status === 404) response = await post('v1');
    if (!response.ok) throw await failure(response);
    const data = await response.json();
    const candidate = data.candidates && data.candidates[0];
    const found = candidate && candidate.content && (candidate.content.parts || []).find((p) => p.inlineData && !p.thought);
    if (!found) {
      const why = (data.promptFeedback && data.promptFeedback.blockReason) || (candidate && candidate.finishReason) || 'no image returned';
      throw new AiError('other', `The image model returned no picture (${why}). Rephrase the prompt.`);
    }
    const dataUrl = `data:${found.inlineData.mimeType || 'image/png'};base64,${found.inlineData.data}`;
    return { dataUrl, transparent: false, ...(await sizeOf(dataUrl)) };
  }

  window.WallAI.imageGenerators.gemini = {
    id: 'gemini',
    label: t`Gemini 圖片模型(Google)`,
    models: [
      ['gemini-3.1-flash-image', t`Gemini 3.1 Flash Image(建議,約 US$0.10/張)`],
      ['gemini-nano-banana-2.1', t`Nano Banana 2.1(最新,約 US$0.05/張)`],
      ['gemini-3-pro-image', t`Gemini 3 Pro Image(最精細,約 US$0.13/張)`],
      ['gemini-3.1-flash-lite-image', t`Gemini 3.1 Flash-Lite Image(最便宜,約 US$0.03/張)`],
    ],
    credential: CREDENTIAL,
    help: t`不支援透明背景:去背圖會先生成在純色背景上,再由編輯器自動去背,邊緣可能略有殘色。圖片模型沒有免費額度。`,
    generate,
  };
})();
