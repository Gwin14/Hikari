import { ImageFormat } from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';
import { isNativeAvailable } from 'hikari-native';

import { loadSource } from './image/load';
import { createRecipe } from './recipe/defaults';
import type { PhotoItem } from './sources/types';

/**
 * Thumbnails for files the platform can't preview (proprietary RAW). Decoded through the
 * native RAW engine at small size, encoded to JPEG and cached on disk.
 */
const dir = () => {
  const d = new Directory(Paths.cache, 'rawthumbs');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
};

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
};

const pending = new Map<string, Promise<string | null>>();
const queue: (() => Promise<void>)[] = [];
let running = 0;
const MAX = 2;

function pump() {
  while (running < MAX && queue.length) {
    const job = queue.shift()!;
    running++;
    job().finally(() => {
      running--;
      pump();
    });
  }
}

export function cachedThumb(item: PhotoItem): string | null {
  const f = new File(dir(), `${hash(item.key)}.jpg`);
  return f.exists ? f.uri : null;
}

export function requestThumb(item: PhotoItem): Promise<string | null> {
  const existing = cachedThumb(item);
  if (existing) return Promise.resolve(existing);
  if (!isNativeAvailable) return Promise.resolve(null);
  let p = pending.get(item.key);
  if (p) return p;
  p = new Promise<string | null>((resolve) => {
    queue.push(async () => {
      try {
        const src = createRecipe({
          kind: item.kind,
          id: item.id,
          uri: item.uri,
          filename: item.filename,
          pairedUri: item.pair?.uri ?? null,
          useRaw: true,
          isRaw: item.isRaw,
        }).source;
        const prepared = await loadSource(src, 384);
        const f = new File(dir(), `${hash(item.key)}.jpg`);
        f.write(prepared.source.encodeToBytes(ImageFormat.JPEG, 80));
        resolve(f.uri);
      } catch {
        resolve(null);
      } finally {
        pending.delete(item.key);
      }
    });
    pump();
  });
  pending.set(item.key, p);
  return p;
}

export function clearThumbCaches() {
  for (const name of ['rawthumbs', 'thumbs']) {
    const d = new Directory(Paths.cache, name);
    if (d.exists) d.delete();
  }
}
