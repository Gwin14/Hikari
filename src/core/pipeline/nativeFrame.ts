import type { Recipe } from '../recipe/schema';
import { cropBoundsInImage, geometryMatrix, type Mat3 } from './geometry';
import { developUniforms, finishUniforms, localUniforms, maskUsesTexture, packUniforms, type FrameInfo, type UniformLayout } from './uniforms';

/**
 * Packs a recipe into the flat float array the native renderer draws (see FrameLayout in
 * RenderEngine.swift). Uses the same uniform math as the Skia path; the layouts must match the
 * structs in Shaders.swift and the SkSL declarations (pipeline.gpu.test.ts checks them).
 */

function layoutOf(fields: readonly (readonly [string, number])[]): UniformLayout {
  let slot = 0;
  const entries = fields.map(([name, size]) => {
    const e = { name, slot, size };
    slot += size;
    return e;
  });
  return { floats: slot, entries };
}

export const DEVELOP_LAYOUT = layoutOf([
  ['uSize', 2], ['uExposure', 1], ['uWB', 3], ['uContrast', 1], ['uHighlights', 1], ['uShadows', 1], ['uWhites', 1], ['uBlacks', 1],
  ['uHeadroom', 1], ['uVibrance', 1], ['uSaturation', 1], ['uHslH', 8], ['uHslS', 8], ['uHslL', 8], ['uGradeS', 3], ['uGradeM', 3],
  ['uGradeH', 3], ['uGradeG', 3], ['uGradeLum', 2], ['uGradeMidLum', 1], ['uGradeGlobalLum', 1], ['uBlending', 1], ['uBalance', 1],
  ['uClarity', 1], ['uTexture', 1], ['uDehaze', 1], ['uNoiseL', 1], ['uNoiseC', 1], ['uDistortion', 1], ['uCA', 1], ['uVigCorr', 1],
  ['uBW', 1], ['uBwMix', 8], ['uHasCurve', 1],
]);

export const LOCAL_LAYOUT = layoutOf([
  ['uSize', 2], ['uType', 1], ['uLine', 4], ['uEllipse', 4], ['uEllipseRF', 2], ['uInvert', 1], ['uOpacity', 1], ['uRangeMode', 1],
  ['uLumRange', 3], ['uColorRange', 3], ['uOverlay', 1], ['uExposure', 1], ['uContrast', 1], ['uHighlights', 1], ['uShadows', 1],
  ['uWhites', 1], ['uBlacks', 1], ['uWB', 3], ['uSaturation', 1], ['uClarity', 1], ['uDehaze', 1], ['uSharpness', 1], ['uNoise', 1],
]);

export const FINISH_LAYOUT = layoutOf([
  ['uSize', 2], ['uSharpen', 1], ['uSharpDetail', 1], ['uSharpMask', 1], ['uLutSize', 1], ['uLutMix', 1], ['uCrop', 4], ['uVignette', 4],
  ['uGrain', 3], ['uGrainScale', 1], ['uBloom', 3], ['uHalation', 3], ['uClip', 1], ['uOutMode', 1], ['uOutP3', 1],
]);

/** The plain-data description of a photo's native inputs that frame packing needs. */
export interface NativeFrameInputs {
  frame: FrameInfo;
  /** Mask id → texture slot. */
  maskSlots: Record<string, number>;
  lutSize: number;
}

export interface NativeFrameOptions {
  clip?: boolean;
  overlayMask?: string | null;
  original?: boolean;
  /** 1 = write target-space code values (export). */
  outMode?: 0 | 1;
  outP3?: boolean;
}

type Rect = [number, number, number, number];

/**
 * @param matrix image pixels → target units
 * @param clip output rectangle, in target units
 * @param split rectangle showing the unedited photo over the result, in target units
 */
export function packFrame(inp: NativeFrameInputs, r: Recipe, matrix: Mat3, clip: Rect, opts: NativeFrameOptions = {}, split: Rect = [0, 0, 0, 0]): number[] {
  'worklet';
  const geo = geometryMatrix(r.geometry, inp.frame.width, inp.frame.height);
  const locals: number[] = [];
  let count = 0;
  for (const m of r.masks) {
    if (!m.visible) continue;
    const slot = inp.maskSlots[m.id];
    if (maskUsesTexture(m) && slot === undefined) continue;
    const packed = packUniforms(LOCAL_LAYOUT, localUniforms(m, inp.frame, opts.overlayMask === m.id));
    for (let i = 0; i < packed.length; i++) locals.push(packed[i]);
    locals.push(slot ?? 0);
    count++;
  }
  const develop = packUniforms(DEVELOP_LAYOUT, developUniforms(r, inp.frame));
  const finish = packUniforms(
    FINISH_LAYOUT,
    finishUniforms(r, inp.frame, {
      crop: cropBoundsInImage(geo),
      lutSize: inp.lutSize,
      clip: !!opts.clip,
      outMode: opts.outMode,
      outP3: opts.outP3,
    }),
  );
  return [...matrix, ...clip, ...split, opts.original ? 1 : 0, count, ...develop, ...finish, ...locals];
}

/** A frame that renders the whole output at `scale` into a target of its own. */
export function packOffscreenFrame(inp: NativeFrameInputs, r: Recipe, scale: number, opts: NativeFrameOptions = {}): number[] {
  'worklet';
  const geo = geometryMatrix(r.geometry, inp.frame.width, inp.frame.height);
  const m = geo.matrix;
  const matrix: Mat3 = [m[0] * scale, m[1] * scale, m[2] * scale, m[3] * scale, m[4] * scale, m[5] * scale, m[6], m[7], m[8]];
  return packFrame(inp, r, matrix, [0, 0, geo.outW * scale, geo.outH * scale], opts);
}
