import { migrateRecipe } from '../recipe/ops';
import type { Recipe, RecipeSettings } from '../recipe/schema';
import { crsToSettings, crsXmlParts, parseXmpCrs, settingsToCrs } from './crs';

/**
 * XMP sidecars: the complete recipe lives in the `hikari:Recipe` attribute (base64 JSON),
 * plus the `crs:` (Camera Raw) mapping of every setting Lightroom/ACR understand, so they
 * pick up the edit when the folder is opened there.
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

/** A named look of the photo, saved along with its edit. */
export interface SavedVersion {
  id: string;
  name: string;
  recipe: Recipe;
  createdAt: number;
}

const bareVersions = (versions: readonly SavedVersion[]) => versions.map(({ id, name, recipe, createdAt }) => ({ id, name, recipe, createdAt }));

function parseVersions(raw: unknown): SavedVersion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v) => {
    const recipe = migrateRecipe(v?.recipe);
    return recipe && typeof v.id === 'string' ? [{ id: v.id, name: String(v.name ?? ''), recipe, createdAt: Number(v.createdAt) || 0 }] : [];
  });
}

export function writeSidecar(recipe: Recipe, rating = 0, versions: readonly SavedVersion[] = []): string {
  const { attrs, elements } = crsXmlParts({ Version: '15.0', ProcessVersion: '11.0', ...settingsToCrs(recipe), HasSettings: 'True' });
  return `<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Hikari">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    xmlns:hikari="https://hikari.app/ns/1.0/"
    xmp:Rating="${rating}"
    hikari:Recipe="${b64.encode(JSON.stringify(recipe))}"${versions.length ? `\n    hikari:Versions="${b64.encode(JSON.stringify(bareVersions(versions)))}"` : ''}
${attrs.join('\n')}>
${elements.join('\n')}
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
`;
}

export interface SidecarData {
  recipe: Recipe | null;
  /** Settings from a foreign (Lightroom/ACR) sidecar, applied when no Hikari recipe exists. */
  crs: Partial<RecipeSettings>;
  rating: number;
  versions: SavedVersion[];
}

export function readSidecar(xml: string): SidecarData {
  const encoded = xml.match(/hikari:Recipe\s*=\s*"([^"]*)"/)?.[1];
  let recipe: Recipe | null = null;
  if (encoded) {
    try {
      recipe = migrateRecipe(JSON.parse(b64.decode(encoded)));
    } catch {
      recipe = null;
    }
  }
  let versions: SavedVersion[] = [];
  const encodedVersions = xml.match(/hikari:Versions\s*=\s*"([^"]*)"/)?.[1];
  if (encodedVersions) {
    try {
      versions = parseVersions(JSON.parse(b64.decode(encodedVersions)));
    } catch {
      versions = [];
    }
  }
  const rating = Number(xml.match(/xmp:Rating\s*=\s*"([^"]*)"/)?.[1] ?? xml.match(/<xmp:Rating>([^<]*)</)?.[1] ?? 0);
  return { recipe, crs: crsToSettings(parseXmpCrs(xml).values).settings, rating: Number.isFinite(rating) ? rating : 0, versions };
}

/** The Photos adjustment data of an edit: the recipe itself, so older saves stay readable. */
export const libraryAdjustment = (recipe: Recipe, versions: readonly SavedVersion[]) =>
  JSON.stringify({ ...recipe, hikariVersions: bareVersions(versions) });

export function parseLibraryAdjustment(json: string): { recipe: Recipe | null; versions: SavedVersion[] } {
  try {
    const raw = JSON.parse(json);
    return { recipe: migrateRecipe(raw), versions: parseVersions(raw?.hikariVersions) };
  } catch {
    return { recipe: null, versions: [] };
  }
}

/** Sidecar name used by Lightroom & co: IMG_0001.CR3 → IMG_0001.xmp */
export const sidecarName = (filename: string) => filename.replace(/\.[^.]+$/, '') + '.xmp';
