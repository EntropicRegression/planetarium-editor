// AI assistant: turns a description (and optional reference pictures) into layers.
//
// The person's message goes to a model (Claude, Gemini or OpenAI; see js/ai/) together with a
// set of tools that act on the editor (`agent` in app.js). The model decides which layers to
// make, draws them through those tools, looks at the rendered result, and revises: an agent
// loop that runs in this page. Keys stay in the browser and go only to the provider chosen.
(function () {
  'use strict';

  const t = window.WallI18n.t;

  const $ = (id) => document.getElementById(id);
  const editor = window.spatialEditor.agent;
  const AI = window.WallAI;

  const SETTINGS_STORE = 'spatialEditor.ai.settings';
  /** One instruction from the person may take this many model turns. */
  const MAX_TURNS = 40;
  /** Longest side of a picture as sent to a model. */
  const PICTURE_SIDE = 1568;

  const TOOL_LABELS = {
    get_scene: t`查看目前場景`,
    set_scene: t`調整場景設定`,
    add_svg_layer: t`繪製圖層`,
    add_pixel_layer: t`繪製像素圖層`,
    add_image_layer: t`放上圖片`,
    update_layer_art: t`重畫圖層`,
    read_layer_art: t`讀取圖層原稿`,
    update_layer: t`調整圖層`,
    delete_layer: t`刪除圖層`,
    view_canvas: t`檢視畫面`,
    view_image: t`檢視圖片`,
    remove_background: t`去除背景`,
    generate_image: t`生成圖片`,
  };

  // ---------------------------------------------------------------- settings

  const settings = {
    provider: 'claude',
    /** provider id -> chosen model id */
    models: {},
    /** credential name -> key (see `credentialOf`) */
    keys: {},
    remember: false,
    imageGenerator: 'none',
    imageModel: {},
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_STORE) || 'null');
      if (saved && typeof saved === 'object') Object.assign(settings, saved);
    } catch (error) {
      // Storage can be unavailable (private windows): settings then last for this page only.
    }
    if (!AI.providers[settings.provider]) settings.provider = 'claude';
    if (settings.imageGenerator !== 'none' && !AI.imageGenerators[settings.imageGenerator]) settings.imageGenerator = 'none';
  }

  function saveSettings() {
    try {
      // Keys are written only if the person asked for them to be remembered.
      const stored = { ...settings, keys: settings.remember ? settings.keys : {} };
      localStorage.setItem(SETTINGS_STORE, JSON.stringify(stored));
    } catch (error) {
      // See loadSettings.
    }
  }

  function provider() {
    return AI.providers[settings.provider];
  }

  function modelOf(p) {
    const chosen = settings.models[p.id];
    return p.models.some(([id]) => id === chosen) ? chosen : p.models[0][0];
  }

  function generator() {
    return settings.imageGenerator === 'none' ? null : AI.imageGenerators[settings.imageGenerator];
  }

  function imageModelOf(g) {
    const chosen = settings.imageModel[g.id];
    return g.models.some(([id]) => id === chosen) ? chosen : g.models[0][0];
  }

  /** The key a provider or generator uses; several share one (e.g. Gemini chat and Gemini images). */
  function keyFor(thing) {
    return (settings.keys[thing.credential.name] || '').trim();
  }

  /** Whether the image generator can be used right now. */
  function imageGenerationReady() {
    const g = generator();
    return !!g && (g.credential.kind !== 'key' || !!keyFor(g));
  }

  // ---------------------------------------------------------------- tools

  const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }];
  const picture = (dataUrl) => {
    const [head, data] = dataUrl.split(',');
    return { type: 'image', mediaType: /data:([^;]+)/.exec(head)[1], data };
  };

  /** Runs one tool call and returns the parts of its result; throws to report an error to the model. */
  async function runTool(name, input) {
    switch (name) {
      case 'get_scene': return text(editor.scene());
      case 'set_scene': return text(editor.setScene(input));
      case 'add_svg_layer': return text(await editor.addSvgLayer(input));
      case 'add_pixel_layer': return text(await editor.addPixelLayer(input));
      case 'add_image_layer': return text(await editor.addImageLayer(input));
      case 'update_layer_art': return text(await editor.replaceArt(input.layer_id, input.svg));
      case 'read_layer_art': return text(editor.readArt(input.layer_id));
      case 'update_layer': return text(editor.updateLayer(input.layer_id, input));
      case 'delete_layer': return text(editor.deleteLayer(input.layer_id));
      case 'view_canvas': {
        const shot = editor.render({ tiltX: input.tilt_x, tiltY: input.tilt_y, onlyLayerId: input.only_layer_id });
        const note = input.only_layer_id != null
          ? `Layer ${input.only_layer_id} alone; the checkerboard is transparent.`
          : `The wallpaper at tilt (${input.tilt_x || 0}, ${input.tilt_y || 0}), ${shot.width}×${shot.height} preview.`;
        return [picture(shot.dataUrl), { type: 'text', text: note }];
      }
      case 'view_image': {
        const shot = await editor.previewReference(input.image, 1024);
        return [picture(shot.dataUrl), { type: 'text', text: `ref:${shot.index}, ${shot.width}×${shot.height} px. A checkerboard means transparent.` }];
      }
      case 'remove_background': {
        const result = await editor.removeBackground(input.image, input.color, input.tolerance);
        const shot = await editor.previewReference(result.image, 768);
        return [picture(shot.dataUrl), { type: 'text', text: JSON.stringify(result) }];
      }
      case 'generate_image': return generateImage(input);
      default: throw new Error(`Unknown tool "${name}".`);
    }
  }

  async function generateImage(input) {
    const g = generator();
    if (!g || !imageGenerationReady()) throw new Error('Image generation is not set up. Draw with SVG instead, or tell the person to choose an image generator in the settings.');
    const references = [];
    for (const ref of (input.reference_images || []).slice(0, 3)) {
      references.push(picture((await editor.previewReference(ref, 1024)).dataUrl));
    }
    const made = await g.generate({
      credential: keyFor(g),
      model: imageModelOf(g),
      prompt: input.prompt,
      shape: input.shape || 'portrait',
      transparent: !!input.transparent_background,
      references,
    });
    imagesGenerated++;
    renderUsage();
    let index = editor.addReference(made.dataUrl, made.width, made.height, 'generated');
    let note = { image: `ref:${index}`, width: made.width, height: made.height };
    if (input.transparent_background && !made.transparent) {
      // This generator cannot produce transparency: it was asked for a flat background, which is cut out here.
      const cut = await editor.removeBackground(`ref:${index}`);
      note = { image: cut.image, width: made.width, height: made.height, background_removed: cut.removed_color, share_made_transparent: cut.share_made_transparent };
      index = Number(cut.image.slice(4));
    }
    const shot = await editor.previewReference(`ref:${index}`, 768);
    return [picture(shot.dataUrl), { type: 'text', text: JSON.stringify(note) }];
  }

  // ---------------------------------------------------------------- conversation

  /** The provider's conversation; null until the first message, and after "新對話". */
  let session = null;
  /** What the session was made with, to notice when the settings changed under it. */
  let sessionKey = '';
  /** Pictures attached to the message being written: { dataUrl, w, h }. */
  let attachments = [];
  let running = false;
  let stopRequested = false;
  const usage = { input: 0, output: 0 };
  let imagesGenerated = 0;
  /** Set by tests to script a model without the network: (options) -> session. */
  let sessionFactory = null;

  function currentTools() {
    return AI.tools({ imageGeneration: imageGenerationReady() });
  }

  function ensureSession() {
    const p = provider();
    const key = [p.id, modelOf(p), imageGenerationReady() ? settings.imageGenerator : 'none'].join('|');
    if (session && sessionKey === key) return session;
    if (session) addNotice(t`設定已變更,開始新的對話(圖層不受影響)。`);
    const options = {
      credential: p.credential.kind === 'key' ? keyFor(p) : null,
      model: modelOf(p),
      system: AI.systemPrompt({ imageGeneration: imageGenerationReady() }),
      tools: currentTools(),
    };
    session = sessionFactory ? sessionFactory(options) : p.createSession(options);
    sessionKey = key;
    return session;
  }

  const ERROR_TEXT = {
    auth: t`金鑰或登入無效,請到「設定」確認。`,
    permission: t`這個帳號沒有權限使用所選的模型。`,
    rate: t`已達到速率或用量限制,請稍等一下再試。`,
    network: t`連不上服務,請檢查網路連線。`,
  };

  function describeError(error) {
    if (!(error instanceof AI.AiError)) return t`發生錯誤:${error.message || error}`;
    const lead = ERROR_TEXT[error.kind] || t`服務回報錯誤。`;
    return error.message && error.kind !== 'aborted' ? `${lead}\n${error.message}` : lead;
  }

  async function send(message) {
    const p = provider();
    if (!sessionFactory) {
      if (p.credential.kind === 'key' && !keyFor(p)) {
        openSettings();
        toastSettings(t`請先填入${p.credential.label}。`);
        return;
      }
    }

    const parts = [];
    for (const item of attachments) {
      const index = editor.addReference(item.dataUrl, item.w, item.h, 'attached');
      parts.push({ type: 'text', text: `Picture ref:${index} from the person (${item.w}×${item.h} px):` });
      parts.push(picture(item.dataUrl));
    }
    parts.push({ type: 'text', text: message });
    addBubble('user', message, attachments.map((a) => a.dataUrl));
    attachments = [];
    renderAttachments();

    setRunning(true);
    try {
      const active = ensureSession();
      active.addUser(parts);
      await runLoop(active);
    } catch (error) {
      if (error instanceof AI.AiError && error.kind === 'aborted') addNotice(t`已停止。`);
      else addNotice(describeError(error), true);
      if (error instanceof AI.AiError && error.kind === 'auth') openSettings();
    } finally {
      setRunning(false);
    }
  }

  async function runLoop(active) {
    const tools = currentTools();
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (stopRequested) throw new AI.AiError('aborted', 'stopped');
      const bubble = addBubble('assistant', '');
      const steps = new Map();
      let reply;
      try {
        reply = await active.run({
          onText: (delta) => bubble.append(delta),
          onToolStart: (id, name) => steps.set(id, addStep(TOOL_LABELS[name] || name)),
          onToolDetail: (id, detail) => steps.has(id) && steps.get(id).detail(detail),
        });
      } catch (error) {
        bubble.finish();
        steps.forEach((step) => step.done(false));
        throw error;
      }
      bubble.finish();
      usage.input += reply.usage.input;
      usage.output += reply.usage.output;
      renderUsage();

      if (reply.stop === 'refusal') {
        steps.forEach((step) => step.done(false));
        addNotice(t`模型拒絕了這個要求,請換個方式描述。`, true);
        return;
      }
      if (reply.stop === 'max_tokens') {
        steps.forEach((step) => step.done(false));
        addNotice(t`回覆太長被截斷了。請把要求拆小一點,例如一次只做幾個圖層。`, true);
        return;
      }
      if (!reply.toolCalls.length) return;

      const results = [];
      for (const call of reply.toolCalls) {
        const step = steps.get(call.id) || addStep(TOOL_LABELS[call.name] || call.name);
        const tool = tools.find((t) => t.name === call.name);
        const problem = tool ? AI.invalid(tool, call.input) : `there is no tool named "${call.name}"`;
        if (problem) {
          step.done(false);
          results.push({
            id: call.id,
            name: call.name,
            isError: true,
            parts: text({ INVALID_INPUT: problem, received: JSON.stringify(call.input).slice(0, 2000) }),
          });
          continue;
        }
        if (typeof call.input.name === 'string') step.detail(call.input.name);
        try {
          results.push({ id: call.id, name: call.name, isError: false, parts: await runTool(call.name, call.input) });
          step.done(true);
        } catch (error) {
          step.done(false);
          results.push({ id: call.id, name: call.name, isError: true, parts: text(String(error.message || error)) });
        }
      }
      active.addToolResults(results);
    }
    addNotice(t`已連續執行 ${MAX_TURNS} 個步驟,先停在這裡。要繼續的話再送一則訊息。`);
  }

  // ---------------------------------------------------------------- chat interface

  const log = $('assistantLog');

  function scrollDown() {
    log.scrollTop = log.scrollHeight;
  }

  /** Enough Markdown for a chat reply: paragraphs, lists, bold, inline code. Everything is escaped first. */
  function renderMarkdown(target, source) {
    target.textContent = '';
    const inline = (parent, line) => {
      // **bold** and `code`; anything else is plain text.
      const pattern = /\*\*([^*]+)\*\*|`([^`]+)`/g;
      let last = 0;
      let match;
      while ((match = pattern.exec(line))) {
        if (match.index > last) parent.append(line.slice(last, match.index));
        const el = document.createElement(match[1] !== undefined ? 'strong' : 'code');
        el.textContent = match[1] !== undefined ? match[1] : match[2];
        parent.appendChild(el);
        last = match.index + match[0].length;
      }
      if (last < line.length) parent.append(line.slice(last));
    };
    let list = null;
    for (const raw of source.split('\n')) {
      const line = raw.trimEnd();
      const item = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
      const heading = /^#{1,4}\s+(.*)$/.exec(line);
      if (item) {
        if (!list) {
          list = document.createElement('ul');
          target.appendChild(list);
        }
        inline(list.appendChild(document.createElement('li')), item[1]);
        continue;
      }
      list = null;
      if (!line.trim()) continue;
      const block = document.createElement(heading ? 'h4' : 'p');
      inline(block, heading ? heading[1] : line);
      target.appendChild(block);
    }
  }

  function addBubble(role, message, pictures) {
    const el = document.createElement('div');
    el.className = `chat-msg ${role}`;
    for (const src of pictures || []) {
      const img = document.createElement('img');
      img.className = 'chat-ref';
      img.alt = t`參考圖`;
      img.src = src;
      el.appendChild(img);
    }
    const body = document.createElement('div');
    body.className = 'chat-text';
    let source = message;
    if (role === 'assistant') renderMarkdown(body, source);
    else body.textContent = source;
    el.appendChild(body);
    log.appendChild(el);
    $('assistantIntro').hidden = true;
    scrollDown();
    return {
      append(delta) {
        source += delta;
        renderMarkdown(body, source);
        scrollDown();
      },
      /** A turn that only called tools leaves no text; its empty bubble is removed. */
      finish() {
        if (!source.trim() && !el.querySelector('img')) el.remove();
      },
    };
  }

  function addStep(label) {
    const el = document.createElement('div');
    el.className = 'chat-step pending';
    const mark = document.createElement('span');
    mark.className = 'chat-step-mark';
    const caption = document.createElement('span');
    caption.textContent = label;
    el.append(mark, caption);
    log.appendChild(el);
    scrollDown();
    return {
      detail(name) {
        caption.textContent = `${label}:${name}`;
      },
      done(ok) {
        el.className = `chat-step ${ok ? 'ok' : 'failed'}`;
      },
    };
  }

  function addNotice(message, isError) {
    const el = document.createElement('div');
    el.className = `chat-notice${isError ? ' error' : ''}`;
    el.textContent = message;
    log.appendChild(el);
    scrollDown();
  }

  function renderUsage() {
    const bits = [];
    if (usage.input || usage.output) bits.push(t`輸入 ${usage.input.toLocaleString()}、輸出 ${usage.output.toLocaleString()} tokens`);
    if (imagesGenerated) bits.push(t`生成 ${imagesGenerated} 張圖`);
    $('assistantUsage').textContent = bits.length ? t`本次對話:${bits.join(',')}` : '';
  }

  function renderHeader() {
    const p = provider();
    const model = p.models.find(([id]) => id === modelOf(p));
    const g = generator();
    $('assistantModelChip').textContent = model ? model[1].split('(')[0] : p.label;
    $('assistantModelChip').title = t`對話模型:${p.label} / ${model ? model[1] : ''}\n素材生成:${g ? g.label : t`不使用`}\n按一下開啟設定`;
  }

  function setRunning(on) {
    running = on;
    stopRequested = false;
    $('assistantSend').hidden = on;
    $('assistantStop').hidden = !on;
    $('assistantInput').disabled = on;
    $('assistantAttach').disabled = on;
    $('assistantReset').disabled = on;
    $('assistantModelChip').disabled = on;
    if (!on) $('assistantInput').focus();
  }

  function renderAttachments() {
    const row = $('assistantAttachments');
    row.textContent = '';
    attachments.forEach((item, i) => {
      const chip = document.createElement('button');
      chip.className = 'chat-attachment';
      chip.title = t`按一下移除這張參考圖`;
      const img = document.createElement('img');
      img.alt = t`參考圖`;
      img.src = item.dataUrl;
      chip.appendChild(img);
      chip.addEventListener('click', () => {
        attachments.splice(i, 1);
        renderAttachments();
      });
      row.appendChild(chip);
    });
    row.hidden = attachments.length === 0;
  }

  /** Reads a picture file and shrinks it to what is worth sending. */
  function readPicture(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, PICTURE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        // PNG keeps transparency (cut-outs, logos); everything else is smaller as JPEG.
        const mediaType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
        resolve({ dataUrl: canvas.toDataURL(mediaType, 0.9), w: canvas.width, h: canvas.height });
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error(t`無法讀取「${file.name}」`));
      };
      img.src = url;
    });
  }

  async function attach(files) {
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      try {
        attachments.push(await readPicture(file));
      } catch (error) {
        addNotice(error.message, true);
      }
    }
    renderAttachments();
  }

  function submit() {
    const input = $('assistantInput');
    const message = input.value.trim();
    if (running || !message) return;
    input.value = '';
    send(message);
  }

  function setOpen(open) {
    $('assistantPanel').hidden = !open;
    document.querySelector('.workspace').classList.toggle('assistant-open', open);
    $('assistantToggle').classList.toggle('primary', open);
    $('assistantToggle').setAttribute('aria-pressed', String(open));
    if (open) $('assistantInput').focus();
    // The other columns change width; let the editor lay its views out again.
    window.dispatchEvent(new Event('resize'));
  }

  function resetConversation() {
    session = null;
    sessionKey = '';
    attachments = [];
    usage.input = 0;
    usage.output = 0;
    imagesGenerated = 0;
    log.querySelectorAll('.chat-msg, .chat-step, .chat-notice').forEach((el) => el.remove());
    $('assistantIntro').hidden = false;
    renderAttachments();
    renderUsage();
  }

  // ---------------------------------------------------------------- settings dialog

  const dialog = $('aiSettings');

  function fillSelect(select, options, value) {
    select.textContent = '';
    options.forEach(([id, label]) => select.appendChild(new Option(label, id)));
    select.value = value;
  }

  /** Every distinct key some provider or generator can use, in a stable order. */
  function credentials() {
    const seen = new Map();
    for (const thing of [...Object.values(AI.providers), ...Object.values(AI.imageGenerators)]) {
      if (thing.credential.kind === 'key' && !seen.has(thing.credential.name)) seen.set(thing.credential.name, thing.credential);
    }
    return Array.from(seen.values());
  }

  function buildKeyFields() {
    const host = $('aiKeys');
    host.textContent = '';
    for (const credential of credentials()) {
      const field = document.createElement('label');
      field.className = 'field';
      field.append(credential.label);
      const input = document.createElement('input');
      input.type = 'password';
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.placeholder = credential.placeholder;
      input.dataset.credential = credential.name;
      input.value = settings.keys[credential.name] || '';
      input.addEventListener('input', () => {
        settings.keys[credential.name] = input.value.trim();
        syncSettingsDialog();
      });
      field.appendChild(input);
      const help = document.createElement('span');
      help.className = 'hint';
      help.textContent = credential.help;
      field.appendChild(help);
      host.appendChild(field);
    }
  }

  async function renderSignIn() {
    const box = $('aiSignIn');
    const p = provider();
    box.hidden = p.credential.kind !== 'signin';
    if (box.hidden) return;
    $('aiSignInStatus').textContent = t`檢查登入狀態…`;
    $('aiSignInBtn').hidden = true;
    $('aiSignOutBtn').hidden = true;
    let status;
    try {
      status = await p.auth.status();
    } catch (error) {
      status = { available: false, reason: String(error.message || error) };
    }
    if (provider() !== p) return; // the choice changed while waiting
    if (!status.available) {
      $('aiSignInStatus').textContent = status.reason || p.credential.help;
      return;
    }
    $('aiSignInStatus').textContent = status.signedIn ? t`已登入${status.account ? `:${status.account}` : ''}` : t`尚未登入。`;
    $('aiSignInBtn').hidden = status.signedIn;
    $('aiSignOutBtn').hidden = !status.signedIn;
  }

  function syncSettingsDialog() {
    const p = provider();
    $('aiProviderHelp').textContent = p.credential.kind === 'key'
      ? (keyFor(p) ? '' : t`需要填入下方的「${p.credential.label}」。`)
      : p.credential.help;
    const g = generator();
    $('aiImageModelRow').hidden = !g;
    $('aiImageHelp').textContent = !g
      ? t`不使用時,AI 只用向量圖(SVG)和像素格作畫。`
      : (imageGenerationReady() ? g.help : t`需要填入下方的「${g.credential.label}」。`);
    renderHeader();
  }

  /** Sends one tiny request with the chosen source, model and key, and says what came back. */
  async function testConnection() {
    const p = provider();
    const out = $('aiTestResult');
    if (p.credential.kind === 'key' && !keyFor(p)) {
      out.textContent = t`請先填入下方的「${p.credential.label}」。`;
      out.className = 'test-result failed';
      return;
    }
    out.textContent = t`測試中…`;
    out.className = 'test-result';
    $('aiTest').disabled = true;
    try {
      const probe = p.createSession({
        credential: p.credential.kind === 'key' ? keyFor(p) : null,
        model: modelOf(p),
        system: 'This is a connection test. Reply with the single word OK and nothing else.',
        // One real tool goes along, so the test exercises the same request shape as real use.
        tools: AI.tools({}).slice(0, 1),
      });
      probe.addUser([{ type: 'text', text: 'Connection test. Reply OK.' }]);
      let said = '';
      await probe.run({ onText: (delta) => { said += delta; }, onToolStart() {}, onToolDetail() {} });
      out.textContent = t`連線成功。模型回覆:「${said.trim().slice(0, 40) || t`(呼叫了工具)`}」`;
      out.className = 'test-result ok';
    } catch (error) {
      out.textContent = t`連線失敗:${describeError(error)}`;
      out.className = 'test-result failed';
    } finally {
      $('aiTest').disabled = false;
    }
  }

  function openSettings() {
    fillSelect($('aiProvider'), Object.values(AI.providers).map((p) => [p.id, p.label]), settings.provider);
    fillSelect($('aiModel'), provider().models, modelOf(provider()));
    fillSelect($('aiImageGenerator'), [['none', t`不使用`]].concat(Object.values(AI.imageGenerators).map((g) => [g.id, g.label])), settings.imageGenerator);
    if (generator()) fillSelect($('aiImageModel'), generator().models, imageModelOf(generator()));
    $('aiRemember').checked = settings.remember;
    buildKeyFields();
    syncSettingsDialog();
    renderSignIn();
    $('aiSettingsNote').hidden = true;
    $('aiTestResult').textContent = '';
    if (!dialog.open) dialog.showModal();
  }

  function toastSettings(message) {
    $('aiSettingsNote').textContent = message;
    $('aiSettingsNote').hidden = false;
  }

  function buildSettings() {
    $('aiProvider').addEventListener('change', () => {
      settings.provider = $('aiProvider').value;
      fillSelect($('aiModel'), provider().models, modelOf(provider()));
      syncSettingsDialog();
      renderSignIn();
    });
    $('aiModel').addEventListener('change', () => {
      settings.models[settings.provider] = $('aiModel').value;
      syncSettingsDialog();
    });
    $('aiImageGenerator').addEventListener('change', () => {
      settings.imageGenerator = $('aiImageGenerator').value;
      if (generator()) fillSelect($('aiImageModel'), generator().models, imageModelOf(generator()));
      syncSettingsDialog();
    });
    $('aiImageModel').addEventListener('change', () => {
      settings.imageModel[settings.imageGenerator] = $('aiImageModel').value;
    });
    $('aiTest').addEventListener('click', testConnection);
    $('aiRemember').addEventListener('change', () => {
      settings.remember = $('aiRemember').checked;
    });
    $('aiSignInBtn').addEventListener('click', async () => {
      $('aiSignInStatus').textContent = t`已開啟登入頁面,請在新分頁完成登入…`;
      try {
        await provider().auth.signIn();
      } catch (error) {
        toastSettings(t`登入失敗:${error.message || error}`);
      }
      renderSignIn();
    });
    $('aiSignOutBtn').addEventListener('click', async () => {
      try {
        await provider().auth.signOut();
      } catch (error) {
        toastSettings(t`登出失敗:${error.message || error}`);
      }
      renderSignIn();
    });
    dialog.addEventListener('close', () => {
      saveSettings();
      renderHeader();
    });
    $('aiSettingsDone').addEventListener('click', () => dialog.close());
    // A click on the dimmed area outside the dialog closes it.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  // ---------------------------------------------------------------- start

  function build() {
    loadSettings();
    buildSettings();
    renderHeader();

    $('assistantToggle').addEventListener('click', () => setOpen($('assistantPanel').hidden));
    $('assistantClose').addEventListener('click', () => setOpen(false));
    $('assistantSettingsBtn').addEventListener('click', openSettings);
    $('assistantModelChip').addEventListener('click', openSettings);
    $('assistantSend').addEventListener('click', submit);
    $('assistantStop').addEventListener('click', () => {
      stopRequested = true;
      if (session) session.abort();
    });
    $('assistantInput').addEventListener('keydown', (event) => {
      // Enter sends; Shift+Enter starts a new line. Not while an input method is composing.
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    $('assistantAttach').addEventListener('click', () => $('assistantFile').click());
    $('assistantFile').addEventListener('change', async (event) => {
      await attach(Array.from(event.target.files));
      event.target.value = '';
    });
    $('assistantInput').addEventListener('paste', (event) => {
      const files = Array.from(event.clipboardData ? event.clipboardData.files : []);
      if (files.some((f) => f.type.startsWith('image/'))) {
        event.preventDefault();
        attach(files);
      }
    });
    // A picture dropped on this panel is a reference for the assistant, not a new layer.
    $('assistantPanel').addEventListener('drop', (event) => {
      event.preventDefault();
      event.stopPropagation();
      $('dropOverlay').hidden = true;
      if (event.dataTransfer) attach(Array.from(event.dataTransfer.files));
    });
    $('assistantReset').addEventListener('click', resetConversation);
    document.querySelectorAll('[data-suggest]').forEach((button) => {
      button.addEventListener('click', () => {
        $('assistantInput').value = button.dataset.suggest;
        $('assistantInput').focus();
      });
    });
  }

  build();

  // For scripted use (tests): drive the assistant without the interface or the network.
  window.spatialAssistant = {
    send,
    setOpen,
    openSettings,
    runTool,
    resetConversation,
    settings,
    renderMarkdown,
    get session() {
      return session;
    },
    /** Pass (options) -> session to script the model; pass null to use the real provider. */
    setSessionFactory(factory) {
      sessionFactory = factory;
      session = null;
      sessionKey = '';
    },
  };
})();
