import { apply, fitRect, geometryMatrix, invert, type Mat3 } from '@/core/pipeline/geometry';
import type { Geometry, Recipe } from '@/core/recipe/schema';
import type { RenderInputs } from '@/core/pipeline/render';

export const VIEW_PAD = 12;
export const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };

/** Everything needed to map between image pixels, output pixels and screen points. */
export interface ViewTransform {
  ok: boolean;
  imgW: number;
  imgH: number;
  matrix: Mat3; // image px → output px
  inverse: Mat3;
  outW: number;
  outH: number;
  /** output px → screen: s * p + (x, y), then zoom about the view center */
  s: number;
  x: number;
  y: number;
  zoom: number;
  panX: number;
  panY: number;
  vw: number;
  vh: number;
}

export function viewGeometry(r: Recipe, cropMode: boolean): Geometry {
  'worklet';
  return cropMode ? { ...r.geometry, crop: FULL_CROP } : r.geometry;
}

export function makeView(
  r: Recipe | null,
  inp: RenderInputs | null,
  vw: number,
  vh: number,
  zoom: number,
  panX: number,
  panY: number,
  cropMode: boolean,
): ViewTransform {
  'worklet';
  if (!r || !inp || vw < 2 || vh < 2) {
    return { ok: false, imgW: 1, imgH: 1, matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], inverse: [1, 0, 0, 0, 1, 0, 0, 0, 1], outW: 1, outH: 1, s: 1, x: 0, y: 0, zoom: 1, panX: 0, panY: 0, vw, vh };
  }
  const g = geometryMatrix(viewGeometry(r, cropMode), inp.frame.width, inp.frame.height);
  const pad = cropMode ? VIEW_PAD * 3 : VIEW_PAD;
  const fit = fitRect(g.outW, g.outH, vw, vh, pad);
  return {
    ok: true,
    imgW: inp.frame.width,
    imgH: inp.frame.height,
    matrix: g.matrix,
    inverse: invert(g.matrix),
    outW: g.outW,
    outH: g.outH,
    s: fit.s,
    x: fit.x,
    y: fit.y,
    zoom,
    panX,
    panY,
    vw,
    vh,
  };
}

/** output px → screen point */
export function outToScreen(v: ViewTransform, ox: number, oy: number): [number, number] {
  'worklet';
  const sx = ox * v.s + v.x;
  const sy = oy * v.s + v.y;
  return [(sx - v.vw / 2) * v.zoom + v.vw / 2 + v.panX, (sy - v.vh / 2) * v.zoom + v.vh / 2 + v.panY];
}

export function screenToOut(v: ViewTransform, px: number, py: number): [number, number] {
  'worklet';
  const sx = (px - v.panX - v.vw / 2) / v.zoom + v.vw / 2;
  const sy = (py - v.panY - v.vh / 2) / v.zoom + v.vh / 2;
  return [(sx - v.x) / v.s, (sy - v.y) / v.s];
}

/** normalized image coords → screen */
export function imageToScreen(v: ViewTransform, nx: number, ny: number): [number, number] {
  'worklet';
  const [ox, oy] = apply(v.matrix, nx * v.imgW, ny * v.imgH);
  return outToScreen(v, ox, oy);
}

/** screen → normalized image coords */
export function screenToImage(v: ViewTransform, px: number, py: number): [number, number] {
  'worklet';
  const [ox, oy] = screenToOut(v, px, py);
  const [ix, iy] = apply(v.inverse, ox, oy);
  return [ix / v.imgW, iy / v.imgH];
}

/** Screen size of one normalized unit along the image long edge. */
export function screenLongEdge(v: ViewTransform): number {
  'worklet';
  return Math.max(v.imgW, v.imgH) * v.s * v.zoom;
}
