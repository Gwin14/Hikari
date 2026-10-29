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
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Auto tone from the histogram of the *unadjusted* image: exposure brings the log-average
 * luminance toward middle grey, whites/blacks set the end points, highlights/shadows
 * recover detail when the tails are heavy, contrast compensates for flat histograms.
 */
export function autoTone(h: Histogram): Light {
  const n = h.total || 1;
  const p01 = percentile(h.l, n, 0.005);
  const p05 = percentile(h.l, n, 0.05);
  const p50 = percentile(h.l, n, 0.5);
  const p95 = percentile(h.l, n, 0.95);
  const p995 = percentile(h.l, n, 0.995);

  // log-average luminance in linear light
  let logSum = 0;
  for (let i = 0; i < 256; i++) if (h.l[i]) logSum += h.l[i] * Math.log(1e-4 + decode(i / 255));
  const key = Math.exp(logSum / n);
  const exposure = clamp(Math.log2(0.18 / Math.max(key, 1e-4)) * 0.75, -2.5, 2.5);

  // after the exposure shift, estimate where the ends will land (approximate, in encoded space)
  const gain = Math.pow(2, exposure / 2.2);
  const top = clamp(p995 * gain, 0, 1.5);
  const bottom = clamp(p01 * gain, 0, 1);

  const highlights = clamp(-(Math.max(0, percentile(h.l, n, 0.9) * gain - 0.8)) * 220 - h.clipHigh * 300, -80, 0);
  const shadows = clamp((0.22 - p05 * gain) * 160, 0, 60);
  const whites = clamp((0.97 - top) * 120, -40, 50);
  const blacks = clamp((0.02 - bottom) * 400, -40, 30);
  const spread = p95 - p05;
  const contrast = clamp((0.62 - spread) * 60 + (p50 < 0.3 || p50 > 0.7 ? -5 : 0), -20, 30);

  const r = (v: number) => Math.round(v);
  return {
    exposure: Math.round(exposure * 100) / 100,
    contrast: r(contrast),
    highlights: r(highlights),
    shadows: r(shadows),
    whites: r(whites),
    blacks: r(blacks),
  };
}

/**
 * Auto white balance: gray-world over pixels that are neither clipped nor very dark nor
 * strongly saturated (those are rarely neutral), mapped back onto temperature/tint sliders.
 */
export function autoWhiteBalance(px: Uint8Array | Uint8ClampedArray, step = 2): Pick<ColorAdj, 'temperature' | 'tint'> {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let count = 0;
  for (let i = 0; i < px.length; i += 4 * step) {
    const R = px[i] / 255;
    const G = px[i + 1] / 255;
    const B = px[i + 2] / 255;
    const mx = Math.max(R, G, B);
    const mn = Math.min(R, G, B);
    if (mx > 0.97 || mx < 0.08) continue;
    if ((mx - mn) / mx > 0.45) continue;
    sr += decode(R);
    sg += decode(G);
    sb += decode(B);
    count++;
  }
  if (count < 50) return { temperature: 0, tint: 0 };
  const r = sr / count;
  const g = sg / count;
  const b = sb / count;
  // Blue/red ratio drives temperature (cool cast → warm correction), green drives tint.
  const temperature = clamp(Math.log2(b / r) * 85, -100, 100);
  const tint = clamp(Math.log2(g / Math.sqrt(r * b)) * 140, -100, 100);
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
