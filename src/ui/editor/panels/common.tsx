import { useCallback } from 'react';

import type { KeyPath } from '@/core/recipe/path';
import { setIn } from '@/core/recipe/path';
import type { Recipe } from '@/core/recipe/schema';
import { liveRecipe, useEditor } from '@/state/editor';
import { RecipeSlider, type SliderProps } from '../../Slider';

export function useCommitPath() {
  return useCallback((path: KeyPath, v: unknown) => {
    useEditor.getState().update((r) => setIn(r, path, v));
  }, []);
}

type Spec = Omit<SliderProps, 'value' | 'onCommit' | 'onLive' | 'label'> & { label: string; path: KeyPath };

/** Renders a column of recipe sliders. */
export function Sliders({ recipe, specs }: { recipe: Recipe; specs: Spec[] }) {
  const commit = useCommitPath();
  return (
    <>
      {specs.map((s) => (
        <RecipeSlider key={s.path.join('.')} {...s} recipe={recipe} live={liveRecipe} onCommit={commit} />
      ))}
    </>
  );
}

export const bipolar = (label: string, path: KeyPath, extra: Partial<Spec> = {}): Spec => ({
  label,
  path,
  min: -100,
  max: 100,
  ...extra,
});
export const unipolar = (label: string, path: KeyPath, extra: Partial<Spec> = {}): Spec => ({
  label,
  path,
  min: 0,
  max: 100,
  ...extra,
});
