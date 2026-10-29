import type { CurvePoint } from '../recipe/schema';

/**
 * Monotone cubic (Fritsch–Carlson) interpolation through curve points. Monotone
 * splines never overshoot, which keeps tone curves free of the ringing a natural
 * spline produces with close points.
 */
export function buildSpline(input: CurvePoint[]): (x: number) => number {
  const pts = [...input].sort((a, b) => a.x - b.x);
  const n = pts.length;
  if (n === 0) return (x) => x;
  if (n === 1) return () => pts[0].y;
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const d: number[] = [];
  const m: number[] = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) {
    const dx = xs[i + 1] - xs[i];
    d.push(dx === 0 ? 0 : (ys[i + 1] - ys[i]) / dx);
  }
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (
      (2 * t3 - 3 * t2 + 1) * ys[i] +
      (t3 - 2 * t2 + t) * h * m[i] +
      (-2 * t3 + 3 * t2) * ys[i + 1] +
      (t3 - t2) * h * m[i + 1]
    );
  };
}

export const isIdentityCurve = (pts: CurvePoint[]) =>
  pts.length === 2 && pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 1 && pts[1].y === 1;

/**
 * Bakes the four curves into a 256x1 RGBA8 strip. R,G,B channels hold the composite
 * of the master curve followed by the per-channel curve, so the shader needs one lookup.
 */
export function bakeCurveLut(curves: { rgb: CurvePoint[]; r: CurvePoint[]; g: CurvePoint[]; b: CurvePoint[] }): Uint8Array {
  const master = buildSpline(curves.rgb);
  const fr = buildSpline(curves.r);
  const fg = buildSpline(curves.g);
  const fb = buildSpline(curves.b);
  const out = new Uint8Array(256 * 4);
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  for (let i = 0; i < 256; i++) {
    const m = clamp(master(i / 255));
    out[i * 4] = Math.round(clamp(fr(m)) * 255);
    out[i * 4 + 1] = Math.round(clamp(fg(m)) * 255);
    out[i * 4 + 2] = Math.round(clamp(fb(m)) * 255);
    out[i * 4 + 3] = 255;
  }
  return out;
}
