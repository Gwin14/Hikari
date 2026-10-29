import { deleteRow, listJson, newId, upsertJson } from '../db/db';
import { pickSections } from './ops';
import { BUILT_IN_PRESETS, type Preset } from './presets';
import { RECIPE_SECTIONS, type RecipeSection, type RecipeSettings } from './schema';

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

export function presetFromFile(text: string): Preset {
  const data = JSON.parse(text);
  if (data?.format !== 'hikari-preset' || typeof data.settings !== 'object') throw new Error('Not a Hikari preset');
  const settings: Partial<RecipeSettings> = {};
  for (const k of RECIPE_SECTIONS) if (k in data.settings) (settings as Record<string, unknown>)[k] = data.settings[k];
  const id = newId();
  upsertJson('presets', 'settings', id, String(data.name ?? 'Preset'), settings);
  return { id, name: String(data.name ?? 'Preset'), group: 'mine', builtIn: false, settings };
}
