import { AlphaType, ColorType, ImageFormat, matchFont, Skia, type SkCanvas, type SkImage } from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';
import { Album, Asset } from 'expo-media-library';
import * as Sharing from 'expo-sharing';
import { encodeImage, isNativeAvailable, saveEditToLibrary } from 'hikari-native';
import { Platform } from 'react-native';

import * as db from '../db/db';
import { decodeTarget, loadSource } from '../image/load';
import { geometryMatrix } from '../pipeline/geometry';
import { maskTexture } from '../pipeline/masks';
import { drawRecipe, makeRgbaImage, prepareInputs, type RenderInputs, type RenderOptions } from '../pipeline/render';
import { bakeCurveLut } from '../color/curve';
import { cubeToStrip, parseCube } from '../color/cube';
import { createRecipe } from '../recipe/defaults';
import { buildRetouch } from '../retouch/remove';
import { isEdited, recipeHash } from '../recipe/ops';
import type { Recipe, SourceRef } from '../recipe/schema';
import { openFolder, writeIntoFolder } from '../sources/folders';
import type { PhotoItem } from '../sources/types';
import { sidecarName, writeSidecar } from '../xmp/sidecar';
import { expandFilename, FORMAT_EXT, FORMAT_MIME, outputSize, type ExportOptions } from './options';

export function sourceFromItem(item: PhotoItem, useRaw: boolean): SourceRef {
  return {
    kind: item.kind,
    id: item.id,
    uri: item.uri,
    filename: item.filename,
    pairedUri: item.pair?.uri ?? null,
    useRaw: useRaw && (item.isRaw || !!item.pair),
    isRaw: item.isRaw,
  };
}

export const recipeFor = (item: PhotoItem): Recipe => db.loadRecipe(item.key) ?? createRecipe(sourceFromItem(item, true));

function lutFor(id: string | null) {
  if (!id) return null;
  const row = db.getLut(id);
  if (!row) return null;
  try {
    const lut = parseCube(new File(row.path).textSync());
    const s = cubeToStrip(lut);
    return { image: makeRgbaImage(s.pixels, s.width, s.height), size: lut.size };
  } catch {
    return null;
  }
}

/** Decodes and prepares every GPU input for a recipe at a given resolution (0 = full). */
export async function buildInputs(key: string, recipe: Recipe, maxDim: number): Promise<{ inputs: RenderInputs; fullW: number; fullH: number }> {
  const prepared = await loadSource(recipe.source, maxDim, {
    decodeNoise: recipe.raw.decodeNoise,
    highlightRecovery: recipe.raw.highlightRecovery,
    lensCorrection: recipe.raw.lensCorrection,
    boost: recipe.raw.boost,
  });
  // removals are solved again at this resolution so the exported fill has full detail
  const retouch = recipe.retouch.length ? await buildRetouch(key, recipe.source, prepared.source, recipe.retouch) : [];
  const inputs = prepareInputs(prepared, recipe.detail.sharpenRadius, {
    curve: makeRgbaImage(bakeCurveLut(recipe.curves), 256, 1),
    lut: lutFor(recipe.lut.id),
    maskTextures: {},
    retouch,
  });
  for (const m of recipe.masks) {
    const img = await maskTexture(key, recipe.source, m, inputs.source);
    if (img) inputs.maskTextures[m.id] = img;
  }
  return { inputs, fullW: prepared.fullWidth, fullH: prepared.fullHeight };
}

interface Watermark {
  text: string;
  position: ExportOptions['watermark']['position'];
  opacity: number;
  size: number;
}

function drawWatermark(c: SkCanvas, w: number, h: number, wm: Watermark) {
  const px = Math.max(10, Math.round((Math.min(w, h) * wm.size) / 100));
  const font = matchFont({ fontFamily: Platform.OS === 'ios' ? 'Helvetica Neue' : 'sans-serif', fontSize: px, fontWeight: '500' });
  const tw = font.measureText(wm.text).width;
  const m = px;
  const x = wm.position === 'tl' || wm.position === 'bl' ? m : wm.position === 'center' ? (w - tw) / 2 : w - tw - m;
  const y = wm.position === 'tl' || wm.position === 'tr' ? m + px : wm.position === 'center' ? h / 2 + px / 3 : h - m;
  const paint = Skia.Paint();
  paint.setColor(Skia.Color('white'));
  paint.setAlphaf(wm.opacity / 100);
  paint.setAntiAlias(true);
  c.drawText(wm.text, x, y, paint, font);
}

function renderPass(inputs: RenderInputs, recipe: Recipe, scale: number, W: number, H: number, opts: RenderOptions, wm: Watermark | null): SkImage {
  const surface = Skia.Surface.MakeOffscreen(W, H) ?? Skia.Surface.Make(W, H);
  if (!surface) throw new Error('Out of memory allocating the export surface');
  const c = surface.getCanvas();
  c.save();
  c.scale(scale, scale);
  drawRecipe(c, inputs, recipe, opts);
  c.restore();
  if (wm) drawWatermark(c, W, H, wm);
  surface.flush();
  const img = surface.makeImageSnapshot();
  return img.makeNonTextureImage() ?? img;
}

const read8 = (img: SkImage) => {
  const px = img.readPixels(0, 0, { width: img.width(), height: img.height(), colorType: ColorType.RGBA_8888, alphaType: AlphaType.Unpremul });
  if (!px) throw new Error('Could not read rendered pixels');
  return px as Uint8Array;
};

export interface RenderedFile {
  uri: string;
  name: string;
  width: number;
  height: number;
}

/** Renders and encodes one photo to a temporary file. */
export async function renderToFile(item: PhotoItem, o: ExportOptions, seq: number, forceJpegFull = false): Promise<RenderedFile> {
  const base = recipeFor(item);
  const recipe: Recipe = {
    ...base,
    detail: {
      ...base.detail,
      sharpenAmount: Math.min(150, base.detail.sharpenAmount + (o.outputSharpen === 'screen' ? 20 : o.outputSharpen === 'print' ? 45 : 0)),
    },
  };
  const format = forceJpegFull ? 'jpeg' : o.format;
  const sizeMode = forceJpegFull ? 'original' : o.sizeMode;

  // decode only as many pixels as the output needs
  let decodeDim = 0;
  if (sizeMode !== 'original' && item.width > 0 && item.height > 0) {
    const g = geometryMatrix(recipe.geometry, item.width, item.height);
    const out = outputSize(g.outW, g.outH, sizeMode, o.sizeValue);
    const ratio = Math.max(out.width / g.outW, out.height / g.outH);
    decodeDim = Math.min(Math.max(item.width, item.height), Math.ceil(Math.max(item.width, item.height) * ratio * 1.1));
  }
  const { inputs, fullW, fullH } = await buildInputs(item.key, recipe, decodeDim);
  const geo = geometryMatrix(recipe.geometry, inputs.frame.width, inputs.frame.height);
  const toFull = Math.max(fullW, fullH) / Math.max(inputs.frame.width, inputs.frame.height);
  const target = outputSize(geo.outW * toFull, geo.outH * toFull, sizeMode, o.sizeValue);
  const scale = Math.min(target.width / geo.outW, 1.0001 * toFull);
  const W = Math.max(1, Math.round(geo.outW * scale));
  const H = Math.max(1, Math.round(geo.outH * scale));

  const p3 = o.colorSpace !== 'srgb';
  const sixteen = !forceJpegFull && o.bitDepth === 16 && (format === 'tiff' || format === 'png');
  const wm: Watermark | null = o.watermark.enabled && o.watermark.text.trim() ? { ...o.watermark } : null;

  let pixels: Uint8Array;
  if (sixteen) {
    const hi = read8(renderPass(inputs, recipe, scale, W, H, { outMode: 2, outP3: p3 }, null));
    const lo = read8(renderPass(inputs, recipe, scale, W, H, { outMode: 3, outP3: p3 }, null));
    const alpha = wm ? read8(renderWatermarkMask(W, H, wm)) : null;
    const out = new Uint16Array(W * H * 4);
    for (let i = 0; i < out.length; i++) {
      if ((i & 3) === 3) {
        out[i] = 65535;
        continue;
      }
      let v = hi[i] * 256 + lo[i];
      if (alpha) {
        const a = alpha[i - (i & 3) + 3] / 255;
        if (a > 0) v = Math.round(v * (1 - a) + 65535 * a);
      }
      out[i] = v;
    }
    pixels = new Uint8Array(out.buffer);
  } else {
    pixels = read8(renderPass(inputs, recipe, scale, W, H, { outMode: 1, outP3: p3 }, wm));
  }

  const name = `${expandFilename(o.filenameTemplate, { name: item.filename, date: new Date(), seq })}.${FORMAT_EXT[format]}`;
  const dir = new Directory(Paths.cache, 'export');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, name);
  if (file.exists) file.delete();

  const useSkia = !isNativeAvailable || (format === 'webp' && Platform.OS === 'ios');
  if (useSkia) {
    // Fallback encoder: 8-bit sRGB through Skia (no metadata carry-over).
    const img = makeRgbaImage(pixels, W, H);
    const fmt = format === 'png' ? ImageFormat.PNG : format === 'webp' ? ImageFormat.WEBP : ImageFormat.JPEG;
    file.write(img.encodeToBytes(fmt, o.quality));
  } else {
    await encodeImage(pixels, W, H, {
      format,
      quality: o.quality / 100,
      bitDepth: sixteen ? 16 : 8,
      colorSpace: o.colorSpace,
      inputFormat: sixteen ? 'rgba16' : 'rgba8',
      inputColorSpace: p3 ? 'p3' : 'srgb',
      metadataSource: decodeTarget({ ...recipe.source, useRaw: false }).uri,
      metadata: o.metadata,
      artist: o.artist || undefined,
      copyright: o.copyright || undefined,
      outputPath: file.uri,
    });
  }
  return { uri: file.uri, name, width: W, height: H };
}

function renderWatermarkMask(W: number, H: number, wm: Watermark): SkImage {
  const surface = Skia.Surface.MakeOffscreen(W, H) ?? Skia.Surface.Make(W, H);
  if (!surface) throw new Error('Out of memory');
  const c = surface.getCanvas();
  c.clear(Skia.Color('transparent'));
  drawWatermark(c, W, H, wm);
  surface.flush();
  const img = surface.makeImageSnapshot();
  return img.makeNonTextureImage() ?? img;
}

export interface ExportProgress {
  done: number;
  total: number;
  current: string;
  errors: string[];
}

/** Exports a batch of photos to the chosen destination. */
export async function exportItems(items: PhotoItem[], o: ExportOptions, onProgress: (p: ExportProgress) => void): Promise<ExportProgress> {
  const progress: ExportProgress = { done: 0, total: items.length, current: '', errors: [] };
  let folderUri: string | null = null;
  if (o.destination === 'folder' && o.destinationFolderId) {
    const row = db.listFolders().find((f) => f.id === o.destinationFolderId);
    if (row) folderUri = await openFolder(row);
  }
  let album: Album | null = null;
  const shareQueue: RenderedFile[] = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    progress.current = item.filename;
    onProgress({ ...progress });
    try {
      const inPlace = o.destination === 'libraryEdit' && item.kind === 'library' && Platform.OS === 'ios' && isNativeAvailable;
      const out = await renderToFile(item, o, i + 1, inPlace);
      const recipe = recipeFor(item);
      if (inPlace) {
        await saveEditToLibrary(item.id, out.uri, JSON.stringify(recipe), String(recipe.version));
        new File(out.uri).delete();
      } else if (o.destination === 'library' || o.destination === 'libraryEdit') {
        const asset = await Asset.create(out.uri);
        try {
          if (!album) album = (await Album.get('Hikari')) ?? (await Album.create('Hikari', [asset], false));
          else await album.add(asset);
        } catch {
          // album creation is optional (limited access)
        }
        new File(out.uri).delete();
      } else if (o.destination === 'share') {
        shareQueue.push(out);
      } else {
        const target = o.destination === 'sourceFolder' ? item.dirUri : folderUri;
        if (!target) throw new Error('No destination folder');
        const bytes = await new File(out.uri).bytes();
        writeIntoFolder(target, out.name, FORMAT_MIME[o.format], bytes);
        if (o.includeSidecar) writeIntoFolder(target, sidecarName(out.name), 'application/rdf+xml', writeSidecar(recipe));
        if (o.includeRaw && (item.isRaw || item.pair?.isRaw)) {
          const rawUri = item.isRaw ? item.uri : item.pair!.uri;
          const rawName = item.isRaw ? item.filename : item.pair!.filename;
          if (o.destination === 'folder') writeIntoFolder(target, rawName, 'application/octet-stream', await new File(rawUri).bytes());
        }
        new File(out.uri).delete();
      }
    } catch (e) {
      progress.errors.push(`${item.filename}: ${e instanceof Error ? e.message : String(e)}`);
    }
    progress.done = i + 1;
    onProgress({ ...progress });
  }

  for (const f of shareQueue) {
    await Sharing.shareAsync(f.uri, { mimeType: FORMAT_MIME[o.format], dialogTitle: f.name });
  }
  return progress;
}

/** Re-renders the grid thumbnail for an item after a batch edit. */
export async function refreshThumb(item: PhotoItem, recipe: Recipe) {
  const hash = recipeHash(recipe);
  if (!isEdited(recipe)) {
    db.setThumb(item.key, null);
    return;
  }
  const { inputs } = await buildInputs(item.key, recipe, 900);
  const geo = geometryMatrix(recipe.geometry, inputs.frame.width, inputs.frame.height);
  const scale = Math.min(1, 640 / Math.max(geo.outW, geo.outH));
  const img = renderPass(inputs, recipe, scale, Math.round(geo.outW * scale), Math.round(geo.outH * scale), {}, null);
  const dir = new Directory(Paths.cache, 'thumbs');
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  const f = new File(dir, `${hash}.jpg`);
  if (!f.exists) f.write(img.encodeToBytes(ImageFormat.JPEG, 85));
  db.setThumb(item.key, f.uri);
}
