// Spatial wallpaper editor.
//
// Layers are images placed on a phone-shaped canvas, each at a depth between 0 (nearest) and
// 1 (farthest). The phone preview reproduces the app's parallax exactly (see `parallaxOf`), and
// export bakes every layer into a full-canvas image, because that is all the app's pack format
// knows: full-screen layers plus a depth.
(function () {
  'use strict';

  const t = window.WallI18n.t;

  const $ = (id) => document.getElementById(id);

  const PRESETS = [
    ['1080 × 2400', 1080, 2400],
    ['1080 × 2340', 1080, 2340],
    ['1440 × 3200', 1440, 3200],
    ['1440 × 3120', 1440, 3120],
    ['1080 × 1920', 1080, 1920],
    [t`自訂`, 0, 0],
  ];
  /** Height in pixels of the working copies used for the previews. */
  const PREVIEW_H = 1000;
  /** Distance in the 3D view between depth 0 and depth 1, and the height of a layer plane. */
  const SPREAD = 520;
  const PLANE_H = 420;
  const HISTORY_LIMIT = 100;

  const state = {
    name: t`我的空間桌布`,
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
  const view = { rx: -14, ry: -40, zoom: 1, panX: 0, panY: 0 };
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

  /**
   * A shader layer's source ({ type: 'shader', glsl, blend, scale }), or null for any other
   * layer. A shader layer is code the phone runs for every pixel: it covers the whole screen,
   * takes no placement, can move by itself, and gets no automatic parallax (it reads the tilt
   * itself). The picture registered for it is only a still, for the layer list.
   */
  function shaderOf(layer) {
    const entry = images.get(layer.imageId);
    return entry && entry.source && entry.source.type === 'shader' ? entry.source : null;
  }

  function animatedShader(layer) {
    const shader = shaderOf(layer);
    return !!shader && window.WallShader.animated(shader.glsl);
  }

  /** One frame of a shader layer at the given size; the caller draws it straight away. */
  function shaderFrame(shader, W, H, time, tiltX, tiltY) {
    const scale = clamp(Number(shader.scale) || 1, 0.25, 1);
    const w = Math.max(2, Math.round(W * scale));
    const h = Math.max(2, Math.round(H * scale));
    return window.WallShader.frame(shader.glsl, w, h, time, tiltX, tiltY, shader.blend === 'add');
  }

  /** Zoom and slide the app gives a layer when the phone tilts: none for a shader layer. */
  function parallaxFor(layer) {
    return shaderOf(layer) ? { zoom: 1, shift: 0 } : parallaxOf(layer.depth);
  }

  /** Draws a layer where it sits on a W x H wallpaper canvas (no parallax). */
  function bakeInto(ctx, layer, W, H) {
    const entry = images.get(layer.imageId);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!entry) return;
    if (entry.source && entry.source.type === 'shader') {
      // Drawn live, as it looks now. If the graphics context is gone the layer stays empty.
      try {
        ctx.drawImage(shaderFrame(entry.source, W, H, performance.now() / 1000, tilt.x, tilt.y), 0, 0, W, H);
      } catch (error) {
        // Nothing to draw.
      }
      return;
    }
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
    // Only the part inside the crop is drawn, where it already was: cropping never moves the picture.
    const c = cropOf(layer);
    const sx = entry.w * c.l;
    const sy = entry.h * c.t;
    const sw = entry.w * (1 - c.l - c.r);
    const sh = entry.h * (1 - c.t - c.b);
    ctx.drawImage(entry.el, sx, sy, sw, sh, sx - entry.w / 2, sy - entry.h / 2, sw, sh);
    ctx.restore();
  }

  /**
   * How much of a layer's picture is trimmed from each side, as fractions of its width and
   * height (l, r, t, b in the picture's own orientation). Videos are never cropped: the app
   * plays the original file.
   */
  function cropOf(layer) {
    const c = (!isVideo(layer) && layer.crop) || {};
    return { l: c.l || 0, r: c.r || 0, t: c.t || 0, b: c.b || 0 };
  }

  /** Sets one side of the crop, leaving at least a twentieth of the picture. */
  function setCrop(layer, side, value) {
    const c = cropOf(layer);
    const opposite = { l: 'r', r: 'l', t: 'b', b: 't' }[side];
    c[side] = clamp(value, 0, 0.95 - c[opposite]);
    layer.crop = c;
  }

  /** How a layer is combined with what is behind it. Only video and shader layers can be non-normal. */
  function compositeOf(layer) {
    const shader = shaderOf(layer);
    if (shader) return shader.blend === 'add' ? 'lighter' : 'source-over';
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
      const p = parallaxFor(layer);
      ctx.save();
      ctx.globalCompositeOperation = compositeOf(layer);
      ctx.translate(W / 2 + tilt.x * p.shift * W, H / 2 + tilt.y * p.shift * H);
      ctx.scale(p.zoom, p.zoom);
      ctx.drawImage(bakedCanvas(layer), -W / 2, -H / 2, W, H);
      ctx.restore();
    }
    drawGuide(ctx, W, H);
    const layer = selected();
    if (layer && layer.visible && !tiltMode) drawSelection(ctx, layer, W, H);
  }

  /** 'none' | 'home' | 'lock': which phone screen's furniture to sketch over the preview. */
  let guide = 'none';

  /**
   * Sketches where a phone puts its own things (status bar, clock, icons), so the subject can be
   * kept clear of them. Not part of the wallpaper: it is never exported.
   */
  function drawGuide(ctx, W, H) {
    if (guide === 'none') return;
    const box = (x, y, w, h, r) => {
      ctx.beginPath();
      ctx.roundRect(x * W, y * H, w * W, h * H, r * W);
      ctx.fill();
    };
    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.34)';
    // Status bar: time on the left, signal and battery on the right.
    box(0.07, 0.022, 0.11, 0.012, 0.01);
    box(0.80, 0.022, 0.05, 0.012, 0.01);
    box(0.87, 0.022, 0.06, 0.012, 0.01);
    if (guide === 'home') {
      box(0.07, 0.135, 0.38, 0.022, 0.012); // date widget
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 4; col++) {
          const cx = 0.155 + col * 0.23;
          const cy = 0.675 + row * 0.115;
          ctx.beginPath();
          ctx.arc(cx * W, cy * H, 0.072 * W, 0, Math.PI * 2);
          ctx.fill();
          if (row === 0) box(cx - 0.06, cy + 0.04, 0.12, 0.011, 0.008); // label
        }
      }
      box(0.085, 0.892, 0.83, 0.056, 0.06); // search bar
    } else {
      box(0.27, 0.115, 0.46, 0.085, 0.03); // clock
      box(0.33, 0.215, 0.34, 0.018, 0.012); // date
      ctx.beginPath();
      ctx.arc(0.13 * W, 0.93 * H, 0.062 * W, 0, Math.PI * 2);
      ctx.arc(0.87 * W, 0.93 * H, 0.062 * W, 0, Math.PI * 2);
      ctx.fill();
    }
    box(0.37, 0.981, 0.26, 0.005, 0.005); // gesture bar
    ctx.restore();
  }

  /** Where the crop handles of the selected layer are on the preview canvas: [{ side, x, y }]. */
  let cropHandles = [];

  /**
   * Outline of the selected layer's picture as shown (parallax zoom included, no tilt), with a
   * handle in the middle of each edge for cropping.
   */
  function drawSelection(ctx, layer, W, H) {
    cropHandles = [];
    const entry = images.get(layer.imageId);
    if (!entry) return;
    const s = coverScale(entry, W, H) * layer.scale;
    const w = entry.w * s;
    const h = entry.h * s;
    const angle = layer.rotation * Math.PI / 180;
    const zoom = parallaxFor(layer).zoom;
    const mirrored = layer.flip && entry.kind === 'image';
    const c = cropOf(layer);
    // The visible rectangle in the picture's own axes; mirroring swaps which side is which.
    const x0 = -w / 2 + w * (mirrored ? c.r : c.l);
    const x1 = w / 2 - w * (mirrored ? c.l : c.r);
    const y0 = -h / 2 + h * c.t;
    const y1 = h / 2 - h * c.b;
    const place = ([px, py]) => {
      const x = layer.x * W + px * Math.cos(angle) - py * Math.sin(angle);
      const y = layer.y * H + px * Math.sin(angle) + py * Math.cos(angle);
      return [W / 2 + x * zoom, H / 2 + y * zoom];
    };
    const corners = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(place);
    ctx.save();
    ctx.beginPath();
    corners.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.lineWidth = 2;
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = '#8b7cff';
    ctx.stroke();
    ctx.setLineDash([]);
    if (entry.kind === 'image' && !layer.locked) {
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const sides = [
        [mirrored ? 'r' : 'l', [x0, my]],
        [mirrored ? 'l' : 'r', [x1, my]],
        ['t', [mx, y0]],
        ['b', [mx, y1]],
      ];
      for (const [side, point] of sides) {
        const [x, y] = place(point);
        cropHandles.push({ side, x, y });
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#8b7cff';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.rect(x - 8, y - 8, 16, 16);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * A point of the preview (0..1 across it) in the selected picture's own coordinates: u and v
   * run 0..1 across the whole, uncropped picture, as it is shown (mirroring included).
   */
  function pictureUV(layer, nx, ny) {
    const entry = images.get(layer.imageId);
    const { W, H } = previewSize();
    const zoom = parallaxFor(layer).zoom;
    const x = ((nx - 0.5) * W) / zoom - layer.x * W;
    const y = ((ny - 0.5) * H) / zoom - layer.y * H;
    const angle = -layer.rotation * Math.PI / 180;
    const s = coverScale(entry, W, H) * layer.scale;
    return {
      u: (x * Math.cos(angle) - y * Math.sin(angle)) / (entry.w * s) + 0.5,
      v: (x * Math.sin(angle) + y * Math.cos(angle)) / (entry.h * s) + 0.5,
    };
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
      if (layer.locked) continue;
      const zoom = parallaxFor(layer).zoom;
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
    // A crop handle of the selected layer takes the press before anything under it.
    const current = selected();
    if (current && current.visible) {
      const { W, H } = previewSize();
      const reach = 16 * (W / p.rect.width);
      const handle = cropHandles.find((hd) => Math.hypot(hd.x - p.x * W, hd.y - p.y * H) <= reach);
      if (handle) {
        phone.setPointerCapture(event.pointerId);
        moveDrag = { crop: handle.side, layer: current };
        return;
      }
    }
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
      zoom: parallaxFor(layer).zoom,
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
    if (d.crop) {
      const p = phonePoint(event);
      let { u, v } = pictureUV(d.layer, p.x, p.y);
      // The picture's own left is on the right while it is mirrored.
      if (d.layer.flip) u = 1 - u;
      const value = { l: u, r: 1 - u, t: v, b: 1 - v }[d.crop];
      setCrop(d.layer, d.crop, value);
      layerChanged(d.layer);
      return;
    }
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
    if (tiltMode || !layer || layer.locked) return;
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
      if (layer.visible && (isVideo(layer) || animatedShader(layer))) {
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
    world.style.transform = `translate(${view.panX}px, ${view.panY}px) scale(${worldScale()}) rotateX(${view.rx}deg) rotateY(${view.ry}deg)`;
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
    eye.textContent = t`你從這一側看`;
    placeBox(eye, w * 0.5, h * 0.16, SPREAD / 2 + 170);
    world.appendChild(eye);

    const focus = document.createElement('div');
    focus.className = 'focus-plane';
    focus.id = 'focusPlane';
    focus.appendChild(document.createElement('span')).textContent = t`對焦面(傾斜時不動)`;
    world.appendChild(focus);

    // A floor grid under the stack, for a sense of where things stand.
    const ground = document.createElement('div');
    ground.className = 'ground';
    ground.style.transform = `translate(-700px, -700px) translateY(${h / 2 + 2}px) rotateX(90deg)`;
    world.appendChild(ground);

    for (const layer of state.layers) {
      const plane = document.createElement('div');
      plane.className = 'plane';
      plane.dataset.id = layer.id;
      plane.appendChild(bakedCanvas(layer));
      plane.appendChild(document.createElement('div')).className = 'plane-label';
      world.appendChild(plane);
      planes.set(layer.id, plane);
    }
    // Move handles for the selected layer: one arrow per axis. Each arrow is two crossed strips,
    // so it does not vanish when seen edge-on.
    const gizmo = document.createElement('div');
    gizmo.className = 'gizmo';
    gizmo.id = 'gizmo';
    for (const axis of ['x', 'y', 'z']) {
      for (const twist of ['', ' twist']) {
        const strip = document.createElement('div');
        strip.className = `gizmo-axis axis-${axis}${twist}`;
        strip.dataset.axis = axis;
        gizmo.appendChild(strip);
      }
    }
    world.appendChild(gizmo);
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
      plane.querySelector('.plane-label').textContent = t`${layer.name}・深度 ${layer.depth.toFixed(2)}`;
    }
    const gizmo = $('gizmo');
    const layer = selected();
    if (gizmo) {
      gizmo.hidden = !layer || !layer.visible || !!layer.locked;
      // At the centre of the layer's picture, just in front of its plane.
      if (!gizmo.hidden) gizmo.style.transform = `translate3d(${layer.x * w}px, ${layer.y * h}px, ${depthToZ(layer.depth) + 2}px)`;
    }
  }

  function setView(rx, ry) {
    view.rx = rx;
    view.ry = ry;
    applyView();
  }

  /** Centres the view again without changing the angle. */
  function frameView() {
    view.panX = 0;
    view.panY = 0;
    view.zoom = 1;
    applyView();
  }

  let spaceDrag = null;

  space.addEventListener('contextmenu', (event) => event.preventDefault());

  space.addEventListener('pointerdown', (event) => {
    // The welcome card sits inside this view; capturing the pointer would swallow its buttons' clicks.
    if (event.target.closest('.welcome')) return;
    const plane = event.target.closest('.plane');
    const axis = event.target.closest('.gizmo-axis');
    // Middle button, right button or Shift + drag slides the view, as in 3D programs.
    const panning = event.button === 1 || event.button === 2 || event.shiftKey;
    if (event.button === 1) event.preventDefault(); // no auto-scroll cursor
    space.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, moved: false };
    if (panning) {
      spaceDrag = { ...start, kind: 'pan', panX: view.panX, panY: view.panY };
      space.classList.add('orbiting');
    } else if (axis && selected()) {
      const layer = selected();
      spaceDrag = { ...start, kind: 'axis', axis: axis.dataset.axis, layer, startX: layer.x, startY: layer.y, startDepth: layer.depth };
    } else if (plane) {
      const layer = state.layers.find((l) => String(l.id) === plane.dataset.id);
      if (!layer) return;
      select(layer.id);
      spaceDrag = { ...start, kind: 'axis', axis: 'z', layer, startX: layer.x, startY: layer.y, startDepth: layer.depth };
    } else {
      spaceDrag = { ...start, kind: 'orbit', rx: view.rx, ry: view.ry };
      space.classList.add('orbiting');
    }
  });

  space.addEventListener('pointermove', (event) => {
    if (!spaceDrag) return;
    const dx = event.clientX - spaceDrag.x;
    const dy = event.clientY - spaceDrag.y;
    if (spaceDrag.kind === 'orbit') {
      view.ry = spaceDrag.ry + dx * 0.4;
      view.rx = clamp(spaceDrag.rx - dy * 0.3, -89, 89);
      applyView();
      return;
    }
    if (spaceDrag.kind === 'pan') {
      view.panX = spaceDrag.panX + dx;
      view.panY = spaceDrag.panY + dy;
      applyView();
      return;
    }
    if (spaceDrag.layer.locked) return;
    // Move the layer along one axis: project the pointer movement onto the direction in which
    // that axis runs on screen for the current view angle.
    const rx = view.rx * Math.PI / 180;
    const ry = view.ry * Math.PI / 180;
    const [ax, ay] = {
      x: [Math.cos(ry), Math.sin(ry) * Math.sin(rx)],
      y: [0, Math.cos(rx)],
      z: [Math.sin(ry), -Math.cos(ry) * Math.sin(rx)],
    }[spaceDrag.axis];
    const len2 = ax * ax + ay * ay;
    if (len2 < 0.02) return; // looking straight down the axis: it cannot be dragged
    const d = (dx * ax + dy * ay) / len2 / worldScale();
    const { w, h } = planeSize();
    const layer = spaceDrag.layer;
    if (spaceDrag.axis === 'x') layer.x = clamp(spaceDrag.startX + d / w, -1, 1);
    else if (spaceDrag.axis === 'y') layer.y = clamp(spaceDrag.startY + d / h, -1, 1);
    else layer.depth = clamp(round2(spaceDrag.startDepth - d / SPREAD), 0, 1);
    spaceDrag.moved = true;
    layerChanged(layer);
  });

  function endSpaceDrag() {
    if (!spaceDrag) return;
    const wasDepth = spaceDrag.kind === 'axis' && spaceDrag.moved;
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
    frameView();
  });
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', () => {
      const [rx, ry] = button.dataset.view.split(',').map(Number);
      setView(rx, ry);
    });
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
      const kind = entry && entry.kind === 'video' ? t`影片・` : '';
      depth.textContent = t`${kind}深度 ${layer.depth.toFixed(2)}${depthWord(layer.depth)}`;
      meta.append(title, depth);

      const eye = iconButton(
        layer.visible ? ICONS.eye : ICONS.eyeOff,
        layer.visible ? t`隱藏這個圖層(不會匯出)` : t`顯示這個圖層`,
        () => {
          layer.visible = !layer.visible;
          refresh();
          commit();
        },
      );
      const lock = iconButton(
        layer.locked ? ICONS.lock : ICONS.unlock,
        layer.locked ? t`解除鎖定` : t`鎖定:在預覽上點不到、拖不動`,
        () => {
          layer.locked = !layer.locked;
          renderLayerList();
          commit();
        },
      );
      lock.classList.toggle('active', !!layer.locked);

      // Double-click the name to rename it where it is.
      title.title = t`按兩下改名`;
      title.addEventListener('dblclick', (event) => {
        event.stopPropagation();
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'layer-rename';
        input.value = layer.name;
        input.setAttribute('aria-label', t`圖層名稱`);
        title.replaceWith(input);
        input.focus();
        input.select();
        let done = false;
        const finish = (keep) => {
          if (done) return;
          done = true;
          if (keep && input.value.trim()) layer.name = input.value.trim().slice(0, 60);
          updateSpace();
          renderLayerList();
          syncProperties();
          commit();
        };
        input.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') finish(true);
          if (e.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        input.addEventListener('click', (e) => e.stopPropagation());
      });

      item.append(thumb, meta, lock, eye);

      // Drag a layer onto another to move it in front of or behind it.
      item.draggable = true;
      item.addEventListener('dragstart', (event) => {
        event.dataTransfer.setData('text/x-layer', String(layer.id));
        event.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragover', (event) => {
        if (!Array.from(event.dataTransfer.types).includes('text/x-layer')) return;
        event.preventDefault();
        const below = event.clientY > item.getBoundingClientRect().top + item.offsetHeight / 2;
        item.classList.toggle('drop-before', !below);
        item.classList.toggle('drop-after', below);
      });
      item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
      item.addEventListener('drop', (event) => {
        const id = Number(event.dataTransfer.getData('text/x-layer'));
        const after = item.classList.contains('drop-after');
        item.classList.remove('drop-before', 'drop-after');
        if (!id || id === layer.id) return;
        event.preventDefault();
        event.stopPropagation();
        moveInStack(id, layer.id, after);
      });
      item.addEventListener('click', () => select(layer.id));
      list.appendChild(item);
    }
    $('emptyHint').hidden = state.layers.length > 0;
    $('welcome').hidden = state.layers.length > 0;
  }

  /**
   * Moves a layer to just in front of (or behind) another in the list. The stack keeps the same
   * set of depths; the layers trade them, so the spacing the scene was built with is preserved.
   */
  function moveInStack(movedId, targetId, after) {
    const order = state.layers.slice().sort((a, b) => a.depth - b.depth); // nearest first, as listed
    const depths = order.map((l) => l.depth);
    const moved = order.find((l) => l.id === movedId);
    if (!moved) return;
    const rest = order.filter((l) => l !== moved);
    const at = rest.findIndex((l) => l.id === targetId);
    if (at < 0) return;
    rest.splice(at + (after ? 1 : 0), 0, moved);
    rest.forEach((l, i) => {
      l.depth = depths[i];
    });
    state.selectedId = movedId;
    refresh();
    commit();
  }

  const ICONS = {
    eye: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5C7 5 3.2 8.3 1.5 12c1.7 3.7 5.5 7 10.5 7s8.800-3.3 10.5-7C20.800 8.300 17 5 12 5zm0 11.500A4.500 4.500 0 1 1 12 7.500a4.500 4.500 0 0 1 0 9zm0-2.300a2.200 2.200 0 1 0 0-4.400 2.200 2.200 0 0 0 0 4.400z"/></svg>',
    eyeOff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.300 2 2 3.300l3.400 3.400C3.700 8 2.300 9.900 1.500 12c1.700 3.700 5.500 7 10.500 7 1.600 0 3.100-.3 4.400-.900l3.300 3.300L21 20.100 3.300 2zM12 16.500a4.500 4.500 0 0 1-4.200-6.200l1.800 1.800a2.200 2.200 0 0 0 2.700 2.700l1.800 1.800c-.600.300-1.300.400-2.100.400zM12 5c5 0 8.800 3.300 10.500 7-.700 1.500-1.700 2.900-3 4.100l-3.100-3.100A4.500 4.500 0 0 0 11 7.600L8.600 5.500C9.700 5.200 10.800 5 12 5z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 9V7A5 5 0 0 0 7 7v2H5.500v12h13V9H17zM9 7a3 3 0 0 1 6 0v2H9V7zm3 10.500a1.800 1.800 0 1 1 0-3.600 1.800 1.800 0 0 1 0 3.600z"/></svg>',
    unlock: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 9H9V7a3 3 0 0 1 5.800-1l1.900-.700A5 5 0 0 0 7 7v2H5.500v12h13V9H17zm-5 8.500a1.800 1.800 0 1 1 0-3.600 1.800 1.800 0 0 1 0 3.600z"/></svg>',
  };

  /** A square button showing one of ICONS; `label` is its tooltip and accessible name. */
  function iconButton(icon, label, onClick) {
    const button = document.createElement('button');
    button.className = 'icon-btn';
    button.innerHTML = icon; // a constant from ICONS, never user text
    button.title = label;
    button.setAttribute('aria-label', label);
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      onClick();
    });
    return button;
  }

  function depthWord(depth) {
    if (depth <= 0.001) return t`・最近`;
    if (depth >= 0.999) return t`・最遠`;
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
    layerSlider('depth', t`深度(0 最近 → 1 最遠)`, 0, 1, 0.01);
    layerSlider('x', t`水平位置`, -1, 1, 0.005, 3);
    layerSlider('y', t`垂直位置`, -1, 1, 0.005, 3);
    layerSlider('scale', t`縮放(1 = 剛好填滿畫布)`, 0.02, 4, 0.01);
    layerSlider('rotation', t`旋轉(度)`, -180, 180, 1, 0);
    layerSlider('opacity', t`不透明度`, 0, 1, 0.01);
    for (const [side, label] of [['l', t`裁切左側`], ['r', t`裁切右側`], ['t', t`裁切上方`], ['b', t`裁切下方`]]) {
      addSlider($('cropFields'), {
        label, min: 0, max: 0.95, step: 0.005, digits: 3,
        get: () => (selected() ? cropOf(selected())[side] : undefined),
        set: (value) => {
          const layer = selected();
          if (!layer) return;
          setCrop(layer, side, value);
          layerChanged(layer);
        },
      });
    }
    $('resetCropBtn').addEventListener('click', () => {
      const layer = selected();
      if (!layer) return;
      delete layer.crop;
      layerChanged(layer);
      commit();
    });
    sceneSlider('strength', t`視差強度`, 0, 0.1, 0.005, 3);
    sceneSlider('focus', t`對焦深度(這個深度的圖層不動)`, 0, 1, 0.05);

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
      const copy = { ...layer, crop: layer.crop && { ...layer.crop }, id: nextId++, name: t`${layer.name} 複本`, x: layer.x + 0.03, y: layer.y + 0.02 };
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
      $('cropRow').hidden = video;
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
    if (tiltMode) text = t`移動滑鼠模擬傾斜手機;移開後會自動搖擺`;
    else if (selected()) text = t`拖曳移動・滾輪縮放・Shift + 滾輪旋轉・方向鍵微調`;
    else if (state.layers.length) text = t`點一下圖層來選取`;
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
      if (gap) text = t`最遠的圖層「${order[0].name}」沒有填滿畫布,空白處在手機上會是黑色。`;
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
    scheduleAutosave();
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
    $('exportImageBtn').disabled = drawOrder().length === 0;
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
        toast(t`無法讀取檔案:${error.message}`, true);
      }
    });
    $('tiltMode').addEventListener('change', (event) => setTiltMode(event.target.checked));
    $('guideMode').addEventListener('change', (event) => {
      guide = event.target.value;
      renderPhone();
    });
    $('newProjectBtn').addEventListener('click', newProject);
    // The button names the language it switches to.
    $('langBtn').textContent = window.WallI18n.lang === 'en' ? '中文' : 'EN';
    $('langBtn').addEventListener('click', () => window.WallI18n.setLang(window.WallI18n.lang === 'en' ? 'zh' : 'en'));
    $('helpBtn').addEventListener('click', () => $('helpDialog').showModal());
    $('helpClose').addEventListener('click', () => $('helpDialog').close());
    $('helpDialog').addEventListener('click', (event) => {
      if (event.target === $('helpDialog')) $('helpDialog').close();
    });
    $('welcomeAdd').addEventListener('click', () => $('imageInput').click());
    $('welcomeOpen').addEventListener('click', () => $('projectInput').click());
    $('welcomeAssistant').addEventListener('click', () => $('assistantToggle').click());
    $('welcomeSample').addEventListener('click', async () => {
      try {
        await loadSample();
      } catch (error) {
        toast(t`無法載入範例:${error.message}`, true);
      }
    });
    $('exportBtn').addEventListener('click', exportPack);
    $('exportImageBtn').addEventListener('click', exportPreview);
    $('saveProjectBtn').addEventListener('click', saveProject);
    $('openProjectBtn').addEventListener('click', () => $('projectInput').click());
    $('projectInput').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      event.target.value = '';
      if (file) await openFile(file);
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
      reader.onerror = () => reject(reader.error || new Error(t`讀取失敗`));
      reader.readAsDataURL(file);
    });
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t`不是可用的圖片`));
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
      video.addEventListener('error', () => reject(new Error(t`瀏覽器無法播放這個影片格式`)), { once: true });
      video.src = src;
    });
    if (!video.videoWidth || !video.videoHeight) throw new Error(t`影片沒有畫面`);
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
    // A project file or a wallpaper pack dropped on the window is opened, like "Open".
    const opened = files.find((f) => /\.(zip|json)$/i.test(f.name));
    if (opened) {
      if (state.layers.length && !window.confirm(t`要開啟「${opened.name}」嗎?目前的圖層會被取代。`)) return;
      await openFile(opened);
      return;
    }
    const pictures = files.filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (!pictures.length) return;
    for (const file of pictures) {
      try {
        const imageId = await loadMediaFile(file);
        addLayer(imageId, file.name.replace(/\.[^.]+$/, ''));
      } catch (error) {
        toast(t`無法讀取「${file.name}」:${error.message}`, true);
      }
    }
    refresh();
    commit();
  }

  // ---------------------------------------------------------------- export

  function canvasBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(t`圖片編碼失敗`))), type, quality);
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
    if (!order.length) throw new Error(t`沒有可匯出的圖層`);

    const files = [];
    const layers = [];
    const work = document.createElement('canvas');
    work.width = W;
    work.height = H;
    const ctx = work.getContext('2d', { willReadFrequently: true });

    for (let i = 0; i < order.length; i++) {
      const layer = order[i];
      const entry = images.get(layer.imageId);
      const shader = shaderOf(layer);
      if (shader) {
        // The phone compiles and runs the code itself; nothing is drawn into a picture here.
        const name = `layer${i}.frag`;
        files.push({ name, data: new TextEncoder().encode(shader.glsl) });
        const spec = { type: 'shader', src: name, depth: round2(layer.depth) };
        if (shader.blend === 'add') spec.blend = 'add';
        if (shader.scale < 1) spec.scale = shader.scale;
        layers.push(spec);
        continue;
      }
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
      const zoom = parallaxFor(layer).zoom;
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
      name: state.name.trim() || t`空間桌布`,
      // The shape everything was laid out on; the app needs it to place video layers.
      canvas: { width: W, height: H },
      parallax: { strength: round(state.strength, 3), focus: round2(state.focus) },
      layers,
    };
    files.unshift({ name: 'manifest.json', data: new TextEncoder().encode(JSON.stringify(manifest, null, 2)) });
    return window.WallZip.makeZip(files);
  }

  /**
   * Hands a finished file to the person. In a browser it is downloaded; in the desktop app a
   * "Save as" dialog picks where it goes. Resolves to false when the person cancelled.
   */
  async function download(bytes, filename, type) {
    if (window.WALL_DESKTOP || window.WALL_APP) {
      const response = await fetch('/api/save', {
        method: 'POST',
        headers: { 'x-wall-editor': '1', 'x-wall-filename': encodeURIComponent(filename), 'Content-Type': type },
        body: bytes,
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
      return !!result.saved;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }

  function fileBase() {
    return (state.name.trim() || t`空間桌布`).replace(/[\\/:*?"<>|]/g, '_');
  }

  async function exportPack() {
    const button = $('exportBtn');
    button.disabled = true;
    try {
      const bytes = await buildPackZip();
      if (!(await download(bytes, `${fileBase()}.zip`, 'application/zip'))) return;
      // In the phone app the pack went straight into the library and is the wallpaper now.
      if (window.WALL_APP) toast(t`已加入桌布庫並設為桌布。回到上一頁就看得到。`);
      else toast(t`已匯出。把這個 .zip 傳到手機,在 App 裡選「匯入 → Shader / 插件包 → 插件包(.zip)」。`);
    } catch (error) {
      toast(t`匯出失敗:${error.message}`, true);
    } finally {
      syncToolbar();
    }
  }

  /** Saves the wallpaper as it looks at rest, as one flat picture at canvas size. */
  async function exportPreview() {
    try {
      const W = state.canvasW;
      const H = state.canvasH;
      const flat = document.createElement('canvas');
      flat.width = W;
      flat.height = H;
      const ctx = flat.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const work = document.createElement('canvas');
      work.width = W;
      work.height = H;
      const wctx = work.getContext('2d');
      for (const layer of drawOrder()) {
        bakeInto(wctx, layer, W, H);
        const zoom = parallaxFor(layer).zoom;
        ctx.save();
        ctx.globalCompositeOperation = compositeOf(layer);
        ctx.translate(W / 2, H / 2);
        ctx.scale(zoom, zoom);
        ctx.drawImage(work, -W / 2, -H / 2);
        ctx.restore();
      }
      await download(await blobBytes(await canvasBlob(flat, 'image/png')), `${fileBase()}.png`, 'image/png');
    } catch (error) {
      toast(t`匯出失敗:${error.message}`, true);
    }
  }

  // ---------------------------------------------------------------- project files

  /** The whole project as one object: the state plus every picture and video it uses, embedded. */
  async function projectData() {
    const used = new Set(state.layers.map((l) => l.imageId));
    const media = {};
    for (const [id, entry] of images) {
      if (!used.has(id)) continue;
      media[id] = entry.kind === 'video'
        ? { kind: 'video', ext: entry.ext, src: await readAsDataUrl(entry.blob) }
        : { kind: 'image', src: entry.src, source: entry.source };
    }
    return { app: 'wall-spatial-editor', version: 2, state: JSON.parse(snapshot()), images: media };
  }

  /** The project file is self-contained: pictures and videos are embedded as data URLs. */
  async function saveProject() {
    try {
      const project = await projectData();
      if (!(await download(new TextEncoder().encode(JSON.stringify(project)), `${fileBase()}.wallproj.json`, 'application/json'))) return;
      dirty = false;
      toast(t`專案已儲存,之後可用「開啟專案」繼續編輯。`);
    } catch (error) {
      toast(t`儲存失敗:${error.message}`, true);
    }
  }

  async function openProject(file) {
    try {
      await loadProject(JSON.parse(await file.text()));
      dirty = false;
      toast(t`已開啟「${state.name}」`);
    } catch (error) {
      toast(t`無法開啟專案:${error.message}`, true);
    }
  }

  /** Replaces everything with the given project (as made by projectData). */
  async function loadProject(project) {
    if (!project || project.app !== 'wall-spatial-editor' || !project.state || !project.images) {
      throw new Error(t`不是這個編輯器的專案檔`);
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
        // Artwork drawn by the assistant keeps its source, so it can still be revised.
        if (media.source) images.get(idMap[oldId]).source = media.source;
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
  }

  const IMAGE_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', avif: 'image/avif' };

  /**
   * Opens a wallpaper pack (.zip, as exported here or by the phone app) for editing: each image
   * or video layer of its manifest becomes a layer at the same depth. Replaces the current scene.
   * Returns notes about anything in the pack the editor has no way to show.
   */
  async function loadPack(bytes) {
    let files = await window.WallZip.readZip(bytes);
    // Accept archives made by zipping the pack's folder rather than its contents.
    if (!files.some((f) => f.name === 'manifest.json')) {
      const nested = files.find((f) => /^[^/]+\/manifest\.json$/.test(f.name));
      if (!nested) throw new Error(t`壓縮檔裡找不到 manifest.json,這不是桌布包`);
      const prefix = nested.name.slice(0, nested.name.indexOf('/') + 1);
      files = files.filter((f) => f.name.startsWith(prefix)).map((f) => ({ name: f.name.slice(prefix.length), data: f.data }));
    }
    const byName = new Map(files.map((f) => [f.name, f.data]));
    const manifest = JSON.parse(new TextDecoder().decode(byName.get('manifest.json')));
    const specs = Array.isArray(manifest.layers) ? manifest.layers : [];
    const notes = [];
    const layers = [];
    let effect = 'none';
    let firstPicture = null;

    for (const spec of specs) {
      const data = byName.get(String(spec.src || ''));
      const depth = round2(clamp(Number(spec.depth === undefined ? 1 : spec.depth), 0, 1));
      const ext = String(spec.src || '').split('.').pop().toLowerCase();
      const base = { depth, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, flip: false, blend: 'normal', visible: true };
      if (spec.type === 'shader') {
        // The editor's own moving effects are recognised by their source. Any other shader
        // becomes a shader layer, unless it needs textures or does not compile here.
        const source = data ? new TextDecoder().decode(data).trim() : '';
        const known = Object.entries(window.WallEffects).find(([, e]) => e.source && e.source.trim() === source);
        if (known) {
          effect = known[0];
          continue;
        }
        try {
          if (Array.isArray(spec.channels) && spec.channels.some(Boolean)) throw new Error('channels');
          const shader = shaderSource({ glsl: source, blend: spec.blend === 'add' ? 'add' : 'normal', render_scale: spec.scale });
          layers.push({ ...base, imageId: await registerDrawing(shaderStill(shader), shader), name: t`動態 ${layers.length + 1}` });
        } catch (error) {
          notes.push(t`略過 shader 圖層「${spec.src}」(編輯器無法顯示這個 shader)`);
        }
        continue;
      }
      if (!data) {
        notes.push(t`找不到圖層檔案「${spec.src}」`);
        continue;
      }
      if (spec.type === 'video') {
        const imageId = await registerVideo(new Blob([data], { type: `video/${ext === 'mov' ? 'quicktime' : ext}` }), `video.${ext}`);
        layers.push({
          ...base,
          imageId,
          name: t`影片 ${layers.length + 1}`,
          x: Number(spec.x) || 0,
          y: Number(spec.y) || 0,
          scale: Number(spec.scale) || 1,
          rotation: Number(spec.rotation) || 0,
          opacity: spec.opacity === undefined ? 1 : Number(spec.opacity),
          blend: spec.blend === 'add' || spec.blend === 'screen' ? spec.blend : 'normal',
        });
      } else if (spec.type === 'image') {
        const src = await readAsDataUrl(new Blob([data], { type: IMAGE_TYPES[ext] || 'image/png' }));
        const imageId = await registerImage(src);
        if (!firstPicture) firstPicture = images.get(imageId);
        layers.push({ ...base, imageId, name: t`圖層 ${layers.length + 1}` });
        if (spec.depthMap) notes.push(t`圖層「${spec.src}」的景深圖沒有帶進來(編輯器不支援)`);
        if (spec.sprites) notes.push(t`圖層「${spec.src}」的動畫貼片沒有帶進來(編輯器不支援)`);
      } else {
        notes.push(t`略過不認得的圖層類型「${spec.type}」`);
      }
    }
    if (!layers.length) throw new Error(t`這個桌布包沒有可以編輯的圖片或影片圖層`);

    // Layers are named far to near; the canvas is the pack's own, or the first picture's size.
    const canvas = manifest.canvas || {};
    const width = Math.round(Number(canvas.width) || (firstPicture ? firstPicture.w : state.canvasW));
    const height = Math.round(Number(canvas.height) || (firstPicture ? firstPicture.h : state.canvasH));
    const parallax = manifest.parallax || {};
    Object.assign(state, {
      name: String(manifest.name || t`我的空間桌布`).slice(0, 80),
      canvasW: clamp(width, 240, 4320),
      canvasH: clamp(height, 240, 7680),
      strength: clamp(parallax.strength === undefined ? 0.04 : Number(parallax.strength), 0, 0.1),
      focus: clamp(parallax.focus === undefined ? 1 : Number(parallax.focus), 0, 1),
      effect,
      layers: layers.map((l) => ({ ...l, id: nextId++ })),
      selectedId: null,
    });
    baked.clear();
    history = [];
    historyIndex = -1;
    refresh();
    commit();
    return notes;
  }

  /** Opens whatever the person picked: a project file or a wallpaper pack. */
  async function openFile(file) {
    const isZip = /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
    if (!isZip) return openProject(file);
    try {
      const notes = await loadPack(new Uint8Array(await file.arrayBuffer()));
      toast(notes.length ? `${t`已開啟桌布包「${state.name}」`}\n${notes.join('\n')}` : t`已開啟桌布包「${state.name}」`, false, notes.length > 0);
    } catch (error) {
      toast(t`無法開啟桌布包:${error.message}`, true);
    }
  }

  function newProject() {
    if (state.layers.length && !window.confirm(t`要開始新專案嗎?目前的圖層會被清除(可先用「儲存專案」留存)。`)) return;
    Object.assign(state, { name: t`我的空間桌布`, strength: 0.04, focus: 1, effect: 'none', layers: [], selectedId: null });
    baked.clear();
    history = [];
    historyIndex = -1;
    refresh();
    commit();
    dirty = false;
  }

  // ---------------------------------------------------------------- autosave
  //
  // The project is kept in the browser's own storage (IndexedDB) a moment after every change and
  // brought back when the editor is opened again, so a closed tab or a crash loses nothing.

  const AUTOSAVE_DELAY = 1500;
  let autosaveTimer = 0;
  /** False once saving has failed (storage full or unavailable): leaving the page then warns. */
  let autosaveWorks = true;

  function autosaveStore(mode) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open('spatialEditor', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('projects');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('projects', mode);
        tx.oncomplete = () => db.close();
        resolve(tx.objectStore('projects'));
      };
    });
  }

  function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(async () => {
      try {
        const project = await projectData();
        const store = await autosaveStore('readwrite');
        await new Promise((resolve, reject) => {
          const put = store.put(project, 'autosave');
          put.onsuccess = resolve;
          put.onerror = () => reject(put.error);
        });
        autosaveWorks = true;
        dirty = false;
        $('saveState').textContent = t`已自動儲存`;
      } catch (error) {
        autosaveWorks = false;
        $('saveState').textContent = t`無法自動儲存,請用「儲存專案」`;
      }
    }, AUTOSAVE_DELAY);
    $('saveState').textContent = '';
  }

  async function restoreAutosave() {
    try {
      const store = await autosaveStore('readonly');
      const project = await new Promise((resolve, reject) => {
        const get = store.get('autosave');
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      if (!project || !project.state || !(project.state.layers || []).length) return;
      await loadProject(project);
      dirty = false;
      toast(t`已還原上次的工作「${state.name}」。`);
    } catch (error) {
      // Nothing saved, or storage is unavailable: start empty.
    }
  }

  // ---------------------------------------------------------------- sample scene

  /** A small finished scene, so a first-time visitor has something to tilt and take apart. */
  async function loadSample() {
    const W = state.canvasW;
    const H = state.canvasH;
    const svg = (body) => `<svg xmlns="${SVG_NS}" viewBox="0 0 ${W} ${H}">${body}</svg>`;
    /** A ridge line from left to right: a closed shape from `top` (fraction of H) down to the bottom. */
    const ridge = (top, rough, seed, fill) => {
      let d = `M${-0.06 * W} ${H * 1.05}`;
      for (let i = 0; i <= 24; i++) {
        const x = -0.06 * W + (1.12 * W * i) / 24;
        const y = H * (top + rough * (Math.sin(i * 0.9 + seed) * 0.6 + Math.sin(i * 2.3 + seed * 2) * 0.4));
        d += ` L${x.toFixed(1)} ${y.toFixed(1)}`;
      }
      return `<path d="${d} L${1.06 * W} ${H * 1.05} Z" fill="${fill}"/>`;
    };
    const pine = (x, base, size, fill) => {
      const w = size * 0.42;
      let d = '';
      for (let k = 0; k < 4; k++) {
        const y = base - size * (0.2 + k * 0.2);
        const half = w * (1 - k * 0.2);
        d += `M${x - half} ${y} L${x} ${y - size * 0.34} L${x + half} ${y} Z `;
      }
      return `<path d="${d}" fill="${fill}"/><rect x="${x - size * 0.035}" y="${base - size * 0.22}" width="${size * 0.07}" height="${size * 0.24}" fill="${fill}"/>`;
    };
    let trees = '';
    for (let i = 0; i < 9; i++) trees += pine(W * (-0.02 + i * 0.13 + (i % 3) * 0.02), H * (0.83 + (i % 2) * 0.03), H * (0.2 + (i % 4) * 0.035), '#0e1424');
    const stars = Array.from({ length: 70 }, (_, i) => {
      const x = (i * 197.3) % W;
      const y = ((i * 331.7) % (H * 0.42));
      return `<circle cx="${x.toFixed(0)}" cy="${y.toFixed(0)}" r="${1.5 + (i % 3)}" fill="#fff" opacity="${0.35 + (i % 5) * 0.12}"/>`;
    }).join('');

    state.name = t`範例・黃昏山谷`;
    const layers = [
      [t`天空`, 1, `<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#141a3c"/><stop offset="0.45" stop-color="#5a3a78"/><stop offset="0.7" stop-color="#e0785a"/><stop offset="1" stop-color="#f6c070"/></linearGradient><radialGradient id="sun"><stop offset="0" stop-color="#fff3c8"/><stop offset="0.35" stop-color="#ffd27a" stop-opacity="0.9"/><stop offset="1" stop-color="#ffb060" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#sky)"/>${stars}<circle cx="${W * 0.62}" cy="${H * 0.6}" r="${W * 0.42}" fill="url(#sun)"/><circle cx="${W * 0.62}" cy="${H * 0.6}" r="${W * 0.085}" fill="#fff3c8"/>`],
      [t`遠山`, 0.8, ridge(0.6, 0.035, 1.3, '#7a5a8c')],
      [t`中景山丘`, 0.55, ridge(0.69, 0.03, 4.1, '#3f3a66')],
      [t`近丘`, 0.3, ridge(0.79, 0.022, 2.2, '#1f2444')],
      [t`樹林`, 0.08, trees + ridge(0.9, 0.012, 5.5, '#0e1424')],
    ];
    for (const [name, depth, body] of layers) await agent.addSvgLayer({ name, depth, svg: svg(body) });
    state.selectedId = null;
    refresh();
    commit();
    setTiltMode(true);
  }

  // ---------------------------------------------------------------- misc UI
  // ---------------------------------------------------------------- misc UI

  let toastTimer = 0;
  function toast(message, isError, linger) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', !!isError);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, isError || linger ? 9000 : 5000);
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
    if (event.key === '?') {
      $('helpDialog').showModal();
      return;
    }
    // View shortcuts, as on a 3D program's number pad.
    const views = { 1: [0, 0], 3: [0, -90], 7: [-89, 0], 0: [-14, -40] };
    if (views[event.key] && !mod) {
      setView(...views[event.key]);
      return;
    }
    if (event.key.toLowerCase() === 'f' && !mod) {
      frameView();
      return;
    }
    const layer = selected();
    if (!layer) return;
    const step = event.shiftKey ? 0.02 : 0.004;
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[event.key]) {
      event.preventDefault();
      if (layer.locked) return;
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
    if (dirty && !autosaveWorks && state.layers.length) event.preventDefault();
  });

  new ResizeObserver(() => {
    layoutPhone();
    applyView();
  }).observe(document.querySelector('.workspace'));

  // ---------------------------------------------------------------- start

  // A problem nobody handled should still be visible to the person, not only in the console.
  window.addEventListener('error', (event) => toast(t`發生未預期的錯誤:${event.message}`, true));
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    toast(t`發生未預期的錯誤:${(reason && reason.message) || reason}`, true);
  });

  buildToolbar();
  buildProperties();
  refresh();
  commit();
  dirty = false;
  // Resolves once the last session's work is back (or there was none), so that whatever opens
  // something else at start-up does not have it replaced a moment later.
  const restored = restoreAutosave();

  // ---------------------------------------------------------------- drawn layers (AI assistant)
  //
  // What the assistant (js/assistant.js) can do to the scene. Its layers are ordinary image
  // layers: artwork written as SVG or as a grid of pixels is rasterised once at canvas size, so
  // everything else (preview, export, undo, hand editing) treats it like an imported picture.
  // The artwork's source is kept on the image entry so it can be read back and revised.

  const SVG_NS = 'http://www.w3.org/2000/svg';
  /** Pictures the person gave the assistant; SVG artwork can show them as href="ref:1", "ref:2"... */
  const references = [];

  /**
   * Checks and tidies SVG written by the model. Returns the markup to keep as the layer's source
   * (references still as "ref:N") and the markup to rasterise (references filled in).
   */
  function prepareSvg(text) {
    let markup = String(text).trim();
    if (!/^<svg[\s>]/.test(markup.replace(/^<\?xml[^>]*>\s*/, '').replace(/^<!--[\s\S]*?-->\s*/, ''))) {
      throw new Error('The artwork must be a single SVG document starting with <svg ...>.');
    }
    if (!/xmlns\s*=/.test(markup.slice(0, markup.indexOf('>') + 1))) {
      markup = markup.replace(/<svg/, `<svg xmlns="${SVG_NS}"`);
    }
    const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const problem = doc.querySelector('parsererror');
    if (problem) throw new Error(`SVG is not well-formed XML: ${problem.textContent.trim().slice(0, 300)}`);
    const root = doc.documentElement;
    if (root.namespaceURI !== SVG_NS || root.localName !== 'svg') throw new Error('The root element must be <svg>.');

    // Nothing in a layer may run or load anything: it is a picture, and it is saved in projects.
    doc.querySelectorAll('script, foreignObject, iframe, object, embed, audio, video').forEach((el) => el.remove());
    const notes = [];
    for (const el of [root, ...root.querySelectorAll('*')]) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on')) el.removeAttribute(attr.name);
        if (name !== 'href' && name !== 'xlink:href') continue;
        const value = attr.value.trim();
        const ref = /^ref:(\d+)$/.exec(value);
        if (value.startsWith('#') || value.startsWith('data:image/')) continue;
        if (ref && references[Number(ref[1]) - 1]) continue;
        el.removeAttribute(attr.name);
        notes.push(`removed ${attr.name}="${value.slice(0, 60)}" (only #ids, data:image/ and existing ref:N are allowed)`);
      }
    }
    root.setAttribute('width', state.canvasW);
    root.setAttribute('height', state.canvasH);
    if (!root.getAttribute('viewBox')) root.setAttribute('viewBox', `0 0 ${state.canvasW} ${state.canvasH}`);

    const source = new XMLSerializer().serializeToString(doc);
    for (const el of root.querySelectorAll('*')) {
      for (const name of ['href', 'xlink:href']) {
        const ref = /^ref:(\d+)$/.exec((el.getAttribute(name) || '').trim());
        if (ref) el.setAttribute(name, references[Number(ref[1]) - 1].src);
      }
    }
    return { source, drawable: new XMLSerializer().serializeToString(doc), viewBox: root.getAttribute('viewBox'), notes };
  }

  async function rasteriseSvg(drawable) {
    const url = URL.createObjectURL(new Blob([drawable], { type: 'image/svg+xml' }));
    try {
      const img = await loadImage(url).catch(() => {
        throw new Error('The browser could not draw this SVG. Check for unsupported or malformed elements.');
      });
      const canvas = document.createElement('canvas');
      canvas.width = state.canvasW;
      canvas.height = state.canvasH;
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function rasterisePixels(spec) {
    const cell = spec.pixel_size;
    const canvas = document.createElement('canvas');
    canvas.width = state.canvasW;
    canvas.height = state.canvasH;
    const ctx = canvas.getContext('2d');
    const x0 = Math.round(spec.x || 0);
    const y0 = Math.round(spec.y || 0);
    spec.rows.forEach((row, j) => {
      Array.from(row).forEach((ch, i) => {
        const color = spec.palette[ch];
        if (!color) return; // any character without a palette entry is transparent
        ctx.fillStyle = color;
        ctx.fillRect(x0 + i * cell, y0 + j * cell, cell, cell);
      });
    });
    return canvas;
  }

  /** Share of the canvas a drawing covers and whether it reaches each edge, so gaps are noticed without looking. */
  function coverageOf(canvas) {
    const small = document.createElement('canvas');
    small.width = 54;
    small.height = Math.max(1, Math.round(54 * canvas.height / canvas.width));
    const ctx = small.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, small.width, small.height);
    const data = ctx.getImageData(0, 0, small.width, small.height).data;
    let painted = 0;
    let opaque = 0;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] > 8) painted++;
      if (data[i] > 250) opaque++;
    }
    const total = small.width * small.height;
    return { painted: round2(painted / total), fully_opaque: opaque === total };
  }

  async function registerDrawing(canvas, source) {
    const imageId = await registerImage(canvas.toDataURL('image/png'));
    images.get(imageId).source = source;
    return imageId;
  }

  function drawnLayer(imageId, name, depth) {
    const layer = {
      id: nextId++,
      imageId,
      name: String(name || t`圖層`).slice(0, 60),
      depth: round2(clamp(Number(depth), 0, 1)),
      x: 0,
      y: 0,
      scale: 1,
      rotation: 0,
      opacity: 1,
      flip: false,
      blend: 'normal',
      visible: true,
    };
    state.layers.push(layer);
    state.selectedId = layer.id;
    refresh();
    commit();
    return layer;
  }

  function layerById(id) {
    const layer = state.layers.find((l) => l.id === Number(id));
    if (!layer) throw new Error(`There is no layer with id ${id}. Call get_scene for the current ids.`);
    return layer;
  }

  function describeLayer(layer) {
    const entry = images.get(layer.imageId);
    const made = entry && entry.source ? entry.source.type : (entry && entry.kind === 'video' ? 'video' : 'imported image');
    return {
      id: layer.id,
      name: layer.name,
      depth: layer.depth,
      artwork: made,
      ...(made === 'shader' ? { blend: entry.source.blend, render_scale: entry.source.scale, animated: window.WallShader.animated(entry.source.glsl) } : {}),
      x: round(layer.x, 3),
      y: round(layer.y, 3),
      scale: round(layer.scale, 3),
      rotation: layer.rotation,
      opacity: layer.opacity,
      visible: layer.visible,
      crop: (() => {
        const c = cropOf(layer);
        return c.l || c.r || c.t || c.b ? { left: c.l, right: c.r, top: c.t, bottom: c.b } : undefined;
      })(),
    };
  }

  /** What to draw for a layer in renderScene: its baked picture, or a shader frame at `time`. */
  function sceneCanvas(layer, W, H, time, tiltX, tiltY) {
    const shader = shaderOf(layer);
    if (!shader) return bakedCanvas(layer);
    try {
      return shaderFrame(shader, W, H, time, tiltX, tiltY);
    } catch (error) {
      return bakedCanvas(layer);
    }
  }

  // ---------------------------------------------------------------- shader layers

  /** Checks what a tool call asked for and returns the shader's source record. Throws what the model should read. */
  function shaderSource(p, previous) {
    const glsl = String(p.glsl === undefined ? (previous ? previous.glsl : '') : p.glsl).replace(/\r\n/g, '\n');
    if (!glsl.trim()) throw new Error('"glsl" is missing: pass the fragment shader source.');
    if (glsl.length > 60000) throw new Error('The shader is too long. Keep it under 60 KB.');
    const blend = p.blend === undefined || p.blend === null ? (previous ? previous.blend : 'normal') : p.blend;
    if (blend !== 'normal' && blend !== 'add') throw new Error('"blend" must be "normal" or "add".');
    const asked = p.render_scale === undefined || p.render_scale === null ? (previous ? previous.scale : 1) : Number(p.render_scale);
    const scale = round2(clamp(Number.isFinite(asked) ? asked : 1, 0.25, 1));
    if (/\biChannel[0-3]\b/.test(window.WallShader.codeOf(glsl))) {
      throw new Error('Shader layers made here have no textures: do not use iChannel0..3. Compute everything from fragCoord, iResolution, iTime and uTilt.');
    }
    const log = window.WallShader.check(glsl);
    if (log) throw new Error(`The shader did not compile. Fix it and call the tool again. Compiler output (line numbers are those of your source):\n${log}`);
    return { type: 'shader', glsl, blend, scale };
  }

  /** A still of the shader three seconds in, for the layer list and as the layer's picture. */
  function shaderStill(shader) {
    const { W, H } = previewSize();
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    canvas.getContext('2d').drawImage(shaderFrame(shader, W, H, 3, 0, 0), 0, 0, W, H);
    return canvas;
  }

  /** What the assistant is told about a shader layer it just wrote. */
  function shaderReport(shader, still) {
    const report = { blend: shader.blend, render_scale: shader.scale, animated: window.WallShader.animated(shader.glsl) };
    const notes = [];
    if (shader.blend === 'add') {
      // Alpha means nothing for an added layer: report how much of the screen it lights up.
      // Counted on every pixel of the still: small things like stars vanish when shrunk.
      const data = still.getContext('2d').getImageData(0, 0, still.width, still.height).data;
      let lit = 0;
      let bright = 0;
      for (let i = 0; i < data.length; i += 4) {
        const peak = Math.max(data[i], data[i + 1], data[i + 2]);
        if (peak > 10) lit++;
        if (peak > 200) bright++;
      }
      const total = still.width * still.height;
      report.lit = round(lit / total, 4);
      if (!lit) notes.push('At 3 seconds this layer adds nothing visible. Check it with view_canvas at a few times.');
      if (bright / total > 0.5) notes.push('More than half the screen is close to full brightness: an added layer this strong washes the picture out. Lower its intensity.');
    } else {
      const data = still.getContext('2d').getImageData(0, 0, still.width, still.height).data;
      let painted = 0;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 8) painted++;
        if (data[i] > 250) opaque++;
      }
      const total = still.width * still.height;
      report.coverage = { painted: round(painted / total, 4), fully_opaque: opaque === total };
      if (report.coverage.fully_opaque) notes.push('This layer is opaque everywhere, so it hides every layer behind it. Write alpha 0 where it should show nothing (and premultiply the colour), or use blend "add".');
      if (!report.coverage.painted) notes.push('At 3 seconds this layer paints nothing. Check it with view_canvas at a few times.');
    }
    if (!report.animated) notes.push('This shader never reads iTime, so it does not move.');
    if (notes.length) report.notes = notes;
    return report;
  }

  /** The scene as the phone shows it, at preview size, for the given tilt (each axis -1..1). */
  function renderScene(options) {
    const { W, H } = previewSize();
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const only = options.onlyLayerId == null ? null : layerById(options.onlyLayerId);
    // Shader layers are shown as they look `time` seconds in, so two views can be compared.
    const time = Number.isFinite(Number(options.time)) ? Math.max(0, Number(options.time)) : 3;
    if (only) {
      // A single layer on a checkerboard, so its transparent parts can be told from dark paint.
      for (let y = 0; y < H; y += 25) {
        for (let x = 0; x < W; x += 25) {
          ctx.fillStyle = ((x + y) / 25) % 2 ? '#3a3d4a' : '#555a6c';
          ctx.fillRect(x, y, 25, 25);
        }
      }
      ctx.globalCompositeOperation = compositeOf(only);
      ctx.drawImage(sceneCanvas(only, W, H, time, 0, 0), 0, 0, W, H);
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      const tx = clamp(Number(options.tiltX) || 0, -1, 1);
      const ty = clamp(Number(options.tiltY) || 0, -1, 1);
      for (const layer of drawOrder()) {
        const p = parallaxFor(layer);
        ctx.save();
        ctx.globalCompositeOperation = compositeOf(layer);
        ctx.translate(W / 2 + tx * p.shift * W, H / 2 + ty * p.shift * H);
        ctx.scale(p.zoom, p.zoom);
        ctx.drawImage(sceneCanvas(layer, W, H, time, tx, ty), -W / 2, -H / 2, W, H);
        ctx.restore();
      }
    }
    return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: W, height: H };
  }

  const agent = {
    /** Registers a picture the person attached; returns the number to use as "ref:N". */
    addReference(src, w, h, origin) {
      references.push({ src, w, h, origin: origin || 'attached' });
      return references.length;
    },

    /** The picture behind "ref:N" (or N), or an error the model can act on. */
    reference(ref) {
      const match = /^(?:ref:)?(\d+)$/.exec(String(ref).trim());
      const found = match && references[Number(match[1]) - 1];
      if (!found) throw new Error(`There is no picture "${ref}". Available: ${references.map((r, i) => `ref:${i + 1}`).join(', ') || 'none'}.`);
      return { ...found, index: Number(match[1]) };
    },

    /** A picture as the model should see it: at most `maxSide` px, transparency as a checkerboard. */
    async previewReference(ref, maxSide) {
      const picture = agent.reference(ref);
      const img = await loadImage(picture.src);
      const scale = Math.min(1, (maxSide || 1024) / Math.max(picture.w, picture.h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(picture.w * scale));
      canvas.height = Math.max(1, Math.round(picture.h * scale));
      const ctx = canvas.getContext('2d');
      for (let y = 0; y < canvas.height; y += 24) {
        for (let x = 0; x < canvas.width; x += 24) {
          ctx.fillStyle = ((x + y) / 24) % 2 ? '#3a3d4a' : '#555a6c';
          ctx.fillRect(x, y, 24, 24);
        }
      }
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: picture.w, height: picture.h, index: picture.index };
    },

    /**
     * Cuts a flat background out of a picture and registers the result as a new reference.
     * Pixels close to the background colour become transparent; a band beyond that fades, and
     * the background's tint is taken back out of the fading pixels so edges do not glow.
     */
    async removeBackground(ref, color, tolerance) {
      const picture = agent.reference(ref);
      const img = await loadImage(picture.src);
      const canvas = document.createElement('canvas');
      canvas.width = picture.w;
      canvas.height = picture.h;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = pixels.data;
      let key;
      if (color) {
        const hex = /^#?([0-9a-f]{6})$/i.exec(String(color).trim());
        if (!hex) throw new Error('color must look like #rrggbb.');
        key = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16));
      } else {
        // The four corners, a few pixels in: the median of each channel.
        const at = (x, y) => (y * canvas.width + x) * 4;
        const inset = Math.min(4, canvas.width - 1, canvas.height - 1);
        const corners = [at(inset, inset), at(canvas.width - 1 - inset, inset), at(inset, canvas.height - 1 - inset), at(canvas.width - 1 - inset, canvas.height - 1 - inset)];
        key = [0, 1, 2].map((c) => corners.map((i) => data[i + c]).sort((a, b) => a - b)[1]);
      }
      const inner = clamp(tolerance === undefined ? 0.18 : Number(tolerance), 0.01, 0.9) * 441.7;
      const outer = inner * 1.7;
      const tight = inner * 0.55;
      const w = canvas.width;
      const h = canvas.height;
      const distance = new Float32Array(w * h);
      for (let i = 0, p = 0; p < distance.length; i += 4, p++) {
        distance[p] = Math.hypot(data[i] - key[0], data[i + 1] - key[1], data[i + 2] - key[2]);
      }
      // Background is what can be reached from the picture's border through background-coloured
      // pixels. A patch of the same colour inside the subject (a green eye on a green backdrop)
      // is not reached and stays; pockets the border cannot reach (between an arm and the body)
      // are caught by the tighter test below, since a generated backdrop is nearly one flat colour.
      const reached = new Uint8Array(w * h);
      const queue = new Int32Array(w * h);
      let head = 0;
      let tail = 0;
      const visit = (p) => {
        if (reached[p] || distance[p] >= outer) return;
        reached[p] = 1;
        queue[tail++] = p;
      };
      for (let x = 0; x < w; x++) {
        visit(x);
        visit((h - 1) * w + x);
      }
      for (let y = 0; y < h; y++) {
        visit(y * w);
        visit(y * w + w - 1);
      }
      while (head < tail) {
        const p = queue[head++];
        // Spread only through pixels that are clearly background; the fading band is where it stops.
        if (distance[p] > inner) continue;
        const x = p % w;
        if (x > 0) visit(p - 1);
        if (x < w - 1) visit(p + 1);
        if (p >= w) visit(p - w);
        if (p < w * (h - 1)) visit(p + w);
      }
      let cleared = 0;
      for (let p = 0, i = 0; p < distance.length; p++, i += 4) {
        const d = distance[p];
        if ((reached[p] && d <= inner) || d <= tight) {
          data[i + 3] = 0;
          cleared++;
        } else if (reached[p]) {
          // The edge of the subject: fade it, and take the backdrop's tint back out so it does not glow.
          const a = (d - inner) / (outer - inner);
          for (let c = 0; c < 3; c++) data[i + c] = clamp(Math.round((data[i + c] - key[c] * (1 - a)) / a), 0, 255);
          data[i + 3] = Math.round(data[i + 3] * a);
        }
      }
      ctx.putImageData(pixels, 0, 0);
      const index = agent.addReference(canvas.toDataURL('image/png'), canvas.width, canvas.height, 'cut-out');
      const hex = `#${key.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      return { image: `ref:${index}`, removed_color: hex, share_made_transparent: round2(cleared / (data.length / 4)) };
    },

    /** Places a picture on a new layer as it is. */
    async addImageLayer(p) {
      const picture = agent.reference(p.image);
      const imageId = await registerImage(picture.src);
      const entry = images.get(imageId);
      entry.source = { type: 'picture', image: `ref:${picture.index}` };
      const fit = p.fit === 'contain' ? containFactor(entry) : 1;
      const layer = drawnLayer(imageId, p.name, p.depth);
      layer.scale = clamp(fit * (p.scale === undefined ? 1 : Number(p.scale)), 0.02, 8);
      layer.x = clamp(Number(p.x) || 0, -1, 1);
      layer.y = clamp(Number(p.y) || 0, -1, 1);
      refresh();
      commit();
      return { layer_id: layer.id, ...describeLayer(layer) };
    },

    scene() {
      return {
        name: state.name,
        canvas: { width: state.canvasW, height: state.canvasH },
        parallax: { strength: state.strength, focus: state.focus },
        effect: state.effect,
        available_effects: Object.keys(window.WallEffects),
        layers_far_to_near: state.layers.slice().sort((a, b) => b.depth - a.depth).map(describeLayer),
        pictures: references.map((r, i) => ({ image: `ref:${i + 1}`, width: r.w, height: r.h, from: r.origin })),
      };
    },

    setScene(p) {
      // Refuse the whole call before changing anything, so a rejected call leaves no half-applied change.
      if (p.effect !== undefined && !window.WallEffects[p.effect]) {
        throw new Error(`Unknown effect "${p.effect}". Use one of: ${Object.keys(window.WallEffects).join(', ')}.`);
      }
      if ((p.canvas_width !== undefined || p.canvas_height !== undefined) && state.layers.length) {
        throw new Error('The canvas size can only be changed while there are no layers: drawn layers would not match the new size.');
      }
      if (p.name !== undefined) state.name = String(p.name).slice(0, 80);
      if (p.parallax_strength !== undefined) state.strength = clamp(Number(p.parallax_strength), 0, 0.1);
      if (p.parallax_focus !== undefined) state.focus = clamp(Number(p.parallax_focus), 0, 1);
      if (p.effect !== undefined) state.effect = p.effect;
      if (p.canvas_width !== undefined || p.canvas_height !== undefined) {
        state.canvasW = clamp(Math.round(Number(p.canvas_width) || state.canvasW), 240, 4320);
        state.canvasH = clamp(Math.round(Number(p.canvas_height) || state.canvasH), 240, 7680);
      }
      refresh();
      commit();
      return agent.scene();
    },

    async addSvgLayer(p) {
      const svg = prepareSvg(p.svg);
      const canvas = await rasteriseSvg(svg.drawable);
      const layer = drawnLayer(await registerDrawing(canvas, { type: 'svg', svg: svg.source }), p.name, p.depth);
      return { layer_id: layer.id, depth: layer.depth, viewBox: svg.viewBox, coverage: coverageOf(canvas), notes: svg.notes };
    },

    /** Adds a layer drawn by a fragment shader: full screen, optionally moving. */
    async addShaderLayer(p) {
      const shader = shaderSource(p);
      const still = shaderStill(shader);
      const layer = drawnLayer(await registerDrawing(still, shader), p.name, p.depth);
      return { layer_id: layer.id, depth: layer.depth, ...shaderReport(shader, still) };
    },

    async addPixelLayer(p) {
      // The palette arrives as [{ char, color }]; a plain { char: color } object is accepted too.
      const palette = Array.isArray(p.palette)
        ? Object.fromEntries(p.palette.map((entry) => [entry.char, entry.color]))
        : p.palette;
      const spec = { pixel_size: Math.max(1, Math.round(p.pixel_size)), palette, rows: p.rows, x: p.x || 0, y: p.y || 0 };
      const canvas = rasterisePixels(spec);
      const layer = drawnLayer(await registerDrawing(canvas, { type: 'pixels', ...spec }), p.name, p.depth);
      return { layer_id: layer.id, depth: layer.depth, coverage: coverageOf(canvas) };
    },

    /** Replaces a layer's artwork, keeping its depth and placement. */
    async replaceArt(id, art) {
      const layer = layerById(id);
      // `art` is the tool's input ({ svg } or { glsl, blend, render_scale }), or SVG text.
      const p = typeof art === 'string' ? { svg: art } : art || {};
      const current = shaderOf(layer);
      if (current || p.glsl !== undefined) {
        if (!current) throw new Error('This layer is not a shader layer: pass "svg" to redraw it, or add a shader layer with add_shader_layer.');
        if (p.svg !== undefined) throw new Error('This is a shader layer: pass "glsl", not "svg".');
        const shader = shaderSource(p, current);
        const still = shaderStill(shader);
        layer.imageId = await registerDrawing(still, shader);
        refresh();
        commit();
        return { layer_id: layer.id, ...shaderReport(shader, still) };
      }
      if (p.svg === undefined) throw new Error('"svg" is missing: pass the complete new SVG document.');
      const svgText = p.svg;
      const svg = prepareSvg(svgText);
      const canvas = await rasteriseSvg(svg.drawable);
      layer.imageId = await registerDrawing(canvas, { type: 'svg', svg: svg.source });
      refresh();
      commit();
      return { layer_id: layer.id, viewBox: svg.viewBox, coverage: coverageOf(canvas), notes: svg.notes };
    },

    readArt(id) {
      const entry = images.get(layerById(id).imageId);
      if (!entry || !entry.source) throw new Error('This layer is an imported picture or video; it has no editable source.');
      return entry.source;
    },

    updateLayer(id, p) {
      const layer = layerById(id);
      if (shaderOf(layer)) {
        const placement = ['x', 'y', 'scale', 'rotation', 'opacity', 'crop_left', 'crop_right', 'crop_top', 'crop_bottom'].filter((key) => p[key] !== undefined);
        if (placement.length) {
          throw new Error(`A shader layer covers the whole screen and has no ${placement.join(', ')}. Change where and how strongly it draws in its code, with update_layer_art.`);
        }
      }
      if (p.name !== undefined) layer.name = String(p.name).slice(0, 60);
      if (p.depth !== undefined) layer.depth = round2(clamp(Number(p.depth), 0, 1));
      if (p.x !== undefined) layer.x = clamp(Number(p.x), -1, 1);
      if (p.y !== undefined) layer.y = clamp(Number(p.y), -1, 1);
      if (p.scale !== undefined) layer.scale = clamp(Number(p.scale), 0.02, 8);
      if (p.rotation !== undefined) layer.rotation = clamp(Number(p.rotation), -180, 180);
      if (p.opacity !== undefined) layer.opacity = clamp(Number(p.opacity), 0, 1);
      if (p.visible !== undefined) layer.visible = !!p.visible;
      for (const [key, side] of [['crop_left', 'l'], ['crop_right', 'r'], ['crop_top', 't'], ['crop_bottom', 'b']]) {
        if (p[key] !== undefined) setCrop(layer, side, Number(p[key]) || 0);
      }
      refresh();
      commit();
      return describeLayer(layer);
    },

    deleteLayer(id) {
      const layer = layerById(id);
      state.layers = state.layers.filter((l) => l !== layer);
      baked.delete(layer.id);
      if (state.selectedId === layer.id) state.selectedId = null;
      refresh();
      commit();
      return { deleted: layer.id, remaining: state.layers.length };
    },

    render: renderScene,
  };

  // For scripted use (tests, automation): add layers and build the pack bytes.
  window.spatialEditor = {
    agent,
    state,
    async addImage(src, name) {
      const layer = addLayer(await registerImage(src), name || t`圖層`);
      refresh();
      commit();
      return layer;
    },
    async addVideo(blob, fileName) {
      const layer = addLayer(await registerVideo(blob, fileName), (fileName || t`影片`).replace(/\.[^.]+$/, ''));
      refresh();
      commit();
      return layer;
    },
    refresh,
    buildPackZip,
    loadPack,
    restored,
  };
})();
