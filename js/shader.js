// Draws shader layers in the editor, the way the phone app does (see docs/PACK_FORMAT.md in the
// app, "Writing shaders"): the same wrapper around a Shadertoy-style fragment, the same uniforms.
// One hidden WebGL 2 canvas is shared by everything; frame() draws into it and returns it, and
// the caller copies it out (drawImage) before asking for another frame.
//
// It is also the compiler check for the assistant: check() returns the driver's error log, with
// line numbers that match the shader as it was written.
(function () {
  'use strict';

  const VERTEX = `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() {
    vUv = aPos * 0.5 + 0.5;
    gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

  // Same names and types as ShaderSource.kt in the app.
  const BUILTINS = [
    ['vec3', 'iResolution', ''],
    ['float', 'iTime', ''],
    ['float', 'iTimeDelta', ''],
    ['int', 'iFrame', ''],
    ['vec4', 'iMouse', ''],
    ['sampler2D', 'iChannel0', ''],
    ['sampler2D', 'iChannel1', ''],
    ['sampler2D', 'iChannel2', ''],
    ['sampler2D', 'iChannel3', ''],
    ['vec3', 'iChannelResolution', '[4]'],
    ['float', 'uOffset', ''],
    ['vec3', 'uTouch', ''],
    ['vec2', 'uTilt', ''],
    ['int', 'uPass', ''],
  ];

  const COMMENTS = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
  const VERSION_LINE = /^[ \t]*#[ \t]*version\b[^\n]*/m;

  /** The author's text with comments blanked, for looking at what it declares and uses. */
  function codeOf(source) {
    return String(source).replace(COMMENTS, ' ');
  }

  /**
   * The source handed to the compiler. `opaque` forces alpha to 1: used for "add" layers, whose
   * alpha the phone ignores, so that the editor can add them with ordinary canvas blending.
   */
  function build(userSource, opaque) {
    const source = String(userSource).replace(/^﻿/, '').replace(/\r\n/g, '\n');
    const code = codeOf(source);
    const hasVersion = VERSION_LINE.test(code);
    const hasMain = /\bvoid\s+main\s*\(/.test(code);
    const hasMainImage = /\bvoid\s+mainImage\s*\(/.test(code);
    if (hasVersion && hasMain && !hasMainImage) return source;
    if (!hasMainImage || hasMain) {
      throw new Error('No entry point: define  void mainImage(out vec4 fragColor, in vec2 fragCoord)  and no main(), and do not write a #version line.');
    }
    const declared = (name) => new RegExp(`\\buniform\\s+(?:(?:highp|mediump|lowp)\\s+)?\\w+\\s+${name}\\b`).test(code);
    let out = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\n';
    for (const [type, name, suffix] of BUILTINS) {
      if (!declared(name)) out += `uniform ${type} ${name}${suffix};\n`;
    }
    // GLSL ES 3.00: the line after "#line N" is line N, so errors carry the author's line numbers.
    out += '#line 1\n';
    out += source.replace(VERSION_LINE, '');
    out += '\nout vec4 planetariumFragColor;\nvoid main() {\n    vec4 color = vec4(0.0, 0.0, 0.0, 1.0);\n    mainImage(color, gl_FragCoord.xy);\n';
    out += opaque ? '    planetariumFragColor = vec4(color.rgb, 1.0);\n}\n' : '    planetariumFragColor = color;\n}\n';
    return out;
  }

  let canvas = null;
  let gl = null;
  /** build() output -> { program, uniforms }. A handful at most are in use at a time. */
  const programs = new Map();

  function context() {
    if (gl && !gl.isContextLost()) return gl;
    canvas = document.createElement('canvas');
    gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
    programs.clear();
    if (!gl) throw new Error('This browser has no WebGL 2, so shader layers cannot be checked or previewed here.');
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.BLEND);
    return gl;
  }

  function compile(g, type, text) {
    const shader = g.createShader(type);
    g.shaderSource(shader, text);
    g.compileShader(shader);
    if (!g.getShaderParameter(shader, g.COMPILE_STATUS)) {
      const log = (g.getShaderInfoLog(shader) || 'the shader did not compile').replace(/\u0000/g, '').trim();
      g.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  }

  function programFor(source, opaque) {
    const g = context();
    const text = build(source, opaque);
    let entry = programs.get(text);
    if (entry) return entry;
    const program = g.createProgram();
    const vertex = compile(g, g.VERTEX_SHADER, VERTEX);
    const fragment = compile(g, g.FRAGMENT_SHADER, text);
    g.attachShader(program, vertex);
    g.attachShader(program, fragment);
    g.linkProgram(program);
    g.deleteShader(vertex);
    g.deleteShader(fragment);
    if (!g.getProgramParameter(program, g.LINK_STATUS)) {
      const log = (g.getProgramInfoLog(program) || 'the shader did not link').trim();
      g.deleteProgram(program);
      throw new Error(log);
    }
    const uniforms = {};
    for (const name of ['iResolution', 'iTime', 'iTimeDelta', 'iFrame', 'iMouse', 'uOffset', 'uTouch', 'uTilt', 'uPass']) {
      uniforms[name] = g.getUniformLocation(program, name);
    }
    entry = { program, uniforms };
    if (programs.size >= 24) {
      const oldest = programs.keys().next().value;
      g.deleteProgram(programs.get(oldest).program);
      programs.delete(oldest);
    }
    programs.set(text, entry);
    return entry;
  }

  /** null when the shader compiles; otherwise the compiler's message. */
  function check(source) {
    try {
      programFor(source, false);
      return null;
    } catch (error) {
      return String(error.message || error);
    }
  }

  /**
   * Draws one frame and returns the shared canvas holding it (premultiplied alpha). `time` is in
   * seconds; tiltX / tiltY are -1..1 as on the phone. Throws if the shader does not compile.
   */
  function frame(source, width, height, time, tiltX, tiltY, opaque) {
    const { program, uniforms } = programFor(source, opaque);
    const g = gl;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    g.viewport(0, 0, width, height);
    g.useProgram(program);
    g.uniform3f(uniforms.iResolution, width, height, 1);
    g.uniform1f(uniforms.iTime, time);
    g.uniform1f(uniforms.iTimeDelta, 1 / 30);
    g.uniform1i(uniforms.iFrame, Math.floor(time * 30));
    g.uniform4f(uniforms.iMouse, 0, 0, 0, 0);
    g.uniform1f(uniforms.uOffset, 0.5);
    g.uniform3f(uniforms.uTouch, 0, 0, 0);
    g.uniform2f(uniforms.uTilt, tiltX || 0, tiltY || 0);
    g.uniform1i(uniforms.uPass, 0);
    g.clearColor(0, 0, 0, 0);
    g.clear(g.COLOR_BUFFER_BIT);
    g.drawArrays(g.TRIANGLE_STRIP, 0, 4);
    return canvas;
  }

  /** Whether the shader moves by itself (the app redraws such a layer up to 30 times a second). */
  function animated(source) {
    return /\b(iTime|iTimeDelta|iFrame)\b/.test(codeOf(source));
  }

  window.WallShader = { check, frame, animated, codeOf };
})();
