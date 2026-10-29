import type { Geometry } from '../recipe/schema';

/** Row-major 3x3 matrix [a b c; d e f; g h i] (Skia layout). */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export function mul(a: Mat3, b: Mat3): Mat3 {
  'worklet';
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6],
    a[0] * b[1] + a[1] * b[4] + a[2] * b[7],
    a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6],
    a[3] * b[1] + a[4] * b[4] + a[5] * b[7],
    a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6],
    a[6] * b[1] + a[7] * b[4] + a[8] * b[7],
    a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

export const translate = (x: number, y: number): Mat3 => {
  'worklet';
  return [1, 0, x, 0, 1, y, 0, 0, 1];
};
export const scale = (sx: number, sy: number): Mat3 => {
  'worklet';
  return [sx, 0, 0, 0, sy, 0, 0, 0, 1];
};
export const rotate = (rad: number): Mat3 => {
  'worklet';
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
};

export function invert(m: Mat3): Mat3 {
  'worklet';
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inv = 1 / det;
  return [
    A * inv,
    -(b * i - c * h) * inv,
    (b * f - c * e) * inv,
    B * inv,
    (a * i - c * g) * inv,
    -(a * f - c * d) * inv,
    C * inv,
    -(a * h - b * g) * inv,
    (a * e - b * d) * inv,
  ];
}

export function apply(m: Mat3, x: number, y: number): [number, number] {
  'worklet';
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

/** Size of the frame after quarter turns. */
export function rotatedSize(w: number, h: number, rotate90: number): [number, number] {
  'worklet';
  return rotate90 % 2 === 1 ? [h, w] : [w, h];
}

/** Scale needed so a w×h image rotated by `rad` still covers a w×h frame (no empty corners). */
export function coverScale(w: number, h: number, rad: number): number {
  'worklet';
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  return Math.max((w * c + h * s) / w, (w * s + h * c) / h);
}

export interface GeometryResult {
  /** Image pixel space → output pixel space. */
  matrix: Mat3;
  outW: number;
  outH: number;
}

/**
 * Builds the full geometric transform. Order (image → output): center, flip, quarter
 * turns, keystone perspective, straighten (with auto cover-scale), then crop.
 * The crop rectangle is normalized to the rotated frame.
 */
export function geometryMatrix(g: Geometry, w: number, h: number): GeometryResult {
  'worklet';
  const [fw, fh] = rotatedSize(w, h, g.rotate90);
  let m = translate(-w / 2, -h / 2);
  m = mul(scale(g.flipH ? -1 : 1, g.flipV ? -1 : 1), m);
  m = mul(rotate((g.rotate90 * Math.PI) / 2), m);
  if (g.perspectiveV !== 0 || g.perspectiveH !== 0) {
    // Keystone: perspective terms in normalized coordinates, then compensate scale so
    // the narrowest edge still spans the frame.
    const pv = (g.perspectiveV / 100) * 0.9;
    const ph = (g.perspectiveH / 100) * 0.9;
    const k: Mat3 = [1, 0, 0, 0, 1, 0, ph / (fw / 2), pv / (fh / 2), 1];
    const comp = 1 + Math.max(Math.abs(pv), Math.abs(ph));
    m = mul(scale(comp, comp), mul(k, m));
  }
  const rad = (g.straighten * Math.PI) / 180;
  if (rad !== 0) {
    const s = coverScale(fw, fh, rad);
    m = mul(scale(s, s), mul(rotate(rad), m));
  }
  m = mul(translate(fw / 2, fh / 2), m);
  const cx = g.crop.x * fw;
  const cy = g.crop.y * fh;
  m = mul(translate(-cx, -cy), m);
  return { matrix: m, outW: Math.max(1, g.crop.w * fw), outH: Math.max(1, g.crop.h * fh) };
}

/** Axis-aligned bounds, in image pixels, of the cropped output (for post-crop vignette). */
export function cropBoundsInImage(r: GeometryResult): [number, number, number, number] {
  'worklet';
  const inv = invert(r.matrix);
  const pts = [apply(inv, 0, 0), apply(inv, r.outW, 0), apply(inv, 0, r.outH), apply(inv, r.outW, r.outH)];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Fit an output of w×h into a viewport, returning scale and offset. */
export function fitRect(w: number, h: number, vw: number, vh: number, pad = 0) {
  'worklet';
  const s = Math.min((vw - pad * 2) / w, (vh - pad * 2) / h);
  return { s, x: (vw - w * s) / 2, y: (vh - h * s) / 2 };
}
