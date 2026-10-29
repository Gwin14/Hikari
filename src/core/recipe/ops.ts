import { defaultSettings } from './defaults';
import { RECIPE_SECTIONS, RECIPE_VERSION, type Recipe, type RecipeSection, type RecipeSettings } from './schema';

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Deep-merge `patch` over `base`, keeping keys `base` defines (forward compatible loading). */
function mergeDefaults<T>(base: T, patch: unknown): T {
  if (patch === undefined || patch === null) return base;
  if (Array.isArray(base)) return (Array.isArray(patch) ? patch : base) as T;
  if (typeof base === 'object' && base !== null) {
    if (typeof patch !== 'object') return base;
    const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
    for (const k of Object.keys(out)) {
      out[k] = mergeDefaults(out[k], (patch as Record<string, unknown>)[k]);
    }
    return out as T;
  }
  return (typeof patch === typeof base || base === null ? patch : base) as T;
}

/** Parse stored JSON into a valid, current-version recipe. */
export function migrateRecipe(raw: unknown): Recipe | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Recipe>;
  if (!r.source) return null;
  const settings = mergeDefaults(defaultSettings(), r);
  return {
    ...settings,
    version: RECIPE_VERSION,
    source: r.source,
    updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
  };
}

export function pickSections(recipe: RecipeSettings, sections: readonly RecipeSection[]): Partial<RecipeSettings> {
  const out: Partial<RecipeSettings> = {};
  for (const s of sections) (out as Record<string, unknown>)[s] = clone(recipe[s]);
  return out;
}

/** Apply copied settings / a preset onto a recipe. Crop is intentionally kept per-photo unless asked. */
export function applySettings(target: Recipe, settings: Partial<RecipeSettings>, keepCrop = true): Recipe {
  const next = clone(target);
  for (const s of RECIPE_SECTIONS) {
    if (!(s in settings)) continue;
    if (s === 'geometry' && keepCrop) {
      const g = clone(settings.geometry!);
      next.geometry = { ...g, crop: next.geometry.crop, aspect: next.geometry.aspect };
      continue;
    }
    (next as unknown as Record<string, unknown>)[s] = clone((settings as Record<string, unknown>)[s]);
  }
  next.updatedAt = Date.now();
  return next;
}

export function resetSection(recipe: Recipe, section: RecipeSection): Recipe {
  const d = defaultSettings();
  return { ...recipe, [section]: clone(d[section]), updatedAt: Date.now() };
}

/** Whether any setting differs from defaults (used for the "edited" badge). */
export function isEdited(recipe: Recipe): boolean {
  const d = defaultSettings() as unknown as Record<string, unknown>;
  const r = recipe as unknown as Record<string, unknown>;
  return RECIPE_SECTIONS.some((s) => JSON.stringify(r[s]) !== JSON.stringify(d[s]));
}

/** Stable short hash of the render-affecting settings (thumbnail cache key). */
export function recipeHash(recipe: Recipe): string {
  const r = recipe as unknown as Record<string, unknown>;
  const str = JSON.stringify(RECIPE_SECTIONS.map((s) => r[s])) + recipe.source.useRaw;
  let h1 = 0x811c9dc5;
  let h2 = 0x1234567;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
