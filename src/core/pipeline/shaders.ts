/**
 * SkSL sources for the develop pipeline.
 *
 * Color handling: every child is sampled in Skia's working color space and converted
 * with toLinearSrgb(), so the math always runs in *linear, extended sRGB* no matter
 * whether the destination is an sRGB screen, a Display-P3 screen or a P3 export
 * surface. Values may exceed [0,1] (RAW headroom, wide gamut). Data textures (curve LUT,
 * 3D LUT, masks) are round-tripped through the same conversion so their stored values
 * survive any working space.
 *
 * Pass order: DEVELOP (source → tone → color) → LOCAL (one pass per mask) → FINISH
 * (detail, LUT, vignette, grain, clipping).
 */

const COMMON = /* sksl */ `
const float3 LUMA = float3(0.2126, 0.7152, 0.0722);

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

// Decode a sample of a texture that stores plain data (not colors), in any working space.
float3 dataOf(float4 v) { return encode(toLinearSrgb(v.rgb)); }

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
  return c.z * mix(float3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}

// Smooth membership of hue h (0..1) to the 8 color bands.
// Centers: red 0, orange 30, yellow 60, green 120, aqua 180, blue 240, purple 270, magenta 300.
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

// Luminance-preserving scale of an encoded color to a new luminance.
float3 setLuma(float3 p, float y0, float y1) {
  if (y0 <= 1.0e-4) return p + (y1 - y0);
  float3 s = p * (y1 / y0);
  // Desaturate toward white when pushed past 1 so highlights roll off cleanly.
  float m = max(s.r, max(s.g, s.b));
  if (m > 1.0) s = mix(s, float3(y1), clamp((m - 1.0) / max(m, 1.0e-3), 0.0, 1.0));
  return s;
}

float toneY(float y, float contrast, float highlights, float shadows, float whites, float blacks) {
  // shadows / highlights act on smooth luminance zones
  float ws = 1.0 - smoothstep(0.0, 0.6, y);
  float wh = smoothstep(0.4, 1.0, y);
  y += shadows * 0.45 * ws * ws * (1.0 - y * 0.5);
  y += highlights * 0.4 * wh * wh * (highlights < 0.0 ? max(y, 0.4) : (1.0 - y * 0.6));
  // whites / blacks move the end points
  y += whites * 0.3 * smoothstep(0.55, 1.0, y);
  y += blacks * 0.2 * (1.0 - smoothstep(0.0, 0.35, y));
  // contrast: symmetric power S-curve around mid grey
  float k = contrast >= 0.0 ? 1.0 + contrast * 1.2 : 1.0 / (1.0 - contrast * 0.8);
  float yc = clamp(y, 0.0, 1.0);
  float sc = yc < 0.5 ? 0.5 * pow(2.0 * yc, k) : 1.0 - 0.5 * pow(2.0 * (1.0 - yc), k);
  return sc + (y - yc);
}
`;

export const DEVELOP_SKSL = /* sksl */ `
uniform shader image;
uniform shader blurS;
uniform shader blurM;
uniform shader blurL;
uniform shader curve;

uniform float2 uSize;
uniform float uExposure;
uniform float3 uWB;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uHeadroom;
uniform float uVibrance;
uniform float uSaturation;
uniform float uHslH[8];
uniform float uHslS[8];
uniform float uHslL[8];
uniform float3 uGradeS;
uniform float3 uGradeM;
uniform float3 uGradeH;
uniform float3 uGradeG;
uniform float2 uGradeLum;
uniform float uGradeMidLum;
uniform float uGradeGlobalLum;
uniform float uBlending;
uniform float uBalance;
uniform float uClarity;
uniform float uTexture;
uniform float uDehaze;
uniform float uNoiseL;
uniform float uNoiseC;
uniform float uDistortion;
uniform float uCA;
uniform float uVigCorr;
uniform float uBW;
uniform float uBwMix[8];
uniform float uHasCurve;
${COMMON}


half4 main(float2 p) {
  float2 c = uSize * 0.5;
  float rn = length(c);
  float2 d = (p - c) / rn;
  float r2 = dot(d, d);
  // lens distortion (barrel/pincushion), radial model
  float2 q = c + d * (1.0 + uDistortion * r2) * rn;

  float3 lin = float3(0.0);
  if (uCA > 0.0) {
    float2 dq = q - c;
    lin.r = toLinearSrgb(image.eval(c + dq * (1.0 - uCA)).rgb).r;
    lin.g = toLinearSrgb(image.eval(q).rgb).g;
    lin.b = toLinearSrgb(image.eval(c + dq * (1.0 + uCA)).rgb).b;
  } else {
    lin = toLinearSrgb(image.eval(q).rgb);
  }
  float alpha = image.eval(q).a;
  if (q.x < 0.0 || q.y < 0.0 || q.x > uSize.x || q.y > uSize.y) return float4(0.0);

  // --- noise reduction on the source (edge-aware luma + chroma smoothing)
  float3 bs = toLinearSrgb(blurS.eval(q).rgb);
  float3 bm = toLinearSrgb(blurM.eval(q).rgb);
  if (uNoiseL > 0.0) {
    float ey = encode1(dot(lin, LUMA)) - encode1(dot(bs, LUMA));
    float w = exp(-(ey * ey) / (0.0004 + 0.004 * uNoiseL));
    lin = mix(lin, bs, uNoiseL * w);
  }
  if (uNoiseC > 0.0) {
    float yl = dot(lin, LUMA);
    float ym = dot(bm, LUMA);
    float3 chroma = mix(lin - yl, (bm - ym) * (yl / max(ym, 1.0e-4)), uNoiseC);
    lin = yl + chroma;
  }

  // --- lens vignette correction, white balance, exposure
  lin *= 1.0 + uVigCorr * r2;
  lin *= float3(uWB);
  lin *= exp2(uExposure);

  // --- highlight shoulder: compress >1 headroom smoothly into display range
  float peak = max(lin.r, max(lin.g, lin.b));
  if (peak > 0.8 && uHeadroom > 0.5) {
    // C1-continuous knee: maps [0.8, inf) onto [0.8, 1.0)
    float comp = 0.8 + 0.2 * (1.0 - exp(-(peak - 0.8) / 0.2));
    lin *= comp / peak;
  }

  // --- dehaze (dark-channel prior on the large blur)
  float3 e = encode(lin);
  if (uDehaze != 0.0) {
    float3 bl = encode(toLinearSrgb(blurL.eval(q).rgb) * float3(uWB) * exp2(uExposure));
    float dark = min(bl.r, min(bl.g, bl.b));
    if (uDehaze > 0.0) {
      float t = max(1.0 - uDehaze * 0.85 * dark, 0.15);
      e = (e - 0.92 * (1.0 - t)) / t;
      e = mix(e, e * (1.0 + uDehaze * 0.15), 0.5);
    } else {
      e = mix(e, float3(0.82), -uDehaze * 0.5 * (0.4 + dark));
    }
  }

  // --- tone (on perceptual luminance, hue preserving)
  float y0 = dot(e, LUMA);
  float y = toneY(y0, uContrast, uHighlights, uShadows, uWhites, uBlacks);

  // clarity (large-scale local contrast) and texture (mid-scale), midtone weighted
  if (uClarity != 0.0 || uTexture != 0.0) {
    float yl = encode1(dot(toLinearSrgb(blurL.eval(q).rgb), LUMA));
    float ym = encode1(dot(bm, LUMA));
    float ys = encode1(dot(toLinearSrgb(image.eval(q).rgb), LUMA));
    float mid = 1.0 - abs(y - 0.5) * 1.6;
    mid = clamp(mid, 0.0, 1.0);
    y += uClarity * 0.7 * (ys - yl) * mid;
    y += uTexture * 1.2 * (ys - ym);
  }
  e = setLuma(e, y0, y);

  // --- tone curve (composite master+channel LUT)
  if (uHasCurve > 0.5) {
    float3 cc = clamp(e, 0.0, 1.0);
    float3 over = e - cc;
    e.r = dataOf(curve.eval(float2(cc.r * 255.0 + 0.5, 0.5))).r;
    e.g = dataOf(curve.eval(float2(cc.g * 255.0 + 0.5, 0.5))).g;
    e.b = dataOf(curve.eval(float2(cc.b * 255.0 + 0.5, 0.5))).b;
    e += over;
  }

  // --- HSL mixer
  float3 hsv = rgb2hsv(clamp(e, 0.0, 1.0));
  float dh = 0.0; float ds = 0.0; float dl = 0.0;
  for (int i = 0; i < 8; i++) {
    float w = bandWeight(hsv.x, i);
    dh += w * uHslH[i];
    ds += w * uHslS[i];
    dl += w * uHslL[i];
  }
  if (dh != 0.0 || ds != 0.0 || dl != 0.0) {
    float yb = dot(e, LUMA);
    float3 h2 = float3(fract(hsv.x + dh * (30.0 / 360.0)), clamp(hsv.y * (1.0 + ds), 0.0, 1.0), hsv.z);
    float3 rgb = hsv2rgb(h2) + (e - clamp(e, 0.0, 1.0));
    float ya = dot(rgb, LUMA);
    float target = yb * (1.0 + dl * 0.6 * hsv.y);
    e = setLuma(rgb, ya, target);
  }

  // --- vibrance / saturation
  float ye = dot(e, LUMA);
  float sat = max(e.r, max(e.g, e.b)) - min(e.r, min(e.g, e.b));
  float skin = smoothstep(0.0, 0.08, abs(hsv.x - 0.07));
  float vib = uVibrance * (1.0 - sat) * (uVibrance > 0.0 ? mix(0.5, 1.0, skin) : 1.0);
  e = ye + (e - ye) * max(0.0, 1.0 + uSaturation + vib);

  // --- color grading (3-way + global)
  float yg = clamp(dot(e, LUMA), 0.0, 1.0);
  float bal = uBalance * 0.5;
  float spread = mix(0.15, 0.6, uBlending);
  float wS = 1.0 - smoothstep(0.0, 0.5 + bal + spread * 0.5, yg);
  float wH = smoothstep(0.5 + bal - spread * 0.5, 1.0, yg);
  float wM = clamp(1.0 - wS - wH, 0.0, 1.0);
  e += float3(uGradeS) * wS + float3(uGradeM) * wM + float3(uGradeH) * wH + float3(uGradeG);
  e += uGradeLum.x * wS * 0.3 + uGradeMidLum * wM * 0.3 + uGradeLum.y * wH * 0.3 + uGradeGlobalLum * 0.3;

  // --- black & white mixer
  if (uBW > 0.5) {
    float3 hs = rgb2hsv(clamp(e, 0.0, 1.0));
    float k = 0.0;
    for (int i = 0; i < 8; i++) k += bandWeight(hs.x, i) * uBwMix[i];
    float g = dot(e, LUMA) * (1.0 + k * hs.y);
    e = float3(g);
  }

  return float4(fromLinearSrgb(decode(e)), alpha);
}
`;

/** One local adjustment pass. Mask is computed parametrically or read from a texture. */
export const LOCAL_SKSL = /* sksl */ `
uniform shader prev;
uniform shader mask;
uniform shader source;
uniform shader blurL;

uniform float2 uSize;
uniform float uType;      // 0 texture, 1 linear, 2 radial, 3 full (range only)
uniform float4 uLine;     // x1,y1,x2,y2 normalized
uniform float4 uEllipse;  // cx,cy,rx,ry normalized
uniform float2 uEllipseRF; // angle, feather
uniform float uInvert;
uniform float uOpacity;
uniform float uRangeMode; // 0 none, 1 luminance, 2 color
uniform float3 uLumRange; // low, high, smooth
uniform float3 uColorRange; // hue 0..1, sat, tolerance
uniform float uOverlay;   // 1 = draw red mask overlay
uniform float uExposure;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float3 uWB;
uniform float uSaturation;
uniform float uClarity;
uniform float uDehaze;
uniform float uSharpness;
uniform float uNoise;
${COMMON}

float maskAt(float2 p, float3 e) {
  float2 n = p / uSize;
  float aspect = uSize.x / uSize.y;
  float m = 1.0;
  if (uType < 0.5) {
    m = dataOf(mask.eval(p)).r;
  } else if (uType < 1.5) {
    float2 a = uLine.xy; float2 b = uLine.zw;
    float2 ab = (b - a) * float2(aspect, 1.0);
    float t = dot((n - a) * float2(aspect, 1.0), ab) / max(dot(ab, ab), 1.0e-6);
    m = 1.0 - smoothstep(0.0, 1.0, t);
  } else if (uType < 2.5) {
    float2 dd = (n - uEllipse.xy) * float2(aspect, 1.0);
    float ca = cos(uEllipseRF.x); float sa = sin(uEllipseRF.x);
    dd = float2(ca * dd.x + sa * dd.y, -sa * dd.x + ca * dd.y);
    float2 rr = uEllipse.zw * float2(aspect, 1.0);
    float r = length(dd / max(rr, float2(1.0e-4)));
    float f = max(uEllipseRF.y, 0.001);
    m = 1.0 - smoothstep(1.0 - f, 1.0, r);
  }
  if (uRangeMode > 0.5 && uRangeMode < 1.5) {
    float y = dot(clamp(e, 0.0, 1.0), LUMA);
    float lo = smoothstep(uLumRange.x - uLumRange.z, uLumRange.x + uLumRange.z, y);
    float hi = 1.0 - smoothstep(uLumRange.y - uLumRange.z, uLumRange.y + uLumRange.z, y);
    m *= lo * hi;
  } else if (uRangeMode > 1.5) {
    float3 hsv = rgb2hsv(clamp(e, 0.0, 1.0));
    float dh = abs(hsv.x - uColorRange.x); dh = min(dh, 1.0 - dh);
    float tol = max(uColorRange.z, 0.01);
    float wHue = 1.0 - smoothstep(tol * 0.5, tol, dh);
    float wSat = smoothstep(0.05, 0.05 + tol * 0.5, hsv.y);
    m *= wHue * wSat;
  }
  if (uInvert > 0.5) m = 1.0 - m;
  return clamp(m * uOpacity, 0.0, 1.0);
}

half4 main(float2 p) {
  float4 inC = prev.eval(p);
  float3 e = encode(toLinearSrgb(inC.rgb));
  float m = maskAt(p, e);
  if (m <= 0.0005) return inC;

  float3 lin = decode(e) * float3(uWB) * exp2(uExposure);
  float3 a = encode(lin);
  if (uDehaze != 0.0) {
    float3 bl = encode(toLinearSrgb(blurL.eval(p).rgb));
    float dark = min(bl.r, min(bl.g, bl.b));
    float t = max(1.0 - max(uDehaze, 0.0) * 0.85 * dark, 0.15);
    a = uDehaze > 0.0 ? (a - 0.92 * (1.0 - t)) / t : mix(a, float3(0.82), -uDehaze * 0.5);
  }
  float y0 = dot(a, LUMA);
  float y = toneY(y0, uContrast, uHighlights, uShadows, uWhites, uBlacks);
  float3 src = toLinearSrgb(source.eval(p).rgb);
  if (uClarity != 0.0) {
    float yl = encode1(dot(toLinearSrgb(blurL.eval(p).rgb), LUMA));
    float ys = encode1(dot(src, LUMA));
    y += uClarity * 0.7 * (ys - yl) * clamp(1.0 - abs(y - 0.5) * 1.6, 0.0, 1.0);
  }
  a = setLuma(a, y0, y);
  float ya = dot(a, LUMA);
  a = ya + (a - ya) * max(0.0, 1.0 + uSaturation);

  if (uSharpness != 0.0 || uNoise != 0.0) {
    float3 n1 = toLinearSrgb(source.eval(p + float2(1.0, 0.0)).rgb);
    float3 n2 = toLinearSrgb(source.eval(p - float2(1.0, 0.0)).rgb);
    float3 n3 = toLinearSrgb(source.eval(p + float2(0.0, 1.0)).rgb);
    float3 n4 = toLinearSrgb(source.eval(p - float2(0.0, 1.0)).rgb);
    float hf = encode1(dot(src, LUMA)) - encode1(dot((n1 + n2 + n3 + n4) * 0.25, LUMA));
    a += (uSharpness > 0.0 ? uSharpness * 1.5 : uSharpness * 0.8) * hf;
    a -= uNoise * hf * 0.9;
  }

  float3 outE = mix(e, a, m);
  if (uOverlay > 0.5) outE = mix(outE, float3(1.0, 0.15, 0.2), m * 0.45);
  return float4(fromLinearSrgb(decode(outE)), inC.a);
}
`;

export const FINISH_SKSL = /* sksl */ `
uniform shader prev;
uniform shader source;
uniform shader blurS;
uniform shader blurM;
uniform shader blurL;
uniform shader lut;

uniform float2 uSize;
uniform float uSharpen;
uniform float uSharpDetail;
uniform float uSharpMask;
uniform float uLutSize;
uniform float uLutMix;
uniform float4 uCrop;       // x,y,w,h in image px (post-crop frame for vignette)
uniform float4 uVignette;   // amount, midpoint, feather, roundness
uniform float3 uGrain;      // amount, size, roughness
uniform float uGrainScale;  // pixels per grain unit (resolution independence)
uniform float3 uBloom;      // amount, threshold, radius
uniform float3 uHalation;   // amount, threshold, radius
uniform float uClip;        // 1 = show clipping
uniform float uOutMode;     // 0 display, 1 data 8-bit, 2 high byte of 16-bit, 3 low byte
uniform float uOutP3;       // data modes: encode values in Display P3 instead of sRGB
${COMMON}

// linear sRGB → linear Display P3
const float3x3 SRGB_TO_P3 = float3x3(
  0.822462, 0.033194, 0.017083,
  0.177538, 0.966806, 0.072397,
  0.000000, 0.000000, 0.910520);

// Export path: write the final encoded value as raw data so the stored bytes are exactly
// the target-space code values (8 bit, or the high/low bytes of 16 bit) on an sRGB surface.
half4 dataOut(float3 e) {
  float3 lin = decode(e);
  if (uOutP3 > 0.5) lin = SRGB_TO_P3 * lin;
  float3 v = clamp(encode(lin), 0.0, 1.0);
  float3 d = v;
  if (uOutMode > 1.5) {
    float3 x = floor(v * 65535.0 + 0.5);
    float3 hi = floor(x / 256.0);
    d = (uOutMode < 2.5 ? hi : x - hi * 256.0) / 255.0;
  }
  return half4(fromLinearSrgb(decode(d)), 1.0);
}

float3 lut3(float3 c) {
  float n = uLutSize;
  float3 x = clamp(c, 0.0, 1.0) * (n - 1.0);
  float b0 = floor(x.b);
  float b1 = min(b0 + 1.0, n - 1.0);
  float fb = x.b - b0;
  float2 p0 = float2(b0 * n + x.r + 0.5, x.g + 0.5);
  float2 p1 = float2(b1 * n + x.r + 0.5, x.g + 0.5);
  return mix(dataOf(lut.eval(p0)), dataOf(lut.eval(p1)), float(fb));
}

half4 main(float2 p) {
  float4 inC = prev.eval(p);
  float3 e = encode(toLinearSrgb(inC.rgb));

  // --- capture/output sharpening (unsharp mask on luma, with edge masking)
  if (uSharpen > 0.0) {
    float ys = encode1(dot(toLinearSrgb(source.eval(p).rgb), LUMA));
    float yb = encode1(dot(toLinearSrgb(blurS.eval(p).rgb), LUMA));
    float ym = encode1(dot(toLinearSrgb(blurM.eval(p).rgb), LUMA));
    float hf = ys - yb;
    // detail: suppress halos by limiting large differences
    float lim = mix(0.02, 0.25, uSharpDetail);
    hf = clamp(hf, -lim, lim);
    float edge = smoothstep(0.0, 0.02 + 0.2 * uSharpMask, abs(ys - ym) + abs(hf));
    float w = uSharpMask > 0.0 ? edge : 1.0;
    e += uSharpen * 2.2 * hf * w;
  }

  // --- 3D LUT
  if (uLutMix > 0.0) e = mix(e, lut3(e), uLutMix);

  // --- light effects: glow taken from the blurred source, blended like a soft screen
  if (uBloom.x > 0.0 || uHalation.x > 0.0) {
    float3 gm = encode(max(toLinearSrgb(blurM.eval(p).rgb), 0.0));
    float3 gl = encode(max(toLinearSrgb(blurL.eval(p).rgb), 0.0));
    float3 room = 1.0 - clamp(e, 0.0, 1.0);
    if (uBloom.x > 0.0) {
      float3 g = mix(gm, gl, uBloom.z);
      float k = smoothstep(uBloom.y - 0.18, uBloom.y + 0.12, dot(g, LUMA));
      e += clamp(g * k, 0.0, 1.0) * uBloom.x * room;
    }
    if (uHalation.x > 0.0) {
      // around the highlights rather than on them: wide glow minus the sharp bright core
      float ys = encode1(max(dot(toLinearSrgb(source.eval(p).rgb), LUMA), 0.0));
      float yg = dot(mix(gm, gl, uHalation.z), LUMA);
      float t = uHalation.y;
      float halo = smoothstep(t - 0.15, t + 0.1, yg) * (1.0 - 0.7 * smoothstep(t - 0.05, t + 0.1, ys));
      e += float3(1.0, 0.3, 0.1) * halo * uHalation.x * 0.8 * room;
    }
  }

  // --- post-crop vignette
  if (uVignette.x != 0.0) {
    float2 cc = uCrop.xy + uCrop.zw * 0.5;
    float2 dd = (p - cc) / (uCrop.zw * 0.5);
    float roundness = uVignette.w;
    float aspect = uCrop.z / uCrop.w;
    dd.x *= mix(1.0, aspect, clamp(roundness, 0.0, 1.0));
    float pw = mix(2.0, 6.0, clamp(-roundness, 0.0, 1.0));
    float r = pow(pow(abs(dd.x), pw) + pow(abs(dd.y), pw), 1.0 / pw);
    float mid = mix(0.2, 1.3, uVignette.y);
    float feather = mix(0.05, 1.2, uVignette.z);
    float v = smoothstep(mid - feather * 0.5, mid + feather * 0.5, r);
    if (uVignette.x < 0.0) e *= 1.0 + uVignette.x * v;
    else e = mix(e, float3(1.0), uVignette.x * v * 0.9);
  }

  // --- film grain (luminance weighted, two octaves)
  if (uGrain.x > 0.0) {
    float2 g = p / (uGrainScale * mix(0.7, 3.0, uGrain.y));
    float n1 = hash12(floor(g));
    float n2 = hash12(floor(g * 2.1) + 17.0);
    float n = mix(n1, (n1 + n2) * 0.5, 1.0 - uGrain.z) - 0.5;
    float y = clamp(dot(e, LUMA), 0.0, 1.0);
    e += n * uGrain.x * 0.22 * (0.4 + 0.6 * (1.0 - abs(y - 0.5) * 2.0));
  }

  if (uOutMode > 0.5) return dataOut(e);

  if (uClip > 0.5) {
    float hi = max(e.r, max(e.g, e.b));
    float lo = min(e.r, min(e.g, e.b));
    if (hi >= 0.999) e = float3(1.0, 0.1, 0.25);
    else if (lo <= 0.001) e = float3(0.1, 0.35, 1.0);
  }

  return float4(fromLinearSrgb(decode(e)), inC.a);
}
`;
