import {
  AlphaType,
  BlendMode,
  BlurStyle,
  ColorType,
  FilterMode,
  MipmapMode,
  PaintStyle,
  Skia,
  StrokeCap,
  StrokeJoin,
  type SkCanvas,
  type SkImage,
  type SkSurface,
} from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';
import { isNativeAvailable, segment, segmentInstances, type SegmentKind } from 'hikari-native';

import { grayToRgba, skyMask } from '../auto/analysis';
import { runCompute } from '../compute/worker';
import { decodeTarget } from '../image/load';
import type { BrushStroke, Mask, SourceRef } from '../recipe/schema';
import { objectMask, refineMask, selectInstances } from './refine';
import { makeRgbaImage, resizeImage } from './render';

/** Long edge of brush and AI mask textures. */
const MASK_LONG_EDGE = 2048;

export const isAiMask = (m: Mask) =>
  m.type === 'subject' || m.type === 'sky' || m.type === 'background' || m.type === 'person' || m.type === 'object';

// ---------------------------------------------------------------------------
// Skia helpers (JS thread)

export function makeSurface(w: number, h: number): SkSurface {
  const s = Skia.Surface.MakeOffscreen(w, h) ?? Skia.Surface.Make(w, h);
  if (!s) throw new Error('Unable to allocate surface');
  return s;
}

export function snapshot(surface: SkSurface): SkImage {
  surface.flush();
  const snap = surface.makeImageSnapshot();
  return snap.makeNonTextureImage() ?? snap;
}

/** Linear-filtered resize to an exact size (masks are upscaled, so nearest would step). */
export function scaleImage(img: SkImage, w: number, h: number): SkImage {
  if (img.width() === w && img.height() === h) return img;
  const surface = makeSurface(w, h);
  surface
    .getCanvas()
    .drawImageRectOptions(img, Skia.XYWHRect(0, 0, img.width(), img.height()), Skia.XYWHRect(0, 0, w, h), FilterMode.Linear, MipmapMode.None, null);
  return snapshot(surface);
}

export function readRgba(img: SkImage): Uint8Array {
  const px = img.readPixels(0, 0, { width: img.width(), height: img.height(), colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
  if (!px) throw new Error('Could not read pixels');
  return px as Uint8Array;
}

/**
 * Draws brush strokes (normalized to a fw × fh frame). With `solidGrow` every stroke is drawn
 * as a hard white stroke widened by that many pixels per side (removal areas).
 */
export function drawStrokes(canvas: SkCanvas, strokes: BrushStroke[], fw: number, fh: number, solidGrow?: number) {
  const long = Math.max(fw, fh);
  for (const s of strokes) {
    if (s.points.length < 2) continue;
    const pb = Skia.PathBuilder.Make();
    pb.moveTo(s.points[0] * fw, s.points[1] * fh);
    for (let i = 2; i < s.points.length; i += 2) pb.lineTo(s.points[i] * fw, s.points[i + 1] * fh);
    if (s.points.length === 2) pb.lineTo(s.points[0] * fw + 0.01, s.points[1] * fh);
    const path = pb.build();
    const paint = Skia.Paint();
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeCap(StrokeCap.Round);
    paint.setStrokeJoin(StrokeJoin.Round);
    paint.setAntiAlias(true);
    const width = s.size * long;
    if (solidGrow !== undefined) {
      paint.setStrokeWidth(width + solidGrow * 2);
      paint.setColor(Skia.Color('white'));
      canvas.drawPath(path, paint);
      continue;
    }
    paint.setStrokeWidth(width * (0.5 + s.hardness * 0.5));
    const sigma = (1 - s.hardness) * width * 0.25;
    if (sigma > 0.3) paint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, sigma, true));
    if (s.erase) {
      paint.setColor(Skia.Color('black'));
      paint.setAlphaf(s.flow);
    } else {
      paint.setColor(Skia.Color('white'));
      paint.setAlphaf(s.flow);
      paint.setBlendMode(BlendMode.Lighten);
    }
    canvas.drawPath(path, paint);
  }
}

const maskSize = (aspect: number): [number, number] =>
  aspect >= 1 ? [MASK_LONG_EDGE, Math.round(MASK_LONG_EDGE / aspect)] : [Math.round(MASK_LONG_EDGE * aspect), MASK_LONG_EDGE];

/**
 * Rasterizes brush strokes (normalized coordinates) into a grayscale mask texture, optionally
 * on top of a base mask (add / subtract refinements of an AI mask).
 */
export function renderBrushMask(strokes: BrushStroke[], aspect: number, base?: SkImage | null): SkImage | null {
  const [w, h] = base ? [base.width(), base.height()] : maskSize(aspect);
  const surface = Skia.Surface.MakeOffscreen(w, h) ?? Skia.Surface.Make(w, h);
  if (!surface) return null;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('black'));
  if (base) canvas.drawImage(base, 0, 0);
  drawStrokes(canvas, strokes, w, h);
  return snapshot(surface);
}

function strokeCoverage(strokes: BrushStroke[], w: number, h: number): Uint8Array {
  const surface = makeSurface(w, h);
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('black'));
  drawStrokes(canvas, strokes, w, h);
  return readRgba(snapshot(surface));
}

// ---------------------------------------------------------------------------
// AI masks

const maskDir = () => {
  const d = new Directory(Paths.document, 'masks');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
};

/** Bump when the stored mask encoding changes so stale cached masks regenerate. */
const MASK_CACHE_VERSION = 3;
const safe = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').slice(-80);
const cacheFile = (key: string) => new File(maskDir(), `${key}-v${MASK_CACHE_VERSION}.png`);

function strokesHash(strokes: BrushStroke[]): string {
  const str = JSON.stringify(strokes);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * Identifies the detection an AI mask is built on. Background reuses the subject detection
 * (inverted in the shader); object masks depend on their selection strokes.
 */
export function maskBaseKey(photoKey: string, src: SourceRef, m: Mask): string {
  const v = src.useRaw ? 'r' : 'p';
  if (m.type === 'object') return `${safe(photoKey)}-object-${v}-${strokesHash(m.strokes.filter((s) => !s.erase))}`;
  return `${safe(photoKey)}-${m.type === 'background' ? 'subject' : m.type}-${v}`;
}

async function imageFromFile(uri: string): Promise<SkImage | null> {
  const data = await Skia.Data.fromURI(uri);
  return Skia.Image.MakeImageFromEncoded(data);
}

/** Moves a native temp file into the mask cache. */
function adopt(tmpUri: string, file: File) {
  const tmp = new File(tmpUri);
  if (file.exists) file.delete();
  tmp.copy(file);
  try {
    tmp.delete();
  } catch {
    // temp cleanup is best effort
  }
}

export interface InstanceMap {
  /** RGBA8, red = object id (0 background). */
  pixels: Uint8Array;
  w: number;
  h: number;
  count: number;
}

const instances = new Map<string, Promise<InstanceMap | null>>();

/** Every detected foreground object of a photo (native), cached per photo and source variant. */
export function instanceMap(photoKey: string, src: SourceRef): Promise<InstanceMap | null> {
  if (!isNativeAvailable) return Promise.resolve(null);
  const key = `${safe(photoKey)}-inst-${src.useRaw ? 'r' : 'p'}`;
  let p = instances.get(key);
  if (!p) {
    p = loadInstances(key, src).catch((e) => {
      console.warn('Object detection failed', e);
      return null;
    });
    instances.set(key, p);
    if (instances.size > 3) instances.delete(instances.keys().next().value!);
  }
  return p;
}

async function loadInstances(key: string, src: SourceRef): Promise<InstanceMap | null> {
  const file = cacheFile(key);
  if (!file.exists) {
    const t = decodeTarget(src);
    const res = await segmentInstances(t.uri, MASK_LONG_EDGE, t.preferRaw);
    if (!res) return null;
    adopt(res.path, file);
  }
  const img = await imageFromFile(file.uri);
  if (!img) return null;
  const pixels = readRgba(img);
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > count) count = pixels[i];
  return count ? { pixels, w: img.width(), h: img.height(), count } : null;
}

/**
 * The objects under a rough brush selection, as a 0/255 mask at the detection's resolution
 * (null when the strokes aren't on any detected object). `strict` only takes objects the strokes
 * really cover (removal: touching up a shirt must not erase the person wearing it).
 */
export async function selectObjects(
  photoKey: string,
  src: SourceRef,
  strokes: BrushStroke[],
  strict = false,
): Promise<{ mask: Uint8Array; w: number; h: number } | null> {
  const inst = await instanceMap(photoKey, src);
  if (!inst) return null;
  const cov = strokeCoverage(strokes, inst.w, inst.h);
  const sel = await runCompute(selectInstances, inst.pixels, 4, inst.count, cov, 4, inst.w * inst.h, strict ? 0.25 : 0.08, strict ? 2 : 0.3);
  return sel.picked ? { mask: sel.mask, w: inst.w, h: inst.h } : null;
}

async function selectedObjects(photoKey: string, src: SourceRef, strokes: BrushStroke[], w: number, h: number): Promise<SkImage | null> {
  const sel = await selectObjects(photoKey, src, strokes);
  return sel ? scaleImage(makeRgbaImage(grayToRgba(sel.mask), sel.w, sel.h), w, h) : null;
}

const bases = new Map<string, Promise<SkImage | null>>();
const resolved = new Map<string, SkImage | null>();

/** The finished detection for a mask if it's already in memory (undefined = not computed yet). */
export const peekMaskBase = (key: string) => resolved.get(key);

/**
 * Detection + edge refinement for an AI / object mask. Results are cached on disk per photo
 * so reopening an edit doesn't re-run segmentation.
 */
export function maskBase(photoKey: string, src: SourceRef, m: Mask, proxy: SkImage): Promise<SkImage | null> {
  const key = maskBaseKey(photoKey, src, m);
  if (resolved.has(key)) return Promise.resolve(resolved.get(key)!);
  let p = bases.get(key);
  if (!p) {
    p = computeBase(key, photoKey, src, m, proxy)
      .catch((e) => {
        console.warn('AI mask failed', e);
        return null;
      })
      .then((img) => {
        resolved.set(key, img);
        // each texture is ~10 MB: keep only the recent ones resident
        if (resolved.size > 6) resolved.delete(resolved.keys().next().value!);
        bases.delete(key);
        return img;
      });
    bases.set(key, p);
  }
  return p;
}

/** Heuristic sky detection (no platform API for it), upscaled for refinement. */
function skyRaw(proxy: SkImage): SkImage | null {
  const small = resizeImage(proxy, 768);
  const m = skyMask(readRgba(small), small.width(), small.height());
  if (!m.some((v) => v > 128)) return null;
  return makeRgbaImage(grayToRgba(m), small.width(), small.height());
}

async function computeBase(key: string, photoKey: string, src: SourceRef, m: Mask, proxy: SkImage): Promise<SkImage | null> {
  const file = cacheFile(key);
  if (file.exists) return imageFromFile(file.uri);

  // refinement runs against the photo itself, at mask resolution
  const guideImg = resizeImage(proxy, MASK_LONG_EDGE);
  const gw = guideImg.width();
  const gh = guideImg.height();
  const long = Math.max(gw, gh);
  const guide = readRgba(guideImg);
  let out: Uint8Array;

  if (m.type === 'object') {
    const adds = m.strokes.filter((s) => !s.erase);
    if (!adds.length) return null;
    const sel = await selectedObjects(photoKey, src, adds, gw, gh);
    out = await runCompute(objectMask, guide, strokeCoverage(adds, gw, gh), sel ? readRgba(sel) : null, gw, gh);
  } else {
    let raw: SkImage | null = null;
    if (m.type === 'sky') {
      raw = skyRaw(proxy);
    } else {
      if (!isNativeAvailable) return null;
      const kind: SegmentKind = m.type === 'person' ? 'person' : 'subject';
      const t = decodeTarget(src);
      const res = await segment(t.uri, kind, MASK_LONG_EDGE, t.preferRaw);
      if (res) {
        raw = await imageFromFile(res.path);
        try {
          new File(res.path).delete();
        } catch {
          // temp cleanup is best effort
        }
      }
    }
    if (!raw) return null;
    const sky = m.type === 'sky';
    out = await runCompute(refineMask, guide, readRgba(scaleImage(raw, gw, gh)), gw, gh, {
      // hair and fur need a fine window; sky edges (foliage, skylines) a wider one
      radius: Math.max(2, Math.round(long * (sky ? 0.008 : 0.005))),
      eps: sky ? 4e-4 : 1e-4,
      lo: 0.04,
      hi: 0.96,
    });
  }
  if (!out.some((v) => v > 128)) return null;
  const img = makeRgbaImage(grayToRgba(out), gw, gh);
  file.write(img.encodeToBytes());
  return img;
}

/** Applies a mask's brush refinements on top of its detection. */
export function composeMask(m: Mask, base: SkImage): SkImage {
  const strokes = m.type === 'object' ? m.strokes.filter((s) => s.erase) : m.strokes;
  if (!strokes.length) return base;
  return renderBrushMask(strokes, base.width() / base.height(), base) ?? base;
}

/** The final texture of any texture-based mask (export / batch path). */
export async function maskTexture(photoKey: string, src: SourceRef, m: Mask, proxy: SkImage): Promise<SkImage | null> {
  if (m.type === 'brush') return renderBrushMask(m.strokes, proxy.width() / proxy.height());
  if (!isAiMask(m)) return null;
  const base = await maskBase(photoKey, src, m, proxy);
  return base ? composeMask(m, base) : null;
}

export function clearMaskCache(photoKey: string) {
  const prefix = safe(photoKey);
  for (const e of maskDir().list()) if (e.name.startsWith(prefix)) e.delete();
  for (const k of [...resolved.keys()]) if (k.startsWith(prefix)) resolved.delete(k);
  for (const k of [...instances.keys()]) if (k.startsWith(prefix)) instances.delete(k);
}
