import type { ExportColorSpace, ExportFormat, MetadataPolicy } from 'hikari-native';

export type SizeMode = 'original' | 'long' | 'short' | 'megapixels' | 'percent';
export type Destination = 'library' | 'libraryEdit' | 'folder' | 'sourceFolder' | 'share';
export type WatermarkPosition = 'tl' | 'tr' | 'bl' | 'br' | 'center';

export interface ExportOptions {
  format: ExportFormat;
  quality: number; // 1..100
  bitDepth: 8 | 16;
  sizeMode: SizeMode;
  sizeValue: number;
  colorSpace: ExportColorSpace;
  metadata: MetadataPolicy;
  artist: string;
  copyright: string;
  outputSharpen: 'none' | 'screen' | 'print';
  watermark: { enabled: boolean; text: string; position: WatermarkPosition; opacity: number; size: number };
  filenameTemplate: string;
  destination: Destination;
  destinationFolderId: string | null;
  includeSidecar: boolean;
  includeRaw: boolean;
}

export const defaultExportOptions = (): ExportOptions => ({
  format: 'jpeg',
  quality: 92,
  bitDepth: 8,
  sizeMode: 'original',
  sizeValue: 2048,
  colorSpace: 'srgb',
  metadata: 'all',
  artist: '',
  copyright: '',
  outputSharpen: 'none',
  watermark: { enabled: false, text: '© ', position: 'br', opacity: 70, size: 3 },
  filenameTemplate: '{name}',
  destination: 'library',
  destinationFolderId: null,
  includeSidecar: false,
  includeRaw: false,
});

export const FORMAT_EXT: Record<ExportFormat, string> = {
  jpeg: 'jpg',
  heic: 'heic',
  png: 'png',
  tiff: 'tif',
  webp: 'webp',
  avif: 'avif',
};
export const FORMAT_MIME: Record<ExportFormat, string> = {
  jpeg: 'image/jpeg',
  heic: 'image/heic',
  png: 'image/png',
  tiff: 'image/tiff',
  webp: 'image/webp',
  avif: 'image/avif',
};

export const supportsQuality = (f: ExportFormat) => f === 'jpeg' || f === 'heic' || f === 'webp' || f === 'avif';
export const supports16Bit = (f: ExportFormat) => f === 'png' || f === 'tiff';

/** Output pixel size for a given cropped size and size rule; never upscales. */
export function outputSize(w: number, h: number, mode: SizeMode, value: number): { width: number; height: number } {
  let s = 1;
  switch (mode) {
    case 'long':
      s = value / Math.max(w, h);
      break;
    case 'short':
      s = value / Math.min(w, h);
      break;
    case 'megapixels':
      s = Math.sqrt((value * 1e6) / (w * h));
      break;
    case 'percent':
      s = value / 100;
      break;
  }
  s = Math.min(1, Math.max(0.01, s));
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

const pad = (n: number, l = 2) => String(n).padStart(l, '0');

/** Expands `{name}`, `{date}`, `{time}`, `{seq}`, `{preset}` and strips path-unsafe characters. */
export function expandFilename(template: string, ctx: { name: string; date: Date; seq: number; preset?: string }): string {
  const base = ctx.name.replace(/\.[^.]+$/, '');
  const d = ctx.date;
  const out = (template || '{name}')
    .replace(/\{name\}/g, base)
    .replace(/\{date\}/g, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`)
    .replace(/\{time\}/g, `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`)
    .replace(/\{seq\}/g, pad(ctx.seq, 3))
    .replace(/\{preset\}/g, ctx.preset ?? '');
  const safe = out.replace(/[\\/:*?"<>|]+/g, '_').trim();
  return safe || base;
}
