/**
 * Non-destructive edit recipe. Everything the renderer needs to reproduce an edit
 * lives here; the original file is never modified. Values are normalized so that
 * 0 means "no change" unless stated otherwise.
 */

export const RECIPE_VERSION = 1;

export type SourceKind = 'library' | 'file';

export interface CurvePoint {
  x: number; // 0..1 input
  y: number; // 0..1 output
}

export interface Curves {
  rgb: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

export const HSL_BANDS = ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'] as const;
export type HslBand = (typeof HSL_BANDS)[number];

export interface HslAdjust {
  hue: number; // -100..100 (maps to ±30°)
  sat: number; // -100..100
  lum: number; // -100..100
}

export interface GradeWheel {
  hue: number; // 0..360
  sat: number; // 0..100
  lum: number; // -100..100
}

export interface Geometry {
  /** Crop rectangle in normalized coordinates of the *straightened* image. */
  crop: { x: number; y: number; w: number; h: number };
  /** Locked aspect (w/h) or null for free. */
  aspect: number | null;
  /** Fine straighten angle in degrees, -45..45. */
  straighten: number;
  /** Quarter turns clockwise 0..3. */
  rotate90: 0 | 1 | 2 | 3;
  flipH: boolean;
  flipV: boolean;
  /** Keystone correction, -100..100. */
  perspectiveV: number;
  perspectiveH: number;
}

export interface Light {
  exposure: number; // EV -5..5
  contrast: number; // -100..100
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
}

export interface ColorAdj {
  temperature: number; // -100..100 relative (Kelvin shift for RAW handled natively)
  tint: number; // -100..100
  vibrance: number;
  saturation: number;
}

export interface Detail {
  sharpenAmount: number; // 0..150
  sharpenRadius: number; // 0.5..3.0 px
  sharpenDetail: number; // 0..100
  sharpenMasking: number; // 0..100
  noiseLuma: number; // 0..100
  noiseColor: number; // 0..100
  clarity: number; // -100..100
  texture: number; // -100..100
  dehaze: number; // -100..100
}

export interface Lens {
  distortion: number; // -100..100
  chromatic: number; // 0..100
  vignetteCorrection: number; // -100..100
  autoProfile: boolean; // use embedded lens metadata (RAW)
}

export interface Effects {
  vignetteAmount: number; // -100..100 (post-crop)
  vignetteMidpoint: number; // 0..100
  vignetteFeather: number; // 0..100
  vignetteRoundness: number; // -100..100
  grainAmount: number; // 0..100
  grainSize: number; // 0..100
  grainRoughness: number; // 0..100
  bw: boolean;
  bwMix: Record<HslBand, number>; // -100..100
}

export interface Grading {
  shadows: GradeWheel;
  midtones: GradeWheel;
  highlights: GradeWheel;
  global: GradeWheel;
  blending: number; // 0..100
  balance: number; // -100..100
}

export interface LutRef {
  /** Id of an imported .cube file in the app's LUT library, or null. */
  id: string | null;
  name: string | null;
  intensity: number; // 0..100
}

export interface RawSettings {
  /** Kelvin/tint used when decoding RAW. null = as shot. */
  kelvin: number | null;
  tintShift: number | null;
  /** Native noise reduction during demosaic. 0..100 */
  decodeNoise: number;
  highlightRecovery: boolean;
  lensCorrection: boolean;
  /** Baseline exposure boost from camera profile, 0..100 (Apple "boost"). */
  boost: number;
}

export type MaskType = 'brush' | 'linear' | 'radial' | 'luminance' | 'color' | 'subject' | 'sky' | 'background' | 'person';

export interface BrushStroke {
  points: number[]; // flattened x,y normalized
  size: number; // normalized to image long edge
  hardness: number; // 0..1
  flow: number; // 0..1
  erase: boolean;
}

export interface MaskGeometry {
  // linear: from (x1,y1) to (x2,y2) — fully applied at 1, fades to 0 at 2
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  // radial: center + radii (normalized), rotation radians, feather 0..1
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  angle: number;
  feather: number;
}

export interface RangeSpec {
  enabled: boolean;
  /** luminance: [low, high] with smoothness. color: target hue/sat with tolerance. */
  lumLow: number;
  lumHigh: number;
  lumSmooth: number;
  hue: number; // 0..360
  sat: number; // 0..1
  hueTolerance: number; // 0..1
}

export interface LocalAdjust {
  exposure: number;
  contrast: number;
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  temperature: number;
  tint: number;
  saturation: number;
  clarity: number;
  dehaze: number;
  sharpness: number;
  noise: number;
}

export interface Mask {
  id: string;
  name: string;
  type: MaskType;
  visible: boolean;
  invert: boolean;
  opacity: number; // 0..100
  geometry: MaskGeometry;
  strokes: BrushStroke[];
  /** Range refinement intersected with the mask (or the mask itself for luminance/color). */
  range: RangeSpec;
  adjust: LocalAdjust;
}

export interface SourceRef {
  kind: SourceKind;
  /** MediaLibrary asset id or file uri. */
  id: string;
  uri: string;
  filename: string;
  /** Uri of the paired RAW (when the main item is a JPEG/HEIC) or vice versa. */
  pairedUri: string | null;
  /** When a pair exists: which one the recipe develops. */
  useRaw: boolean;
  isRaw: boolean;
}

export interface Recipe {
  version: number;
  source: SourceRef;
  raw: RawSettings;
  geometry: Geometry;
  light: Light;
  color: ColorAdj;
  curves: Curves;
  hsl: Record<HslBand, HslAdjust>;
  grading: Grading;
  detail: Detail;
  lens: Lens;
  effects: Effects;
  lut: LutRef;
  masks: Mask[];
  /** Profile look: 'color' | 'vivid' | 'neutral' | 'flat' | 'mono'. */
  profile: ProfileId;
  updatedAt: number;
}

export type ProfileId = 'standard' | 'vivid' | 'neutral' | 'flat' | 'mono';

/** Sections that can be copied/pasted or saved into presets selectively. */
export const RECIPE_SECTIONS = [
  'profile',
  'raw',
  'geometry',
  'light',
  'color',
  'curves',
  'hsl',
  'grading',
  'detail',
  'lens',
  'effects',
  'lut',
  'masks',
] as const;
export type RecipeSection = (typeof RECIPE_SECTIONS)[number];

export type RecipeSettings = Omit<Recipe, 'version' | 'source' | 'updatedAt'>;
