import {
  autoAdjust,
  computeHistogram as nativeHistogram,
  hasNativeCompute,
  objectMask as nativeObjectMask,
  refineMask as nativeRefineMask,
  removeSpot as nativeRemoveSpot,
  selectInstances as nativeSelectInstances,
  skyMask as nativeSkyMask,
} from 'hikari-native';

import { autoTone, autoWhiteBalance, computeHistogram, skyMask, type Histogram } from '../auto/analysis';
import { boxFilter, objectMask, refineMask, selectInstances, type RefineOptions } from '../pipeline/refine';
import { dilate, inpaint } from '../retouch/inpaint';
import type { Light } from '../recipe/schema';
import { runCompute } from './worker';

/**
 * CPU image math: the native build where the platform has one, otherwise the TypeScript
 * version on the compute runtime. Both produce the same output (computeParity.test.ts).
 */

const asBytes = (a: Float32Array) => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

/** Copied: a buffer from native carries no 4-byte alignment guarantee. */
const asFloats = (b: Uint8Array) => {
  const out = new Float32Array(b.byteLength / 4);
  new Uint8Array(out.buffer).set(b);
  return out;
};

export const computeRefinedMask = (guide: Uint8Array, mask: Uint8Array, w: number, h: number, o: RefineOptions): Promise<Uint8Array> =>
  hasNativeCompute ? nativeRefineMask(guide, mask, w, h, o) : runCompute(refineMask, guide, mask, w, h, o);

export const computeObjectMask = (guide: Uint8Array, coverage: Uint8Array, selected: Uint8Array | null, w: number, h: number): Promise<Uint8Array> =>
  hasNativeCompute ? nativeObjectMask(guide, coverage, selected, w, h) : runCompute(objectMask, guide, coverage, selected, w, h);

export const computeSelectInstances = (
  labels: Uint8Array,
  labelStride: number,
  count: number,
  coverage: Uint8Array,
  coverageStride: number,
  n: number,
  minCover: number,
  minShare: number,
): Promise<{ mask: Uint8Array; picked: number }> =>
  hasNativeCompute
    ? nativeSelectInstances(labels, labelStride, count, coverage, coverageStride, n, minCover, minShare)
    : runCompute(selectInstances, labels, labelStride, count, coverage, coverageStride, n, minCover, minShare);

export interface RemoveSpotParams {
  /** Pixels removed around the strokes. */
  grow: number;
  feather: number;
  searchMaxDim: number;
  seed: number;
}

/**
 * Rebuilds one removal area from its surroundings.
 * @param pixels 3 floats per pixel, the region so far
 * @param area 0/1 per pixel
 * @param alpha patch blend weight so far; the result keeps the max with this area's feather
 */
export async function computeRemoveSpot(
  pixels: Float32Array,
  area: Uint8Array,
  alpha: Float32Array,
  w: number,
  h: number,
  o: RemoveSpotParams,
): Promise<{ pixels: Float32Array; alpha: Float32Array }> {
  if (hasNativeCompute) {
    const res = await nativeRemoveSpot(asBytes(pixels), area, asBytes(alpha), w, h, o);
    return { pixels: asFloats(res.pixels), alpha: asFloats(res.alpha) };
  }
  const grown = dilate(area, w, h, o.grow);
  // feathered blend weight, fully inside the solved area
  const soft = boxFilter(Float32Array.from(grown), w, h, o.feather);
  const solve = dilate(grown, w, h, o.feather * 2 + 1);
  const filled = await runCompute(inpaint, pixels, solve, w, h, { searchMaxDim: o.searchMaxDim, seed: o.seed });
  const raised = new Float32Array(alpha);
  for (let i = 0; i < raised.length; i++) if (soft[i] > raised[i]) raised[i] = soft[i];
  return { pixels: filled, alpha: raised };
}

export async function computeHistogramOf(px: Uint8Array, step = 1): Promise<Histogram> {
  if (!hasNativeCompute) return computeHistogram(px, step);
  const { bins, total, clipLow, clipHigh } = await nativeHistogram(px, step);
  const channel = (i: number) => Uint32Array.from(bins.slice(i * 256, (i + 1) * 256));
  return { r: channel(0), g: channel(1), b: channel(2), l: channel(3), total, clipLow, clipHigh };
}

export const computeSkyMask = (px: Uint8Array, w: number, h: number): Promise<Uint8Array> =>
  hasNativeCompute ? nativeSkyMask(px, w, h) : Promise.resolve(skyMask(px, w, h));

export async function computeAutoAdjust(px: Uint8Array): Promise<{ light: Light; temperature: number; tint: number }> {
  if (hasNativeCompute) return autoAdjust(px);
  return { light: autoTone(computeHistogram(px)), ...autoWhiteBalance(px) };
}
