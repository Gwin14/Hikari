import { recipeHash } from './ops';
import type { Recipe } from './schema';

/** First free "<base> N" name, counting up from the highest number already used. */
export function nextVersionName(existing: readonly string[], base: string): string {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} (\\d+)$`);
  let max = 0;
  for (const name of existing) {
    const m = re.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${base} ${max + 1}`;
}

/** The saved version whose settings are what's on screen, if any. */
export function matchingVersion<T extends { id: string; recipe: Recipe }>(versions: readonly T[], current: Recipe): T | null {
  const h = recipeHash(current);
  return versions.find((v) => recipeHash(v.recipe) === h) ?? null;
}

/** A saved version's settings, carried onto the photo's current source (paths can move between sessions). */
export function recipeFromVersion(version: Recipe, current: Recipe): Recipe {
  return {
    ...version,
    source: { ...current.source, useRaw: current.source.pairedUri ? version.source.useRaw : current.source.useRaw },
    updatedAt: Date.now(),
  };
}
