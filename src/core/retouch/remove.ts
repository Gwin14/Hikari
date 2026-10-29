import { AlphaType, ColorType, FilterMode, MipmapMode, Skia, type SkImage } from '@shopify/react-native-skia';

import { grayToRgba } from '../auto/analysis';
import { runCompute } from '../compute/worker';
import { drawStrokes, makeSurface, readRgba, selectObjects, snapshot } from '../pipeline/masks';
import { boxFilter } from '../pipeline/refine';
import type { RetouchPatch } from '../pipeline/render';
import { makeRgbaImage } from '../pipeline/render';
import type { RetouchSpot, SourceRef } from '../recipe/schema';
import { dilate, inpaint } from './inpaint';

/**
 * Content-aware removal. Each spot's area is rebuilt from its surroundings (see inpaint.ts)
 * and the result is kept as a small feathered patch drawn over the source before develop, so
 * every adjustment (and every blur the adjustments use) sees the cleaned photo.
 */

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Planned {
  spot: RetouchSpot;
  /** Detected objects under the strokes (object-aware spots), at detection resolution. */
  objects: { image: SkImage; w: number; h: number } | null;
  hole: Rect;
}

const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
/** IEEE half from float (round to nearest), for RGBA_F16 patches. */
function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  const e = ((x >>> 23) & 0xff) - 112;
  const m = x & 0x7fffff;
  if (e <= 0) return e < -10 ? sign : sign | (((m | 0x800000) >> (1 - e)) + 0x1000) >> 13;
  if (e >= 31) return sign | 0x7c00;
  return sign | ((e << 10) + ((m + 0x1000) >> 13));
}

function seedOf(id: string) {
  let h = 0x9e3779b9;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 2654435761);
  return h >>> 0;
}

const patchCache = new Map<string, RetouchPatch>();

/**
 * Builds the removal patches for `source` (any resolution: editor proxy or full-size export).
 * Spots are applied in order, so a later spot can sample an area an earlier one cleaned.
 */
export async function buildRetouch(photoKey: string, src: SourceRef, source: SkImage, spots: RetouchSpot[]): Promise<RetouchPatch[]> {
  const W = source.width();
  const H = source.height();
  const long = Math.max(W, H);
  // extra pixels removed around the strokes (anti-aliased edges, halos, soft shadows) and feather
  const grow = Math.max(2, Math.round(long * 0.002));
  const feather = Math.max(1, Math.round(long * 0.0015));

  const planned: Planned[] = [];
  for (const spot of spots) {
    const pts = spot.strokes.flatMap((s) => s.points);
    if (pts.length < 2) continue;
    const pad = Math.max(...spot.strokes.map((s) => s.size)) * long * 0.5 + grow + feather * 2;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i] * W);
      x1 = Math.max(x1, pts[i] * W);
      y0 = Math.min(y0, pts[i + 1] * H);
      y1 = Math.max(y1, pts[i + 1] * H);
    }
    let hole: Rect = { x: x0 - pad, y: y0 - pad, w: x1 - x0 + pad * 2, h: y1 - y0 + pad * 2 };
    let objects: Planned['objects'] = null;
    if (spot.objectAware) {
      const sel = await selectObjects(photoKey, src, spot.strokes, true);
      if (sel) {
        let bx0 = sel.w;
        let by0 = sel.h;
        let bx1 = -1;
        let by1 = -1;
        for (let y = 0; y < sel.h; y++)
          for (let x = 0; x < sel.w; x++)
            if (sel.mask[y * sel.w + x]) {
              if (x < bx0) bx0 = x;
              if (x > bx1) bx1 = x;
              if (y < by0) by0 = y;
              if (y > by1) by1 = y;
            }
        const sx = W / sel.w;
        const sy = H / sel.h;
        const p = grow + feather * 2 + 2;
        hole = union(hole, { x: bx0 * sx - p, y: by0 * sy - p, w: (bx1 - bx0 + 1) * sx + p * 2, h: (by1 - by0 + 1) * sy + p * 2 });
        objects = { image: makeRgbaImage(grayToRgba(sel.mask), sel.w, sel.h), w: sel.w, h: sel.h };
      }
    }
    planned.push({ spot, objects, hole });
  }

  // each hole needs context around it to copy from; overlapping regions are solved together
  const regionOf = (r: Rect): Rect => {
    const m = Math.max(24, Math.max(r.w, r.h) * 0.75);
    const x = Math.max(0, Math.floor(r.x - m));
    const y = Math.max(0, Math.floor(r.y - m));
    return { x, y, w: Math.min(W, Math.ceil(r.x + r.w + m)) - x, h: Math.min(H, Math.ceil(r.y + r.h + m)) - y };
  };
  const clusters: { rect: Rect; items: Planned[] }[] = [];
  for (const p of planned) {
    let c = { rect: regionOf(p.hole), items: [p] };
    for (let i = clusters.length - 1; i >= 0; i--) {
      if (!overlaps(clusters[i].rect, c.rect)) continue;
      c = { rect: union(clusters[i].rect, c.rect), items: [...clusters[i].items, ...c.items] };
      clusters.splice(i, 1);
    }
    clusters.push(c);
  }

  const out: RetouchPatch[] = [];
  for (const c of clusters) {
    // keep the original order inside a cluster
    c.items.sort((a, b) => spots.indexOf(a.spot) - spots.indexOf(b.spot));
    const key = `${photoKey}|${src.useRaw}|${W}x${H}|${JSON.stringify(c.items.map((i) => i.spot))}`;
    let patch = patchCache.get(key);
    if (!patch) {
      patch = await solveCluster(source, c.rect, c.items, W, H, grow, feather);
      patchCache.set(key, patch);
      if (patchCache.size > 24) patchCache.delete(patchCache.keys().next().value!);
    }
    out.push(patch);
  }
  return out;
}

async function solveCluster(source: SkImage, R: Rect, items: Planned[], W: number, H: number, grow: number, feather: number): Promise<RetouchPatch> {
  const { x, y, w, h } = R;
  const n = w * h;
  const hdr = source.getImageInfo().colorType !== ColorType.RGBA_8888;
  const raw = source.readPixels(x, y, { width: w, height: h, colorType: hdr ? ColorType.RGBA_F32 : ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
  if (!raw) throw new Error('Could not read the photo');
  let img: Float32Array = new Float32Array(n * 3);
  const k = raw instanceof Float32Array ? 1 : 1 / 255;
  for (let i = 0; i < n; i++) {
    img[i * 3] = raw[i * 4] * k;
    img[i * 3 + 1] = raw[i * 4 + 1] * k;
    img[i * 3 + 2] = raw[i * 4 + 2] * k;
  }
  const alpha = new Float32Array(n);
  // search at most ~preview resolution; larger exports only refine (fast, still sharp)
  const searchMaxDim = Math.min(1024, Math.round(Math.max(w, h) * Math.min(1, 2048 / Math.max(W, H))));

  for (const it of items) {
    // area under the strokes (and detected object), in region pixels
    const surface = makeSurface(w, h);
    const canvas = surface.getCanvas();
    canvas.clear(Skia.Color('black'));
    canvas.save();
    canvas.translate(-x, -y);
    drawStrokes(canvas, it.spot.strokes, W, H, 0);
    if (it.objects) {
      const o = it.objects;
      canvas.drawImageRectOptions(o.image, Skia.XYWHRect(0, 0, o.w, o.h), Skia.XYWHRect(0, 0, W, H), FilterMode.Linear, MipmapMode.None, null);
    }
    canvas.restore();
    const px = readRgba(snapshot(surface));
    const area = new Uint8Array(n);
    for (let i = 0; i < n; i++) area[i] = px[i * 4] > 24 ? 1 : 0;

    const grown = dilate(area, w, h, grow);
    // feathered blend weight, fully inside the solved area
    const soft = boxFilter(Float32Array.from(grown), w, h, feather);
    const solve = dilate(grown, w, h, feather * 2 + 1);
    img = await runCompute(inpaint, img, solve, w, h, { searchMaxDim, seed: seedOf(it.spot.id) });
    for (let i = 0; i < n; i++) if (soft[i] > alpha[i]) alpha[i] = soft[i];
  }

  let image: SkImage | null;
  if (hdr) {
    // same half-float layout as the decoded RAW source, so headroom above 1 survives
    const f = new Uint16Array(n * 4);
    for (let i = 0; i < n; i++) {
      f[i * 4] = toHalf(img[i * 3]);
      f[i * 4 + 1] = toHalf(img[i * 3 + 1]);
      f[i * 4 + 2] = toHalf(img[i * 3 + 2]);
      f[i * 4 + 3] = toHalf(alpha[i]);
    }
    image = Skia.Image.MakeImage(
      { width: w, height: h, colorType: ColorType.RGBA_F16, alphaType: AlphaType.Unpremul },
      Skia.Data.fromBytes(new Uint8Array(f.buffer)),
      w * 8,
    );
  } else {
    const b = new Uint8Array(n * 4);
    for (let i = 0; i < n; i++) {
      b[i * 4] = Math.max(0, Math.min(255, Math.round(img[i * 3] * 255)));
      b[i * 4 + 1] = Math.max(0, Math.min(255, Math.round(img[i * 3 + 1] * 255)));
      b[i * 4 + 2] = Math.max(0, Math.min(255, Math.round(img[i * 3 + 2] * 255)));
      b[i * 4 + 3] = Math.round(alpha[i] * 255);
    }
    image = makeRgbaImage(b, w, h);
  }
  if (!image) throw new Error('Could not build the removal patch');
  return { image, x, y };
}
