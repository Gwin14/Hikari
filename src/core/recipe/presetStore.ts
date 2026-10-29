import { deleteRow, listJson, newId, upsertJson } from '../db/db';
import { pickSections } from './ops';
import { BUILT_IN_PRESETS, type Preset } from './presets';
import { RECIPE_SECTIONS, type RecipeSection, type RecipeSettings } from './schema';
import { crsToSettings, parseLrTemplate, parseXmpCrs, writeLightroomPreset } from '../xmp/crs';

export function listPresets(): Preset[] {
  const mine = listJson<Partial<RecipeSettings>>('presets', 'settings').map((p) => ({
    id: p.id,
    name: p.name,
    group: 'mine',
    builtIn: false,
    settings: p.value,
  }));
  return [...mine, ...BUILT_IN_PRESETS];
}

export function savePreset(name: string, recipe: RecipeSettings, sections: readonly RecipeSection[]): Preset {
  const id = newId();
  const settings = pickSections(recipe, sections);
  upsertJson('presets', 'settings', id, name, settings);
  return { id, name, group: 'mine', builtIn: false, settings };
}

export const deletePreset = (id: string) => deleteRow('presets', id);

/** Shareable preset file (.hikari): versioned JSON. */
export function presetToFile(p: Preset): string {
  return JSON.stringify({ format: 'hikari-preset', version: 1, name: p.name, settings: p.settings }, null, 2);
}

/** Lightroom Classic / Lightroom / ACR develop preset (.xmp). */
export const presetToLightroom = (p: Preset): string => writeLightroomPreset(p.name, p.settings);

const baseName = (filename: string) => filename.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || 'Preset';

/** Parses a preset file without saving it: Hikari (.hikari), Lightroom (.xmp) or legacy Lightroom (.lrtemplate). */
export function parsePresetFile(text: string, filename = ''): { name: string; settings: Partial<RecipeSettings> } {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart();
  if (trimmed.startsWith('{')) {
    const data = JSON.parse(trimmed);
    if (data?.format !== 'hikari-preset' || typeof data.settings !== 'object') throw new Error('Not a Hikari preset');
    const settings: Partial<RecipeSettings> = {};
    for (const k of RECIPE_SECTIONS) if (k in data.settings) (settings as Record<string, unknown>)[k] = data.settings[k];
    return { name: String(data.name ?? baseName(filename)), settings };
  }
  const lr = trimmed.startsWith('<') || /<x:xmpmeta|camera-raw-settings/.test(trimmed) ? parseXmpCrs(trimmed) : parseLrTemplate(trimmed);
  if (lr.values.PresetType && lr.values.PresetType !== 'Normal') throw new Error('Profiles (.xmp with LUT tables) are not supported; import a develop preset');
  const { settings, used } = crsToSettings(lr.values);
  if (!used) throw new Error('No compatible settings found in this preset');
  return { name: lr.name || baseName(filename), settings };
}

export function presetFromFile(text: string, filename = ''): Preset {
  const { name, settings } = parsePresetFile(text, filename);
  const id = newId();
  upsertJson('presets', 'settings', id, name, settings);
  return { id, name, group: 'mine', builtIn: false, settings };
}
