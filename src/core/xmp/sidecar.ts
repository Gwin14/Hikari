import { migrateRecipe } from '../recipe/ops';
import type { Recipe } from '../recipe/schema';

/**
 * XMP sidecars: the complete recipe lives in the `hikari:Recipe` attribute (base64 JSON),
 * plus a `crs:` (Camera Raw) mapping of the basic settings so Lightroom/ACR/Capture One
 * pick up the main adjustments when the folder is opened there.
 */

const b64 = {
  encode(s: string): string {
    const bytes = new TextEncoder().encode(s);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  },
  decode(s: string): string {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  },
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);

function crsAttributes(r: Recipe, rating: number): Record<string, string> {
  const a: Record<string, string> = {
    'crs:Version': '15.0',
    'crs:ProcessVersion': '11.0',
    'crs:Exposure2012': signed(Math.round(r.light.exposure * 100) / 100),
    'crs:Contrast2012': signed(r.light.contrast),
    'crs:Highlights2012': signed(r.light.highlights),
    'crs:Shadows2012': signed(r.light.shadows),
    'crs:Whites2012': signed(r.light.whites),
    'crs:Blacks2012': signed(r.light.blacks),
    'crs:Clarity2012': signed(r.detail.clarity),
    'crs:Texture': signed(r.detail.texture),
    'crs:Dehaze': signed(r.detail.dehaze),
    'crs:Vibrance': signed(r.color.vibrance),
    'crs:Saturation': signed(r.color.saturation),
    'crs:IncrementalTemperature': signed(Math.round(r.color.temperature * 0.8)),
    'crs:IncrementalTint': signed(Math.round(r.color.tint * 0.8)),
    'crs:Sharpness': String(Math.round(r.detail.sharpenAmount)),
    'crs:SharpenRadius': String(r.detail.sharpenRadius),
    'crs:SharpenDetail': String(Math.round(r.detail.sharpenDetail)),
    'crs:SharpenEdgeMasking': String(Math.round(r.detail.sharpenMasking)),
    'crs:LuminanceSmoothing': String(Math.round(r.detail.noiseLuma)),
    'crs:ColorNoiseReduction': String(Math.round(r.detail.noiseColor)),
    'crs:PostCropVignetteAmount': signed(r.effects.vignetteAmount),
    'crs:GrainAmount': String(Math.round(r.effects.grainAmount)),
    'crs:ConvertToGrayscale': r.effects.bw || r.profile === 'mono' ? 'True' : 'False',
    'crs:HasCrop': r.geometry.crop.w < 1 || r.geometry.crop.h < 1 ? 'True' : 'False',
    'crs:CropLeft': String(r.geometry.crop.x),
    'crs:CropTop': String(r.geometry.crop.y),
    'crs:CropRight': String(r.geometry.crop.x + r.geometry.crop.w),
    'crs:CropBottom': String(r.geometry.crop.y + r.geometry.crop.h),
    'crs:CropAngle': String(r.geometry.straighten),
    'crs:HasSettings': 'True',
    'xmp:Rating': String(rating),
  };
  const names: Record<string, string> = {
    red: 'Red', orange: 'Orange', yellow: 'Yellow', green: 'Green', aqua: 'Aqua', blue: 'Blue', purple: 'Purple', magenta: 'Magenta',
  };
  for (const [band, n] of Object.entries(names)) {
    const h = r.hsl[band as keyof typeof r.hsl];
    a[`crs:HueAdjustment${n}`] = signed(h.hue);
    a[`crs:SaturationAdjustment${n}`] = signed(h.sat);
    a[`crs:LuminanceAdjustment${n}`] = signed(h.lum);
  }
  return a;
}

export function writeSidecar(recipe: Recipe, rating = 0): string {
  const attrs = crsAttributes(recipe, rating);
  attrs['hikari:Recipe'] = b64.encode(JSON.stringify(recipe));
  const body = Object.entries(attrs)
    .map(([k, v]) => `    ${k}="${esc(v)}"`)
    .join('\n');
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Hikari">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:hikari="https://hikari.app/ns/1.0/"
${body}/>
 </rdf:RDF>
</x:xmpmeta>
`;
}

function attr(xml: string, name: string): string | null {
  const m = xml.match(new RegExp(`${name.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`));
  if (m) return m[1];
  const el = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return el ? el[1] : null;
}

export interface SidecarData {
  recipe: Recipe | null;
  /** Basic settings from a foreign (Lightroom) sidecar, applied when no Hikari recipe exists. */
  crs: Partial<{ exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number; clarity: number; vibrance: number; saturation: number; dehaze: number; texture: number }>;
  rating: number;
}

export function readSidecar(xml: string): SidecarData {
  const encoded = attr(xml, 'hikari:Recipe');
  let recipe: Recipe | null = null;
  if (encoded) {
    try {
      recipe = migrateRecipe(JSON.parse(b64.decode(encoded)));
    } catch {
      recipe = null;
    }
  }
  const num = (n: string) => {
    const v = attr(xml, n);
    return v == null ? undefined : Number(v);
  };
  const crs: SidecarData['crs'] = {};
  const map: [keyof SidecarData['crs'], string][] = [
    ['exposure', 'crs:Exposure2012'],
    ['contrast', 'crs:Contrast2012'],
    ['highlights', 'crs:Highlights2012'],
    ['shadows', 'crs:Shadows2012'],
    ['whites', 'crs:Whites2012'],
    ['blacks', 'crs:Blacks2012'],
    ['clarity', 'crs:Clarity2012'],
    ['vibrance', 'crs:Vibrance'],
    ['saturation', 'crs:Saturation'],
    ['dehaze', 'crs:Dehaze'],
    ['texture', 'crs:Texture'],
  ];
  for (const [k, n] of map) {
    const v = num(n);
    if (v !== undefined && !Number.isNaN(v)) crs[k] = v;
  }
  return { recipe, crs, rating: num('xmp:Rating') ?? 0 };
}

/** Sidecar name used by Lightroom & co: IMG_0001.CR3 → IMG_0001.xmp */
export const sidecarName = (filename: string) => filename.replace(/\.[^.]+$/, '') + '.xmp';
