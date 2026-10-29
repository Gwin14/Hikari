import { isRawName } from 'hikari-native';

import type { PhotoItem } from './types';

const baseName = (name: string) => {
  const i = name.lastIndexOf('.');
  return (i < 0 ? name : name.slice(0, i)).toLowerCase();
};

/**
 * Merges RAW and processed files that share a base name (IMG_0001.CR3 + IMG_0001.JPG) into
 * one item. The processed file becomes the primary (fast thumbnail); the RAW is the pair.
 * Order of the input list is preserved.
 */
export function pairItems(items: PhotoItem[]): PhotoItem[] {
  const groups = new Map<string, PhotoItem[]>();
  for (const it of items) {
    const k = `${it.folderId ?? ''}/${baseName(it.filename)}`;
    const g = groups.get(k);
    if (g) g.push(it);
    else groups.set(k, [it]);
  }
  const consumed = new Set<string>();
  const out: PhotoItem[] = [];
  for (const it of items) {
    if (consumed.has(it.key)) continue;
    const g = groups.get(`${it.folderId ?? ''}/${baseName(it.filename)}`)!;
    const raw = g.find((x) => isRawName(x.filename));
    const processed = g.find((x) => !isRawName(x.filename));
    if (g.length >= 2 && raw && processed) {
      consumed.add(raw.key);
      consumed.add(processed.key);
      out.push({
        ...processed,
        width: raw.width || processed.width,
        height: raw.height || processed.height,
        pair: { uri: raw.uri, filename: raw.filename, isRaw: true },
      });
    } else {
      out.push(it);
    }
  }
  return out;
}
