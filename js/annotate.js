// Marking up a picture for the assistant.
//
// The person picks what to mark (the wallpaper as it looks now, one layer alone, or one of the
// pictures the assistant knows), draws regions, boxes and arrows on it and writes a line about
// each one. "Add to the assistant" attaches the marked-up picture to the message being written
// and appends a numbered list of the marks, with their positions in the coordinates the model
// works in: canvas pixels for the wallpaper and its layers, the picture's own pixels for a ref.
// Pointing at a place is what plain words are worst at, which is the whole point of this.
(function () {
  'use strict';

  const t = window.WallI18n.t;
  const $ = (id) => document.getElementById(id);

  /** Mark colours. The name goes into the text, so the model can tell the marks apart. */
  const COLORS = [
    { value: '#ff4b4b', name: () => t`紅色` },
    { value: '#ffd12e', name: () => t`黃色` },
    { value: '#4bc8ff', name: () => t`藍色` },
    { value: '#8cff6b', name: () => t`綠色` },
  ];
  /** Longest side of the picture being marked up, in pixels. */
  const MAX_SIDE = 1200;

  /** The marks on the picture: { kind: 'brush' | 'rect' | 'arrow', points, color, width, note }. */
  let marks = [];
  let tool = 'brush';
  let color = COLORS[0].value;
  let brushWidth = 18;
  /** What is being marked: { img, title, lead, factor, options } (see loadTarget). */
  let target = null;
  let drawing = null;
  let highlight = -1;
  let targets = [];
  let chosenIndex = 0;

  const canvas = () => $('annotateCanvas');

  // ---------------------------------------------------------------- what can be marked

  /** Everything worth marking up, as choices for the picker. */
  function targetList() {
    const scene = window.spatialEditor.agent.scene();
    const list = [];
    if (scene.layers_far_to_near.length) list.push({ kind: 'canvas', label: t`目前的桌布畫面` });
    // Nearest first, like the layer list.
    for (const layer of scene.layers_far_to_near.slice().reverse()) {
      list.push({ kind: 'layer', id: layer.id, label: t`圖層「${layer.name}」(深度 ${layer.depth})`, name: layer.name });
    }
    for (const picture of scene.pictures) {
      list.push({ kind: 'ref', ref: picture.image, label: t`參考圖 ${picture.image}(${picture.width}×${picture.height})` });
    }
    return list;
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t`無法讀取這張圖`));
      img.src = src;
    });
  }

  /**
   * Draws the chosen thing into a picture to mark up. `modelW` is its width in the coordinates
   * the model works in, which is how a position on the picture becomes a position it can use.
   */
  async function loadTarget(choice) {
    const agent = window.spatialEditor.agent;
    const { width: W, height: H } = agent.scene().canvas;
    if (choice.kind === 'ref') {
      const picture = await agent.previewReference(choice.ref, MAX_SIDE);
      return {
        img: await loadImage(picture.dataUrl),
        modelW: picture.width,
        lead: t`附圖是 ${choice.ref} 加上我畫的標註(棋盤格是透明的部分)。下面的座標是這張圖自己的座標,它原本是 ${picture.width}×${picture.height} px。`,
      };
    }
    const shot = choice.kind === 'layer' ? agent.render({ onlyLayerId: choice.id }) : agent.render({});
    return {
      img: await loadImage(shot.dataUrl),
      modelW: W,
      lead: choice.kind === 'layer'
        ? t`附圖是圖層「${choice.name}」(id ${choice.id})單獨的樣子加上我畫的標註,棋盤格是透明的部分。下面的座標是畫布座標(畫布 ${W}×${H} px)。`
        : t`附圖是目前的桌布畫面加上我畫的標註。下面的座標是畫布座標(畫布 ${W}×${H} px)。`,
    };
  }

  // ---------------------------------------------------------------- drawing

  /** Marks are drawn thicker on a bigger picture, so they look the same whatever is being marked. */
  function markScale() {
    return Math.max(1, canvas().width / 540);
  }

  function boxOf(mark) {
    const xs = mark.points.map((p) => p[0]);
    const ys = mark.points.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  function anchorOf(mark) {
    if (mark.kind === 'arrow') return mark.points[0];
    const [x1, y1] = boxOf(mark);
    return [x1, y1];
  }

  function drawArrow(ctx, [x1, y1], [x2, y2], k) {
    const angle = Math.atan2(y2 - y1, x2 - x1);
    const head = 26 * k;
    ctx.lineWidth = 4 * k;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x2, y2);
    ctx.lineTo(x2 - head * Math.cos(angle - 0.4), y2 - head * Math.sin(angle - 0.4));
    ctx.lineTo(x2 - head * Math.cos(angle + 0.4), y2 - head * Math.sin(angle + 0.4));
    ctx.closePath();
    ctx.fill();
  }

  function drawBadge(ctx, [x, y], n, markColor, k) {
    const r = 15 * k;
    const cx = Math.min(Math.max(x, r + 2), canvas().width - r - 2);
    const cy = Math.min(Math.max(y - r, r + 2), canvas().height - r - 2);
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = markColor;
    ctx.fill();
    ctx.lineWidth = 2 * k;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
    ctx.stroke();
    ctx.fillStyle = '#10121a';
    ctx.font = `bold ${19 * k}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(n), cx, cy + k);
    ctx.restore();
  }

  function drawMark(ctx, mark, n, lit) {
    const k = markScale();
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = mark.color;
    ctx.fillStyle = mark.color;
    if (mark.kind === 'brush') {
      ctx.globalAlpha = 0.45;
      ctx.lineWidth = mark.width * k;
      ctx.beginPath();
      mark.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      // A single tap still leaves a dot.
      if (mark.points.length === 1) ctx.lineTo(mark.points[0][0] + 0.01, mark.points[0][1]);
      ctx.stroke();
    } else if (mark.kind === 'rect') {
      const [x1, y1, x2, y2] = boxOf(mark);
      ctx.globalAlpha = 0.16;
      ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.globalAlpha = 0.95;
      ctx.lineWidth = 4 * k;
      ctx.strokeRect(x1, y1, x2 - x1, y2 - y1);
    } else {
      drawArrow(ctx, mark.points[0], mark.points[mark.points.length - 1], k);
    }
    ctx.restore();
    if (lit) {
      const [x1, y1, x2, y2] = boxOf(mark);
      const pad = 8 * k;
      ctx.save();
      ctx.setLineDash([10 * k, 7 * k]);
      ctx.lineWidth = 2 * k;
      ctx.strokeStyle = '#ffffff';
      ctx.strokeRect(x1 - pad, y1 - pad, x2 - x1 + pad * 2, y2 - y1 + pad * 2);
      ctx.restore();
    }
    drawBadge(ctx, anchorOf(mark), n, mark.color, k);
  }

  function redraw() {
    const el = canvas();
    const ctx = el.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width, el.height);
    if (target) ctx.drawImage(target.img, 0, 0, el.width, el.height);
    marks.forEach((mark, i) => drawMark(ctx, mark, i + 1, i === highlight));
    if (drawing) drawMark(ctx, drawing, marks.length + 1, false);
  }

  // ---------------------------------------------------------------- pointer

  /** Where the pointer is on the picture, or null if the picture has no size on screen. */
  function pointAt(event) {
    const el = canvas();
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return [
      Math.min(Math.max((event.clientX - rect.left) * el.width / rect.width, 0), el.width),
      Math.min(Math.max((event.clientY - rect.top) * el.height / rect.height, 0), el.height),
    ];
  }

  function onPointerDown(event) {
    if (!target) return;
    const start = pointAt(event);
    if (!start) return;
    event.preventDefault();
    // Keeps the stroke going when the pointer leaves the canvas; not every pointer can be held.
    try {
      canvas().setPointerCapture(event.pointerId);
    } catch (error) {
      // Drawing works without it.
    }
    drawing = { kind: tool, points: [start], color, width: brushWidth, note: '' };
    redraw();
  }

  function onPointerMove(event) {
    if (!drawing) return;
    const point = pointAt(event);
    if (!point) return;
    if (drawing.kind === 'brush') {
      const last = drawing.points[drawing.points.length - 1];
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) < 3) return;
      drawing.points.push(point);
    } else {
      drawing.points[1] = point;
    }
    redraw();
  }

  function onPointerUp() {
    if (!drawing) return;
    const mark = drawing;
    drawing = null;
    const [x1, y1, x2, y2] = boxOf(mark);
    // A box or arrow needs a drag; a tap with the brush is a deliberate dot.
    if (mark.kind !== 'brush' && Math.hypot(x2 - x1, y2 - y1) < 12) {
      redraw();
      return;
    }
    marks.push(mark);
    highlight = marks.length - 1;
    renderMarks();
    redraw();
    const input = $('annotateList').querySelector(`[data-note="${marks.length - 1}"]`);
    if (input) input.focus();
  }

  // ---------------------------------------------------------------- the list of marks

  function kindLabel(mark) {
    if (mark.kind === 'brush') return t`塗抹`;
    if (mark.kind === 'rect') return t`方框`;
    return t`箭頭`;
  }

  function renderMarks() {
    const list = $('annotateList');
    list.textContent = '';
    marks.forEach((mark, i) => {
      const item = document.createElement('li');
      item.className = 'annotate-mark';

      const badge = document.createElement('span');
      badge.className = 'annotate-badge';
      badge.style.background = mark.color;
      badge.textContent = String(i + 1);

      const note = document.createElement('input');
      note.type = 'text';
      note.value = mark.note;
      note.dataset.note = String(i);
      note.placeholder = t`這裡要怎麼改?`;
      note.setAttribute('aria-label', t`標記 ${i + 1}(${kindLabel(mark)})的說明`);
      note.addEventListener('input', () => {
        mark.note = note.value;
        updateCount();
      });
      note.addEventListener('focus', () => {
        highlight = i;
        redraw();
      });
      note.addEventListener('keydown', (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') event.preventDefault();
      });

      const remove = document.createElement('button');
      remove.className = 'small danger annotate-remove';
      remove.type = 'button';
      remove.textContent = '✕';
      remove.title = t`刪掉這個標記`;
      remove.addEventListener('click', () => {
        marks.splice(i, 1);
        highlight = -1;
        renderMarks();
        redraw();
      });

      item.append(badge, note, remove);
      list.appendChild(item);
    });
    $('annotateEmpty').hidden = marks.length > 0;
    updateCount();
  }

  function updateCount() {
    const noNote = marks.filter((m) => !m.note.trim()).length;
    $('annotateApply').disabled = marks.length === 0;
    $('annotateCount').textContent = !marks.length
      ? ''
      : noNote
        ? t`${marks.length} 個標記,其中 ${noNote} 個還沒寫說明`
        : t`${marks.length} 個標記`;
  }

  // ---------------------------------------------------------------- handing it over

  function round(value) {
    return Math.round(value);
  }

  /** The marks as text, in the coordinates the model works in. */
  function markText() {
    const lines = [];
    marks.forEach((mark, i) => {
      const f = target.factor;
      const [x1, y1, x2, y2] = boxOf(mark).map((v) => round(v * f));
      const name = (COLORS.find((c) => c.value === mark.color) || COLORS[0]).name();
      let head;
      if (mark.kind === 'arrow') {
        const from = mark.points[0].map((v) => round(v * f));
        const to = mark.points[mark.points.length - 1].map((v) => round(v * f));
        head = t`${i + 1}. ${name}箭頭,從 (${from[0]}, ${from[1]}) 指到 (${to[0]}, ${to[1]})`;
      } else if (mark.kind === 'rect') {
        head = t`${i + 1}. ${name}方框,x ${x1}–${x2}、y ${y1}–${y2}`;
      } else {
        head = t`${i + 1}. ${name}塗抹的範圍,大約 x ${x1}–${x2}、y ${y1}–${y2}`;
      }
      lines.push(mark.note.trim() ? `${head}:${mark.note.trim()}` : head);
    });
    return lines.join('\n');
  }

  function apply() {
    if (!marks.length || !target) return;
    highlight = -1;
    redraw();
    const el = canvas();
    const picture = { dataUrl: el.toDataURL('image/jpeg', 0.92), w: el.width, h: el.height };
    const text = `${target.lead}\n${markText()}\n${t`請依照標註修改,沒有標到的地方不要動。`}\n`;
    window.spatialAssistant.attachPicture(picture);
    window.spatialAssistant.appendToInput(text);
    close();
  }

  // ---------------------------------------------------------------- the dialog

  /** Sizes the canvas to the picture (capped) and works out the marks' coordinate factor. */
  function layout() {
    const el = canvas();
    const scale = Math.min(1, MAX_SIDE / Math.max(target.img.naturalWidth, target.img.naturalHeight));
    el.width = Math.max(1, Math.round(target.img.naturalWidth * scale));
    el.height = Math.max(1, Math.round(target.img.naturalHeight * scale));
    target.factor = target.modelW / el.width;
  }

  async function choose(index) {
    const choice = targets[index];
    if (!choice) return false;
    $('annotateApply').disabled = true;
    try {
      target = await loadTarget(choice);
    } catch (error) {
      window.spatialEditor.toast(t`無法載入這張圖:${error.message}`, true);
      return false;
    }
    chosenIndex = index;
    marks = [];
    drawing = null;
    highlight = -1;
    layout();
    renderMarks();
    redraw();
    return true;
  }

  function setTool(next) {
    tool = next;
    document.querySelectorAll('#annotateTools [data-tool]').forEach((button) => {
      button.classList.toggle('active', button.dataset.tool === next);
    });
    $('annotateWidthRow').hidden = next !== 'brush';
  }

  function setColor(next) {
    color = next;
    document.querySelectorAll('#annotateColors [data-color]').forEach((button) => {
      button.classList.toggle('active', button.dataset.color === next);
    });
  }

  /** Lets go of the picture and the marks. Reopening starts from the chosen picture again. */
  function reset() {
    marks = [];
    drawing = null;
    target = null;
    highlight = -1;
    renderMarks();
  }

  function close() {
    if ($('annotateDialog').open) $('annotateDialog').close();
    // Not left to the dialog's "close" event: some web views never fire it.
    reset();
  }

  /** Opens the dialog on `choice` if given, else on the selected layer, else on the whole picture. */
  async function open(preferred) {
    const editor = window.spatialEditor;
    targets = targetList();
    if (!targets.length) {
      editor.toast(t`還沒有圖層或參考圖可以標註。`, true);
      return;
    }
    reset();
    const picker = $('annotateTarget');
    picker.textContent = '';
    targets.forEach((choice, i) => picker.appendChild(new Option(choice.label, String(i))));
    let index = 0;
    if (preferred !== undefined) {
      const found = targets.findIndex((c) => c.kind === 'layer' && c.id === preferred);
      if (found >= 0) index = found;
    }
    picker.value = String(index);
    // showModal() on an open dialog throws, which would leave it standing there holding nothing.
    if (!$('annotateDialog').open) $('annotateDialog').showModal();
    await choose(index);
  }

  function build() {
    const el = canvas();
    el.addEventListener('pointerdown', onPointerDown);
    el.addEventListener('pointermove', onPointerMove);
    el.addEventListener('pointerup', onPointerUp);
    el.addEventListener('pointercancel', onPointerUp);

    COLORS.forEach((item) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'annotate-color';
      button.dataset.color = item.value;
      button.style.background = item.value;
      button.title = item.name();
      button.setAttribute('aria-label', item.name());
      button.addEventListener('click', () => setColor(item.value));
      $('annotateColors').appendChild(button);
    });
    document.querySelectorAll('#annotateTools [data-tool]').forEach((button) => {
      button.addEventListener('click', () => setTool(button.dataset.tool));
    });
    $('annotateWidth').addEventListener('input', () => {
      brushWidth = Number($('annotateWidth').value);
    });
    // Changing what is being marked starts the marks again, so ask before throwing them away.
    $('annotateTarget').addEventListener('change', async (event) => {
      const next = Number(event.target.value);
      if (marks.length && !window.confirm(t`換一張圖的話,現在畫的 ${marks.length} 個標記會不見。要換嗎?`)) {
        event.target.value = String(chosenIndex);
        return;
      }
      if (!(await choose(next))) event.target.value = String(chosenIndex);
    });
    $('annotateUndoMark').addEventListener('click', () => {
      marks.pop();
      highlight = -1;
      renderMarks();
      redraw();
    });
    $('annotateClear').addEventListener('click', () => {
      marks = [];
      highlight = -1;
      renderMarks();
      redraw();
    });
    $('annotateCancel').addEventListener('click', close);
    $('annotateApply').addEventListener('click', apply);
    // Esc dismisses the dialog without going through close().
    $('annotateDialog').addEventListener('close', reset);
    setTool('brush');
    setColor(COLORS[0].value);
  }

  build();

  // For scripted use (tests): open it, and see what it is holding.
  window.WallAnnotate = {
    open,
    state: () => ({ marks: marks.length, target: !!target, tool, color, factor: target ? target.factor : null }),
  };
})();
