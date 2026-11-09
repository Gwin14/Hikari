package expo.modules.hikarinative.render

/**
 * OpenGL ES port of the develop pipeline (src/core/pipeline/shaders.ts). Mirrors the Metal version
 * in ios/render/Shaders.swift. Uniforms come as one float block in FrameLayout order, read
 * through f() so vec3s can straddle vec4 boundaries; pipeline.gpu.test.ts renders this source.
 */
internal object GlShaders {
  val RECIPE_FRAGMENT = """
#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

layout(std140) uniform Frame { vec4 u[634]; };
uniform sampler2D uImage, uBlurN, uBlurS, uBlurM, uBlurL, uCurve, uLut;
uniform sampler2DArray uMasks;
uniform int uLocalCount;
in vec2 vP;
out vec4 fragColor;

float f(int i) { return u[i / 4][i % 4]; }
vec2 f2(int i) { return vec2(f(i), f(i + 1)); }
vec3 f3(int i) { return vec3(f(i), f(i + 1), f(i + 2)); }
vec4 f4(int i) { return vec4(f(i), f(i + 1), f(i + 2), f(i + 3)); }

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float encode1(float x) {
  float a = abs(x);
  float e = a <= 0.0031308 ? a * 12.92 : 1.055 * pow(a, 1.0 / 2.4) - 0.055;
  return sign(x) * e;
}
float decode1(float x) {
  float a = abs(x);
  float d = a <= 0.04045 ? a / 12.92 : pow((a + 0.055) / 1.055, 2.4);
  return sign(x) * d;
}
vec3 encode(vec3 c) { return vec3(encode1(c.r), encode1(c.g), encode1(c.b)); }
vec3 decode(vec3 c) { return vec3(decode1(c.r), decode1(c.g), decode1(c.b)); }
vec3 sat3(vec3 c) { return clamp(c, vec3(0.0), vec3(1.0)); }

vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-4;
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), sat3(p - 1.0), c.y);
}

float bandCenter(int i) {
  if (i == 0) return 0.0;
  if (i == 1) return 30.0 / 360.0;
  if (i == 2) return 60.0 / 360.0;
  if (i == 3) return 120.0 / 360.0;
  if (i == 4) return 180.0 / 360.0;
  if (i == 5) return 240.0 / 360.0;
  if (i == 6) return 270.0 / 360.0;
  return 300.0 / 360.0;
}
float bandWidth(int i) {
  if (i == 2 || i == 5 || i == 7) return 45.0 / 360.0;
  if (i == 3 || i == 4) return 60.0 / 360.0;
  return 30.0 / 360.0;
}
float bandWeight(float h, int i) {
  float d = abs(h - bandCenter(i));
  d = min(d, 1.0 - d);
  float t = clamp(1.0 - d / bandWidth(i), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

vec3 setLuma(vec3 p, float y0, float y1) {
  if (y0 <= 1.0e-4) return p + (y1 - y0);
  vec3 s = p * (y1 / y0);
  float m = max(s.r, max(s.g, s.b));
  if (m > 1.0) s = mix(s, vec3(y1), clamp((m - 1.0) / max(m, 1.0e-3), 0.0, 1.0));
  return s;
}

float toneY(float y, float contrast, float highlights, float shadows, float whites, float blacks) {
  float ws = 1.0 - smoothstep(0.0, 0.6, y);
  float wh = smoothstep(0.4, 1.0, y);
  y += shadows * 0.45 * ws * ws * (1.0 - y * 0.5);
  y += highlights * 0.4 * wh * wh * (highlights < 0.0 ? max(y, 0.4) : (1.0 - y * 0.6));
  y += whites * 0.3 * smoothstep(0.55, 1.0, y);
  y += blacks * 0.2 * (1.0 - smoothstep(0.0, 0.35, y));
  float k = contrast >= 0.0 ? 1.0 + contrast * 1.2 : 1.0 / (1.0 - contrast * 0.8);
  float yc = clamp(y, 0.0, 1.0);
  float sc = yc < 0.5 ? 0.5 * pow(2.0 * yc, k) : 1.0 - 0.5 * pow(2.0 * (1.0 - yc), k);
  return sc + (y - yc);
}


const mat3 SRGB_TO_P3 = mat3(
  vec3(0.822462, 0.033194, 0.017083),
  vec3(0.177538, 0.966806, 0.072397),
  vec3(0.000000, 0.000000, 0.910520));

vec4 at(sampler2D t, vec2 p, vec2 size) { return texture(t, p / size); }
vec3 linAt(sampler2D t, vec2 p, vec2 size) { return decode(at(t, p, size).rgb); }

vec4 develop(vec2 p, sampler2D image, sampler2D blurN, sampler2D blurM, sampler2D blurL, sampler2D curve) {
  vec2 size = vec2(f2(0));
  vec2 c = size * 0.5;
  float rn = length(c);
  vec2 d = (p - c) / rn;
  float r2 = dot(d, d);
  vec2 q = c + d * (1.0 + f(61) * r2) * rn;

  vec3 lin = vec3(0.0);
  if (f(62) > 0.0) {
    vec2 dq = q - c;
    lin.r = linAt(image, c + dq * (1.0 - f(62)), size).r;
    lin.g = linAt(image, q, size).g;
    lin.b = linAt(image, c + dq * (1.0 + f(62)), size).b;
  } else {
    lin = linAt(image, q, size);
  }
  float alpha = at(image, q, size).a;
  if (q.x < 0.0 || q.y < 0.0 || q.x > size.x || q.y > size.y) return vec4(0.0);

  vec3 wb = vec3(f3(3));
  vec3 bs = linAt(blurN, q, size);
  vec3 bm = linAt(blurM, q, size);
  if (f(59) > 0.0) {
    float ey = encode1(dot(lin, LUMA)) - encode1(dot(bs, LUMA));
    float w = exp(-(ey * ey) / (0.0004 + 0.004 * f(59)));
    lin = mix(lin, bs, f(59) * w);
  }
  if (f(60) > 0.0) {
    float yl = dot(lin, LUMA);
    float ym = dot(bm, LUMA);
    vec3 chroma = mix(lin - yl, (bm - ym) * (yl / max(ym, 1.0e-4)), f(60));
    lin = yl + chroma;
  }

  lin *= 1.0 + f(63) * r2;
  lin *= wb;
  lin *= exp2(f(2));

  float peak = max(lin.r, max(lin.g, lin.b));
  if (peak > 0.8 && f(11) > 0.5) {
    float comp = 0.8 + 0.2 * (1.0 - exp(-(peak - 0.8) / 0.2));
    lin *= comp / peak;
  }

  vec3 e = encode(lin);
  if (f(58) != 0.0) {
    vec3 bl = encode(linAt(blurL, q, size) * wb * exp2(f(2)));
    float dark = min(bl.r, min(bl.g, bl.b));
    if (f(58) > 0.0) {
      float t = max(1.0 - f(58) * 0.85 * dark, 0.15);
      e = (e - 0.92 * (1.0 - t)) / t;
      e = mix(e, e * (1.0 + f(58) * 0.15), 0.5);
    } else {
      e = mix(e, vec3(0.82), -f(58) * 0.5 * (0.4 + dark));
    }
  }

  float y0 = dot(e, LUMA);
  float y = toneY(y0, f(6), f(7), f(8), f(9), f(10));

  if (f(56) != 0.0 || f(57) != 0.0) {
    float yl = encode1(dot(linAt(blurL, q, size), LUMA));
    float ym = encode1(dot(bm, LUMA));
    float ys = encode1(dot(linAt(image, q, size), LUMA));
    float mid = clamp(1.0 - abs(y - 0.5) * 1.6, 0.0, 1.0);
    y += f(56) * 0.7 * (ys - yl) * mid;
    y += f(57) * 1.2 * (ys - ym);
  }
  e = setLuma(e, y0, y);

  if (f(73) > 0.5) {
    vec3 cc = sat3(e);
    vec3 over = e - cc;
    e.r = texture(curve, vec2((cc.r * 255.0 + 0.5) / 256.0, 0.5)).r;
    e.g = texture(curve, vec2((cc.g * 255.0 + 0.5) / 256.0, 0.5)).g;
    e.b = texture(curve, vec2((cc.b * 255.0 + 0.5) / 256.0, 0.5)).b;
    e += over;
  }

  vec3 hsv = rgb2hsv(sat3(e));
  float dh = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 8; i++) {
    float w = bandWeight(hsv.x, i);
    dh += w * f(14 + i);
    ds += w * f(22 + i);
    dl += w * f(30 + i);
  }
  if (dh != 0.0 || ds != 0.0 || dl != 0.0) {
    float yb = dot(e, LUMA);
    vec3 h2 = vec3(fract(hsv.x + dh * (30.0 / 360.0)), clamp(hsv.y * (1.0 + ds), 0.0, 1.0), hsv.z);
    vec3 rgb = hsv2rgb(h2) + (e - sat3(e));
    float ya = dot(rgb, LUMA);
    float target = yb * (1.0 + dl * 0.6 * hsv.y);
    e = setLuma(rgb, ya, target);
  }

  float ye = dot(e, LUMA);
  float sat = max(e.r, max(e.g, e.b)) - min(e.r, min(e.g, e.b));
  float skin = smoothstep(0.0, 0.08, abs(hsv.x - 0.07));
  float vib = f(12) * (1.0 - sat) * (f(12) > 0.0 ? mix(0.5, 1.0, skin) : 1.0);
  e = ye + (e - ye) * max(0.0, 1.0 + f(13) + vib);

  float yg = clamp(dot(e, LUMA), 0.0, 1.0);
  float bal = f(55) * 0.5;
  float spread = mix(0.15, 0.6, f(54));
  float wS = 1.0 - smoothstep(0.0, 0.5 + bal + spread * 0.5, yg);
  float wH = smoothstep(0.5 + bal - spread * 0.5, 1.0, yg);
  float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
  e += vec3(f3(38)) * wS + vec3(f3(41)) * wM + vec3(f3(44)) * wH + vec3(f3(47));
  e += f2(50)[0] * wS * 0.3 + f(52) * wM * 0.3 + f2(50)[1] * wH * 0.3 + f(53) * 0.3;

  if (f(64) > 0.5) {
    vec3 hs = rgb2hsv(sat3(e));
    float k = 0.0;
    for (int i = 0; i < 8; i++) k += bandWeight(hs.x, i) * f(65 + i);
    float g = dot(e, LUMA) * (1.0 + k * hs.y);
    e = vec3(g);
  }
  return vec4(e, alpha);
}


float maskAt(vec2 p, vec3 e, int L) {
  vec2 size = vec2(f2(L + 0));
  vec2 n = p / size;
  float aspect = size.x / size.y;
  vec2 asp = vec2(aspect, 1.0);
  float m = 1.0;
  vec4 line = vec4(f4(L + 3));
  vec4 ellipse = vec4(f4(L + 7));
  vec2 rf = vec2(f2(L + 11));
  vec3 lumRange = vec3(f3(L + 16));
  vec3 colorRange = vec3(f3(L + 19));
  if (f(L + 2) < 0.5) {
    m = texture(uMasks, vec3(n, f(L + 37))).r;
  } else if (f(L + 2) < 1.5) {
    vec2 a = line.xy; vec2 b = line.zw;
    vec2 ab = (b - a) * asp;
    float t = dot((n - a) * asp, ab) / max(dot(ab, ab), 1.0e-6);
    m = 1.0 - smoothstep(0.0, 1.0, t);
  } else if (f(L + 2) < 2.5) {
    vec2 dd = (n - ellipse.xy) * asp;
    float ca = cos(rf.x); float sa = sin(rf.x);
    dd = vec2(ca * dd.x + sa * dd.y, -sa * dd.x + ca * dd.y);
    vec2 rr = ellipse.zw * asp;
    float r = length(dd / max(rr, vec2(1.0e-4)));
    float f = max(rf.y, 0.001);
    m = 1.0 - smoothstep(1.0 - f, 1.0, r);
  }
  if (f(L + 15) > 0.5 && f(L + 15) < 1.5) {
    float y = dot(sat3(e), LUMA);
    float lo = smoothstep(lumRange.x - lumRange.z, lumRange.x + lumRange.z, y);
    float hi = 1.0 - smoothstep(lumRange.y - lumRange.z, lumRange.y + lumRange.z, y);
    m *= lo * hi;
  } else if (f(L + 15) > 1.5) {
    vec3 hsv = rgb2hsv(sat3(e));
    float dh = abs(hsv.x - colorRange.x); dh = min(dh, 1.0 - dh);
    float tol = max(colorRange.z, 0.01);
    float wHue = 1.0 - smoothstep(tol * 0.5, tol, dh);
    float wSat = smoothstep(0.05, 0.05 + tol * 0.5, hsv.y);
    m *= wHue * wSat;
  }
  if (f(L + 13) > 0.5) m = 1.0 - m;
  return clamp(m * f(L + 14), 0.0, 1.0);
}


vec4 local(vec2 p, vec4 inC, int L, sampler2D source, sampler2D blurL) {
  vec2 size = vec2(f2(L + 0));
  vec3 e = inC.rgb;
  float m = maskAt(p, e, L);
  if (m <= 0.0005) return inC;

  vec3 lin = decode(e) * vec3(f3(L + 29)) * exp2(f(L + 23));
  vec3 a = encode(lin);
  if (f(L + 34) != 0.0) {
    vec3 bl = at(blurL, p, size).rgb;
    float dark = min(bl.r, min(bl.g, bl.b));
    float t = max(1.0 - max(f(L + 34), 0.0) * 0.85 * dark, 0.15);
    a = f(L + 34) > 0.0 ? (a - 0.92 * (1.0 - t)) / t : mix(a, vec3(0.82), -f(L + 34) * 0.5);
  }
  float y0 = dot(a, LUMA);
  float y = toneY(y0, f(L + 24), f(L + 25), f(L + 26), f(L + 27), f(L + 28));
  vec3 src = linAt(source, p, size);
  if (f(L + 33) != 0.0) {
    float yl = encode1(dot(linAt(blurL, p, size), LUMA));
    float ys = encode1(dot(src, LUMA));
    y += f(L + 33) * 0.7 * (ys - yl) * clamp(1.0 - abs(y - 0.5) * 1.6, 0.0, 1.0);
  }
  a = setLuma(a, y0, y);
  float ya = dot(a, LUMA);
  a = ya + (a - ya) * max(0.0, 1.0 + f(L + 32));

  if (f(L + 35) != 0.0 || f(L + 36) != 0.0) {
    vec3 n1 = linAt(source, p + vec2(1.0, 0.0), size);
    vec3 n2 = linAt(source, p - vec2(1.0, 0.0), size);
    vec3 n3 = linAt(source, p + vec2(0.0, 1.0), size);
    vec3 n4 = linAt(source, p - vec2(0.0, 1.0), size);
    float hf = encode1(dot(src, LUMA)) - encode1(dot((n1 + n2 + n3 + n4) * 0.25, LUMA));
    a += (f(L + 35) > 0.0 ? f(L + 35) * 1.5 : f(L + 35) * 0.8) * hf;
    a -= f(L + 36) * hf * 0.9;
  }

  vec3 outE = mix(e, a, m);
  if (f(L + 22) > 0.5) outE = mix(outE, vec3(1.0, 0.15, 0.2), m * 0.45);
  return vec4(outE, inC.a);
}


vec3 lut3(vec3 c, float n, sampler2D lut) {
  vec2 size = vec2(n * n, n);
  vec3 x = sat3(c) * (n - 1.0);
  float b0 = floor(x.b);
  float b1 = min(b0 + 1.0, n - 1.0);
  float fb = x.b - b0;
  vec2 p0 = vec2(b0 * n + x.r + 0.5, x.g + 0.5);
  vec2 p1 = vec2(b1 * n + x.r + 0.5, x.g + 0.5);
  return mix(at(lut, p0, size).rgb, at(lut, p1, size).rgb, fb);
}


vec4 finish(vec2 p, vec4 inC, sampler2D source, sampler2D blurS, sampler2D blurM, sampler2D blurL, sampler2D lut) {
  vec2 size = vec2(f2(74));
  vec3 e = inC.rgb;

  if (f(76) > 0.0) {
    float ys = encode1(dot(linAt(source, p, size), LUMA));
    float yb = encode1(dot(linAt(blurS, p, size), LUMA));
    float ym = encode1(dot(linAt(blurM, p, size), LUMA));
    float hf = ys - yb;
    float lim = mix(0.02, 0.25, f(77));
    hf = clamp(hf, -lim, lim);
    float edge = smoothstep(0.0, 0.02 + 0.2 * f(78), abs(ys - ym) + abs(hf));
    float w = f(78) > 0.0 ? edge : 1.0;
    e += f(76) * 2.2 * hf * w;
  }

  if (f(80) > 0.0) e = mix(e, lut3(e, f(79), lut), f(80));

  vec3 bloom = vec3(f3(93));
  vec3 halation = vec3(f3(96));
  if (bloom.x > 0.0 || halation.x > 0.0) {
    vec3 gm = encode(max(linAt(blurM, p, size), vec3(0.0)));
    vec3 gl = encode(max(linAt(blurL, p, size), vec3(0.0)));
    vec3 room = 1.0 - sat3(e);
    if (bloom.x > 0.0) {
      vec3 g = mix(gm, gl, bloom.z);
      float k = smoothstep(bloom.y - 0.18, bloom.y + 0.12, dot(g, LUMA));
      e += sat3(g * k) * bloom.x * room;
    }
    if (halation.x > 0.0) {
      float ys = encode1(max(dot(linAt(source, p, size), LUMA), 0.0));
      float yg = dot(mix(gm, gl, halation.z), LUMA);
      float t = halation.y;
      float halo = smoothstep(t - 0.15, t + 0.1, yg) * (1.0 - 0.7 * smoothstep(t - 0.05, t + 0.1, ys));
      e += vec3(1.0, 0.3, 0.1) * halo * halation.x * 0.8 * room;
    }
  }

  vec4 vignette = vec4(f4(85));
  vec4 crop = vec4(f4(81));
  if (vignette.x != 0.0) {
    vec2 cc = crop.xy + crop.zw * 0.5;
    vec2 dd = (p - cc) / (crop.zw * 0.5);
    float roundness = vignette.w;
    float aspect = crop.z / crop.w;
    dd.x *= mix(1.0, aspect, clamp(roundness, 0.0, 1.0));
    float pw = mix(2.0, 6.0, clamp(-roundness, 0.0, 1.0));
    float r = pow(pow(abs(dd.x), pw) + pow(abs(dd.y), pw), 1.0 / pw);
    float mid = mix(0.2, 1.3, vignette.y);
    float feather = mix(0.05, 1.2, vignette.z);
    float v = smoothstep(mid - feather * 0.5, mid + feather * 0.5, r);
    if (vignette.x < 0.0) e *= 1.0 + vignette.x * v;
    else e = mix(e, vec3(1.0), vignette.x * v * 0.9);
  }

  vec3 grain = vec3(f3(89));
  if (grain.x > 0.0) {
    vec2 g = p / (f(92) * mix(0.7, 3.0, grain.y));
    float n1 = hash12(floor(g));
    float n2 = hash12(floor(g * 2.1) + 17.0);
    float n = mix(n1, (n1 + n2) * 0.5, 1.0 - grain.z) - 0.5;
    float y = clamp(dot(e, LUMA), 0.0, 1.0);
    e += n * grain.x * 0.22 * (0.4 + 0.6 * (1.0 - abs(y - 0.5) * 2.0));
  }

  // data output: the stored values are the target-space code values, at the target's bit depth
  if (f(100) > 0.5) {
    vec3 lin = decode(e);
    if (f(101) > 0.5) lin = SRGB_TO_P3 * lin;
    if (f(100) > 1.5) {
      vec3 x = floor(sat3(encode(lin)) * 65535.0 + 0.5);
      vec3 hi = floor(x / 256.0);
      return vec4((f(100) < 2.5 ? hi : x - hi * 256.0) / 255.0, 1.0);
    }
    return vec4(sat3(encode(lin)), 1.0);
  }

  if (f(99) > 0.5) {
    float hi = max(e.r, max(e.g, e.b));
    float lo = min(e.r, min(e.g, e.b));
    if (hi >= 0.999) e = vec3(1.0, 0.1, 0.25);
    else if (lo <= 0.001) e = vec3(0.1, 0.35, 1.0);
  }
  return vec4(e, inC.a);
}

void main() {
  vec4 c = develop(vP, uImage, uBlurN, uBlurM, uBlurL, uCurve);
  for (int i = 0; i < uLocalCount; i++) {
    c = local(vP, c, 102 + i * 38, uImage, uBlurL);
  }
  fragColor = finish(vP, c, uImage, uBlurS, uBlurM, uBlurL, uLut);
}
""".trim()

  val IMAGE_VERTEX = """
#version 300 es
precision highp float;
uniform float uM[9];
uniform vec2 uTarget, uImageSize;
uniform float uFlipY;
out vec2 vP;
void main() {
  vec2 p = vec2((gl_VertexID & 1) != 0 ? uImageSize.x : 0.0, (gl_VertexID & 2) != 0 ? uImageSize.y : 0.0);
  float X = uM[0] * p.x + uM[1] * p.y + uM[2];
  float Y = uM[3] * p.x + uM[4] * p.y + uM[5];
  float W = uM[6] * p.x + uM[7] * p.y + uM[8];
  float ny = uFlipY > 0.5 ? W - 2.0 * Y / uTarget.y : 2.0 * Y / uTarget.y - W;
  gl_Position = vec4(2.0 * X / uTarget.x - W, ny, 0.0, W);
  vP = p;
}
""".trim()

  val ORIGINAL_FRAGMENT = """
#version 300 es
precision highp float;
uniform sampler2D uImage;
uniform vec2 uImageSize;
in vec2 vP;
out vec4 fragColor;
void main() { fragColor = texture(uImage, vP / uImageSize); }
""".trim()

  val RECT_VERTEX = """
#version 300 es
precision highp float;
uniform vec4 uRect;
out vec2 vUv;
void main() {
  vec2 uv = vec2((gl_VertexID & 1) != 0 ? 1.0 : 0.0, (gl_VertexID & 2) != 0 ? 1.0 : 0.0);
  vec2 q = uRect.xy + uv * uRect.zw;
  gl_Position = vec4(q * 2.0 - 1.0, 0.0, 1.0);
  vUv = uv;
}
""".trim()

  val COPY_FRAGMENT = """
#version 300 es
precision highp float;
uniform sampler2D uSrc;
in vec2 vUv;
out vec4 fragColor;
void main() { fragColor = texture(uSrc, vUv); }
""".trim()

  val GAUSS_FRAGMENT = """
#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform float uSigma;
uniform ivec2 uDir;
in vec2 vUv;
out vec4 fragColor;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 coord = clamp(ivec2(floor(vUv * vec2(size))), ivec2(0), size - ivec2(1));
  int r = int(ceil(3.0 * uSigma));
  float k = -0.5 / (uSigma * uSigma);
  vec4 sum = vec4(0.0);
  float total = 0.0;
  for (int i = -r; i <= r; i++) {
    ivec2 q = clamp(coord + uDir * i, ivec2(0), size - ivec2(1));
    float g = exp(k * float(i * i));
    sum += texelFetch(uSrc, q, 0) * g;
    total += g;
  }
  fragColor = sum / total;
}
""".trim()
}
