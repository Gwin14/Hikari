import {
  AlphaType,
  BlendMode,
  ColorType,
  FilterMode,
  MipmapMode,
  Skia,
  TileMode,
  type SkCanvas,
  type SkImage,
  type SkRuntimeEffect,
  type SkShader,
} from '@shopify/react-native-skia';

import type { Recipe } from '../recipe/schema';
import { cropBoundsInImage, geometryMatrix, type GeometryResult } from './geometry';
import { DEVELOP_SKSL, FINISH_SKSL, LOCAL_SKSL } from './shaders';
import {
  developUniforms,
  finishUniforms,
  localUniforms,
  maskUsesTexture,
  packUniforms,
  type FrameInfo,
  type UniformLayout,
} from './uniforms';

export interface Program {
  effect: SkRuntimeEffect;
  layout: UniformLayout;
}

export interface Programs {
  develop: Program;
  local: Program;
  finish: Program;
}

function compile(source: string, name: string): Program {
  const effect = Skia.RuntimeEffect.Make(source);
  if (!effect) throw new Error(`Failed to compile ${name} shader`);
  const n = effect.getUniformCount();
  const raw: { name: string; slot: number }[] = [];
  for (let i = 0; i < n; i++) raw.push({ name: effect.getUniformName(i), slot: effect.getUniform(i).slot });
  raw.sort((a, b) => a.slot - b.slot);
  const floats = effect.getUniformFloatCount();
  const entries = raw.map((u, i) => ({ ...u, size: (i + 1 < raw.length ? raw[i + 1].slot : floats) - u.slot }));
  return { effect, layout: { floats, entries } };
}

let programs: Programs | null = null;
export function getPrograms(): Programs {
  if (!programs) {
    programs = {
      develop: compile(DEVELOP_SKSL, 'develop'),
      local: compile(LOCAL_SKSL, 'local'),
      finish: compile(FINISH_SKSL, 'finish'),
    };
  }
  return programs;
}

/** A removal result: a feathered patch (alpha = blend weight) drawn over the source at x, y. */
export interface RetouchPatch {
  image: SkImage;
  x: number;
  y: number;
}

/**
 * GPU-side inputs for rendering one photo at one resolution. The editor keeps one at
 * proxy size; export builds one at full size.
 */
export interface RenderInputs {
  programs: Programs;
  frame: FrameInfo;
  source: SkImage;
  /** σ≈1.5px: luma noise reduction. */
  blurN: SkImage;
  /** σ = sharpen radius. */
  blurS: SkImage;
  /** σ ≈ 0.4% long edge: texture, color NR, sharpen masking. */
  blurM: SkImage;
  /** σ ≈ 2% long edge: clarity, dehaze. */
  blurL: SkImage;
  curve: SkImage | null;
  lut: { image: SkImage; size: number } | null;
  /** Mask id → grayscale texture (brush strokes / AI segmentation), any resolution. */
  maskTextures: Record<string, SkImage>;
  /** Object removal patches over `source` (the blurs are already built from the cleaned photo). */
  retouch: RetouchPatch[];
  /** Changes whenever the source or a blur image changes (UI-thread texture cache key). */
  gpuKey: string;
}

let gpuSeq = 0;
export const nextGpuKey = () => `g${++gpuSeq}`;

/**
 * Copies an image into a GPU texture owned by the calling thread. Blurs are built on the JS
 * thread as raster images; drawing rasters every frame on the UI thread makes Skia re-upload
 * them whenever its texture cache evicts them, which stalls slider drags.
 */
export function toTexture(img: SkImage): SkImage {
  'worklet';
  const surface = Skia.Surface.MakeOffscreen(img.width(), img.height());
  if (!surface) return img;
  surface.getCanvas().drawImage(img, 0, 0);
  surface.flush();
  return surface.makeImageSnapshot();
}

export interface RenderOptions {
  clip?: boolean;
  /** Mask id to show as a red overlay. */
  overlayMask?: string | null;
  /** Skip all adjustments (before/after). */
  original?: boolean;
  /** Export data modes, see FINISH_SKSL. */
  outMode?: 0 | 1 | 2 | 3;
  outP3?: boolean;
}

function imageShader(img: SkImage, fw: number, fh: number): SkShader {
  'worklet';
  const sx = fw / img.width();
  const sy = fh / img.height();
  const m = sx === 1 && sy === 1 ? undefined : Skia.Matrix().scale(sx, sy);
  return img.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None, m);
}

/** The source with object removals applied. */
function sourceShader(inp: RenderInputs, w: number, h: number): SkShader {
  'worklet';
  let sh = imageShader(inp.source, w, h);
  for (const p of inp.retouch) {
    const patch = p.image.makeShaderOptions(TileMode.Decal, TileMode.Decal, FilterMode.Linear, MipmapMode.None, Skia.Matrix().translate(p.x, p.y));
    sh = Skia.Shader.MakeBlend(BlendMode.SrcOver, sh, patch);
  }
  return sh;
}

/** Builds the full shader chain in image pixel space. */
export function buildShader(inp: RenderInputs, r: Recipe, opts: RenderOptions = {}): SkShader {
  'worklet';
  const { width: w, height: h } = inp.frame;
  if (opts.original) return imageShader(inp.source, w, h);
  const src = sourceShader(inp, w, h);
  const P = inp.programs;
  const blurN = imageShader(inp.blurN, w, h);
  const blurS = imageShader(inp.blurS, w, h);
  const blurM = imageShader(inp.blurM, w, h);
  const blurL = imageShader(inp.blurL, w, h);
  const curve = inp.curve ? imageShader(inp.curve, inp.curve.width(), 1) : blurM;

  let sh = P.develop.effect.makeShaderWithChildren(packUniforms(P.develop.layout, developUniforms(r, inp.frame)), [
    src,
    blurN,
    blurM,
    blurL,
    curve,
  ]);

  for (const m of r.masks) {
    if (!m.visible) continue;
    const tex = inp.maskTextures[m.id];
    if (maskUsesTexture(m) && !tex) continue;
    const maskSh = tex ? imageShader(tex, w, h) : blurM;
    const u = packUniforms(P.local.layout, localUniforms(m, inp.frame, opts.overlayMask === m.id));
    sh = P.local.effect.makeShaderWithChildren(u, [sh, maskSh, src, blurL]);
  }

  const geo = geometryMatrix(r.geometry, w, h);
  const lutSh = inp.lut ? inp.lut.image.makeShaderOptions(TileMode.Clamp, TileMode.Clamp, FilterMode.Linear, MipmapMode.None) : blurM;
  const fu = finishUniforms(r, inp.frame, {
    crop: cropBoundsInImage(geo),
    lutSize: inp.lut ? inp.lut.size : 0,
    clip: !!opts.clip,
    outMode: opts.outMode,
    outP3: opts.outP3,
  });
  return P.finish.effect.makeShaderWithChildren(packUniforms(P.finish.layout, fu), [sh, src, blurS, blurM, lutSh]);
}

/** Draws the developed, geometry-transformed photo with its output origin at (0,0). */
export function drawRecipe(canvas: SkCanvas, inp: RenderInputs, r: Recipe, opts: RenderOptions = {}): GeometryResult {
  'worklet';
  const { width: w, height: h } = inp.frame;
  const geo = geometryMatrix(r.geometry, w, h);
  const paint = Skia.Paint();
  paint.setShader(buildShader(inp, r, opts));
  canvas.save();
  canvas.clipRect(Skia.XYWHRect(0, 0, geo.outW, geo.outH), 1, true);
  canvas.concat(Skia.Matrix(geo.matrix));
  canvas.drawRect(Skia.XYWHRect(0, 0, w, h), paint);
  canvas.restore();
  return geo;
}

// ---------------------------------------------------------------------------
// JS-thread helpers to prepare inputs

export function blurImage(img: SkImage, sigma: number, w = img.width(), h = img.height()): SkImage {
  const surface = Skia.Surface.MakeOffscreen(w, h) ?? Skia.Surface.Make(w, h);
  if (!surface) throw new Error('Unable to allocate surface');
  const canvas = surface.getCanvas();
  const paint = Skia.Paint();
  if (sigma > 0.05) paint.setImageFilter(Skia.ImageFilter.MakeBlur(sigma, sigma, TileMode.Clamp, null));
  canvas.drawImageRect(img, Skia.XYWHRect(0, 0, img.width(), img.height()), Skia.XYWHRect(0, 0, w, h), paint);
  surface.flush();
  const snap = surface.makeImageSnapshot();
  return snap.makeNonTextureImage() ?? snap;
}

/** Downscale (or copy) into a GPU-independent raster image. */
export function resizeImage(img: SkImage, maxDim: number): SkImage {
  const long = Math.max(img.width(), img.height());
  if (long <= maxDim) return img;
  const s = maxDim / long;
  return blurImage(img, 0, Math.round(img.width() * s), Math.round(img.height() * s));
}

export function makeRgbaImage(pixels: Uint8Array, width: number, height: number): SkImage {
  const data = Skia.Data.fromBytes(pixels);
  const img = Skia.Image.MakeImage(
    { width, height, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul },
    data,
    width * 4,
  );
  if (!img) throw new Error('MakeImage failed');
  return img;
}

/** Recomputes the sharpen blur (sharpen radius changed). */
export function rebuildBlurS(inp: RenderInputs, fullLong: number, sharpenRadius: number): RenderInputs {
  const src = cleanedSource(inp.source, inp.retouch);
  const sg = blurSigmas(src.width(), src.height(), fullLong, sharpenRadius);
  return { ...inp, blurS: blurImage(src, sg.s), gpuKey: nextGpuKey() };
}

export const blurSigmas = (w: number, h: number, fullLong: number, sharpenRadius: number) => {
  const long = Math.max(w, h);
  const s = long / fullLong; // preview → full-resolution pixel ratio
  return {
    n: Math.max(0.6, 1.5 * s * 2),
    s: Math.max(0.5, sharpenRadius * s * 1.2),
    m: long * 0.004,
    l: long * 0.02,
  };
};

export interface PreparedSource {
  source: SkImage;
  fullWidth: number;
  fullHeight: number;
  isRaw: boolean;
}

/** Source with removal patches baked in (8 bit; only used to build the blurs). */
function cleanedSource(src: SkImage, retouch: RetouchPatch[]): SkImage {
  if (!retouch.length) return src;
  const surface = Skia.Surface.MakeOffscreen(src.width(), src.height()) ?? Skia.Surface.Make(src.width(), src.height());
  if (!surface) throw new Error('Unable to allocate surface');
  const canvas = surface.getCanvas();
  canvas.drawImage(src, 0, 0);
  for (const p of retouch) canvas.drawImage(p.image, p.x, p.y);
  surface.flush();
  const snap = surface.makeImageSnapshot();
  return snap.makeNonTextureImage() ?? snap;
}

export function prepareInputs(
  prepared: PreparedSource,
  sharpenRadius: number,
  extras: Pick<RenderInputs, 'curve' | 'lut' | 'maskTextures' | 'retouch'>,
): RenderInputs {
  const w = prepared.source.width();
  const h = prepared.source.height();
  const src = cleanedSource(prepared.source, extras.retouch);
  const sg = blurSigmas(w, h, Math.max(prepared.fullWidth, prepared.fullHeight), sharpenRadius);
  // Large blurs are computed at reduced resolution: visually identical and much cheaper.
  const half = (d: number) => Math.max(1, Math.round(d / 4));
  return {
    programs: getPrograms(),
    frame: { width: w, height: h, isRaw: prepared.isRaw },
    source: prepared.source,
    blurN: blurImage(src, sg.n),
    blurS: blurImage(src, sg.s),
    blurM: blurImage(src, sg.m / 2, Math.round(w / 2), Math.round(h / 2)),
    blurL: blurImage(src, sg.l / 4, half(w), half(h)),
    ...extras,
    gpuKey: nextGpuKey(),
  };
}

/** Render a recipe offscreen to an RGBA8 raster image at the given output scale. */
export function renderToImage(inp: RenderInputs, r: Recipe, outScale = 1, opts: RenderOptions = {}): SkImage {
  const geo = geometryMatrix(r.geometry, inp.frame.width, inp.frame.height);
  const W = Math.max(1, Math.round(geo.outW * outScale));
  const H = Math.max(1, Math.round(geo.outH * outScale));
  const surface = Skia.Surface.MakeOffscreen(W, H) ?? Skia.Surface.Make(W, H);
  if (!surface) throw new Error('Unable to allocate export surface');
  const canvas = surface.getCanvas();
  canvas.scale(outScale, outScale);
  drawRecipe(canvas, inp, r, opts);
  surface.flush();
  const snap = surface.makeImageSnapshot();
  return snap.makeNonTextureImage() ?? snap;
}
