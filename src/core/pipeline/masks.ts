import { BlendMode, BlurStyle, ColorType, AlphaType, PaintStyle, Skia, StrokeCap, StrokeJoin, type SkImage } from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';
import { isNativeAvailable, segment, type SegmentKind } from 'hikari-native';

import { grayToRgba, skyMask } from '../auto/analysis';
import { decodeTarget } from '../image/load';
import type { BrushStroke, Mask, SourceRef } from '../recipe/schema';
import { makeRgbaImage, resizeImage } from './render';

const MASK_LONG_EDGE = 1024;

/** Rasterizes brush strokes (normalized coordinates) into a grayscale mask texture. */
export function renderBrushMask(strokes: BrushStroke[], aspect: number): SkImage | null {
  const w = aspect >= 1 ? MASK_LONG_EDGE : Math.round(MASK_LONG_EDGE * aspect);
  const h = aspect >= 1 ? Math.round(MASK_LONG_EDGE / aspect) : MASK_LONG_EDGE;
  const surface = Skia.Surface.MakeOffscreen(w, h) ?? Skia.Surface.Make(w, h);
  if (!surface) return null;
  const canvas = surface.getCanvas();
  canvas.clear(Skia.Color('black'));
  const long = Math.max(w, h);
  for (const s of strokes) {
    if (s.points.length < 2) continue;
    const pb = Skia.PathBuilder.Make();
    pb.moveTo(s.points[0] * w, s.points[1] * h);
    for (let i = 2; i < s.points.length; i += 2) pb.lineTo(s.points[i] * w, s.points[i + 1] * h);
    if (s.points.length === 2) pb.lineTo(s.points[0] * w + 0.01, s.points[1] * h);
    const path = pb.build();
    const paint = Skia.Paint();
    paint.setStyle(PaintStyle.Stroke);
    paint.setStrokeCap(StrokeCap.Round);
    paint.setStrokeJoin(StrokeJoin.Round);
    const width = s.size * long;
    paint.setStrokeWidth(width * (0.5 + s.hardness * 0.5));
    paint.setAntiAlias(true);
    const sigma = (1 - s.hardness) * width * 0.25;
    if (sigma > 0.3) paint.setMaskFilter(Skia.MaskFilter.MakeBlur(BlurStyle.Normal, sigma, true));
    if (s.erase) {
      paint.setColor(Skia.Color('black'));
      paint.setAlphaf(s.flow);
    } else {
      paint.setColor(Skia.Color('white'));
      paint.setAlphaf(s.flow);
      paint.setBlendMode(BlendMode.Lighten);
    }
    canvas.drawPath(path, paint);
  }
  surface.flush();
  const snap = surface.makeImageSnapshot();
  return snap.makeNonTextureImage() ?? snap;
}

const maskDir = () => {
  const d = new Directory(Paths.document, 'masks');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
};

const safe = (s: string) => s.replace(/[^a-z0-9]+/gi, '_').slice(-80);
const maskFile = (photoKey: string, mask: Mask, useRaw: boolean) =>
  new File(maskDir(), `${safe(photoKey)}-${mask.type}-${useRaw ? 'r' : 'p'}.png`);

async function imageFromFile(uri: string): Promise<SkImage | null> {
  const data = await Skia.Data.fromURI(uri);
  return Skia.Image.MakeImageFromEncoded(data);
}

/**
 * AI mask texture for subject/person/sky/background. Results are cached on disk per photo
 * so reopening an edit doesn't re-run segmentation.
 */
export async function aiMaskTexture(photoKey: string, src: SourceRef, mask: Mask, proxy: SkImage): Promise<SkImage | null> {
  const file = maskFile(photoKey, mask, src.useRaw);
  if (file.exists) return imageFromFile(file.uri);

  if (mask.type === 'sky') {
    const small = resizeImage(proxy, 384);
    const px = small.readPixels(0, 0, {
      width: small.width(),
      height: small.height(),
      colorType: ColorType.RGBA_8888,
      alphaType: AlphaType.Unpremul,
    });
    if (!px) return null;
    const m = skyMask(px as Uint8Array, small.width(), small.height());
    if (!m.some((v) => v > 128)) return null;
    const img = makeRgbaImage(grayToRgba(m), small.width(), small.height());
    file.write(img.encodeToBytes());
    return img;
  }

  if (!isNativeAvailable) return null;
  const kind: SegmentKind = mask.type === 'person' ? 'person' : 'subject';
  const t = decodeTarget(src);
  const res = await segment(t.uri, kind, 1536, t.preferRaw);
  if (!res) return null;
  const tmp = new File(res.path);
  tmp.copy(file);
  try {
    tmp.delete();
  } catch {
    // ignore
  }
  return imageFromFile(file.uri);
}

export function clearMaskCache(photoKey: string) {
  const prefix = safe(photoKey);
  for (const e of maskDir().list()) if (e.name.startsWith(prefix)) e.delete();
}
