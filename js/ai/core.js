// What every model provider shares: the instructions that teach a model to build layered
// wallpapers, the tools it may call, and the small vocabulary the assistant and the providers
// use to talk to each other.
//
// A provider (js/ai/claude.js, gemini.js, openai.js) turns this neutral form into its own API's
// requests. It registers itself in WallAI.providers as:
//
//   { id, label, models: [[id, label]...], credential: { kind, label, placeholder, help },
//     createSession({ credential, model, system, tools }) -> session }
//
// A session owns the conversation in the provider's native format:
//
//   session.addUser(parts)             parts: [{ type: 'text', text } | { type: 'image', mediaType, data }]
//   session.addToolResults(results)    results: [{ id, name, isError, parts }]
//   session.run({ onText, onToolStart, onToolDetail }) -> { toolCalls, stop, usage }
//       toolCalls: [{ id, name, input }]
//       stop: 'end' | 'tools' | 'max_tokens' | 'refusal'
//       usage: { input, output } in tokens
//   session.abort()
//
// run() appends the model's reply to the conversation itself, and throws an AiError for anything
// the person has to deal with (bad key, rate limit, no network).
(function () {
  'use strict';

  /** `kind` tells the interface what to say: 'auth' | 'permission' | 'rate' | 'network' | 'request' | 'aborted' | 'other'. */
  class AiError extends Error {
    constructor(kind, message, status) {
      super(message);
      this.name = 'AiError';
      this.kind = kind;
      this.status = status;
    }
  }

  /** Sorts an HTTP failure into an AiError; `detail` is the provider's own message. */
  function httpError(status, detail) {
    const kind = status === 401 ? 'auth'
      : status === 403 ? 'permission'
        : status === 429 ? 'rate'
          : status === 400 || status === 404 || status === 422 ? 'request'
            : 'other';
    return new AiError(kind, detail || `HTTP ${status}`, status);
  }

  /**
   * Reads a server-sent-events response body, calling `onEvent(data, eventName)` with each
   * event's data (parsed as JSON when it is JSON). Resolves when the stream ends.
   */
  async function readSse(response, onEvent) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const flush = (block) => {
      let name = '';
      const data = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith('event:')) name = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (!data.length) return;
      const text = data.join('\n');
      if (text === '[DONE]') return;
      let value = text;
      try {
        value = JSON.parse(text);
      } catch (error) {
        // Not JSON: hand over the text as it is.
      }
      onEvent(value, name);
    };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let cut;
      while ((cut = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, cut);
        buffer = buffer.slice(cut).replace(/^\r?\n\r?\n/, '');
        flush(block);
      }
    }
    if (buffer.trim()) flush(buffer);
  }

  /** fetch that reports "could not connect" and "stopped by the person" as AiErrors. */
  async function request(url, options) {
    try {
      return await fetch(url, options);
    } catch (error) {
      if (error && error.name === 'AbortError') throw new AiError('aborted', 'stopped');
      throw new AiError('network', String((error && error.message) || error));
    }
  }

  // ---------------------------------------------------------------- what the model is taught

  const PROMPT_BASE = `You are the layer artist inside "Spatial Wallpaper Editor", a tool for making parallax ("spatial") live wallpapers for Android phones. The person describes a scene in words, sometimes with reference pictures, and you build it as a stack of layers by calling the tools. They watch the layers appear in the editor while you work, can adjust everything you make by hand afterwards, and export the result to their phone.

# How a spatial wallpaper works

The wallpaper is a portrait canvas (get_scene reports its size in pixels) made of full-canvas layers. Each layer has a depth from 1 (farthest) to 0 (nearest) and they are drawn far to near.

When the phone tilts, a layer at depth d slides sideways by tilt × strength × (focus − d) of the screen size. Layers at the focus depth stay still; with the default focus of 1 the far background is fixed and nearer layers move more. So that sliding never shows a layer's edge, each layer is also enlarged about the screen centre by 1 + 2 × strength × |focus − d|. With the default strength 0.04, the nearest layer is enlarged 8% and loses about 4% on every side. Keep anything that matters out of the outer 6% of a near layer.

Parallax is only visible between layers at different depths, so the depth you give each layer is the whole effect.

# What makes one look good

- Split the scene by distance, not by object. Four to seven layers is typical: sky, far horizon, middle distance, near objects, and a foreground frame. Spread their depths out, for example 1.0, 0.8, 0.6, 0.4, 0.2, 0.05.
- The farthest layer must be opaque and fill the whole canvas. Wherever no layer paints, the phone shows black.
- Every other layer is transparent where it has nothing to show. Paint each layer further than what is visible at rest: carry hills, buildings and ground on behind the nearer layers and down to the bottom of the canvas, because tilting reveals what was covered. Shapes that reach a canvas edge should run past it (draw from about −5% to 105%).
- Let silhouettes overlap the ones behind them. Overlap is what reads as depth; separate objects floating apart do not.
- Use atmospheric perspective: far things are paler, hazier, lower in contrast and less detailed; near things are darker, more saturated, crisper and larger.
- A phone covers part of the picture. A status bar and clock sit across the top 8% or so, app icons and the dock over roughly the bottom third of a home screen, and a large clock in the upper third of a lock screen. Put the subject in the calmer middle band and keep the areas under the interface simple.
- One clear subject, supported by everything else.

# Drawing layers

add_svg_layer takes one complete SVG document and turns it into a layer.
- Use viewBox="0 0 W H" with exactly the canvas size, so your coordinates are canvas pixels.
- Leave the background transparent (no full-size rect) on every layer except the farthest.
- Gradients, patterns, clipPath, mask and filters all work; feGaussianBlur is good for glow, haze and soft clouds. The artwork is turned into pixels once, so filters cost nothing on the phone.
- Scripts, foreignObject and anything loaded from outside (images, fonts, stylesheets) are removed. Avoid <text>: fonts differ between machines, so draw lettering as shapes if you need it.
- Repeat things with <defs>, <use>, <pattern> and transforms rather than writing every window, star or tree out. Aim for under about 40 KB of SVG per layer; split a layer in two before making it huge.
- The tool result tells you how much of the canvas the layer painted and whether it is fully opaque, which is a quick check that the back layer has no gaps and a foreground layer did not accidentally fill the canvas.

Draw one distance per layer, and if a layer would be enormous, draw it in two and merge them: merge_layers bakes layers into one picture at the farthest one's depth. Merging is also how to tidy a stack that grew past about seven layers, or to join pieces that must move as one (a building and its windows, a tree and its shadow). It is one-way: the merged layers' own drawings are gone, so merge only when you are happy with how those layers look.

For pixel art, either write SVG on a coarse grid (shape-rendering="crispEdges" on the root, every coordinate a multiple of the cell size, e.g. 6 px), or use add_pixel_layer for sprites and small pieces: rows of characters, a palette mapping characters to colours, and a cell size. Characters without a palette entry are transparent.

# Moving layers

Everything above is a still picture. add_shader_layer adds a layer that moves: a GLSL fragment shader the phone runs for every pixel, every frame. Use it for motion that suits the scene and can be computed: stars that twinkle, drifting fog or clouds, light shimmering on water, rain, snow, embers, fireflies, a neon sign or a window that flickers, light rays, an aurora. It cannot move a drawn object (a tail, a flag, a person); do not try to redraw artwork in a shader. One shader layer is usually right, two at most; a still scene with one quiet moving thing looks better than a busy one.

How to write one:
- Shadertoy style. Define only  void mainImage(out vec4 fragColor, in vec2 fragCoord)  plus helper functions. No #version line, no main(), no uniform declarations: they are added for you.
- This is GLSL ES 3.00 on a phone GPU. Write float literals with a decimal point (1.0, not 1). No implicit int/float conversion. Loops need constant bounds. There are no textures: iChannel0..3 are not available, so make noise with hash functions.
- Uniforms: iResolution.xy (pixels), iTime (seconds), uTilt (vec2, each −1..1, the phone's tilt). fragCoord is in pixels with the origin at the BOTTOM-left, the opposite of SVG. For a point at SVG (x, y) on a W×H canvas use uv = vec2(x / W, 1.0 − y / H) with uv = fragCoord / iResolution.xy. Keep circles round with  vec2 p = (fragCoord − 0.5 * iResolution.xy) / iResolution.y.
- blend "add": the colour you write is added to the layers behind (alpha is ignored). Black adds nothing, so this is the easy and usual choice for anything that glows: stars, dust, light, fire, shimmer, rain streaks. Keep it subtle; values above about 0.6 over large areas wash the picture out.
- blend "normal": you write premultiplied colour over the layers behind. Write vec4(0.0) where nothing shows and vec4(colour * a, a) elsewhere. Use it for things that darken or cover: fog, clouds, smoke, falling snow with soft edges.
- A shader layer always covers the whole screen, so confine the effect yourself: multiply by a mask built from uv (smoothstep bands, distance to a point) so that stars stay in the sky above the horizon, shimmer stays on the water, a flicker stays inside one window. Take those positions from the layers you drew.
- Depth only decides what it is drawn in front of. Shader layers get no automatic parallax; if the effect should slide with the others, offset its coordinates yourself by uTilt times a small factor (about 0.02 for far things, 0.06 for near ones).
- Move slowly. Wallpaper motion should be calm: speeds of 0.02 to 0.3 screen heights a second, twinkles over one to four seconds. Do not flash.
- Keep it cheap, it runs all the time: a few dozen operations per pixel, loops of at most about 24 steps, at most 4 octaves of noise. For soft effects (fog, glow, aurora) set render_scale to 0.5: it is drawn at half resolution and costs a quarter.

If the shader does not compile, the tool returns the compiler's messages with your own line numbers; fix those lines and call it again. Then look at it: view_canvas takes a time in seconds, so view it at two different times (for example 1 and 6) to see that it moves the way you meant and stays where it should. Fix it with update_layer_art (pass glsl). update_layer cannot move or fade a shader layer; change its code.

# Pictures

Some pictures are marked up by the person: coloured regions, boxes and arrows, each with a numbered badge, and their message lists what each number means. The numbers in the list are the badges in the picture, and the positions in it are given in canvas pixels (for a marked-up ref, in that picture's own pixels), so you can act on them directly: a box or a brushed region is the area they mean, and an arrow points from something to where it should go. When the picture is one layer alone, the message gives that layer's id; fix that layer with update_layer_art rather than adding a new one. The marks are instructions about the picture, never part of it: do not draw the marks, badges or their colours into a layer, and leave everything they did not mark alone.

Pictures available to you are numbered ref:1, ref:2 and so on: the ones the person attached appear in the conversation with their pixel sizes, and get_scene lists all of them. Study the person's pictures for composition, palette and mood. Any picture can go on a layer in two ways: add_image_layer places it whole (update_layer can then crop it to the part you want), and inside SVG <image href="ref:1" x=".." y=".." width=".." height=".." preserveAspectRatio="xMidYMid slice"/> places it where you want, where a clipPath or mask can cut a region out of it. Cut-outs made with clip paths are rough, so for the person's own photographs redraw the scene unless the photograph itself is what they asked for.`;

  const PROMPT_IMAGES = `

# Generating pictures

generate_image makes a new picture from a description and gives it the next ref number. Use it when the scene calls for painted or photographic richness that flat vector shapes cannot give: skies, landscapes, textures, characters, detailed objects. Keep drawing with SVG what SVG does well: gradients, haze, glows, silhouettes, simple geometry, and anything that must line up exactly.

Generated pictures only help a layered wallpaper if each layer is a separate picture that belongs to the same world. A method that works:
1. Generate the whole scene once as a style master, in portrait. It fixes the palette, light and rendering style. Do not use it as a layer unless it is the back layer.
2. Generate the back layer: the farthest part alone (sky, distant land) filling the frame, passing the master in reference_images and saying "same style, palette and light as the reference; only the …; nothing in front of it".
3. Generate each nearer element separately with transparent_background true, again passing the master: "only the …, same style as the reference, whole object in frame, nothing else". The element comes back cut out. Describe the element so that it extends past the bottom or sides where a nearer layer or the canvas edge will hide it.
4. Place each with add_image_layer (fit "cover" for full-frame pieces, "contain" or an explicit scale and position for objects), far to near, then check with view_canvas as usual.

Write prompts the way you would brief an illustrator: subject, viewpoint, light, palette, style, and what must not appear. Say "no text, no watermark, no border". Each call costs the person money and takes several seconds, so plan the pieces first and do not regenerate for small flaws that placement, opacity or an SVG overlay can fix. remove_background cuts a flat-coloured background out of any picture if a cut-out came back with one.`;

  const PROMPT_METHOD = `

# Working method

1. Call get_scene first. There may already be layers, including ones the person imported or drew; build on them, and do not delete or replace their work unless they ask.
2. If the request is clear enough to act on, act. Ask a question only when something essential cannot be guessed, and then ask just that one thing.
3. Give the wallpaper a fitting name with set_scene, then add layers from far to near.
4. When the stack is in place, call view_canvas and look critically: black gaps, a subject that does not read, clutter, hard edges where layers meet. Then look again with tilt_x at −1 and at 1 to see that tilting reveals no hole or layer edge. Fix what you find with update_layer_art (redraw one layer) or update_layer (depth, opacity, visibility, placement). Two or three rounds of looking and fixing are enough; stop when it is good.
5. Finish with a short summary in the person's language: the layers and their depths, and anything they may want to adjust by hand. Do not paste SVG into the chat.

Motion is optional: add a shader layer when the scene has something that would naturally move, or when the person asks for it. set_scene can instead add a ready-made overlay (dust, snow, rain) that plays on the phone but cannot be previewed here; do not use one together with a shader layer that does the same job.

Write to the person in the language they write in.`;

  function systemPrompt(options) {
    return PROMPT_BASE + (options && options.imageGeneration ? PROMPT_IMAGES : '') + PROMPT_METHOD;
  }

  const DEPTH = { type: 'number', description: '1 = farthest, 0 = nearest.' };
  const LAYER_ID = { type: 'number', description: 'A layer id from get_scene.' };

  const BASE_TOOLS = [
    {
      name: 'get_scene',
      description: 'Returns the wallpaper as it is now: name, canvas size in pixels, parallax settings, effect and the effects available, every layer (id, name, depth, placement, how it was made) from far to near, and the pictures available as ref:N. Call it before changing anything.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'set_scene',
      description: 'Changes scene-wide settings. Only the fields you pass change. The canvas size can only be changed while there are no layers.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the wallpaper, shown in the phone app.' },
          parallax_strength: { type: 'number', description: '0 to 0.1; default 0.04. How far layers slide when the phone tilts.' },
          parallax_focus: { type: 'number', description: '0 to 1; default 1. Layers at this depth do not move.' },
          effect: { type: 'string', description: 'Moving overlay shown on the phone, one of the available_effects that get_scene lists ("none" for no overlay).' },
          canvas_width: { type: 'number', description: 'Canvas width in pixels.' },
          canvas_height: { type: 'number', description: 'Canvas height in pixels.' },
        },
      },
    },
    {
      name: 'add_svg_layer',
      description: 'Adds a layer drawn as SVG. The SVG is rasterised at canvas size; use viewBox="0 0 <canvas width> <canvas height>". Returns the new layer id and how much of the canvas it paints.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name for the layer list, in the language the person writes in.' },
          depth: DEPTH,
          svg: { type: 'string', description: 'A complete SVG document.' },
        },
        required: ['name', 'depth', 'svg'],
      },
    },
    {
      name: 'add_shader_layer',
      description: 'Adds a moving layer drawn by a GLSL ES 3.00 fragment shader (Shadertoy style: define mainImage only). It covers the whole screen and runs on the phone every frame. The shader is compiled first: if it fails, the compiler output comes back and nothing is added. The result reports how much of the screen it paints or lights at 3 seconds and whether it moves.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name for the layer list.' },
          depth: { type: 'number', description: '1 = farthest, 0 = nearest. Decides only which layers it is drawn in front of.' },
          glsl: { type: 'string', description: 'The fragment shader source: helper functions and  void mainImage(out vec4 fragColor, in vec2 fragCoord). No #version, no main(), no uniform declarations.' },
          blend: { type: 'string', enum: ['add', 'normal'], description: '"add": the colour is added to what is behind (for glows and light). "normal": premultiplied colour laid over what is behind (for fog, clouds, anything that covers). Default "normal".' },
          render_scale: { type: 'number', description: '0.25 to 1. Fraction of the screen resolution it is drawn at; use 0.5 for soft effects. Default 1.' },
        },
        required: ['name', 'depth', 'glsl'],
      },
    },
    {
      name: 'add_pixel_layer',
      description: 'Adds a layer drawn as a grid of square pixels, for pixel-art sprites and details. Each string in rows is one row; each character is one cell, coloured by palette. Characters with no palette entry are transparent.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short name for the layer list.' },
          depth: DEPTH,
          pixel_size: { type: 'number', description: 'Side of one cell in canvas pixels, e.g. 6.' },
          palette: {
            type: 'array',
            description: 'The colour of each character used in rows.',
            items: {
              type: 'object',
              properties: {
                char: { type: 'string', description: 'A single character.' },
                color: { type: 'string', description: 'A CSS colour such as #f4e04a.' },
              },
              required: ['char', 'color'],
            },
          },
          rows: { type: 'array', items: { type: 'string' }, description: 'Top row first.' },
          x: { type: 'number', description: 'Canvas x of the left edge of the grid, in pixels. Default 0.' },
          y: { type: 'number', description: 'Canvas y of the top edge of the grid, in pixels. Default 0.' },
        },
        required: ['name', 'depth', 'pixel_size', 'palette', 'rows'],
      },
    },
    {
      name: 'add_image_layer',
      description: 'Places one of the available pictures (ref:N) on a new layer as it is. fit "cover" fills the canvas (cropping the overflow); "contain" shows the whole picture. Adjust placement afterwards with update_layer.',
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'Which picture, e.g. "ref:2".' },
          name: { type: 'string', description: 'Short name for the layer list.' },
          depth: DEPTH,
          fit: { type: 'string', enum: ['cover', 'contain'], description: 'Default "cover".' },
          scale: { type: 'number', description: 'Multiplies the size given by fit. Default 1.' },
          x: { type: 'number', description: 'Horizontal offset of the picture centre as a fraction of the canvas width; 0 = centred, −0.25 = a quarter to the left.' },
          y: { type: 'number', description: 'Vertical offset as a fraction of the canvas height; 0 = centred, 0.25 = a quarter down.' },
        },
        required: ['image', 'name', 'depth'],
      },
    },
    {
      name: 'update_layer_art',
      description: 'Redraws an existing layer, keeping its id, depth and placement. Use it to fix or refine a layer instead of deleting and adding. Pass svg for a drawn layer, or glsl for a shader layer (get_scene says which each layer is).',
      parameters: {
        type: 'object',
        properties: {
          layer_id: LAYER_ID,
          svg: { type: 'string', description: 'For a drawn layer: the complete new SVG document.' },
          glsl: { type: 'string', description: 'For a shader layer: the complete new fragment shader source.' },
          blend: { type: 'string', enum: ['add', 'normal'], description: 'For a shader layer: change how it is combined. Omit to keep it.' },
          render_scale: { type: 'number', description: 'For a shader layer: 0.25 to 1. Omit to keep it.' },
        },
        required: ['layer_id'],
      },
    },
    {
      name: 'read_layer_art',
      description: 'Returns what a layer was made from (its SVG, pixel grid, or which picture), so you can revise it. Layers the person imported have no source.',
      parameters: { type: 'object', properties: { layer_id: LAYER_ID }, required: ['layer_id'] },
    },
    {
      name: 'update_layer',
      description: 'Changes a layer\'s properties without redrawing it. Only the fields you pass change.',
      parameters: {
        type: 'object',
        properties: {
          layer_id: LAYER_ID,
          name: { type: 'string', description: 'New name.' },
          depth: DEPTH,
          opacity: { type: 'number', description: '0 to 1.' },
          visible: { type: 'boolean', description: 'Hidden layers are not exported.' },
          x: { type: 'number', description: 'Horizontal offset as a fraction of the canvas width; 0 = centred.' },
          y: { type: 'number', description: 'Vertical offset as a fraction of the canvas height; 0 = centred.' },
          scale: { type: 'number', description: '1 = filling the canvas (or as drawn).' },
          rotation: { type: 'number', description: 'Degrees.' },
          crop_left: { type: 'number', description: 'Fraction of the picture trimmed from its left, 0 to 0.95. The rest stays where it is. Not for videos.' },
          crop_right: { type: 'number', description: 'Fraction trimmed from the right.' },
          crop_top: { type: 'number', description: 'Fraction trimmed from the top.' },
          crop_bottom: { type: 'number', description: 'Fraction trimmed from the bottom.' },
        },
        required: ['layer_id'],
      },
    },
    {
      name: 'merge_layers',
      description: 'Bakes two or more layers into one picture and puts a single layer in their place, at the farthest one\'s depth and slot in the stack. Everything in it then moves as one, and its own drawing can no longer be read back or edited, so merge only layers that belong at the same distance. Video and shader layers cannot be merged.',
      parameters: {
        type: 'object',
        properties: {
          layer_ids: { type: 'array', items: { type: 'number' }, description: 'Ids of the layers to merge, two or more.' },
          name: { type: 'string', description: 'Name for the merged layer. Default: the farthest layer\'s name.' },
        },
        required: ['layer_ids'],
      },
    },
    {
      name: 'delete_layer',
      description: 'Removes a layer. The person can undo it.',
      parameters: { type: 'object', properties: { layer_id: LAYER_ID }, required: ['layer_id'] },
    },
    {
      name: 'view_canvas',
      description: 'Shows you the wallpaper as the phone would display it, as an image. Pass tilt_x / tilt_y (each −1 to 1) to see it with the phone tilted, which is how to check the parallax for holes and exposed edges. Pass only_layer_id to see one layer alone on a checkerboard (the checkerboard is transparency).',
      parameters: {
        type: 'object',
        properties: {
          tilt_x: { type: 'number', description: '−1 to 1.' },
          tilt_y: { type: 'number', description: '−1 to 1.' },
          only_layer_id: { type: 'number', description: 'Show just this layer.' },
          time: { type: 'number', description: 'Seconds: the moment at which shader layers are shown. Default 3. View two different times to see motion.' },
        },
      },
    },
    {
      name: 'view_image',
      description: 'Shows you one of the available pictures (ref:N), with transparency drawn as a checkerboard.',
      parameters: { type: 'object', properties: { image: { type: 'string', description: 'e.g. "ref:2".' } }, required: ['image'] },
    },
    {
      name: 'remove_background',
      description: 'Makes a flat-coloured background of a picture transparent and returns the result as a new ref. By default the colour is taken from the picture\'s corners.',
      parameters: {
        type: 'object',
        properties: {
          image: { type: 'string', description: 'e.g. "ref:2".' },
          color: { type: 'string', description: 'Background colour as #rrggbb. Default: sampled from the corners.' },
          tolerance: { type: 'number', description: '0 to 1, how far from that colour still counts as background. Default 0.18.' },
        },
        required: ['image'],
      },
    },
  ];

  const IMAGE_TOOLS = [
    {
      name: 'generate_image',
      description: 'Generates a picture from a description and registers it as the next ref:N. Returns the ref and shows you the picture. Slow and paid: plan before calling.',
      parameters: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: 'What to paint: subject, viewpoint, light, palette, style, and what must not appear.' },
          shape: { type: 'string', enum: ['portrait', 'square', 'landscape'], description: 'Default "portrait", the shape of the wallpaper.' },
          transparent_background: { type: 'boolean', description: 'True for a single element cut out from its background, ready to sit on a nearer layer.' },
          reference_images: { type: 'array', items: { type: 'string' }, description: 'Pictures to stay consistent with, e.g. ["ref:1"]. Up to 3.' },
        },
        required: ['prompt'],
      },
    },
  ];

  function tools(options) {
    return options && options.imageGeneration ? BASE_TOOLS.concat(IMAGE_TOOLS) : BASE_TOOLS;
  }

  /**
   * Tool inputs arrive unvalidated, and one cut off mid-way can still parse as an object with
   * fields missing. Returns what is wrong with `input`, or null when it fits the tool's schema.
   */
  function invalid(tool, input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return 'the input is not an object';
    const schema = tool.parameters;
    for (const key of schema.required || []) {
      if (input[key] === undefined || input[key] === null) return `"${key}" is missing`;
    }
    for (const [key, value] of Object.entries(input)) {
      const spec = schema.properties[key];
      if (!spec || value === null) continue;
      const actual = Array.isArray(value) ? 'array' : typeof value;
      if (actual !== spec.type) return `"${key}" should be ${spec.type}, got ${actual}`;
      if (spec.type === 'number' && !Number.isFinite(value)) return `"${key}" is not a finite number`;
      if (spec.enum && !spec.enum.includes(value)) return `"${key}" should be one of ${spec.enum.join(', ')}`;
      if (spec.items && value.some((item) => (Array.isArray(item) ? 'array' : typeof item) !== spec.items.type)) {
        return `every item of "${key}" should be ${spec.items.type}`;
      }
    }
    return null;
  }

  window.WallAI = {
    AiError,
    httpError,
    readSse,
    request,
    systemPrompt,
    tools,
    invalid,
    /** id -> provider; filled in by the provider scripts. */
    providers: {},
    /** id -> image generator; filled in by js/ai/imagegen.js. */
    imageGenerators: {},
  };
})();
