import {
  HSL_BANDS,
  RECIPE_VERSION,
  type Effects,
  type GradeWheel,
  type HslAdjust,
  type HslBand,
  type LocalAdjust,
  type Mask,
  type MaskType,
  type Recipe,
  type RecipeSettings,
  type SourceRef,
} from './schema';

const wheel = (): GradeWheel => ({ hue: 0, sat: 0, lum: 0 });
const bands = <T>(make: () => T): Record<HslBand, T> =>
  Object.fromEntries(HSL_BANDS.map((b) => [b, make()])) as Record<HslBand, T>;

export const identityCurve = () => [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export const defaultEffects = (): Effects => ({
  vignetteAmount: 0,
  vignetteMidpoint: 50,
  vignetteFeather: 50,
  vignetteRoundness: 0,
  grainAmount: 0,
  grainSize: 25,
  grainRoughness: 50,
  bloomAmount: 0,
  bloomThreshold: 70,
  bloomRadius: 50,
  halationAmount: 0,
  halationThreshold: 75,
  halationRadius: 50,
  bw: false,
  bwMix: bands(() => 0),
});

export function defaultSettings(): RecipeSettings {
  return {
    profile: 'standard',
    raw: { kelvin: null, tintShift: null, decodeNoise: 0, highlightRecovery: true, lensCorrection: true, boost: 100 },
    geometry: {
      crop: { x: 0, y: 0, w: 1, h: 1 },
      aspect: null,
      straighten: 0,
      rotate90: 0,
      flipH: false,
      flipV: false,
      perspectiveV: 0,
      perspectiveH: 0,
    },
    light: { exposure: 0, contrast: 0, highlights: 0, shadows: 0, whites: 0, blacks: 0 },
    color: { temperature: 0, tint: 0, vibrance: 0, saturation: 0 },
    curves: { rgb: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
    hsl: bands<HslAdjust>(() => ({ hue: 0, sat: 0, lum: 0 })),
    grading: { shadows: wheel(), midtones: wheel(), highlights: wheel(), global: wheel(), blending: 50, balance: 0 },
    detail: {
      sharpenAmount: 0,
      sharpenRadius: 1,
      sharpenDetail: 25,
      sharpenMasking: 0,
      noiseLuma: 0,
      noiseColor: 0,
      clarity: 0,
      texture: 0,
      dehaze: 0,
    },
    lens: { distortion: 0, chromatic: 0, vignetteCorrection: 0, autoProfile: true },
    effects: defaultEffects(),
    lut: { id: null, name: null, intensity: 100 },
    masks: [],
    retouch: [],
  };
}

export function createRecipe(source: SourceRef): Recipe {
  const s = defaultSettings();
  // RAW files get a gentle default capture sharpening and color NR, like desktop raw converters.
  if (source.isRaw || (source.useRaw && source.pairedUri)) {
    s.detail.sharpenAmount = 40;
    s.detail.noiseColor = 25;
  }
  return { version: RECIPE_VERSION, source, ...s, updatedAt: Date.now() };
}

export const defaultLocalAdjust = (): LocalAdjust => ({
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  temperature: 0,
  tint: 0,
  saturation: 0,
  clarity: 0,
  dehaze: 0,
  sharpness: 0,
  noise: 0,
});

let maskSeq = 0;
export function createMask(type: MaskType, name: string): Mask {
  maskSeq += 1;
  return {
    id: `m${Date.now().toString(36)}${maskSeq}`,
    name,
    type,
    visible: true,
    invert: type === 'background',
    opacity: 100,
    geometry: {
      x1: 0.5,
      y1: 0.15,
      x2: 0.5,
      y2: 0.55,
      cx: 0.5,
      cy: 0.5,
      rx: 0.3,
      ry: 0.3,
      angle: 0,
      feather: 0.5,
    },
    strokes: [],
    range: {
      enabled: type === 'luminance' || type === 'color',
      lumLow: 0.6,
      lumHigh: 1,
      lumSmooth: 0.15,
      hue: 210,
      sat: 0.5,
      hueTolerance: 0.25,
    },
    adjust: defaultLocalAdjust(),
  };
}
