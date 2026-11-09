/**
 Metal port of the develop pipeline in src/core/pipeline/shaders.ts.

 Every texture holds sRGB-encoded (extended) values or plain data, so sampling needs no color
 management: decode() is the only conversion. The three stages run as functions of one fragment
 shader, evaluated per output pixel in image space, the way the nested SkSL shaders are.

 The uniform structs are tightly packed in declaration order: the layouts in
 src/core/pipeline/nativeFrame.ts write straight into them.
 */
let hikariMetalSource = #"""
#include <metal_stdlib>
using namespace metal;

constexpr sampler smp(coord::normalized, address::clamp_to_edge, filter::linear);

constant float3 LUMA = float3(0.2126, 0.7152, 0.0722);

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
float3 encode(float3 c) { return float3(encode1(c.r), encode1(c.g), encode1(c.b)); }
float3 decode(float3 c) { return float3(decode1(c.r), decode1(c.g), decode1(c.b)); }
float3 sat3(float3 c) { return clamp(c, float3(0.0), float3(1.0)); }

float3 rgb2hsv(float3 c) {
  float4 K = float4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  float4 p = mix(float4(c.bg, K.wz), float4(c.gb, K.xy), step(c.b, c.g));
  float4 q = mix(float4(p.xyw, c.r), float4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  float e = 1.0e-4;
  return float3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
}
float3 hsv2rgb(float3 c) {
  float3 p = abs(fract(c.xxx + float3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(float3(1.0), sat3(p - 1.0), c.y);
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

float hash12(float2 p) {
  float3 p3 = fract(float3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float3 setLuma(float3 p, float y0, float y1) {
  if (y0 <= 1.0e-4) return p + (y1 - y0);
  float g = clamp(y1 / y0, 0.0, 2.5);
  float3 s = y1 + (p - y0) * g;
  float m = max(s.r, max(s.g, s.b));
  if (m > 1.0) s = y1 + (s - y1) * clamp((1.0 - y1) / max(m - y1, 1.0e-4), 0.0, 1.0);
  return s;
}

float shoulderCurve(float x, float k, float b) {
  if (x <= k) return x;
  float s = x - k;
  return k + s / (1.0 + s * b);
}

float3 highlightShoulder(float3 lin, float white) {
  if (white <= 1.0) return lin;
  float k = 0.8 - 0.35 * smoothstep(1.0, 5.0, log2(white));
  float b = 1.0 / (1.0 - k) - 1.0 / (white - k);
  float peak = max(lin.r, max(lin.g, lin.b));
  if (peak <= k) return lin;
  float3 held = lin * (shoulderCurve(peak, k, b) / peak);
  float3 own = float3(shoulderCurve(lin.r, k, b), shoulderCurve(lin.g, k, b), shoulderCurve(lin.b, k, b));
  return mix(held, own, smoothstep(1.0, 4.0, peak));
}

float toneY(float y, float contrast, float highlights, float shadows, float whites, float blacks) {
  y *= 1.0 + shadows * (shadows > 0.0 ? 1.1 : 0.7) * (1.0 - smoothstep(0.0, 0.7, y));
  if (highlights >= 0.0) y = 1.0 - (1.0 - y) * (1.0 - highlights * 0.6 * smoothstep(0.4, 1.0, y));
  else y *= 1.0 + highlights * 0.35 * smoothstep(0.3, 1.0, y);
  y += whites * 0.3 * smoothstep(0.4, 1.0, y);
  y += blacks * 0.2 * (1.0 - smoothstep(0.0, 0.35, y));
  float yc = clamp(y, 0.0, 1.0);
  float k = 1.0 + contrast * 1.2;
  float sc = contrast < 0.0
    ? yc - contrast * 0.0716 * sin(6.2831853 * yc)
    : (yc < 0.5 ? 0.5 * pow(2.0 * yc, k) : 1.0 - 0.5 * pow(2.0 * (1.0 - yc), k));
  return sc + (y - yc);
}

struct DevelopU {
  packed_float2 uSize;
  float uExposure;
  packed_float3 uWB;
  float uContrast, uHighlights, uShadows, uWhites, uBlacks, uHeadroom, uVibrance, uSaturation;
  float uHslH[8];
  float uHslS[8];
  float uHslL[8];
  packed_float3 uGradeS, uGradeM, uGradeH, uGradeG;
  packed_float2 uGradeLum;
  float uGradeMidLum, uGradeGlobalLum, uBlending, uBalance;
  float uClarity, uTexture, uDehaze, uNoiseL, uNoiseC, uDistortion, uCA, uVigCorr, uBW;
  float uBwMix[8];
  float uHasCurve;
};

struct LocalU {
  packed_float2 uSize;
  float uType;
  packed_float4 uLine;
  packed_float4 uEllipse;
  packed_float2 uEllipseRF;
  float uInvert, uOpacity, uRangeMode;
  packed_float3 uLumRange;
  packed_float3 uColorRange;
  float uOverlay, uExposure, uContrast, uHighlights, uShadows, uWhites, uBlacks;
  packed_float3 uWB;
  float uSaturation, uClarity, uDehaze, uSharpness, uNoise;
  float uTexSlot;
};

struct FinishU {
  packed_float2 uSize;
  float uSharpen, uSharpDetail, uSharpMask, uLutSize, uLutMix;
  packed_float4 uCrop;
  packed_float4 uVignette;
  packed_float3 uGrain;
  float uGrainScale;
  packed_float3 uBloom;
  packed_float3 uHalation;
  float uClip, uOutMode, uOutP3;
};

#define T texture2d<float>
float4 at(T t, float2 p, float2 size) { return t.sample(smp, p / size); }
float3 linAt(T t, float2 p, float2 size) { return decode(at(t, p, size).rgb); }

/** Returns the encoded color; alpha 0 marks pixels outside the lens-corrected frame. */
float4 develop(float2 p, constant DevelopU &U, T image, T blurN, T blurM, T blurL, T curve) {
  float2 size = float2(U.uSize);
  float2 c = size * 0.5;
  float rn = length(c);
  float2 d = (p - c) / rn;
  float r2 = dot(d, d);
  float2 q = c + d * (1.0 + U.uDistortion * r2) * rn;

  float3 lin = float3(0.0);
  if (U.uCA > 0.0) {
    float2 dq = q - c;
    lin.r = linAt(image, c + dq * (1.0 - U.uCA), size).r;
    lin.g = linAt(image, q, size).g;
    lin.b = linAt(image, c + dq * (1.0 + U.uCA), size).b;
  } else {
    lin = linAt(image, q, size);
  }
  float alpha = at(image, q, size).a;
  if (q.x < 0.0 || q.y < 0.0 || q.x > size.x || q.y > size.y) return float4(0.0);

  float3 wb = float3(U.uWB);
  float3 bs = linAt(blurN, q, size);
  float3 bm = linAt(blurM, q, size);
  if (U.uNoiseL > 0.0) {
    float ey = encode1(dot(lin, LUMA)) - encode1(dot(bs, LUMA));
    float w = exp(-(ey * ey) / (0.0004 + 0.004 * U.uNoiseL));
    lin = mix(lin, bs, U.uNoiseL * w);
  }
  if (U.uNoiseC > 0.0) {
    float yl = dot(lin, LUMA);
    float ym = dot(bm, LUMA);
    float3 chroma = mix(lin - yl, (bm - ym) * (yl / max(ym, 1.0e-4)), U.uNoiseC);
    lin = yl + chroma;
  }

  lin *= 1.0 + U.uVigCorr * r2;
  lin *= wb;
  lin *= exp2(U.uExposure);

  lin = highlightShoulder(lin, U.uHeadroom);

  float3 e = encode(lin);
  if (U.uDehaze != 0.0) {
    float3 bl = encode(linAt(blurL, q, size) * wb * exp2(U.uExposure));
    float dark = min(bl.r, min(bl.g, bl.b));
    if (U.uDehaze > 0.0) {
      float t = max(1.0 - U.uDehaze * 0.85 * dark, 0.15);
      e = (e - 0.92 * (1.0 - t)) / t;
      e = mix(e, e * (1.0 + U.uDehaze * 0.15), 0.5);
    } else {
      e = mix(e, float3(0.82), -U.uDehaze * 0.5 * (0.4 + dark));
    }
  }

  float y0 = dot(e, LUMA);
  float y = toneY(y0, U.uContrast, U.uHighlights, U.uShadows, U.uWhites, U.uBlacks);

  if (U.uClarity != 0.0 || U.uTexture != 0.0) {
    float yl = encode1(dot(linAt(blurL, q, size), LUMA));
    float ym = encode1(dot(bm, LUMA));
    float ys = encode1(dot(linAt(image, q, size), LUMA));
    float mid = clamp(1.0 - abs(y - 0.5) * 1.6, 0.0, 1.0);
    y += U.uClarity * 0.7 * (ys - yl) * mid;
    y += U.uTexture * 1.2 * (ys - ym);
  }
  e = setLuma(e, y0, y);

  if (U.uHasCurve > 0.5) {
    float3 cc = sat3(e);
    float3 over = e - cc;
    e.r = curve.sample(smp, float2((cc.r * 255.0 + 0.5) / 256.0, 0.5)).r;
    e.g = curve.sample(smp, float2((cc.g * 255.0 + 0.5) / 256.0, 0.5)).g;
    e.b = curve.sample(smp, float2((cc.b * 255.0 + 0.5) / 256.0, 0.5)).b;
    e += over;
  }

  float3 hsv = rgb2hsv(sat3(e));
  float dh = 0.0, ds = 0.0, dl = 0.0;
  for (int i = 0; i < 8; i++) {
    float w = bandWeight(hsv.x, i);
    dh += w * U.uHslH[i];
    ds += w * U.uHslS[i];
    dl += w * U.uHslL[i];
  }
  if (dh != 0.0 || ds != 0.0 || dl != 0.0) {
    float yb = dot(e, LUMA);
    float3 h2 = float3(fract(hsv.x + dh * (30.0 / 360.0)), clamp(hsv.y * (1.0 + ds), 0.0, 1.0), hsv.z);
    float3 rgb = hsv2rgb(h2) + (e - sat3(e));
    float ya = dot(rgb, LUMA);
    float target = yb * (1.0 + dl * 0.6 * hsv.y);
    e = setLuma(rgb, ya, target);
  }

  float ye = dot(e, LUMA);
  float sat = max(e.r, max(e.g, e.b)) - min(e.r, min(e.g, e.b));
  float skin = smoothstep(0.0, 0.08, abs(hsv.x - 0.07));
  float vib = U.uVibrance * (1.0 - sat) * (U.uVibrance > 0.0 ? mix(0.5, 1.0, skin) : 1.0);
  e = ye + (e - ye) * max(0.0, 1.0 + U.uSaturation + vib);

  float yg = clamp(dot(e, LUMA), 0.0, 1.0);
  float bal = U.uBalance * 0.5;
  float spread = mix(0.15, 0.6, U.uBlending);
  float wS = 1.0 - smoothstep(0.0, 0.5 + bal + spread * 0.5, yg);
  float wH = smoothstep(0.5 + bal - spread * 0.5, 1.0, yg);
  float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
  e += float3(U.uGradeS) * wS + float3(U.uGradeM) * wM + float3(U.uGradeH) * wH + float3(U.uGradeG);
  e += U.uGradeLum[0] * wS * 0.3 + U.uGradeMidLum * wM * 0.3 + U.uGradeLum[1] * wH * 0.3 + U.uGradeGlobalLum * 0.3;

  if (U.uBW > 0.5) {
    float3 hs = rgb2hsv(sat3(e));
    float k = 0.0;
    for (int i = 0; i < 8; i++) k += bandWeight(hs.x, i) * U.uBwMix[i];
    float g = dot(e, LUMA) * (1.0 + k * hs.y);
    e = float3(g);
  }
  return float4(e, alpha);
}

float maskAt(float2 p, float3 e, constant LocalU &U, T mask) {
  float2 size = float2(U.uSize);
  float2 n = p / size;
  float aspect = size.x / size.y;
  float2 asp = float2(aspect, 1.0);
  float m = 1.0;
  float4 line = float4(U.uLine);
  float4 ellipse = float4(U.uEllipse);
  float2 rf = float2(U.uEllipseRF);
  float3 lumRange = float3(U.uLumRange);
  float3 colorRange = float3(U.uColorRange);
  if (U.uType < 0.5) {
    m = mask.sample(smp, n).r;
  } else if (U.uType < 1.5) {
    float2 a = line.xy; float2 b = line.zw;
    float2 ab = (b - a) * asp;
    float t = dot((n - a) * asp, ab) / max(dot(ab, ab), 1.0e-6);
    m = 1.0 - smoothstep(0.0, 1.0, t);
  } else if (U.uType < 2.5) {
    float2 dd = (n - ellipse.xy) * asp;
    float ca = cos(rf.x); float sa = sin(rf.x);
    dd = float2(ca * dd.x + sa * dd.y, -sa * dd.x + ca * dd.y);
    float2 rr = ellipse.zw * asp;
    float r = length(dd / max(rr, float2(1.0e-4)));
    float f = max(rf.y, 0.001);
    m = 1.0 - smoothstep(1.0 - f, 1.0, r);
  }
  if (U.uRangeMode > 0.5 && U.uRangeMode < 1.5) {
    float y = dot(sat3(e), LUMA);
    float lo = smoothstep(lumRange.x - lumRange.z, lumRange.x + lumRange.z, y);
    float hi = 1.0 - smoothstep(lumRange.y - lumRange.z, lumRange.y + lumRange.z, y);
    m *= lo * hi;
  } else if (U.uRangeMode > 1.5) {
    float3 hsv = rgb2hsv(sat3(e));
    float dh = abs(hsv.x - colorRange.x); dh = min(dh, 1.0 - dh);
    float tol = max(colorRange.z, 0.01);
    float wHue = 1.0 - smoothstep(tol * 0.5, tol, dh);
    float wSat = smoothstep(0.05, 0.05 + tol * 0.5, hsv.y);
    m *= wHue * wSat;
  }
  if (U.uInvert > 0.5) m = 1.0 - m;
  return clamp(m * U.uOpacity, 0.0, 1.0);
}

float4 local(float2 p, float4 inC, constant LocalU &U, T mask, T source, T blurL) {
  float2 size = float2(U.uSize);
  float3 e = inC.rgb;
  float m = maskAt(p, e, U, mask);
  if (m <= 0.0005) return inC;

  float3 lin = highlightShoulder(decode(e) * float3(U.uWB) * exp2(U.uExposure), max(exp2(U.uExposure), 1.0));
  float3 a = encode(lin);
  if (U.uDehaze != 0.0) {
    float3 bl = at(blurL, p, size).rgb;
    float dark = min(bl.r, min(bl.g, bl.b));
    float t = max(1.0 - max(U.uDehaze, 0.0) * 0.85 * dark, 0.15);
    a = U.uDehaze > 0.0 ? (a - 0.92 * (1.0 - t)) / t : mix(a, float3(0.82), -U.uDehaze * 0.5);
  }
  float y0 = dot(a, LUMA);
  float y = toneY(y0, U.uContrast, U.uHighlights, U.uShadows, U.uWhites, U.uBlacks);
  float3 src = linAt(source, p, size);
  if (U.uClarity != 0.0) {
    float yl = encode1(dot(linAt(blurL, p, size), LUMA));
    float ys = encode1(dot(src, LUMA));
    y += U.uClarity * 0.7 * (ys - yl) * clamp(1.0 - abs(y - 0.5) * 1.6, 0.0, 1.0);
  }
  a = setLuma(a, y0, y);
  float ya = dot(a, LUMA);
  a = ya + (a - ya) * max(0.0, 1.0 + U.uSaturation);

  if (U.uSharpness != 0.0 || U.uNoise != 0.0) {
    float3 n1 = linAt(source, p + float2(1.0, 0.0), size);
    float3 n2 = linAt(source, p - float2(1.0, 0.0), size);
    float3 n3 = linAt(source, p + float2(0.0, 1.0), size);
    float3 n4 = linAt(source, p - float2(0.0, 1.0), size);
    float hf = encode1(dot(src, LUMA)) - encode1(dot((n1 + n2 + n3 + n4) * 0.25, LUMA));
    a += (U.uSharpness > 0.0 ? U.uSharpness * 1.5 : U.uSharpness * 0.8) * hf;
    a -= U.uNoise * hf * 0.9;
  }

  float3 outE = mix(e, a, m);
  if (U.uOverlay > 0.5) outE = mix(outE, float3(1.0, 0.15, 0.2), m * 0.45);
  return float4(outE, inC.a);
}

float3 lut3(float3 c, float n, T lut) {
  float2 size = float2(n * n, n);
  float3 x = sat3(c) * (n - 1.0);
  float b0 = floor(x.b);
  float b1 = min(b0 + 1.0, n - 1.0);
  float fb = x.b - b0;
  float2 p0 = float2(b0 * n + x.r + 0.5, x.g + 0.5);
  float2 p1 = float2(b1 * n + x.r + 0.5, x.g + 0.5);
  return mix(at(lut, p0, size).rgb, at(lut, p1, size).rgb, fb);
}

constant float3x3 SRGB_TO_P3 = float3x3(
  float3(0.822462, 0.033194, 0.017083),
  float3(0.177538, 0.966806, 0.072397),
  float3(0.000000, 0.000000, 0.910520));

float4 finish(float2 p, float4 inC, constant FinishU &U, T source, T blurS, T blurM, T blurL, T lut) {
  float2 size = float2(U.uSize);
  float3 e = inC.rgb;

  if (U.uSharpen > 0.0) {
    float ys = encode1(dot(linAt(source, p, size), LUMA));
    float yb = encode1(dot(linAt(blurS, p, size), LUMA));
    float ym = encode1(dot(linAt(blurM, p, size), LUMA));
    float hf = ys - yb;
    float lim = mix(0.02, 0.25, U.uSharpDetail);
    hf = clamp(hf, -lim, lim);
    float edge = smoothstep(0.0, 0.02 + 0.2 * U.uSharpMask, abs(ys - ym) + abs(hf));
    float w = U.uSharpMask > 0.0 ? edge : 1.0;
    e += U.uSharpen * 2.2 * hf * w;
  }

  if (U.uLutMix > 0.0) e = mix(e, lut3(e, U.uLutSize, lut), U.uLutMix);

  float3 bloom = float3(U.uBloom);
  float3 halation = float3(U.uHalation);
  if (bloom.x > 0.0 || halation.x > 0.0) {
    float3 gm = encode(max(linAt(blurM, p, size), float3(0.0)));
    float3 gl = encode(max(linAt(blurL, p, size), float3(0.0)));
    float3 room = 1.0 - sat3(e);
    if (bloom.x > 0.0) {
      float3 g = mix(gm, gl, bloom.z);
      float k = smoothstep(bloom.y - 0.18, bloom.y + 0.12, dot(g, LUMA));
      e += sat3(g * k) * bloom.x * room;
    }
    if (halation.x > 0.0) {
      float ys = encode1(max(dot(linAt(source, p, size), LUMA), 0.0));
      float yg = dot(mix(gm, gl, halation.z), LUMA);
      float t = halation.y;
      float halo = smoothstep(t - 0.15, t + 0.1, yg) * (1.0 - 0.7 * smoothstep(t - 0.05, t + 0.1, ys));
      e += float3(1.0, 0.3, 0.1) * halo * halation.x * 0.8 * room;
    }
  }

  float4 vignette = float4(U.uVignette);
  float4 crop = float4(U.uCrop);
  if (vignette.x != 0.0) {
    float2 cc = crop.xy + crop.zw * 0.5;
    float2 dd = (p - cc) / (crop.zw * 0.5);
    float roundness = vignette.w;
    float aspect = crop.z / crop.w;
    dd.x *= mix(1.0, aspect, clamp(roundness, 0.0, 1.0));
    float pw = mix(2.0, 6.0, clamp(-roundness, 0.0, 1.0));
    float r = pow(pow(abs(dd.x), pw) + pow(abs(dd.y), pw), 1.0 / pw);
    float mid = mix(0.2, 1.3, vignette.y);
    float feather = mix(0.05, 1.2, vignette.z);
    float v = smoothstep(mid - feather * 0.5, mid + feather * 0.5, r);
    if (vignette.x < 0.0) e *= 1.0 + vignette.x * v;
    else e = mix(e, float3(1.0), vignette.x * v * 0.9);
  }

  float3 grain = float3(U.uGrain);
  if (grain.x > 0.0) {
    float2 g = p / (U.uGrainScale * mix(0.7, 3.0, grain.y));
    float n1 = hash12(floor(g));
    float n2 = hash12(floor(g * 2.1) + 17.0);
    float n = mix(n1, (n1 + n2) * 0.5, 1.0 - grain.z) - 0.5;
    float y = clamp(dot(e, LUMA), 0.0, 1.0);
    e += n * grain.x * 0.22 * (0.4 + 0.6 * (1.0 - abs(y - 0.5) * 2.0));
  }

  // data output: the stored values are the target-space code values, at the target's bit depth
  if (U.uOutMode > 0.5) {
    float3 lin = decode(e);
    if (U.uOutP3 > 0.5) lin = SRGB_TO_P3 * lin;
    return float4(sat3(encode(lin)), 1.0);
  }

  if (U.uClip > 0.5) {
    float hi = max(e.r, max(e.g, e.b));
    float lo = min(e.r, min(e.g, e.b));
    if (hi >= 0.999) e = float3(1.0, 0.1, 0.25);
    else if (lo <= 0.001) e = float3(0.1, 0.35, 1.0);
  }
  return float4(e, inC.a);
}

struct VOut {
  float4 pos [[position]];
  float2 p;
};

/** The image rectangle through a row-major 3x3 (perspective) matrix into target pixels. */
vertex VOut imageVertex(uint vid [[vertex_id]],
                        constant float *m [[buffer(0)]],
                        constant packed_float2 &targetSize [[buffer(1)]],
                        constant packed_float2 &imageSize [[buffer(2)]]) {
  float2 size = float2(imageSize);
  float2 t = float2(targetSize);
  float2 p = float2((vid & 1) ? size.x : 0.0, (vid & 2) ? size.y : 0.0);
  float X = m[0] * p.x + m[1] * p.y + m[2];
  float Y = m[3] * p.x + m[4] * p.y + m[5];
  float W = m[6] * p.x + m[7] * p.y + m[8];
  VOut o;
  o.pos = float4(2.0 * X / t.x - W, W - 2.0 * Y / t.y, 0.0, W);
  o.p = p;
  return o;
}

fragment float4 recipeFragment(VOut in [[stage_in]],
                               constant DevelopU &D [[buffer(0)]],
                               constant FinishU &F [[buffer(1)]],
                               constant LocalU *L [[buffer(2)]],
                               constant uint &localCount [[buffer(3)]],
                               T image [[texture(0)]],
                               T blurN [[texture(1)]],
                               T blurS [[texture(2)]],
                               T blurM [[texture(3)]],
                               T blurL [[texture(4)]],
                               T curve [[texture(5)]],
                               T lut [[texture(6)]],
                               array<T, 24> masks [[texture(7)]]) {
  float2 p = in.p;
  float4 c = develop(p, D, image, blurN, blurM, blurL, curve);
  for (uint i = 0; i < localCount; i++) {
    c = local(p, c, L[i], masks[int(L[i].uTexSlot)], image, blurL);
  }
  return finish(p, c, F, image, blurS, blurM, blurL, lut);
}

fragment float4 originalFragment(VOut in [[stage_in]],
                                 constant packed_float2 &imageSize [[buffer(0)]],
                                 T image [[texture(0)]]) {
  return image.sample(smp, in.p / float2(imageSize));
}

// ---- image helpers ----

struct UvOut {
  float4 pos [[position]];
  float2 uv;
};

/** Covers a rectangle of the target, given in normalized device-independent [0, 1] coordinates. */
vertex UvOut rectVertex(uint vid [[vertex_id]], constant packed_float4 &rect [[buffer(0)]]) {
  float4 r = float4(rect);
  float2 uv = float2((vid & 1) ? 1.0 : 0.0, (vid & 2) ? 1.0 : 0.0);
  float2 q = r.xy + uv * r.zw;
  UvOut o;
  o.pos = float4(q.x * 2.0 - 1.0, 1.0 - q.y * 2.0, 0.0, 1.0);
  o.uv = uv;
  return o;
}

fragment float4 copyFragment(UvOut in [[stage_in]], T src [[texture(0)]]) {
  return src.sample(smp, in.uv);
}

fragment float4 gaussFragment(UvOut in [[stage_in]],
                              constant float &sigma [[buffer(0)]],
                              constant packed_int2 &dir [[buffer(1)]],
                              T src [[texture(0)]]) {
  int w = src.get_width();
  int h = src.get_height();
  int2 coord = clamp(int2(floor(in.uv * float2(w, h))), int2(0), int2(w - 1, h - 1));
  int r = int(ceil(3.0 * sigma));
  float k = -0.5 / (sigma * sigma);
  int2 d = int2(dir);
  float4 sum = float4(0.0);
  float total = 0.0;
  for (int i = -r; i <= r; i++) {
    int2 q = clamp(coord + d * i, int2(0), int2(w - 1, h - 1));
    float g = exp(k * float(i * i));
    sum += src.read(uint2(q)) * g;
    total += g;
  }
  return sum / total;
}
"""#
