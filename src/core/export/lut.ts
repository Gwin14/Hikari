import { AlphaType, ColorType, Skia } from '@shopify/react-native-skia';

import { identityStrip, stripToCube } from '../color/cube';
import { bakeCurveLut } from '../color/curve';
import { defaultSettings } from '../recipe/defaults';
import type { Recipe } from '../recipe/schema';
import { drawRecipe, getPrograms, makeRgbaImage, nextGpuKey, type RenderInputs } from '../pipeline/render';
import { lutFor } from './exporter';

/** Lattice size of exported LUTs (33³ is the de-facto standard for .cube). */
export const LUT_EXPORT_SIZE = 33;

/**
 * Keeps only the global color/tone settings a 3D LUT can represent. Spatial operations
 * (geometry, local masks, sharpening, noise reduction, clarity/texture/dehaze, optics,
 * vignette, grain) depend on pixel position or neighbours and are dropped.
 */
export function lutRecipe(r: Recipe): Recipe {
  const d = defaultSettings();
  return {
    ...r,
    geometry: d.geometry,
    detail: d.detail,
    lens: d.lens,
    masks: [],
    effects: { ...d.effects, bw: r.effects.bw, bwMix: r.effects.bwMix },
  };
}

/** Renders the identity lattice through the develop pipeline and returns a .cube file. */
export function bakeLut(recipe: Recipe, title: string, n = LUT_EXPORT_SIZE): string {
  const r = lutRecipe(recipe);
  const W = n * n;
  const source = makeRgbaImage(identityStrip(n), W, n);
  const inputs: RenderInputs = {
    programs: getPrograms(),
    frame: { width: W, height: n, isRaw: false },
    source,
    // blurs equal to the source: every detail-based term cancels out
    blurN: source,
    blurS: source,
    blurM: source,
    blurL: source,
    curve: makeRgbaImage(bakeCurveLut(r.curves), 256, 1),
    lut: lutFor(r.lut.id),
    maskTextures: {},
    gpuKey: nextGpuKey(),
  };
  const pass = (outMode: 2 | 3) => {
    const surface = Skia.Surface.MakeOffscreen(W, n) ?? Skia.Surface.Make(W, n);
    if (!surface) throw new Error('Unable to allocate LUT surface');
    drawRecipe(surface.getCanvas(), inputs, r, { outMode });
    surface.flush();
    const img = surface.makeImageSnapshot();
    const px = img.readPixels(0, 0, { width: W, height: n, colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
    if (!px) throw new Error('Could not read LUT pixels');
    return px as Uint8Array;
  };
  return stripToCube(pass(2), pass(3), n, title);
}
