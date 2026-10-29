import { createRecipe } from '@/core/recipe/defaults';
import type { SourceRef } from '@/core/recipe/schema';
import { matchingVersion, nextVersionName, recipeFromVersion } from '@/core/recipe/versions';

const src: SourceRef = { kind: 'file', id: 'f', uri: 'file:///a.jpg', filename: 'a.jpg', pairedUri: null, useRaw: false, isRaw: false };

describe('versions', () => {
  it('names new versions after the highest number in use', () => {
    expect(nextVersionName([], 'Version')).toBe('Version 1');
    expect(nextVersionName(['Version 1', 'Warm', 'Version 4'], 'Version')).toBe('Version 5');
    expect(nextVersionName(['Version 2x', 'Versão 3'], 'Version')).toBe('Version 1');
    expect(nextVersionName(['V.(1) 2'], 'V.(1)')).toBe('V.(1) 3');
  });

  it('finds the version matching what is on screen', () => {
    const base = createRecipe(src);
    const warm = { ...base, color: { ...base.color, temperature: 20 } };
    const versions = [
      { id: 'a', recipe: base },
      { id: 'b', recipe: warm },
    ];
    expect(matchingVersion(versions, { ...warm, updatedAt: 1 })?.id).toBe('b');
    expect(matchingVersion(versions, { ...base, light: { ...base.light, exposure: 1 } })).toBeNull();
  });

  it('applies a version onto the current source', () => {
    const stored = { ...createRecipe({ ...src, uri: 'file:///old.jpg', pairedUri: 'file:///a.dng', useRaw: true }), light: { ...createRecipe(src).light, exposure: 1 } };
    const current = createRecipe({ ...src, pairedUri: 'file:///a.dng' });
    const next = recipeFromVersion(stored, current);
    expect(next.source.uri).toBe('file:///a.jpg');
    expect(next.source.useRaw).toBe(true);
    expect(next.light.exposure).toBe(1);
    // without a pair there is nothing to switch to
    expect(recipeFromVersion(stored, createRecipe(src)).source.useRaw).toBe(false);
  });
});
