import { buildSpline, isIdentityCurve } from '../color/curve';
import { defaultSettings } from '../recipe/defaults';
import { HSL_BANDS, type CurvePoint, type GradeWheel, type HslBand, type RecipeSection, type RecipeSettings } from '../recipe/schema';

/**
 * Adobe Camera Raw settings (`crs:` namespace), the format behind Lightroom presets
 * (.xmp, Lightroom Classic 7.3+ / Lightroom / ACR), the legacy Lua `.lrtemplate` presets
 * and XMP sidecars. Values are kept as strings (scalars) or string lists (rdf:Seq).
 * Keys are stored without the `crs:` prefix.
 */
export type CrsMap = Record<string, string | string[]>;

const BAND_NAME: Record<HslBand, string> = {
  red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', aqua: 'Aqua', blue: 'Blue', purple: 'Purple', magenta: 'Magenta',
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const round4 = (v: number) => Math.round(v * 10000) / 10000;
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);
const int = (v: number) => signed(Math.round(v));
const bool = (v: boolean) => (v ? 'True' : 'False');

// ---------------------------------------------------------------------------
// Tone curves

const curveToSeq = (pts: CurvePoint[]) =>
  [...pts].sort((a, b) => a.x - b.x).map((p) => `${Math.round(clamp(p.x, 0, 1) * 255)}, ${Math.round(clamp(p.y, 0, 1) * 255)}`);

function seqToCurve(seq: string[]): CurvePoint[] | null {
  const pts = seq
    .map((s) => s.split(',').map((v) => Number(v.trim())))
    .filter((p) => p.length === 2 && p.every(Number.isFinite))
    .map(([x, y]) => ({ x: clamp(x / 255, 0, 1), y: clamp(y / 255, 0, 1) }));
  return pts.length >= 2 ? pts : null;
}

/**
 * Approximates Lightroom's parametric (region) curve: each region slider pushes the curve
 * up/down with a smooth bump between its split points. Returns null when flat.
 */
function parametricCurve(m: CrsMap): ((x: number) => number) | null {
  const n = (k: string, d: number) => {
    const v = Number(m[k]);
    return Number.isFinite(v) ? v : d;
  };
  const amt = [n('ParametricShadows', 0), n('ParametricDarks', 0), n('ParametricLights', 0), n('ParametricHighlights', 0)].map((v) => v / 100);
  if (amt.every((v) => v === 0)) return null;
  const s1 = n('ParametricShadowSplit', 25) / 100;
  const s2 = n('ParametricMidtoneSplit', 50) / 100;
  const s3 = n('ParametricHighlightSplit', 75) / 100;
  const edges = [0, s1, s2, s3, 1];
  const bump = (x: number, lo: number, hi: number) => {
    // raised cosine spanning the region and half of its neighbours
    const c = (lo + hi) / 2;
    const w = hi - lo;
    const d = Math.abs(x - c) / w;
    return d >= 1 ? 0 : 0.5 + 0.5 * Math.cos(Math.PI * d);
  };
  return (x) => {
    let y = x;
    for (let i = 0; i < 4; i++) y += amt[i] * 0.25 * bump(x, edges[i], edges[i + 1]) * Math.min(1, 6 * x * (1 - x));
    return clamp(y, 0, 1);
  };
}

/** Bakes `outer ∘ inner` into a point curve sampled densely enough for the monotone spline. */
function composeCurve(inner: (x: number) => number, outer: CurvePoint[]): CurvePoint[] {
  const f = buildSpline(outer);
  const pts: CurvePoint[] = [];
  for (let i = 0; i <= 16; i++) {
    const x = i / 16;
    pts.push({ x, y: round2(clamp(f(inner(x)), 0, 1) * 100) / 100 });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Hikari → Camera Raw

/** Camera Raw values for the given sections (all sections of a full recipe). */
export function settingsToCrs(s: Partial<RecipeSettings>): CrsMap {
  const a: CrsMap = {};
  if (s.light) {
    const L = s.light;
    a.Exposure2012 = signed(round2(L.exposure));
    a.Contrast2012 = int(L.contrast);
    a.Highlights2012 = int(L.highlights);
    a.Shadows2012 = int(L.shadows);
    a.Whites2012 = int(L.whites);
    a.Blacks2012 = int(L.blacks);
  }
  if (s.color) {
    const C = s.color;
    if (C.temperature !== 0 || C.tint !== 0) {
      a.WhiteBalance = 'Custom';
      a.IncrementalTemperature = int(C.temperature * 0.8);
      a.IncrementalTint = int(C.tint * 0.8);
    } else {
      a.WhiteBalance = 'As Shot';
    }
    a.Vibrance = int(C.vibrance);
    a.Saturation = int(C.saturation);
  }
  if (s.curves) {
    a.ToneCurveName2012 = isIdentityCurve(s.curves.rgb) ? 'Linear' : 'Custom';
    a.ToneCurvePV2012 = curveToSeq(s.curves.rgb);
    a.ToneCurvePV2012Red = curveToSeq(s.curves.r);
    a.ToneCurvePV2012Green = curveToSeq(s.curves.g);
    a.ToneCurvePV2012Blue = curveToSeq(s.curves.b);
    for (const k of ['ParametricShadows', 'ParametricDarks', 'ParametricLights', 'ParametricHighlights']) a[k] = '0';
    a.ParametricShadowSplit = '25';
    a.ParametricMidtoneSplit = '50';
    a.ParametricHighlightSplit = '75';
  }
  if (s.hsl) {
    for (const b of HSL_BANDS) {
      const h = s.hsl[b];
      a[`HueAdjustment${BAND_NAME[b]}`] = int(h.hue);
      a[`SaturationAdjustment${BAND_NAME[b]}`] = int(h.sat);
      a[`LuminanceAdjustment${BAND_NAME[b]}`] = int(h.lum);
    }
  }
  if (s.grading) {
    const g = s.grading;
    // Lightroom 10+ keeps shadow/highlight hue+sat in the old split-toning keys.
    a.SplitToningShadowHue = String(Math.round(g.shadows.hue) % 360);
    a.SplitToningShadowSaturation = String(Math.round(g.shadows.sat));
    a.SplitToningHighlightHue = String(Math.round(g.highlights.hue) % 360);
    a.SplitToningHighlightSaturation = String(Math.round(g.highlights.sat));
    a.SplitToningBalance = int(g.balance);
    a.ColorGradeShadowLum = int(g.shadows.lum);
    a.ColorGradeHighlightLum = int(g.highlights.lum);
    a.ColorGradeMidtoneHue = String(Math.round(g.midtones.hue) % 360);
    a.ColorGradeMidtoneSat = String(Math.round(g.midtones.sat));
    a.ColorGradeMidtoneLum = int(g.midtones.lum);
    a.ColorGradeGlobalHue = String(Math.round(g.global.hue) % 360);
    a.ColorGradeGlobalSat = String(Math.round(g.global.sat));
    a.ColorGradeGlobalLum = int(g.global.lum);
    a.ColorGradeBlending = String(Math.round(g.blending));
  }
  if (s.detail) {
    const D = s.detail;
    a.Sharpness = String(Math.round(D.sharpenAmount));
    a.SharpenRadius = signed(Math.round(D.sharpenRadius * 10) / 10);
    a.SharpenDetail = String(Math.round(D.sharpenDetail));
    a.SharpenEdgeMasking = String(Math.round(D.sharpenMasking));
    a.LuminanceSmoothing = String(Math.round(D.noiseLuma));
    a.ColorNoiseReduction = String(Math.round(D.noiseColor));
    a.Clarity2012 = int(D.clarity);
    a.Texture = int(D.texture);
    a.Dehaze = int(D.dehaze);
  }
  if (s.lens) {
    a.LensProfileEnable = s.lens.autoProfile ? '1' : '0';
    a.LensManualDistortionAmount = int(s.lens.distortion);
    a.VignetteAmount = int(s.lens.vignetteCorrection);
    a.AutoLateralCA = s.lens.chromatic > 0 ? '1' : '0';
  }
  if (s.effects) {
    const E = s.effects;
    a.PostCropVignetteAmount = int(E.vignetteAmount);
    a.PostCropVignetteMidpoint = String(Math.round(E.vignetteMidpoint));
    a.PostCropVignetteFeather = String(Math.round(E.vignetteFeather));
    a.PostCropVignetteRoundness = int(E.vignetteRoundness);
    a.PostCropVignetteStyle = '1';
    a.GrainAmount = String(Math.round(E.grainAmount));
    a.GrainSize = String(Math.round(E.grainSize));
    a.GrainFrequency = String(Math.round(E.grainRoughness));
    for (const b of HSL_BANDS) a[`GrayMixer${BAND_NAME[b]}`] = int(E.bwMix[b]);
  }
  if (s.effects || s.profile) {
    a.ConvertToGrayscale = bool(!!s.effects?.bw || s.profile === 'mono');
  }
  if (s.geometry) {
    const G = s.geometry;
    const cropped = G.crop.x > 0 || G.crop.y > 0 || G.crop.w < 1 || G.crop.h < 1 || G.straighten !== 0;
    a.HasCrop = bool(cropped);
    a.CropLeft = String(round4(G.crop.x));
    a.CropTop = String(round4(G.crop.y));
    a.CropRight = String(round4(G.crop.x + G.crop.w));
    a.CropBottom = String(round4(G.crop.y + G.crop.h));
    a.CropAngle = String(round2(G.straighten));
    a.PerspectiveVertical = int(G.perspectiveV);
    a.PerspectiveHorizontal = int(G.perspectiveH);
  }
  return a;
}

// ---------------------------------------------------------------------------
// Camera Raw → Hikari

export interface CrsImport {
  settings: Partial<RecipeSettings>;
  /** Camera Raw keys that were read into Hikari settings. */
  used: number;
}

/**
 * Converts Camera Raw values into Hikari sections. Only sections with at least one key
 * present are returned; missing keys in a returned section take Hikari's defaults (which
 * equal Lightroom's neutral values).
 */
export function crsToSettings(m: CrsMap): CrsImport {
  const d = defaultSettings();
  const touched = new Set<RecipeSection>();
  let used = 0;
  const num = (key: string, section: RecipeSection): number | undefined => {
    const raw = m[key];
    if (raw === undefined || Array.isArray(raw)) return undefined;
    const v = Number(raw.trim());
    if (!Number.isFinite(v)) return undefined;
    touched.add(section);
    used++;
    return v;
  };
  const set = (key: string, section: RecipeSection, lo: number, hi: number, apply: (v: number) => void) => {
    const v = num(key, section);
    if (v !== undefined) apply(clamp(v, lo, hi));
  };
  const str = (key: string) => {
    const v = m[key];
    return typeof v === 'string' ? v.trim() : undefined;
  };

  // --- light (PV2012 keys, legacy Exposure as fallback)
  set(m.Exposure2012 !== undefined ? 'Exposure2012' : 'Exposure', 'light', -5, 5, (v) => (d.light.exposure = v));
  set('Contrast2012', 'light', -100, 100, (v) => (d.light.contrast = v));
  set('Highlights2012', 'light', -100, 100, (v) => (d.light.highlights = v));
  set('Shadows2012', 'light', -100, 100, (v) => (d.light.shadows = v));
  set('Whites2012', 'light', -100, 100, (v) => (d.light.whites = v));
  set('Blacks2012', 'light', -100, 100, (v) => (d.light.blacks = v));

  // --- white balance & presence
  set('Vibrance', 'color', -100, 100, (v) => (d.color.vibrance = v));
  set('Saturation', 'color', -100, 100, (v) => (d.color.saturation = v));
  const wb = str('WhiteBalance');
  if (wb) touched.add('color');
  if (m.IncrementalTemperature !== undefined || m.IncrementalTint !== undefined) {
    set('IncrementalTemperature', 'color', -100, 100, (v) => (d.color.temperature = clamp(v / 0.8, -100, 100)));
    set('IncrementalTint', 'color', -100, 100, (v) => (d.color.tint = clamp(v / 0.8, -100, 100)));
  } else if (wb !== 'As Shot' && (m.Temperature !== undefined || m.Tint !== undefined)) {
    // Absolute Kelvin (RAW presets): expressed relative to a ~5500 K daylight capture on a mired scale.
    set('Temperature', 'color', 2000, 50000, (k) => (d.color.temperature = clamp(((1e6 / 5500 - 1e6 / k) / 90) * 100, -100, 100)));
    set('Tint', 'color', -150, 150, (t) => (d.color.tint = clamp((t / 150) * 100, -100, 100)));
  }

  // --- tone curves
  const curveKeys = ['ToneCurvePV2012', 'ToneCurvePV2012Red', 'ToneCurvePV2012Green', 'ToneCurvePV2012Blue'] as const;
  const chans = ['rgb', 'r', 'g', 'b'] as const;
  curveKeys.forEach((k, i) => {
    const v = m[k];
    const pts = Array.isArray(v) ? seqToCurve(v) : null;
    if (pts) {
      d.curves[chans[i]] = pts;
      touched.add('curves');
      used++;
    }
  });
  const param = parametricCurve(m);
  if (param) {
    d.curves.rgb = composeCurve(param, d.curves.rgb);
    touched.add('curves');
    used++;
  }

  // --- HSL / B&W mixer
  for (const b of HSL_BANDS) {
    const n = BAND_NAME[b];
    set(`HueAdjustment${n}`, 'hsl', -100, 100, (v) => (d.hsl[b].hue = v));
    set(`SaturationAdjustment${n}`, 'hsl', -100, 100, (v) => (d.hsl[b].sat = v));
    set(`LuminanceAdjustment${n}`, 'hsl', -100, 100, (v) => (d.hsl[b].lum = v));
    set(`GrayMixer${n}`, 'effects', -100, 100, (v) => (d.effects.bwMix[b] = v));
  }

  // --- color grading (and legacy split toning, which shares the shadow/highlight keys)
  const wheel = (w: GradeWheel, hue: string, sat: string, lum: string | null) => {
    set(hue, 'grading', 0, 360, (v) => (w.hue = v));
    set(sat, 'grading', 0, 100, (v) => (w.sat = v));
    if (lum) set(lum, 'grading', -100, 100, (v) => (w.lum = v));
  };
  wheel(d.grading.shadows, 'SplitToningShadowHue', 'SplitToningShadowSaturation', 'ColorGradeShadowLum');
  wheel(d.grading.highlights, 'SplitToningHighlightHue', 'SplitToningHighlightSaturation', 'ColorGradeHighlightLum');
  wheel(d.grading.midtones, 'ColorGradeMidtoneHue', 'ColorGradeMidtoneSat', 'ColorGradeMidtoneLum');
  wheel(d.grading.global, 'ColorGradeGlobalHue', 'ColorGradeGlobalSat', 'ColorGradeGlobalLum');
  set('ColorGradeBlending', 'grading', 0, 100, (v) => (d.grading.blending = v));
  set('SplitToningBalance', 'grading', -100, 100, (v) => (d.grading.balance = v));

  // --- detail
  set('Sharpness', 'detail', 0, 150, (v) => (d.detail.sharpenAmount = v));
  set('SharpenRadius', 'detail', 0.5, 3, (v) => (d.detail.sharpenRadius = v));
  set('SharpenDetail', 'detail', 0, 100, (v) => (d.detail.sharpenDetail = v));
  set('SharpenEdgeMasking', 'detail', 0, 100, (v) => (d.detail.sharpenMasking = v));
  set('LuminanceSmoothing', 'detail', 0, 100, (v) => (d.detail.noiseLuma = v));
  set('ColorNoiseReduction', 'detail', 0, 100, (v) => (d.detail.noiseColor = v));
  set(m.Clarity2012 !== undefined ? 'Clarity2012' : 'Clarity', 'detail', -100, 100, (v) => (d.detail.clarity = v));
  set('Texture', 'detail', -100, 100, (v) => (d.detail.texture = v));
  set('Dehaze', 'detail', -100, 100, (v) => (d.detail.dehaze = v));

  // --- optics
  set('LensProfileEnable', 'lens', 0, 1, (v) => (d.lens.autoProfile = v >= 1));
  set('LensManualDistortionAmount', 'lens', -100, 100, (v) => (d.lens.distortion = v));
  set('VignetteAmount', 'lens', -100, 100, (v) => (d.lens.vignetteCorrection = v));
  set('AutoLateralCA', 'lens', 0, 1, (v) => (d.lens.chromatic = v >= 1 ? 50 : 0));

  // --- effects
  set('PostCropVignetteAmount', 'effects', -100, 100, (v) => (d.effects.vignetteAmount = v));
  set('PostCropVignetteMidpoint', 'effects', 0, 100, (v) => (d.effects.vignetteMidpoint = v));
  set('PostCropVignetteFeather', 'effects', 0, 100, (v) => (d.effects.vignetteFeather = v));
  set('PostCropVignetteRoundness', 'effects', -100, 100, (v) => (d.effects.vignetteRoundness = v));
  set('GrainAmount', 'effects', 0, 100, (v) => (d.effects.grainAmount = v));
  set('GrainSize', 'effects', 0, 100, (v) => (d.effects.grainSize = v));
  set('GrainFrequency', 'effects', 0, 100, (v) => (d.effects.grainRoughness = v));
  const gray = str('ConvertToGrayscale');
  if (gray) {
    d.effects.bw = /^true$/i.test(gray);
    touched.add('effects');
    used++;
  }

  // --- profile (Adobe look names → closest Hikari profile)
  const look = `${str('LookName') ?? ''} ${str('CameraProfile') ?? ''}`.toLowerCase();
  if (look.trim() || gray) {
    touched.add('profile');
    if (d.effects.bw || /monochrome|b&w|bw\b/.test(look)) d.profile = 'mono';
    else if (/vivid|landscape/.test(look)) d.profile = 'vivid';
    else if (/neutral|faithful/.test(look)) d.profile = 'neutral';
    else if (/flat|log/.test(look)) d.profile = 'flat';
    else d.profile = 'standard';
  }

  // --- geometry
  if (/^true$/i.test(str('HasCrop') ?? '')) {
    const l = num('CropLeft', 'geometry') ?? 0;
    const t = num('CropTop', 'geometry') ?? 0;
    const r = num('CropRight', 'geometry') ?? 1;
    const b = num('CropBottom', 'geometry') ?? 1;
    d.geometry.crop = { x: clamp(l, 0, 1), y: clamp(t, 0, 1), w: clamp(r - l, 0.01, 1), h: clamp(b - t, 0.01, 1) };
    set('CropAngle', 'geometry', -45, 45, (v) => (d.geometry.straighten = v));
  }
  set('PerspectiveVertical', 'geometry', -100, 100, (v) => (d.geometry.perspectiveV = v));
  set('PerspectiveHorizontal', 'geometry', -100, 100, (v) => (d.geometry.perspectiveH = v));

  const settings: Partial<RecipeSettings> = {};
  for (const k of touched) (settings as Record<string, unknown>)[k] = d[k];
  return { settings, used };
}

// ---------------------------------------------------------------------------
// XMP read/write

const unescapeXml = (s: string) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface XmpCrs {
  values: CrsMap;
  name: string | null;
  group: string | null;
}

/**
 * Reads the top-level `crs:` settings of an XMP packet. Structured children (masks, local
 * corrections, Look tables) are skipped so their nested `crs:` attributes don't leak into
 * the global settings.
 */
export function parseXmpCrs(xml: string): XmpCrs {
  const values: CrsMap = {};
  let name: string | null = null;
  let group: string | null = null;
  const li = (body: string) => [...body.matchAll(/<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/g)].map((x) => unescapeXml(x[1].trim()));
  let rest = xml;
  for (const el of xml.matchAll(/<crs:(\w+)(\s[^>]*)?>([\s\S]*?)<\/crs:\1>/g)) {
    const [whole, key, attrs = '', body] = el;
    rest = rest.replace(whole, '');
    if (key === 'Look') {
      const n = (attrs + body).match(/crs:Name\s*=\s*"([^"]*)"/) ?? body.match(/<crs:Name>([^<]*)<\/crs:Name>/);
      if (n) values.LookName = unescapeXml(n[1]);
    } else if (body.includes('<rdf:Seq')) {
      values[key] = li(body);
    } else if (body.includes('<rdf:Alt')) {
      const v = li(body)[0] ?? '';
      if (key === 'Name') name = v;
      else if (key === 'Group') group = v;
      else values[key] = v;
    } else if (!body.includes('<')) {
      values[key] = unescapeXml(body.trim());
    }
  }
  // Self-closing structured children (e.g. <crs:Look crs:Name="…"/>)
  rest = rest.replace(/<crs:(\w+)\s[^>]*\/>/g, (whole, key) => {
    if (key === 'Look') {
      const n = whole.match(/crs:Name\s*=\s*"([^"]*)"/);
      if (n) values.LookName = unescapeXml(n[1]);
    }
    return '';
  });
  for (const a of rest.matchAll(/\bcrs:(\w+)\s*=\s*"([^"]*)"/g)) {
    if (!(a[1] in values)) values[a[1]] = unescapeXml(a[2]);
  }
  return { values, name, group };
}

/** Serializes Camera Raw values as `rdf:Description` attributes + element children. */
export function crsXmlParts(values: CrsMap): { attrs: string[]; elements: string[] } {
  const attrs: string[] = [];
  const elements: string[] = [];
  for (const [k, v] of Object.entries(values)) {
    if (Array.isArray(v)) {
      const items = v.map((x) => `      <rdf:li>${escapeXml(x)}</rdf:li>`).join('\n');
      elements.push(`   <crs:${k}>\n    <rdf:Seq>\n${items}\n    </rdf:Seq>\n   </crs:${k}>`);
    } else {
      attrs.push(`   crs:${k}="${escapeXml(v)}"`);
    }
  }
  return { attrs, elements };
}

export const altElement = (key: string, value: string) =>
  `   <crs:${key}>\n    <rdf:Alt>\n     <rdf:li xml:lang="x-default">${escapeXml(value)}</rdf:li>\n    </rdf:Alt>\n   </crs:${key}>`;

function uuid32(): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16).toUpperCase();
  return s;
}

/** A Lightroom Classic / Lightroom / ACR develop preset (.xmp). */
export function writeLightroomPreset(name: string, settings: Partial<RecipeSettings>, group = 'Hikari'): string {
  const values: CrsMap = {
    PresetType: 'Normal',
    Cluster: '',
    UUID: uuid32(),
    SupportsAmount2: 'True',
    SupportsAmount: 'True',
    SupportsColor: 'True',
    SupportsMonochrome: 'True',
    SupportsHighDynamicRange: 'True',
    SupportsNormalDynamicRange: 'True',
    SupportsSceneReferred: 'True',
    SupportsOutputReferred: 'True',
    RequiresRGBTables: 'False',
    CameraModelRestriction: '',
    Copyright: '',
    ContactInfo: '',
    Version: '15.0',
    ProcessVersion: '11.0',
    ...settingsToCrs(settings),
    HasSettings: 'True',
  };
  const { attrs, elements } = crsXmlParts(values);
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Hikari">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
${attrs.join('\n')}>
${[altElement('Name', name), altElement('ShortName', ''), altElement('SortName', ''), altElement('Group', group), altElement('Description', ''), ...elements].join('\n')}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}

// ---------------------------------------------------------------------------
// Legacy Lightroom (.lrtemplate, a Lua table literal)

type Lua = string | number | boolean | null | Lua[] | { [k: string]: Lua };

function parseLua(src: string): Lua {
  let i = 0;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i])) i++;
      if (src.startsWith('--', i)) {
        if (src.startsWith('--[[', i)) i = src.indexOf(']]', i) + 2 || src.length;
        else while (i < src.length && src[i] !== '\n') i++;
      } else return;
    }
  };
  const ident = () => {
    const m = /^[A-Za-z_]\w*/.exec(src.slice(i, i + 256));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const string = (): string => {
    if (src.startsWith('[[', i)) {
      const end = src.indexOf(']]', i);
      const s = src.slice(i + 2, end);
      i = end + 2;
      return s;
    }
    const q = src[i++];
    let out = '';
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') {
        const c = src[++i];
        out += c === 'n' ? '\n' : c === 't' ? '\t' : c;
        i++;
      } else out += src[i++];
    }
    i++;
    return out;
  };
  const value = (): Lua => {
    ws();
    const c = src[i];
    if (c === '{') return table();
    if (c === '"' || c === "'" || src.startsWith('[[', i)) return string();
    const n = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i, i + 64));
    if (n) {
      i += n[0].length;
      return Number(n[0]);
    }
    const id = ident();
    if (id === 'true') return true;
    if (id === 'false') return false;
    if (id === 'nil' || id === null) return null;
    // function-call style, e.g. ZSTR "$$$/Key=Name"
    ws();
    if (src[i] === '"' || src[i] === "'") return string();
    return null;
  };
  const table = (): Lua => {
    i++; // {
    const obj: Record<string, Lua> = {};
    const arr: Lua[] = [];
    let keyed = false;
    for (;;) {
      ws();
      if (i >= src.length) break;
      if (src[i] === '}') {
        i++;
        break;
      }
      let key: string | null = null;
      const save = i;
      if (src[i] === '[') {
        i++;
        const k = value();
        ws();
        i++; // ]
        ws();
        i++; // =
        key = String(k);
      } else {
        const id = ident();
        ws();
        if (id && src[i] === '=' && src[i + 1] !== '=') {
          i++;
          key = id;
        } else i = save;
      }
      const v = value();
      if (key !== null) {
        keyed = true;
        obj[key] = v;
      } else arr.push(v);
      ws();
      if (src[i] === ',' || src[i] === ';') i++;
    }
    return keyed ? obj : arr;
  };
  ws();
  // `s = { ... }`
  const eq = src.indexOf('{', i);
  if (eq < 0) throw new Error('Not a Lightroom template');
  i = eq;
  return table();
}

/** Reads a legacy Lightroom `.lrtemplate` develop preset. */
export function parseLrTemplate(text: string): XmpCrs {
  const root = parseLua(text) as Record<string, Lua>;
  const value = (root?.value ?? {}) as Record<string, Lua>;
  const settings = (value.settings ?? null) as Record<string, Lua> | null;
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Not a Lightroom develop preset');
  const values: CrsMap = {};
  for (const [k, v] of Object.entries(settings)) {
    if (typeof v === 'number') values[k] = String(v);
    else if (typeof v === 'boolean') values[k] = bool(v);
    else if (typeof v === 'string') values[k] = v;
    else if (Array.isArray(v) && v.every((x) => typeof x === 'number')) {
      const pairs: string[] = [];
      for (let j = 0; j + 1 < v.length; j += 2) pairs.push(`${v[j]}, ${v[j + 1]}`);
      values[k] = pairs;
    }
  }
  const title = typeof root.title === 'string' ? root.title.replace(/^\$\$\$[^=]*=/, '') : null;
  const name = typeof root.internalName === 'string' ? root.internalName : title;
  return { values, name: name || null, group: null };
}
