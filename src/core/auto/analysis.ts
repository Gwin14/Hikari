import { wbMultipliers } from '../pipeline/uniforms';
import type { ColorAdj, Light } from '../recipe/schema';

export interface Histogram {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  l: Uint32Array;
  total: number;
  /** Fraction of pixels clipped at either end (any channel). */
  clipLow: number;
  clipHigh: number;
}

/** 256-bin histogram of an RGBA8 buffer (optionally subsampled). */
export function computeHistogram(px: Uint8Array | Uint8ClampedArray, step = 1): Histogram {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const l = new Uint32Array(256);
  let total = 0;
  let lo = 0;
  let hi = 0;
  const stride = 4 * step;
  for (let i = 0; i < px.length; i += stride) {
    const R = px[i];
    const G = px[i + 1];
    const B = px[i + 2];
    r[R]++;
    g[G]++;
    b[B]++;
    l[Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
    if (R <= 1 || G <= 1 || B <= 1) lo++;
    if (R >= 254 || G >= 254 || B >= 254) hi++;
    total++;
  }
  return { r, g, b, l, total, clipLow: total ? lo / total : 0, clipHigh: total ? hi / total : 0 };
}

export function percentile(bins: Uint32Array, total: number, p: number): number {
  const target = total * p;
  let acc = 0;
  for (let i = 0; i < 256; i++) {
    acc += bins[i];
    if (acc >= target) return i / 255;
  }
  return 1;
}

const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const encode = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** JS mirror of toneY() in shaders.ts (keep in sync). */
function toneY(y: number, contrast: number, highlights: number, shadows: number, whites: number, blacks: number): number {
  const ws = 1 - smoothstep(0, 0.6, y);
  const wh = smoothstep(0.4, 1, y);
  y += shadows * 0.45 * ws * ws * (1 - y * 0.5);
  y += highlights * 0.4 * wh * wh * (highlights < 0 ? Math.max(y, 0.4) : 1 - y * 0.6);
  y += whites * 0.3 * smoothstep(0.55, 1, y);
  y += blacks * 0.2 * (1 - smoothstep(0, 0.35, y));
  const k = contrast >= 0 ? 1 + contrast * 1.2 : 1 / (1 - contrast * 0.8);
  const yc = clamp(y, 0, 1);
  const sc = yc < 0.5 ? 0.5 * Math.pow(2 * yc, k) : 1 - 0.5 * Math.pow(2 * (1 - yc), k);
  return sc + (y - yc);
}

/** Where an encoded luminance lands after the develop pass's exposure, shoulder and tone stages. */
function developY(e: number, L: Light): number {
  let lin = decode(e) * Math.pow(2, L.exposure);
  if (L.exposure > 0 && lin > 0.8) lin = 0.8 + 0.2 * (1 - Math.exp(-(lin - 0.8) / 0.2));
  const y = toneY(encode(lin), L.contrast / 100, L.highlights / 100, L.shadows / 100, L.whites / 100, L.blacks / 100);
  return clamp(y, 0, 1);
}

/** Bisection for an increasing f on [lo, hi]; returns the bound when the target is out of reach. */
function solve(f: (x: number) => number, target: number, lo: number, hi: number): number {
  if (f(lo) >= target) return lo;
  if (f(hi) <= target) return hi;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Auto tone from the histogram of the *unadjusted* image. Each slider is solved against a
 * simulation of the real tone curve, in order: exposure moves the median toward mid grey
 * (keeping part of the scene's key, and never pushing the bright tenth into clipping),
 * highlights/shadows recover heavy tails, whites/blacks set the end points (left alone when
 * the image already reaches them), contrast evens out flat or harsh histograms.
 */
export function autoTone(h: Histogram): Light {
  const n = h.total || 1;
  const q = (p: number) => percentile(h.l, n, p);
  const p005 = q(0.005);
  const p05 = q(0.05);
  const p10 = q(0.1);
  const p50 = q(0.5);
  const p90 = q(0.9);
  const p95 = q(0.95);
  const p995 = q(0.995);
  const L: Light = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 };

  // exposure: high-key scenes stay bright, low-key ones stay dark-ish
  const targetMid = 0.46 + (p50 - 0.46) * (p50 > 0.46 ? 0.7 : 0.5);
  let exposure = solve((x) => developY(p50, { ...L, exposure: x }), targetMid, -2, 2);
  if (exposure > 0) {
    // brightening must not blow out what is already bright (windows, lights, sky)
    const cap = (p: number, top: number) => (p < top ? solve((x) => developY(p, { ...L, exposure: x }), top, 0, 2) : 0.3);
    exposure = Math.min(exposure, cap(p90, 0.93), cap(p95, 0.97));
  }
  L.exposure = Math.round(exposure * 100) / 100;

  // highlights: pull the bright tenth down when it sits high or the image clips
  const y90 = developY(p90, L);
  L.highlights = -clamp((y90 - 0.82) * 250 + Math.max(0, h.clipHigh - 0.005) * 150, 0, 60);

  // shadows: lift a crushed dark tenth, less so when most of the frame is dark on purpose
  let dark = 0;
  for (let i = 0; i < 256; i++) if (developY(i / 255, L) < 0.08) dark += h.l[i];
  const lowKey = clamp(1.5 - (2 * dark) / n, 0.25, 1);
  L.shadows = clamp((0.12 - developY(p10, L)) * 220, 0, 35) * lowKey;

  // whites / blacks: only extend the end points the image doesn't reach (anymore)
  if (developY(p995, L) < 0.96) L.whites = solve((x) => developY(p995, { ...L, whites: x }), 0.965, 0, 40);
  if (developY(p005, L) > 0.03) {
    L.blacks = -solve((x) => -developY(p005, { ...L, blacks: -x }), -0.025, 0, 40);
  }

  // contrast: aim for a natural spread between the 5th and 95th percentiles
  const spread = developY(p95, L) - developY(p05, L);
  L.contrast = clamp((0.72 - spread) * 70, -15, 25);

  const r = (v: number) => Math.round(v);
  return {
    exposure: L.exposure,
    contrast: r(L.contrast),
    highlights: r(L.highlights),
    shadows: r(L.shadows),
    whites: r(L.whites),
    blacks: r(L.blacks),
  };
}

/**
 * Auto white balance: weighted gray-world over well-exposed, near-neutral pixels (strongly
 * colored ones — foliage, sky, sunsets — are rarely neutral and are ignored). The slider
 * values that neutralize that average are solved through the same wbMultipliers() the
 * shader uses, then damped: the average is only a guess, and warm casts are usually wanted.
 */
export function autoWhiteBalance(px: Uint8Array | Uint8ClampedArray, step = 2): Pick<ColorAdj, 'temperature' | 'tint'> {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sw = 0;
  let count = 0;
  let total = 0;
  for (let i = 0; i < px.length; i += 4 * step) {
    total++;
    const R = px[i] / 255;
    const G = px[i + 1] / 255;
    const B = px[i + 2] / 255;
    const mx = Math.max(R, G, B);
    const mn = Math.min(R, G, B);
    if (mx > 0.96 || mx < 0.06) continue;
    const sat = (mx - mn) / mx;
    if (sat > 0.35) continue;
    const w = (1 - sat / 0.35) ** 2 * (0.3 + mx);
    sr += decode(R) * w;
    sg += decode(G) * w;
    sb += decode(B) * w;
    sw += w;
    count++;
  }
  if (count < 50 || sw <= 0) return { temperature: 0, tint: 0 };
  const lr = Math.log(sr / sw);
  const lg = Math.log(sg / sw);
  const lb = Math.log(sb / sw);
  const err = (t: number, n: number) => {
    const m = wbMultipliers(t, n);
    const g = lg + Math.log(m[1]);
    return (lr + Math.log(m[0]) - g) ** 2 + (lb + Math.log(m[2]) - g) ** 2;
  };
  let bt = 0;
  let bn = 0;
  let best = err(0, 0);
  for (const [stepSize, span] of [[4, 100], [1, 4]] as const) {
    const ct = bt;
    const cn = bn;
    for (let t = Math.max(-100, ct - span); t <= Math.min(100, ct + span); t += stepSize)
      for (let n = Math.max(-100, cn - span); n <= Math.min(100, cn + span); n += stepSize) {
        const e = err(t, n);
        if (e < best) {
          best = e;
          bt = t;
          bn = n;
        }
      }
  }
  // fewer neutral pixels → less confidence in the estimate
  const confidence = clamp(count / (total * 0.15), 0, 1);
  const k = 0.75 * confidence;
  const temperature = clamp(bt * k * (bt < 0 ? 0.6 : 1), -60, 60);
  const tint = clamp(bn * k * 0.8, -40, 40);
  return { temperature: Math.round(temperature), tint: Math.round(tint) };
}

/**
 * Sky probability mask from an RGBA8 buffer: bright, low-texture, blue-or-neutral regions
 * connected to the top edge. Returns a grayscale mask (0..255) at the input size.
 */
export function skyMask(px: Uint8Array | Uint8ClampedArray, w: number, h: number): Uint8Array {
  const score = new Float32Array(w * h);
  const lum = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const R = px[i * 4] / 255;
    const G = px[i * 4 + 1] / 255;
    const B = px[i * 4 + 2] / 255;
    lum[i] = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const R = px[i * 4] / 255;
      const G = px[i * 4 + 1] / 255;
      const B = px[i * 4 + 2] / 255;
      const l = lum[i];
      // local gradient magnitude (texture)
      const lx = lum[y * w + Math.min(w - 1, x + 1)] - lum[y * w + Math.max(0, x - 1)];
      const ly = lum[Math.min(h - 1, y + 1) * w + x] - lum[Math.max(0, y - 1) * w + x];
      const grad = Math.sqrt(lx * lx + ly * ly);
      const blueness = clamp((B - R) * 3 + 0.4, 0, 1);
      const neutralBright = l > 0.7 && Math.max(R, G, B) - Math.min(R, G, B) < 0.12 ? 0.8 : 0;
      const color = Math.max(blueness * (B > G * 0.9 ? 1 : 0.5), neutralBright);
      const bright = clamp((l - 0.25) * 2.5, 0, 1);
      const smooth = clamp(1 - grad * 12, 0, 1);
      const vertical = clamp(1.3 - (y / h) * 1.2, 0, 1);
      score[i] = color * bright * smooth * vertical;
    }
  }
  // flood fill from the top row through pixels above threshold
  const mask = new Uint8Array(w * h);
  const seen = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) if (score[x] > 0.35) stack.push(x);
  while (stack.length) {
    const i = stack.pop()!;
    if (seen[i]) continue;
    seen[i] = 1;
    if (score[i] < 0.25) continue;
    mask[i] = Math.round(clamp(score[i] * 1.6, 0, 1) * 255);
    const x = i % w;
    const y = (i - x) / w;
    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  // fill holes inside the sky body: everything above the lowest sky pixel per column with high score
  for (let x = 0; x < w; x++) {
    let lowest = -1;
    for (let y = 0; y < h; y++) if (mask[y * w + x] > 128) lowest = y;
    for (let y = 0; y < lowest; y++) {
      const i = y * w + x;
      if (mask[i] < 200 && score[i] > 0.1) mask[i] = 230;
    }
  }
  return mask;
}

/** Expands a single-channel mask into RGBA8 (for uploading as a texture). */
export function grayToRgba(mask: Uint8Array): Uint8Array {
  const out = new Uint8Array(mask.length * 4);
  for (let i = 0; i < mask.length; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = mask[i];
    out[i * 4 + 3] = 255;
  }
  return out;
}
