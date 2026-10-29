/** Immutable get/set by key path — worklet-safe so sliders can edit the recipe on the UI thread. */
export type KeyPath = readonly (string | number)[];

export function getIn(obj: unknown, path: KeyPath): unknown {
  'worklet';
  let cur = obj as Record<string | number, unknown> | undefined;
  for (let i = 0; i < path.length; i++) {
    if (cur == null) return undefined;
    cur = cur[path[i]] as Record<string | number, unknown> | undefined;
  }
  return cur;
}

export function setIn<T>(obj: T, path: KeyPath, value: unknown, i = 0): T {
  'worklet';
  if (i >= path.length) return value as T;
  const k = path[i];
  const src = obj as unknown as Record<string | number, unknown>;
  const copy = (Array.isArray(obj) ? (obj as unknown[]).slice() : { ...src }) as Record<string | number, unknown>;
  copy[k] = setIn(src?.[k], path, value, i + 1);
  return copy as unknown as T;
}
