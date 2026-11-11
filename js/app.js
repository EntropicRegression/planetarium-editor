// Spatial wallpaper editor.
//
// Layers are images placed on a phone-shaped canvas, each at a depth between 0 (nearest) and
// 1 (farthest). The phone preview reproduces the app's parallax exactly (see `parallaxOf`), and
// export bakes every layer into a full-canvas image, because that is all the app's pack format
// knows: full-screen layers plus a depth.
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const PRESETS = [
    ['1080 × 2400', 1080, 2400],
    ['1080 × 2340', 1080, 2340],
    ['1440 × 3200', 1440, 3200],
    ['1440 × 3120', 1440, 3120],
    ['1080 × 1920', 1080, 1920],
    ['自訂', 0, 0],
  ];
  /** Height in pixels of the working copies used for the previews. */
  const PREVIEW_H = 1000;
  /** Distance in the 3D view between depth 0 and depth 1, and the height of a layer plane. */
  const SPREAD = 520;
  const PLANE_H = 420;
  const HISTORY_LIMIT = 100;

  const state = {
    name: '我的空間桌布',
    canvasW: 1080,
    canvasH: 2400,
    strength: 0.04,
    focus: 1,
    effect: 'none',
    layers: [],
    selectedId: null,
  };

  /**
   * imageId -> the picture or video a layer shows:
   *   { kind: 'image' | 'video', el, w, h, src, thumb, blob, ext }
   * `el` is an <img> or a playing <video>; `src` is a data URL (image) or object URL (video);
   * `blob` and `ext` are the original video file, exported untouched.
   * Kept even after a layer is deleted, so undo can bring it back.
   */
  const images = new Map();
  /** layerId -> preview-sized canvas holding the layer as it sits on the wallpaper canvas. */
  const baked = new Map();
  /** layerId -> its plane element in the 3D view. */
  const planes = new Map();

  let nextId = 1;
  const view = { rx: -14, ry: -40, zoom: 1 };
  const tilt = { x: 0, y: 0 };
  let tiltMode = false;
  let swaying = false;
  let frameRequest = 0;
  let history = [];
  let historyIndex = -1;
  let dirty = false;

  // ---------------------------------------------------------------- geometry

  function previewSize() {
    return { W: Math.round(PREVIEW_H * state.canvasW / state.canvasH), H: PREVIEW_H };
  }

  function selected() {
    return state.layers.find((l) => l.id === state.selectedId) || null;
  }

  /** Visible layers, far to near: the order the app draws them in. */
  function drawOrder() {
    return state.layers.filter((l) => l.visible).sort((a, b) => b.depth - a.depth);
  }

  /**
   * The app's parallax for a layer at `depth`: it is zoomed by `zoom` about the screen centre
   * (so sliding never shows its edge) and slides by tilt * `shift` of the screen size.
   */
  function parallaxOf(depth) {
    const k = state.focus - depth;
    return { zoom: 1 + 2 * state.strength * Math.abs(k), shift: state.strength * k };
  }

  /** Scale that makes a picture or video cover a W x H canvas; a layer's `scale` multiplies this. */
  function coverScale(entry, W, H) {
    return Math.max(W / entry.w, H / entry.h);
  }

  function containFactor(entry) {
    const sx = state.canvasW / entry.w;
    const sy = state.canvasH / entry.h;
    return Math.min(sx, sy) / Math.max(sx, sy);
  }

  function isVideo(layer) {
    const entry = images.get(layer.imageId);
    return !!entry && entry.kind === 'video';
  }

  /** Draws a layer where it sits on a W x H wallpaper canvas (no parallax). */
  function bakeInto(ctx, layer, W, H) {
    const entry = images.get(layer.imageId);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!entry) return;
    // A video that has not decoded a frame yet has nothing to draw.
    if (entry.kind === 'video' && entry.el.readyState < 2) return;
    const s = coverScale(entry, W, H) * layer.scale;
    // The app cannot mirror a video, so the editor does not either.
    const flip = layer.flip && entry.kind === 'image';
    ctx.save();
    ctx.globalAlpha = layer.opacity;
    ctx.imageSmoothingQuality = 'high';
    ctx.translate(W / 2 + layer.x * W, H / 2 + layer.y * H);
    ctx.rotate(layer.rotation * Math.PI / 180);
    ctx.scale(flip ? -s : s, s);
    ctx.drawImage(entry.el, -entry.w / 2, -entry.h / 2, entry.w, entry.h);
    ctx.restore();
  }

  /** How a layer is combined with what is behind it. Only video layers can be non-normal. */
  function compositeOf(layer) {
    if (!isVideo(layer)) return 'source-over';
    return layer.blend === 'add' ? 'lighter' : layer.blend === 'screen' ? 'screen' : 'source-over';
  }

  function bakedCanvas(layer) {
    let canvas = baked.get(layer.id);
    if (!canvas) {
      canvas = document.createElement('canvas');
      baked.set(layer.id, canvas);
    }
    return canvas;
  }

  function rebake(layer) {
    const { W, H } = previewSize();
    const canvas = bakedCanvas(layer);
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    bakeInto(canvas.getContext('2d', { willReadFrequently: true }), layer, W, H);
  }

  function rebakeAll() {
    state.layers.forEach(rebake);
  }

  // ---------------------------------------------------------------- phone preview

  const phone = $('phone');

  function renderPhone() {
    const { W, H } = previewSize();
    if (phone.width !== W || phone.height !== H) {
      phone.width = W;
      phone.height = H;
      layoutPhone();
    }
    const ctx = phone.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0a0a0f';
    ctx.fillRect(0, 0, W, H);
    for (const layer of drawOrder()) {
      const p = parallaxOf(layer.depth);
      ctx.save();
      ctx.globalCompositeOperation = compositeOf(layer);
      ctx.translate(W / 2 + tilt.x * p.shift * W, H / 2 + tilt.y * p.shift * H);
      ctx.scale(p.zoom, p.zoom);
      ctx.drawImage(bakedCanvas(layer), -W / 2, -H / 2, W, H);
      ctx.restore();
    }
    const layer = selected();
    if (layer && layer.visible && !tiltMode) drawSelection(ctx, layer, W, H);
  }

  /** Outline of the selected layer's image, as shown (parallax zoom included, no tilt). */
  function drawSelection(ctx, layer, W, H) {
    const entry = images.get(layer.imageId);
    if (!entry) return;
    const s = coverScale(entry, W, H) * layer.scale;
    const hw = entry.w * s / 2;
    const hh = entry.h * s / 2;
    const angle = layer.rotation * Math.PI / 180;
    const zoom = parallaxOf(layer.depth).zoom;
    const corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([px, py]) => {
      const x = layer.x * W + px * Math.cos(angle) - py * Math.sin(angle);
      const y = layer.y * H + px * Math.sin(angle) + py * Math.cos(angle);
      return [W / 2 + x * zoom, H / 2 + y * zoom];
    });
    ctx.save();
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = '#8b7cff';
    ctx.stroke();
    ctx.restore();
  }

  /** Fits the canvas element into its column while keeping the wallpaper's aspect ratio. */
  function layoutPhone() {
    const wrap = phone.closest('.phone-wrap');
    const availW = wrap.clientWidth - 18;
    const availH = wrap.clientHeight - 18;
    if (availW <= 0 || availH <= 0) return;
    const aspect = state.canvasW / state.canvasH;
    let h = availH;
    let w = h * aspect;
    if (w > availW) {
      w = availW;
      h = w / aspect;
    }
    phone.style.width = `${Math.round(w)}px`;
    phone.style.height = `${Math.round(h)}px`;
  }

  function phonePoint(event) {
    const rect = phone.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) / rect.width,
      y: (event.clientY - rect.top) / rect.height,
      rect,
    };
  }

  /** The nearest visible layer that has something painted under the pointer. */
  function hitTest(nx, ny) {
    const { W, H } = previewSize();
    const order = drawOrder().reverse();
    for (const layer of order) {
      const zoom = parallaxOf(layer.depth).zoom;
      const bx = Math.round(((nx - 0.5) / zoom + 0.5) * W);
      const by = Math.round(((ny - 0.5) / zoom + 0.5) * H);
      if (bx < 0 || by < 0 || bx >= W || by >= H) continue;
      const ctx = bakedCanvas(layer).getContext('2d', { willReadFrequently: true });
      if (ctx.getImageData(bx, by, 1, 1).data[3] > 10) return layer;
    }
    return null;
  }

  let moveDrag = null;

  phone.addEventListener('pointerdown', (event) => {
    if (tiltMode) return;
    const p = phonePoint(event);
    const layer = hitTest(p.x, p.y);
    select(layer ? layer.id : null);
    if (!layer) return;
    phone.setPointerCapture(event.pointerId);
    moveDrag = {
      layer,
      startX: layer.x,
      startY: layer.y,
      clientX: event.clientX,
      clientY: event.clientY,
      zoom: parallaxOf(layer.depth).zoom,
      rect: p.rect,
    };
  });

  phone.addEventListener('pointermove', (event) => {
    if (tiltMode) {
      const p = phonePoint(event);
      swaying = false;
      tilt.x = Math.max(-1, Math.min(1, (p.x - 0.5) * 2));
      tilt.y = Math.max(-1, Math.min(1, (p.y - 0.5) * 2));
      renderPhone();
      return;
    }
    if (!moveDrag) return;
    const d = moveDrag;
    d.layer.x = d.startX + (event.clientX - d.clientX) / d.rect.width / d.zoom;
    d.layer.y = d.startY + (event.clientY - d.clientY) / d.rect.height / d.zoom;
    layerChanged(d.layer);
  });

  function endMove() {
    if (!moveDrag) return;
    moveDrag = null;
    commit();
  }
  phone.addEventListener('pointerup', endMove);
  phone.addEventListener('pointercancel', endMove);
  phone.addEventListener('pointerleave', () => {
    if (!tiltMode) return;
    swaying = true;
    scheduleFrame();
  });

  let wheelCommit = 0;
  phone.addEventListener('wheel', (event) => {
    const layer = selected();
    if (tiltMode || !layer) return;
    event.preventDefault();
    if (event.shiftKey) {
      const delta = event.deltaY || event.deltaX;
      layer.rotation = clamp(layer.rotation + (delta > 0 ? 2 : -2), -180, 180);
    } else {
      layer.scale = clamp(layer.scale * Math.exp(-event.deltaY * 0.0015), 0.02, 8);
    }
    layerChanged(layer);
    clearTimeout(wheelCommit);
    wheelCommit = setTimeout(commit, 400);
  }, { passive: false });

  /**
   * One animation loop for everything that moves by itself: video layers showing their current
   * frame, and the gentle sway that keeps the parallax visible while the pointer is away from
   * the preview. It stops as soon as neither is needed.
   */
  function animate(ms) {
    frameRequest = 0;
    let moving = false;
    for (const layer of state.layers) {
      if (layer.visible && isVideo(layer)) {
        rebake(layer);
        moving = true;
      }
    }
    if (tiltMode && swaying) {
      const t = ms / 1000;
      tilt.x = Math.sin(t * 0.9) * 0.9;
      tilt.y = Math.sin(t * 0.6 + 1) * 0.5;
      moving = true;
    }
    if (!moving) return;
    renderPhone();
    scheduleFrame();
  }

  function scheduleFrame() {
    if (!frameRequest) frameRequest = requestAnimationFrame(animate);
  }

  function setTiltMode(on) {
    tiltMode = on;
    swaying = on;
    $('tiltMode').checked = on;
    phone.classList.toggle('tilting', on);
    tilt.x = 0;
    tilt.y = 0;
    updateHints();
    renderPhone();
    scheduleFrame();
  }

  // ---------------------------------------------------------------- 3D view

  const space = $('space');
  const world = $('world');

  function planeSize() {
    return { w: PLANE_H * state.canvasW / state.canvasH, h: PLANE_H };
  }

  function depthToZ(depth) {
    return (0.5 - depth) * SPREAD;
  }

  function worldScale() {
    const fit = Math.min(space.clientHeight / (PLANE_H * 1.55), space.clientWidth / (SPREAD * 1.5));
    return Math.max(0.2, fit) * view.zoom;
  }

  function applyView() {
    world.style.transform = `scale(${worldScale()}) rotateX(${view.rx}deg) rotateY(${view.ry}deg)`;
  }

  function placeBox(el, w, h, z) {
    el.style.width = `${w}px`;
    el.style.height = `${h}px`;
    el.style.transform = `translate(${-w / 2}px, ${-h / 2}px) translateZ(${z}px)`;
  }

  /** Rebuilds the planes. Called when the set of layers changes; otherwise see `updateSpace`. */
  function buildSpace() {
    world.textContent = '';
    planes.clear();
    const { w, h } = planeSize();

    const eye = document.createElement('div');
    eye.className = 'eye-marker';
    eye.textContent = '你從這一側看';
    placeBox(eye, w * 0.5, h * 0.16, SPREAD / 2 + 170);
    world.appendChild(eye);

    const focus = document.createElement('div');
    focus.className = 'focus-plane';
    focus.id = 'focusPlane';
    focus.appendChild(document.createElement('span')).textContent = '對焦面(傾斜時不動)';
    world.appendChild(focus);

    for (const layer of state.layers) {
      const plane = document.createElement('div');
      plane.className = 'plane';
      plane.dataset.id = layer.id;
      plane.appendChild(bakedCanvas(layer));
      plane.appendChild(document.createElement('div')).className = 'plane-label';
      world.appendChild(plane);
      planes.set(layer.id, plane);
    }
    updateSpace();
    applyView();
  }

  function updateSpace() {
    const { w, h } = planeSize();
    const focus = $('focusPlane');
    if (focus) placeBox(focus, w * 1.06, h * 1.06, depthToZ(state.focus));
    for (const layer of state.layers) {
      const plane = planes.get(layer.id);
      if (!plane) continue;
      placeBox(plane, w, h, depthToZ(layer.depth));
      plane.classList.toggle('selected', layer.id === state.selectedId);
      plane.classList.toggle('hidden-layer', !layer.visible);
      plane.querySelector('.plane-label').textContent = `${layer.name}・深度 ${layer.depth.toFixed(2)}`;
    }
  }

  let spaceDrag = null;

  space.addEventListener('pointerdown', (event) => {
    const plane = event.target.closest('.plane');
    space.setPointerCapture(event.pointerId);
    if (plane) {
      const layer = state.layers.find((l) => String(l.id) === plane.dataset.id);
      if (!layer) return;
      select(layer.id);
      spaceDrag = { kind: 'depth', layer, startDepth: layer.depth, x: event.clientX, y: event.clientY, moved: false };
    } else {
      spaceDrag = { kind: 'orbit', rx: view.rx, ry: view.ry, x: event.clientX, y: event.clientY };
      space.classList.add('orbiting');
    }
  });

  space.addEventListener('pointermove', (event) => {
    if (!spaceDrag) return;
    const dx = event.clientX - spaceDrag.x;
    const dy = event.clientY - spaceDrag.y;
    if (spaceDrag.kind === 'orbit') {
      view.ry = spaceDrag.ry + dx * 0.4;
      view.rx = clamp(spaceDrag.rx - dy * 0.3, -70, 70);
      applyView();
      return;
    }
    // Move the layer along the depth axis: project the pointer movement onto the direction in
    // which that axis runs on screen for the current view angle.
    const rx = view.rx * Math.PI / 180;
    const ry = view.ry * Math.PI / 180;
    const ax = Math.sin(ry);
    const ay = -Math.cos(ry) * Math.sin(rx);
    const len2 = ax * ax + ay * ay;
    if (len2 < 0.02) return; // looking straight down the axis: depth cannot be dragged
    const dz = (dx * ax + dy * ay) / len2 / worldScale();
    spaceDrag.layer.depth = clamp(round2(spaceDrag.startDepth - dz / SPREAD), 0, 1);
    spaceDrag.moved = true;
    layerChanged(spaceDrag.layer);
  });

  function endSpaceDrag() {
    if (!spaceDrag) return;
    const wasDepth = spaceDrag.kind === 'depth' && spaceDrag.moved;
    spaceDrag = null;
    space.classList.remove('orbiting');
    if (wasDepth) {
      renderLayerList();
      commit();
    }
  }
  space.addEventListener('pointerup', endSpaceDrag);
  space.addEventListener('pointercancel', endSpaceDrag);

  space.addEventListener('wheel', (event) => {
    event.preventDefault();
    view.zoom = clamp(view.zoom * Math.exp(-event.deltaY * 0.001), 0.4, 2.5);
    applyView();
  }, { passive: false });

  $('resetViewBtn').addEventListener('click', () => {
    view.rx = -14;
    view.ry = -40;
    view.zoom = 1;
    applyView();
  });

  // ---------------------------------------------------------------- layer list

  function renderLayerList() {
    const list = $('layerList');
    list.textContent = '';
    // Nearest first. Among equal depths the one drawn last (on top) comes first.
    const order = state.layers.slice().sort((a, b) => b.depth - a.depth).reverse();
    for (const layer of order) {
      const item = document.createElement('li');
      item.className = 'layer-item';
      item.classList.toggle('selected', layer.id === state.selectedId);
      item.classList.toggle('hidden-layer', !layer.visible);

      const thumb = document.createElement('img');
      thumb.className = 'layer-thumb';
      thumb.alt = '';
      const entry = images.get(layer.imageId);
      if (entry) thumb.src = entry.thumb || entry.src;

      const meta = document.createElement('div');
      meta.className = 'layer-meta';
      const title = document.createElement('div');
      title.className = 'layer-title';
      title.textContent = layer.name;
      const depth = document.createElement('div');
      depth.className = 'layer-depth';
      const kind = entry && entry.kind === 'video' ? '影片・' : '';
      depth.textContent = `${kind}深度 ${layer.depth.toFixed(2)}${depthWord(layer.depth)}`;
      meta.append(title, depth);

      const eye = document.createElement('button');
      eye.className = 'icon-btn';
      eye.textContent = layer.visible ? '隱藏' : '顯示';
      eye.title = layer.visible ? '隱藏這個圖層(不會匯出)' : '顯示這個圖層';
      eye.addEventListener('click', (event) => {
        event.stopPropagation();
        layer.visible = !layer.visible;
        refresh();
        commit();
      });

      item.append(thumb, meta, eye);
      item.addEventListener('click', () => select(layer.id));
      list.appendChild(item);
    }
    $('emptyHint').hidden = state.layers.length > 0;
  }

  function depthWord(depth) {
    if (depth <= 0.001) return '・最近';
    if (depth >= 0.999) return '・最遠';
    return '';
  }

  // ---------------------------------------------------------------- properties

  /** Controls bound to a value; `sync` pushes the current value into the inputs. */
  const bindings = [];

  function addSlider(container, spec) {
    const field = document.createElement('label');
    field.className = 'field';
    field.append(spec.label);
    const row = document.createElement('div');
    row.className = 'slider-row';
    const range = document.createElement('input');
    range.type = 'range';
    const number = document.createElement('input');
    number.type = 'number';
    for (const input of [range, number]) {
      input.min = spec.min;
      input.max = spec.max;
      input.step = spec.step;
    }
    number.setAttribute('aria-label', spec.label);
    row.append(range, number);
    field.appendChild(row);
    container.appendChild(field);

    const onInput = (source) => {
      const value = clamp(parseFloat(source.value), spec.min, spec.max);
      if (Number.isNaN(value)) return;
      spec.set(value);
      if (source !== range) range.value = value;
      if (source !== number) number.value = value;
    };
    range.addEventListener('input', () => onInput(range));
    number.addEventListener('input', () => onInput(number));
    range.addEventListener('change', commit);
    number.addEventListener('change', commit);

    bindings.push({
      sync() {
        const value = spec.get();
        if (value === undefined) return;
        const shown = round(value, spec.digits === undefined ? 2 : spec.digits);
        range.value = shown;
        if (document.activeElement !== number) number.value = shown;
      },
    });
  }

  function layerSlider(key, label, min, max, step, digits) {
    addSlider($('layerFields'), {
      label, min, max, step, digits,
      get: () => (selected() ? selected()[key] : undefined),
      set: (value) => {
        const layer = selected();
        if (!layer) return;
        layer[key] = value;
        layerChanged(layer);
        if (key === 'depth') renderLayerList();
      },
    });
  }

  function sceneSlider(key, label, min, max, step, digits) {
    addSlider($('sceneFields'), {
      label, min, max, step, digits,
      get: () => state[key],
      set: (value) => {
        state[key] = value;
        updateSpace();
        renderPhone();
      },
    });
  }

  function buildProperties() {
    layerSlider('depth', '深度(0 最近 → 1 最遠)', 0, 1, 0.01);
    layerSlider('x', '水平位置', -1, 1, 0.005, 3);
    layerSlider('y', '垂直位置', -1, 1, 0.005, 3);
    layerSlider('scale', '縮放(1 = 剛好填滿畫布)', 0.02, 4, 0.01);
    layerSlider('rotation', '旋轉(度)', -180, 180, 1, 0);
    layerSlider('opacity', '不透明度', 0, 1, 0.01);
    sceneSlider('strength', '視差強度', 0, 0.1, 0.005, 3);
    sceneSlider('focus', '對焦深度(這個深度的圖層不動)', 0, 1, 0.05);

    const effect = $('effect');
    for (const [key, value] of Object.entries(window.WallEffects)) {
      effect.appendChild(new Option(value.label, key));
    }
    effect.addEventListener('change', () => {
      state.effect = effect.value;
      commit();
    });

    $('layerName').addEventListener('input', () => {
      const layer = selected();
      if (!layer) return;
      layer.name = $('layerName').value;
      updateSpace();
      renderLayerList();
    });
    $('layerName').addEventListener('change', commit);

    $('layerFlip').addEventListener('change', () => {
      const layer = selected();
      if (!layer) return;
      layer.flip = $('layerFlip').checked;
      layerChanged(layer);
      commit();
    });

    const withLayer = (fn) => () => {
      const layer = selected();
      if (!layer) return;
      fn(layer);
      layerChanged(layer);
      syncProperties();
      commit();
    };
    $('fitCoverBtn').addEventListener('click', withLayer((layer) => {
      layer.scale = 1;
      layer.x = 0;
      layer.y = 0;
      layer.rotation = 0;
    }));
    $('layerBlend').addEventListener('change', () => {
      const layer = selected();
      if (!layer) return;
      layer.blend = $('layerBlend').value;
      renderPhone();
      commit();
    });

    $('fitContainBtn').addEventListener('click', withLayer((layer) => {
      const entry = images.get(layer.imageId);
      layer.scale = entry ? containFactor(entry) : 1;
      layer.x = 0;
      layer.y = 0;
      layer.rotation = 0;
    }));
    $('centerBtn').addEventListener('click', withLayer((layer) => {
      layer.x = 0;
      layer.y = 0;
    }));

    $('deleteBtn').addEventListener('click', deleteSelected);
    $('duplicateBtn').addEventListener('click', () => {
      const layer = selected();
      if (!layer) return;
      const copy = { ...layer, id: nextId++, name: `${layer.name} 複本`, x: layer.x + 0.03, y: layer.y + 0.02 };
      state.layers.push(copy);
      rebake(copy);
      state.selectedId = copy.id;
      refresh();
      commit();
    });
    $('replaceImageBtn').addEventListener('click', () => $('replaceInput').click());
  }

  function syncProperties() {
    const layer = selected();
    $('layerProps').hidden = !layer;
    $('noSelection').hidden = !!layer;
    if (layer) {
      if (document.activeElement !== $('layerName')) $('layerName').value = layer.name;
      $('layerFlip').checked = layer.flip;
      // Mirroring is baked into pictures; blending is something only the app's video layer does.
      const video = isVideo(layer);
      $('flipRow').hidden = video;
      $('blendRow').hidden = !video;
      $('layerBlend').value = layer.blend || 'normal';
    }
    bindings.forEach((b) => b.sync());
    $('effect').value = state.effect;
  }

  // ---------------------------------------------------------------- state changes

  /** A layer's own properties changed: redraw it everywhere. */
  function layerChanged(layer) {
    rebake(layer);
    updateSpace();
    renderPhone();
    syncProperties();
    updateWarning();
  }

  /** The set of layers, the selection or the canvas changed: rebuild every view. */
  function refresh() {
    rebakeAll();
    buildSpace();
    renderLayerList();
    syncProperties();
    syncToolbar();
    layoutPhone();
    renderPhone();
    updateWarning();
    updateHints();
    scheduleFrame();
  }

  function select(id) {
    if (state.selectedId === id) return;
    state.selectedId = id;
    updateSpace();
    renderLayerList();
    syncProperties();
    renderPhone();
    updateHints();
  }

  function deleteSelected() {
    const layer = selected();
    if (!layer) return;
    state.layers = state.layers.filter((l) => l !== layer);
    baked.delete(layer.id);
    state.selectedId = null;
    refresh();
    commit();
  }

  function updateHints() {
    let text;
    if (tiltMode) text = '移動滑鼠模擬傾斜手機;移開後會自動搖擺';
    else if (selected()) text = '拖曳移動・滾輪縮放・Shift + 滾輪旋轉・方向鍵微調';
    else if (state.layers.length) text = '點一下圖層來選取';
    else text = '';
    $('phoneHint').textContent = text;
  }

  /** The app shows black wherever no layer paints, so warn when the back layer has gaps. */
  function updateWarning() {
    const warning = $('edgeWarning');
    const order = drawOrder();
    let text = '';
    if (order.length) {
      const { W, H } = previewSize();
      const ctx = bakedCanvas(order[0]).getContext('2d', { willReadFrequently: true });
      const points = [[1, 1], [W - 2, 1], [1, H - 2], [W - 2, H - 2], [W >> 1, H >> 1]];
      const gap = points.some(([x, y]) => ctx.getImageData(x, y, 1, 1).data[3] < 250);
      if (gap) text = `最遠的圖層「${order[0].name}」沒有填滿畫布,空白處在手機上會是黑色。`;
    }
    warning.textContent = text;
    warning.hidden = !text;
  }

  // ---------------------------------------------------------------- history

  function snapshot() {
    return JSON.stringify({
      name: state.name,
      canvasW: state.canvasW,
      canvasH: state.canvasH,
      strength: state.strength,
      focus: state.focus,
      effect: state.effect,
      selectedId: state.selectedId,
      layers: state.layers,
    });
  }

  function restore(json) {
    const data = JSON.parse(json);
    Object.assign(state, data);
    baked.clear();
    refresh();
  }

  /** Records the current state as an undo step, if it differs from the last one. */
  function commit() {
    const now = snapshot();
    if (history[historyIndex] === now) return;
    history = history.slice(0, historyIndex + 1);
    history.push(now);
    if (history.length > HISTORY_LIMIT) history.shift();
    historyIndex = history.length - 1;
    dirty = true;
    syncToolbar();
  }

  function undo() {
    if (historyIndex <= 0) return;
    historyIndex--;
    restore(history[historyIndex]);
  }

  function redo() {
    if (historyIndex >= history.length - 1) return;
    historyIndex++;
    restore(history[historyIndex]);
  }

  // ---------------------------------------------------------------- toolbar

  function syncToolbar() {
    if (document.activeElement !== $('packName')) $('packName').value = state.name;
    const index = PRESETS.findIndex(([, w, h]) => w === state.canvasW && h === state.canvasH);
    const custom = index < 0 || customChosen;
    $('canvasPreset').value = String(custom ? PRESETS.length - 1 : index);
    $('customSize').hidden = !custom;
    $('canvasW').value = state.canvasW;
    $('canvasH').value = state.canvasH;
    $('undoBtn').disabled = historyIndex <= 0;
    $('redoBtn').disabled = historyIndex >= history.length - 1;
    $('exportBtn').disabled = drawOrder().length === 0;
  }

  let customChosen = false;

  function buildToolbar() {
    const preset = $('canvasPreset');
    PRESETS.forEach(([label], i) => preset.appendChild(new Option(label, String(i))));
    preset.addEventListener('change', () => {
      const [, w, h] = PRESETS[Number(preset.value)];
      customChosen = w === 0;
      if (!customChosen) setCanvasSize(w, h);
      else syncToolbar();
    });
    const applyCustom = () => {
      const w = clamp(parseInt($('canvasW').value, 10) || state.canvasW, 240, 4320);
      const h = clamp(parseInt($('canvasH').value, 10) || state.canvasH, 240, 7680);
      setCanvasSize(w, h);
    };
    $('canvasW').addEventListener('change', applyCustom);
    $('canvasH').addEventListener('change', applyCustom);

    $('packName').addEventListener('input', () => {
      state.name = $('packName').value;
    });
    $('packName').addEventListener('change', commit);

    $('undoBtn').addEventListener('click', undo);
    $('redoBtn').addEventListener('click', redo);
    $('addLayerBtn').addEventListener('click', () => $('imageInput').click());
    $('imageInput').addEventListener('change', async (event) => {
      await addFiles(Array.from(event.target.files));
      event.target.value = '';
    });
    $('replaceInput').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      const layer = selected();
      if (!file || !layer) return;
      try {
        layer.imageId = await loadMediaFile(file);
        refresh();
        commit();
      } catch (error) {
        toast(`無法讀取檔案:${error.message}`, true);
      }
    });
    $('tiltMode').addEventListener('change', (event) => setTiltMode(event.target.checked));
    $('exportBtn').addEventListener('click', exportPack);
    $('saveProjectBtn').addEventListener('click', saveProject);
    $('openProjectBtn').addEventListener('click', () => $('projectInput').click());
    $('projectInput').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (file) await openProject(file);
    });
  }

  function setCanvasSize(w, h) {
    state.canvasW = w;
    state.canvasH = h;
    refresh();
    commit();
  }

  // ---------------------------------------------------------------- images

  function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('讀取失敗'));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('不是可用的圖片'));
      img.src = src;
    });
  }

  async function registerImage(src) {
    const img = await loadImage(src);
    const id = `img${nextId++}`;
    images.set(id, { kind: 'image', el: img, w: img.naturalWidth, h: img.naturalHeight, src });
    return id;
  }

  /** Starts a muted, looping <video> for the file and waits until it can show a frame. */
  async function registerVideo(blob, fileName) {
    const src = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'auto';
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error('瀏覽器無法播放這個影片格式')), { once: true });
      video.src = src;
    });
    if (!video.videoWidth || !video.videoHeight) throw new Error('影片沒有畫面');
    video.play().catch(() => {});

    // A still for the layer list.
    const still = document.createElement('canvas');
    still.width = 96;
    still.height = Math.max(1, Math.round(96 * video.videoHeight / video.videoWidth));
    still.getContext('2d').drawImage(video, 0, 0, still.width, still.height);

    const match = /\.([A-Za-z0-9]{2,5})$/.exec(fileName || '');
    const id = `img${nextId++}`;
    images.set(id, {
      kind: 'video',
      el: video,
      w: video.videoWidth,
      h: video.videoHeight,
      src,
      thumb: still.toDataURL('image/jpeg', 0.7),
      blob,
      ext: match ? match[1].toLowerCase() : 'mp4',
    });
    return id;
  }

  async function loadMediaFile(file) {
    if (file.type.startsWith('video/')) return registerVideo(file, file.name);
    return registerImage(await readAsDataUrl(file));
  }

  /** Adds a layer in front of everything already there; the first one becomes the background. */
  function addLayer(imageId, name) {
    const img = images.get(imageId);
    const first = state.layers.length === 0;
    const nearest = state.layers.reduce((min, l) => Math.min(min, l.depth), 1);
    const layer = {
      id: nextId++,
      imageId,
      name,
      depth: first ? 1 : round2(Math.max(0, nearest - 0.25)),
      x: 0,
      y: 0,
      scale: first ? 1 : round2(containFactor(img)),
      rotation: 0,
      opacity: 1,
      flip: false,
      blend: 'normal',
      visible: true,
    };
    state.layers.push(layer);
    state.selectedId = layer.id;
    return layer;
  }

  async function addFiles(files) {
    const pictures = files.filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (!pictures.length) return;
    for (const file of pictures) {
      try {
        const imageId = await loadMediaFile(file);
        addLayer(imageId, file.name.replace(/\.[^.]+$/, ''));
      } catch (error) {
        toast(`無法讀取「${file.name}」:${error.message}`, true);
      }
    }
    refresh();
    commit();
  }

  // ---------------------------------------------------------------- export

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('圖片編碼失敗'))), type, quality);
    });
  }

  async function blobBytes(blob) {
    return new Uint8Array(await blob.arrayBuffer());
  }

  function isOpaque(ctx, W, H) {
    const data = ctx.getImageData(0, 0, W, H).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return false;
    }
    return true;
  }

  /** Builds the pack as zip bytes: manifest.json, one full-canvas image per layer, thumb.jpg. */
  async function buildPackZip() {
    const W = state.canvasW;
    const H = state.canvasH;
    const order = drawOrder();
    if (!order.length) throw new Error('沒有可匯出的圖層');

    const files = [];
    const layers = [];
    const work = document.createElement('canvas');
    work.width = W;
    work.height = H;
    const ctx = work.getContext('2d', { willReadFrequently: true });

    for (let i = 0; i < order.length; i++) {
      const layer = order[i];
      const entry = images.get(layer.imageId);
      if (entry && entry.kind === 'video') {
        // A video cannot be redrawn into a new file here, so the original goes in untouched and
        // the app places it using these numbers (same meaning as the editor's own).
        const name = `layer${i}.${entry.ext}`;
        files.push({ name, data: await blobBytes(entry.blob) });
        const spec = {
          type: 'video',
          src: name,
          depth: round2(layer.depth),
          x: round(layer.x, 4),
          y: round(layer.y, 4),
          scale: round(layer.scale, 4),
          rotation: round(layer.rotation, 2),
          opacity: round2(layer.opacity),
          loop: true,
        };
        if (layer.blend && layer.blend !== 'normal') spec.blend = layer.blend;
        layers.push(spec);
        continue;
      }
      bakeInto(ctx, layer, W, H);
      // Photos that fill the canvas go out as JPEG; anything with transparency must stay PNG.
      const opaque = isOpaque(ctx, W, H);
      const name = `layer${i}.${opaque ? 'jpg' : 'png'}`;
      const blob = await canvasBlob(work, opaque ? 'image/jpeg' : 'image/png', 0.92);
      files.push({ name, data: await blobBytes(blob) });
      layers.push({ type: 'image', src: name, depth: round2(layer.depth) });
    }

    const effect = window.WallEffects[state.effect];
    if (effect && effect.source) {
      files.push({ name: 'effect.frag', data: new TextEncoder().encode(effect.source) });
      layers.push({ type: 'shader', src: 'effect.frag', depth: 0, blend: effect.blend });
    }

    const thumb = document.createElement('canvas');
    thumb.width = 360;
    thumb.height = Math.round(360 * H / W);
    const tctx = thumb.getContext('2d');
    tctx.fillStyle = '#0a0a0f';
    tctx.fillRect(0, 0, thumb.width, thumb.height);
    for (const layer of order) {
      const zoom = parallaxOf(layer.depth).zoom;
      tctx.save();
      tctx.globalCompositeOperation = compositeOf(layer);
      tctx.translate(thumb.width / 2, thumb.height / 2);
      tctx.scale(zoom, zoom);
      tctx.drawImage(bakedCanvas(layer), -thumb.width / 2, -thumb.height / 2, thumb.width, thumb.height);
      tctx.restore();
    }
    files.push({ name: 'thumb.jpg', data: await blobBytes(await canvasBlob(thumb, 'image/jpeg', 0.85)) });

    const manifest = {
      format: 1,
      name: state.name.trim() || '空間桌布',
      // The shape everything was laid out on; the app needs it to place video layers.
      canvas: { width: W, height: H },
      parallax: { strength: round(state.strength, 3), focus: round2(state.focus) },
      layers,
    };
    files.unshift({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
    return window.WallZip.makeZip(files);
  }

  function download(bytes, filename, type) {
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function fileBase() {
    return (state.name.trim() || '空間桌布').replace(/[\\/:*?"<>|]/g, '_');
  }

  async function exportPack() {
    const button = $('exportBtn');
    button.disabled = true;
    try {
      const bytes = await buildPackZip();
      download(bytes, `${fileBase()}.zip`, 'application/zip');
      toast('已匯出。把這個 .zip 傳到手機,在 App 裡選「匯入 → Shader / 插件包 → 插件包(.zip)」。');
    } catch (error) {
      toast(`匯出失敗:${error.message}`, true);
    } finally {
      syncToolbar();
    }
  }

  // ---------------------------------------------------------------- project files

  /** The project file is self-contained: pictures and videos are embedded as data URLs. */
  async function saveProject() {
    try {
      const used = new Set(state.layers.map((l) => l.imageId));
      const media = {};
      for (const [id, entry] of images) {
        if (!used.has(id)) continue;
        media[id] = entry.kind === 'video'
          ? { kind: 'video', ext: entry.ext, src: await readAsDataUrl(entry.blob) }
          : { kind: 'image', src: entry.src };
      }
      const project = { app: 'wall-spatial-editor', version: 2, state: JSON.parse(snapshot()), images: media };
      download(new TextEncoder().encode(JSON.stringify(project)), `${fileBase()}.wallproj.json`, 'application/json');
      dirty = false;
      toast('專案已儲存,之後可用「開啟專案」繼續編輯。');
    } catch (error) {
      toast(`儲存失敗:${error.message}`, true);
    }
  }

  async function openProject(file) {
    try {
      const project = JSON.parse(await file.text());
      if (project.app !== 'wall-spatial-editor' || !project.state || !project.images) {
        throw new Error('不是這個編輯器的專案檔');
      }
      // Image and layer ids are renumbered so they cannot clash with ones already in memory.
      const idMap = {};
      for (const [oldId, item] of Object.entries(project.images)) {
        // Version 1 files stored just the picture's data URL.
        const media = typeof item === 'string' ? { kind: 'image', src: item } : item;
        if (media.kind === 'video') {
          const blob = await (await fetch(media.src)).blob();
          idMap[oldId] = await registerVideo(blob, `video.${media.ext || 'mp4'}`);
        } else {
          idMap[oldId] = await registerImage(media.src);
        }
      }
      const data = project.state;
      data.layers = (data.layers || []).filter((l) => idMap[l.imageId]).map((l) => ({
        ...l,
        id: nextId++,
        imageId: idMap[l.imageId],
      }));
      data.selectedId = null;
      history = [];
      historyIndex = -1;
      restore(JSON.stringify(data));
      commit();
      dirty = false;
      toast(`已開啟「${state.name}」`);
    } catch (error) {
      toast(`無法開啟專案:${error.message}`, true);
    }
  }

  // ---------------------------------------------------------------- misc UI

  let toastTimer = 0;
  function toast(message, isError) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, isError ? 7000 : 5000);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }
  function round(value, digits) {
    const f = 10 ** digits;
    return Math.round(value * f) / f;
  }
  function round2(value) {
    return round(value, 2);
  }

  function isTyping(target) {
    return target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
  }

  window.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === 'z') {
      if (isTyping(event.target) && event.target.type === 'text') return;
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      redo();
      return;
    }
    if (isTyping(event.target)) return;
    const layer = selected();
    if (!layer) return;
    const step = event.shiftKey ? 0.02 : 0.004;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      event.preventDefault();
      layer.x = clamp(layer.x + moves[event.key][0], -1, 1);
      layer.y = clamp(layer.y + moves[event.key][1], -1, 1);
      layerChanged(layer);
      commit();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      deleteSelected();
    } else if (event.key === '[' || event.key === ']') {
      layer.depth = clamp(round2(layer.depth + (event.key === ']' ? 0.05 : -0.05)), 0, 1);
      layerChanged(layer);
      renderLayerList();
      commit();
    }
  });

  let dragDepth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer || !Array.from(event.dataTransfer.types).includes('Files')) return;
    dragDepth++;
    $('dropOverlay').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropOverlay').hidden = true;
  });
  window.addEventListener('dragover', (event) => event.preventDefault());
  window.addEventListener('drop', async (event) => {
    event.preventDefault();
    dragDepth = 0;
    $('dropOverlay').hidden = true;
    if (event.dataTransfer) await addFiles(Array.from(event.dataTransfer.files));
  });

  window.addEventListener('beforeunload', (event) => {
    if (dirty && state.layers.length) event.preventDefault();
  });

  new ResizeObserver(() => {
    layoutPhone();
    applyView();
  }).observe(document.querySelector('.workspace'));

  // ---------------------------------------------------------------- start

  buildToolbar();
  buildProperties();
  refresh();
  commit();
  dirty = false;

  // For scripted use (tests, automation): add layers and build the pack bytes.
  window.spatialEditor = {
    state,
    async addImage(src, name) {
      const layer = addLayer(await registerImage(src), name || '圖層');
      refresh();
      commit();
      return layer;
    },
    async addVideo(blob, fileName) {
      const layer = addLayer(await registerVideo(blob, fileName), (fileName || '影片').replace(/\.[^.]+$/, ''));
      refresh();
      commit();
      return layer;
    },
    refresh,
    buildPackZip,
  };
})();
