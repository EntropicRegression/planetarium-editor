// Animated overlays that can be added in front of the layers. These are the same shaders the
// app ships under app/src/main/assets/effects; they are exported as a shader layer of the pack.
// The editor has no GL preview for them: they only show on the phone.
(function () {
  'use strict';

  const dust = `// Floating light dust: soft glowing motes drifting upwards. Meant for "blend": "add".
vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

float motes(vec2 uv, float scale, float speed, float size) {
    uv *= scale;
    uv.y -= iTime * speed;
    vec2 cell = floor(uv);
    vec2 f = fract(uv);
    vec2 rnd = hash2(cell);
    // Only some cells hold a mote, each wandering a little around its own spot.
    float present = step(0.55, fract(rnd.x * 7.31 + rnd.y * 3.17));
    vec2 pos = 0.25 + 0.5 * rnd;
    pos.x += 0.12 * sin(iTime * (0.3 + rnd.y) + rnd.x * 6.2831);
    float twinkle = 0.6 + 0.4 * sin(iTime * (0.8 + rnd.x * 1.5) + rnd.y * 6.2831);
    float d = length(f - pos);
    return present * twinkle * (1.0 - smoothstep(0.0, size, d));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.y;
    // Nearer motes are larger, faster and slide more with tilt.
    float glow = 0.0;
    glow += 0.45 * motes(uv + uTilt * 0.010, 9.0, 0.020, 0.10);
    glow += 0.65 * motes(uv + uTilt * 0.025 + 3.7, 6.0, 0.035, 0.13);
    glow += 0.90 * motes(uv + uTilt * 0.050 + 8.1, 3.5, 0.055, 0.16);
    vec3 color = vec3(1.0, 0.86, 0.62) * glow * 0.55;
    fragColor = vec4(color, 0.0);
}
`;

  const snow = `// Falling snow in three depth layers. Output is premultiplied white, for "blend": "normal".
vec2 hash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453);
}

float flakes(vec2 uv, float scale, float speed, float size) {
    uv *= scale;
    // fragCoord's y points up, so adding time makes the pattern fall.
    uv.y += iTime * speed;
    uv.x += 0.3 * sin(uv.y * 0.7 + scale);
    vec2 cell = floor(uv);
    vec2 f = fract(uv);
    vec2 rnd = hash2(cell);
    float present = step(0.4, fract(rnd.x * 5.13 + rnd.y * 9.71));
    vec2 pos = 0.25 + 0.5 * rnd;
    pos.x += 0.15 * sin(iTime * (0.6 + rnd.y) + rnd.x * 6.2831);
    float d = length(f - pos);
    return present * (1.0 - smoothstep(size * 0.3, size, d));
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.y;
    float a = 0.0;
    a += 0.45 * flakes(uv + uTilt * 0.010, 14.0, 1.2, 0.10);
    a += 0.65 * flakes(uv + uTilt * 0.025 + 5.3, 9.0, 1.5, 0.12);
    a += 0.90 * flakes(uv + uTilt * 0.050 + 2.9, 5.0, 1.9, 0.14);
    a = clamp(a, 0.0, 1.0);
    fragColor = vec4(vec3(a), a);
}
`;

  const rain = `// Slanted rain streaks in two depth layers. Output is premultiplied, for "blend": "normal".
float hash1(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float streaks(vec2 uv, float columns, float speed, float len) {
    // Lean the rain a little.
    uv.x += uv.y * 0.12;
    float col = floor(uv.x * columns);
    float fx = fract(uv.x * columns);
    float rnd = hash1(vec2(col, columns));
    float present = step(0.45, rnd);
    // Each column has its own phase and speed; fragCoord's y points up, so adding time falls.
    float y = fract(uv.y * 0.9 + iTime * speed * (0.8 + 0.4 * rnd) + rnd * 17.0);
    float body = smoothstep(0.0, len, y) * (1.0 - smoothstep(len, len + 0.02, y));
    float thin = 1.0 - smoothstep(0.0, 0.5, abs(fx - 0.5) * 6.0);
    return present * body * thin;
}

void mainImage(out vec4 fragColor, in vec2 fragCoord) {
    vec2 uv = fragCoord / iResolution.y;
    float a = 0.0;
    a += 0.25 * streaks(uv + uTilt * 0.015, 70.0, 1.6, 0.10);
    a += 0.40 * streaks(uv + uTilt * 0.040 + 4.2, 40.0, 2.1, 0.16);
    a = clamp(a, 0.0, 1.0);
    fragColor = vec4(vec3(0.82, 0.88, 1.0) * a, a);
}
`;

  window.WallEffects = {
    none: { label: '無', source: null, blend: 'normal' },
    dust: { label: '光塵', source: dust, blend: 'add' },
    snow: { label: '飄雪', source: snow, blend: 'normal' },
    rain: { label: '下雨', source: rain, blend: 'normal' },
  };
})();
