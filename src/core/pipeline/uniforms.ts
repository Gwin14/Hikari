import { HSL_BANDS, type GradeWheel, type Mask, type Recipe } from '../recipe/schema';

export type UniformValues = Record<string, number | readonly number[]>;
export interface UniformLayout {
  floats: number;
  entries: { name: string; slot: number; size: number }[];
}

/** Packs named uniform values into the flat float array a runtime effect expects. */
export function packUniforms(layout: UniformLayout, values: UniformValues): number[] {
  'worklet';
  const out: number[] = new Array(layout.floats).fill(0);
  for (const e of layout.entries) {
    const v = values[e.name];
    if (v === undefined) continue;
    if (typeof v === 'number') out[e.slot] = v;
    else for (let i = 0; i < e.size && i < v.length; i++) out[e.slot + i] = v[i];
  }
  return out;
}

/** Approximate RGB of a black body at kelvin (Tanner Helland fit), normalized 0..1. */
export function kelvinToRgb(k: number): [number, number, number] {
  'worklet';
  const t = k / 100;
  let r: number;
  let g: number;
  let b: number;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  const c = (v: number) => Math.max(0, Math.min(255, v)) / 255;
  return [c(r), c(g), c(b)];
}

/**
 * White balance multipliers in linear light. temperature > 0 warms, tint > 0 adds magenta.
 * Normalized to keep luminance constant so WB doesn't shift exposure.
 */
export function wbMultipliers(temperature: number, tint: number): [number, number, number] {
  'worklet';
  if (temperature === 0 && tint === 0) return [1, 1, 1];
  // Map slider to a correlated color temperature around D65 on a mired scale.
  const mired = 1e6 / 6500 + (temperature / 100) * 90;
  const target = kelvinToRgb(1e6 / mired);
  const ref = kelvinToRgb(6500);
  let r = target[0] / ref[0];
  let g = target[1] / ref[1];
  let b = target[2] / ref[2];
  g *= 1 - (tint / 100) * 0.3;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r /= y;
  g /= y;
  b /= y;
  return [r, g, b];
}

function wheelOffset(w: GradeWheel): [number, number, number] {
  'worklet';
  if (w.sat === 0) return [0, 0, 0];
  const h = (w.hue % 360) / 60;
  const x = 1 - Math.abs((h % 2) - 1);
  let rgb: [number, number, number];
  if (h < 1) rgb = [1, x, 0];
  else if (h < 2) rgb = [x, 1, 0];
  else if (h < 3) rgb = [0, 1, x];
  else if (h < 4) rgb = [0, x, 1];
  else if (h < 5) rgb = [x, 0, 1];
  else rgb = [1, 0, x];
  const y = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const k = (w.sat / 100) * 0.22;
  return [(rgb[0] - y) * k, (rgb[1] - y) * k, (rgb[2] - y) * k];
}

function isIdentity(pts: { x: number; y: number }[]): boolean {
  'worklet';
  return pts.length === 2 && pts[0].x === 0 && pts[0].y === 0 && pts[1].x === 1 && pts[1].y === 1;
}

export interface FrameInfo {
  width: number;
  height: number;
  /** Whether the source carries >1.0 headroom (RAW decode). */
  isRaw: boolean;
}

export function developUniforms(r: Recipe, f: FrameInfo): UniformValues {
  'worklet';
  const L = r.light;
  const C = r.color;
  let contrast = L.contrast / 100;
  let sat = C.saturation / 100;
  let vib = C.vibrance / 100;
  let highlights = L.highlights / 100;
  let shadows = L.shadows / 100;
  const p = r.profile;
  if (p === 'vivid') {
    contrast += 0.12;
    sat += 0.12;
    vib += 0.15;
  } else if (p === 'neutral') {
    contrast -= 0.08;
    sat -= 0.05;
  } else if (p === 'flat') {
    contrast -= 0.35;
    sat -= 0.15;
    highlights -= 0.2;
    shadows += 0.2;
  }
  const hslH: number[] = [];
  const hslS: number[] = [];
  const hslL: number[] = [];
  const bwMix: number[] = [];
  for (const b of HSL_BANDS) {
    hslH.push(r.hsl[b].hue / 100);
    hslS.push(r.hsl[b].sat / 100);
    hslL.push(r.hsl[b].lum / 100);
    bwMix.push(r.effects.bwMix[b] / 100);
  }
  const g = r.grading;
  const c = r.curves;
  return {
    uSize: [f.width, f.height],
    uExposure: L.exposure,
    uWB: wbMultipliers(C.temperature, C.tint),
    uContrast: contrast,
    uHighlights: highlights,
    uShadows: shadows,
    uWhites: L.whites / 100,
    uBlacks: L.blacks / 100,
    uHeadroom: (f.isRaw && r.raw.highlightRecovery) || L.exposure > 0 ? 1 : 0,
    uVibrance: vib,
    uSaturation: sat,
    uHslH: hslH,
    uHslS: hslS,
    uHslL: hslL,
    uGradeS: wheelOffset(g.shadows),
    uGradeM: wheelOffset(g.midtones),
    uGradeH: wheelOffset(g.highlights),
    uGradeG: wheelOffset(g.global),
    uGradeLum: [g.shadows.lum / 100, g.highlights.lum / 100],
    uGradeMidLum: g.midtones.lum / 100,
    uGradeGlobalLum: g.global.lum / 100,
    uBlending: g.blending / 100,
    uBalance: g.balance / 100,
    uClarity: r.detail.clarity / 100,
    uTexture: r.detail.texture / 100,
    uDehaze: r.detail.dehaze / 100,
    uNoiseL: r.detail.noiseLuma / 100,
    uNoiseC: r.detail.noiseColor / 100,
    uDistortion: (r.lens.distortion / 100) * 0.15,
    uCA: (r.lens.chromatic / 100) * 0.004,
    uVigCorr: (r.lens.vignetteCorrection / 100) * 0.8,
    uBW: r.effects.bw || p === 'mono' ? 1 : 0,
    uBwMix: bwMix,
    uHasCurve: isIdentity(c.rgb) && isIdentity(c.r) && isIdentity(c.g) && isIdentity(c.b) ? 0 : 1,
  };
}

export const maskUsesTexture = (m: Mask) => {
  'worklet';
  return (
    m.type === 'brush' || m.type === 'subject' || m.type === 'sky' || m.type === 'background' || m.type === 'person' || m.type === 'object'
  );
};

export function localUniforms(m: Mask, f: FrameInfo, overlay: boolean): UniformValues {
  'worklet';
  const a = m.adjust;
  const type = maskUsesTexture(m) ? 0 : m.type === 'linear' ? 1 : m.type === 'radial' ? 2 : 3;
  const rangeMode = !m.range.enabled ? 0 : m.type === 'color' ? 2 : 1;
  const G = m.geometry;
  return {
    uSize: [f.width, f.height],
    uType: type,
    uLine: [G.x1, G.y1, G.x2, G.y2],
    uEllipse: [G.cx, G.cy, G.rx, G.ry],
    uEllipseRF: [G.angle, G.feather],
    uInvert: m.invert ? 1 : 0,
    uOpacity: m.opacity / 100,
    uRangeMode: rangeMode,
    uLumRange: [m.range.lumLow, m.range.lumHigh, m.range.lumSmooth],
    uColorRange: [m.range.hue / 360, m.range.sat, m.range.hueTolerance],
    uOverlay: overlay ? 1 : 0,
    uExposure: a.exposure / 25,
    uContrast: a.contrast / 100,
    uHighlights: a.highlights / 100,
    uShadows: a.shadows / 100,
    uWhites: a.whites / 100,
    uBlacks: a.blacks / 100,
    uWB: wbMultipliers(a.temperature, a.tint),
    uSaturation: a.saturation / 100,
    uClarity: a.clarity / 100,
    uDehaze: a.dehaze / 100,
    uSharpness: a.sharpness / 100,
    uNoise: a.noise / 100,
  };
}

export interface FinishExtras {
  crop: [number, number, number, number];
  lutSize: number;
  clip: boolean;
  /** 0 display, 1 data 8-bit, 2/3 high/low byte of 16-bit (export). */
  outMode?: number;
  outP3?: boolean;
}

export function finishUniforms(r: Recipe, f: FrameInfo, x: FinishExtras): UniformValues {
  'worklet';
  const d = r.detail;
  const e = r.effects;
  return {
    uSize: [f.width, f.height],
    uSharpen: d.sharpenAmount / 150,
    uSharpDetail: d.sharpenDetail / 100,
    uSharpMask: d.sharpenMasking / 100,
    uLutSize: x.lutSize,
    uLutMix: x.lutSize > 0 ? r.lut.intensity / 100 : 0,
    uCrop: x.crop,
    uVignette: [e.vignetteAmount / 100, e.vignetteMidpoint / 100, e.vignetteFeather / 100, e.vignetteRoundness / 100],
    uGrain: [e.grainAmount / 100, e.grainSize / 100, e.grainRoughness / 100],
    uGrainScale: Math.max(f.width, f.height) / 1800,
    uClip: x.clip ? 1 : 0,
    uOutMode: x.outMode ?? 0,
    uOutP3: x.outP3 ? 1 : 0,
  };
}
