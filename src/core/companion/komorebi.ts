import { Directory, File, Paths } from 'expo-file-system';
import { readForeignAdjustment } from 'hikari-native';
import { Linking, Platform } from 'react-native';

import { parseCube } from '../color/cube';
import * as db from '../db/db';
import type { Effects, LutRef } from '../recipe/schema';

/**
 * Komorebi (the camera) and Hikari talk through the device only: deep links both ways and,
 * on iOS, an App Group container both apps can read:
 *
 *   luts/komorebi.json, luts/hikari.json   one manifest per app, each written only by its owner
 *   luts/<owner>-<id>.cube                 the LUT files those manifests point at
 *   captures/<asset>.json                  the look (LUT) Komorebi shot a photo with
 *
 * Keep this contract in sync with `app/utils/hikari.js` in Komorebi.
 */
export const APP_GROUP = 'group.br.dev.fabiosantos.komorebi.camera';
export const KOMOREBI_SCHEME = 'komorebi';

export interface SharedLut {
  id: string;
  name: string;
  /** File name inside `luts/`. */
  file: string;
  updatedAt: number;
}

export interface CaptureLook {
  assetId: string;
  lut: { id: string; name: string; file: string; intensity: number } | null;
  /** The library original carries no baked look (RAW, or Komorebi's reversible effects edit). */
  cleanOriginal: boolean;
  /** Grain/halation/bloom of the capture (same shape as the effects recipe). */
  effects?: Pick<KomorebiRecipe, 'grain' | 'halation' | 'bloom'>;
}

function sharedDir(): Directory | null {
  if (Platform.OS !== 'ios') return null;
  try {
    const dir = Paths.appleSharedContainers?.[APP_GROUP];
    return dir?.exists ? dir : null;
  } catch {
    return null;
  }
}

export const isCompanionShareAvailable = () => sharedDir() !== null;

function readJson<T>(f: File): T | null {
  try {
    return f.exists ? (JSON.parse(f.textSync()) as T) : null;
  } catch {
    return null;
  }
}

const safeName = (id: string) => id.replace(/[^\w.-]+/g, '_');

/** LUTs Komorebi published (built-in looks and the ones the user imported or generated). */
export function listKomorebiLuts(): SharedLut[] {
  const dir = sharedDir();
  if (!dir) return [];
  return readJson<SharedLut[]>(new File(dir, 'luts', 'komorebi.json')) ?? [];
}

/** Catalog id of a Komorebi LUT once imported into Hikari's library. */
export const komorebiLutId = (id: string) => `komorebi-${id}`;

/**
 * Copies a Komorebi LUT into Hikari's LUT library (stable id, so re-importing replaces it).
 * Returns the catalog id, or null if the file is missing or invalid.
 */
export function importKomorebiLut(lut: Pick<SharedLut, 'id' | 'name' | 'file'>): string | null {
  const dir = sharedDir();
  if (!dir) return null;
  const id = komorebiLutId(lut.id);
  try {
    const src = new File(dir, 'luts', lut.file);
    if (!src.exists) return db.getLut(id) ? id : null;
    const text = src.textSync();
    const cube = parseCube(text);
    const luts = new Directory(Paths.document, 'luts');
    if (!luts.exists) luts.create({ intermediates: true, idempotent: true });
    const dest = new File(luts, `${safeName(id)}.cube`);
    if (!dest.exists || dest.textSync() !== text) dest.write(text);
    db.addLut({ id, name: lut.name, size: cube.size, path: dest.uri });
    return id;
  } catch {
    return null;
  }
}

/** Imports every Komorebi LUT not yet in the library. Cheap enough to run when the LUT panel opens. */
export function syncKomorebiLuts(): number {
  let n = 0;
  for (const l of listKomorebiLuts()) if (importKomorebiLut(l)) n++;
  return n;
}

/** Writes a LUT for Komorebi to use live in the camera. */
export function publishLutToKomorebi(name: string, cubeText: string): boolean {
  const dir = sharedDir();
  if (!dir) return false;
  parseCube(cubeText);
  const lutsDir = new Directory(dir, 'luts');
  if (!lutsDir.exists) lutsDir.create({ intermediates: true, idempotent: true });
  const manifestFile = new File(lutsDir, 'hikari.json');
  const manifest = readJson<SharedLut[]>(manifestFile) ?? [];
  const id = safeName(name.trim().toLowerCase()) || db.newId();
  const file = `hikari-${id}.cube`;
  const f = new File(lutsDir, file);
  if (f.exists) f.delete();
  f.write(cubeText);
  const entry: SharedLut = { id, name: name.trim() || 'Hikari', file, updatedAt: Date.now() };
  const next = [entry, ...manifest.filter((l) => l.id !== id)];
  if (manifestFile.exists) manifestFile.delete();
  manifestFile.write(JSON.stringify(next));
  return true;
}

/** The look Komorebi recorded for a capture, from the shared container or a deep link. */
export function captureLook(assetId: string): CaptureLook | null {
  const handed = handoffs.get(assetId);
  if (handed?.look) return handed.look;
  const dir = sharedDir();
  if (!dir) return null;
  // Komorebi names the record after the bare PHAsset identifier
  return readJson<CaptureLook>(new File(dir, 'captures', `${safeName(assetId.replace(/^ph:\/\//, ''))}.json`));
}

/** One Komorebi effect as saved with the capture (`config` holds the preset's parameters). */
export interface KomorebiEffect {
  enabled?: boolean;
  id?: string;
  name?: string;
  config?: Record<string, number> | null;
}

/** Komorebi's reversible effects edit, stored in Photos as "app.komorebi.effects" adjustment data. */
export interface KomorebiRecipe {
  filter?: { id: string; name?: string } | null;
  grain?: KomorebiEffect | null;
  halation?: KomorebiEffect | null;
  bloom?: KomorebiEffect | null;
}

export const KOMOREBI_EFFECTS_FORMAT = 'app.komorebi.effects';

const clamp100 = (v: number) => Math.round(Math.max(0, Math.min(100, v)));
const active = (e: KomorebiEffect | null | undefined) => (e?.enabled !== false && e?.config ? e.config : null);

/**
 * Komorebi presets → Hikari sliders. The numbers line up the strength of each preset with
 * how Hikari renders it, so a photo reopens looking like it was shot, but every value stays
 * continuously adjustable instead of Komorebi's three steps.
 */
export function effectsFromKomorebi(r: KomorebiRecipe): Partial<Effects> {
  const out: Partial<Effects> = {};
  const grain = active(r.grain);
  if (grain) {
    out.grainAmount = clamp100((grain.lumaStrength ?? 8) * 6);
    out.grainSize = clamp100(grain.clumpSize ?? 34);
    out.grainRoughness = clamp100(40 + (grain.clumpAmount ?? 0.13) * 150);
  }
  const halation = active(r.halation);
  if (halation) {
    out.halationAmount = clamp100((halation.targetPeakOpacity ?? 0.36) * 150);
    out.halationThreshold = clamp100((halation.threshold ?? 0.76) * 100);
    out.halationRadius = clamp100(((halation.diffusionRadius ?? 36) - 16) * 2);
  }
  const bloom = active(r.bloom);
  if (bloom) {
    out.bloomAmount = clamp100((bloom.intensity ?? 0.7) * 60);
    out.bloomThreshold = clamp100((bloom.threshold ?? 0.68) * 100);
    out.bloomRadius = clamp100(((bloom.radius ?? 100) - 40) / 1.2);
  }
  return out;
}

function lutFromKomorebi(filter: { id: string; name?: string }, intensity = 100): LutRef | null {
  const lut = { id: filter.id, name: filter.name || filter.id, file: `komorebi-${safeName(filter.id)}.cube` };
  const id = importKomorebiLut(lut) ?? (db.getLut(komorebiLutId(lut.id)) ? komorebiLutId(lut.id) : null);
  return id ? { id, name: lut.name, intensity: clamp100(intensity) } : null;
}

export interface StartingLook {
  lut: LutRef | null;
  effects: Partial<Effects>;
}

/**
 * The look a Komorebi capture was shot with, to start a fresh edit from. It comes from the
 * reversible effects edit in Photos (the original under it is clean) or, for RAW captures,
 * from the capture record. A look baked into the processed photo is not applied twice.
 */
export async function komorebiStartingLook(assetId: string, usesRaw: boolean): Promise<StartingLook | null> {
  let recipe: KomorebiRecipe | null = null;
  let clean = false;
  try {
    const json = await readForeignAdjustment(assetId, KOMOREBI_EFFECTS_FORMAT);
    if (json) {
      recipe = JSON.parse(json) as KomorebiRecipe;
      clean = true;
    }
  } catch {
    recipe = null;
  }
  if (!recipe) {
    const look = captureLook(assetId);
    if (!look) return null;
    clean = look.cleanOriginal;
    recipe = {
      filter: look.lut ? { id: look.lut.id, name: look.lut.name } : null,
      ...(look.effects ?? {}),
    };
  }
  if (!usesRaw && !clean) return null;
  const lut = recipe.filter?.id && recipe.filter.id !== 'none' ? lutFromKomorebi(recipe.filter) : null;
  const effects = effectsFromKomorebi(recipe);
  return lut || Object.keys(effects).length ? { lut, effects } : null;
}

// ---------------------------------------------------------------------------- deep links

interface Handoff {
  /** Where "back to the camera" goes. */
  returnUrl: string;
  look: CaptureLook | null;
}

/** Photos opened from Komorebi in this session, by MediaLibrary asset id. */
const handoffs = new Map<string, Handoff>();

export function registerHandoff(assetId: string, params: { return?: string; lut?: string; lutName?: string; lutFile?: string; lutIntensity?: string; clean?: string }) {
  const returnUrl = params.return && params.return.startsWith(`${KOMOREBI_SCHEME}://`) ? params.return : komorebiGalleryUrl(assetId);
  const look: CaptureLook | null = params.lut
    ? {
        assetId,
        lut: {
          id: params.lut,
          name: params.lutName || params.lut,
          file: params.lutFile || `komorebi-${safeName(params.lut)}.cube`,
          intensity: Number(params.lutIntensity ?? 100) || 100,
        },
        cleanOriginal: params.clean === '1',
      }
    : null;
  handoffs.set(assetId, { returnUrl, look });
}

export const komorebiGalleryUrl = (assetId: string) =>
  `${KOMOREBI_SCHEME}://components/Galery?asset=${encodeURIComponent(assetId.replace(/^ph:\/\//, ''))}`;

/** Return url when this library asset came from Komorebi, else null. */
export const handoffReturnUrl = (assetId: string) => handoffs.get(assetId)?.returnUrl ?? null;

export async function returnToKomorebi(assetId: string): Promise<boolean> {
  const url = handoffReturnUrl(assetId) ?? komorebiGalleryUrl(assetId);
  try {
    await Linking.openURL(url);
    return true;
  } catch {
    return false;
  }
}
