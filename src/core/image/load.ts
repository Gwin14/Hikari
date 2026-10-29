import { AlphaType, ColorType, Skia, type SkImage } from '@shopify/react-native-skia';
import { File } from 'expo-file-system';
import { decodeImage, isNativeAvailable, isRawName, type RawDecodeOptions } from 'hikari-native';
import { Platform } from 'react-native';

import type { PreparedSource } from '../pipeline/render';
import { resizeImage } from '../pipeline/render';
import type { SourceRef } from '../recipe/schema';

export interface DecodeTarget {
  /** What to hand to the native decoder (asset id, content:// or file://). */
  uri: string;
  /** File name used to detect RAW. */
  filename: string;
  preferRaw: boolean;
}

/** Which file of a source (or pair) to develop. */
export function decodeTarget(src: SourceRef): DecodeTarget {
  const wantsRaw = src.useRaw && (src.isRaw || !!src.pairedUri);
  if (src.kind === 'library' && Platform.OS === 'ios') {
    // PhotoKit resolves RAW vs processed resources from the asset itself.
    return { uri: src.id, filename: src.filename, preferRaw: src.useRaw };
  }
  if (wantsRaw && !src.isRaw && src.pairedUri) {
    return { uri: src.pairedUri, filename: src.pairedUri.split('/').pop() ?? 'raw.dng', preferRaw: true };
  }
  if (!wantsRaw && src.isRaw && src.pairedUri) {
    return { uri: src.pairedUri, filename: src.pairedUri.split('/').pop() ?? 'image.jpg', preferRaw: false };
  }
  return { uri: src.kind === 'library' ? src.id : src.uri, filename: src.filename, preferRaw: wantsRaw };
}

const cache = new Map<string, Promise<PreparedSource>>();

export function loadSource(src: SourceRef, maxDim: number, raw?: RawDecodeOptions): Promise<PreparedSource> {
  const t = decodeTarget(src);
  const key = `${t.uri}|${t.preferRaw}|${maxDim}|${raw ? JSON.stringify(raw) : ''}`;
  let p = cache.get(key);
  if (!p) {
    p = decode(t, maxDim, raw);
    cache.set(key, p);
    p.catch(() => cache.delete(key));
    // Keep only a few decoded sources resident.
    if (cache.size > 4) cache.delete(cache.keys().next().value!);
  }
  return p;
}

export function evictSource(src: SourceRef) {
  const t = decodeTarget(src);
  for (const k of [...cache.keys()]) if (k.startsWith(`${t.uri}|`)) cache.delete(k);
}

async function decode(t: DecodeTarget, maxDim: number, raw?: RawDecodeOptions): Promise<PreparedSource> {
  if (!isNativeAvailable) return decodeWithSkia(t.uri, maxDim);
  const res = await decodeImage(t.uri, { maxDim, preferRaw: t.preferRaw, raw });
  const file = new File(res.path);
  const bytes = await file.bytes();
  try {
    file.delete();
  } catch {
    // temp file cleanup is best effort
  }
  const half = res.format === 'rgba16f';
  const image = Skia.Image.MakeImage(
    {
      width: res.width,
      height: res.height,
      colorType: half ? ColorType.RGBA_F16 : ColorType.RGBA_8888,
      alphaType: AlphaType.Premul,
    },
    Skia.Data.fromBytes(bytes),
    res.width * (half ? 8 : 4),
  );
  if (!image) throw new Error('Could not create image from decoded pixels');
  return { source: image, fullWidth: res.fullWidth, fullHeight: res.fullHeight, isRaw: res.isRaw };
}

/** Fallback without the native module (Expo Go / web): platform codecs via Skia, no RAW. */
async function decodeWithSkia(uri: string, maxDim: number): Promise<PreparedSource> {
  if (isRawName(uri)) throw new Error('RAW decoding requires a development build');
  const data = await Skia.Data.fromURI(uri);
  const img = Skia.Image.MakeImageFromEncoded(data);
  if (!img) throw new Error('Unsupported image');
  const fullWidth = img.width();
  const fullHeight = img.height();
  const source: SkImage = maxDim > 0 ? resizeImage(img, maxDim) : img;
  return { source, fullWidth, fullHeight, isRaw: false };
}
