import { requireNativeView, requireOptionalNativeModule } from 'expo';
import type { ComponentType } from 'react';
import type { ViewProps } from 'react-native';

export type PixelFormat = 'rgba8' | 'rgba16f' | 'rgba16';

export interface RawDecodeOptions {
  /** 0..100 native demosaic noise reduction. */
  decodeNoise: number;
  highlightRecovery: boolean;
  lensCorrection: boolean;
  /** 0..100 camera profile tone boost (Apple "boostAmount"). */
  boost: number;
}

export interface DecodeOptions {
  /** Longest edge of the output, or 0 for full resolution. */
  maxDim: number;
  /** Develop the RAW data (true) or the embedded/processed image (false). */
  preferRaw: boolean;
  raw?: RawDecodeOptions;
}

export interface DecodeResult {
  /** Raw pixel file: width*height*4 bytes (rgba8) or *8 bytes (rgba16f, sRGB-encoded, extended range). */
  path: string;
  width: number;
  height: number;
  /** Oriented size of the full-resolution image. */
  fullWidth: number;
  fullHeight: number;
  format: PixelFormat;
  isRaw: boolean;
}

export interface PhotoMetadata {
  width: number;
  height: number;
  make?: string;
  model?: string;
  lens?: string;
  iso?: number;
  exposureTime?: number;
  fNumber?: number;
  focalLength?: number;
  focalLength35?: number;
  exposureBias?: number;
  flash?: boolean;
  dateTaken?: string;
  latitude?: number;
  longitude?: number;
  colorProfile?: string;
  bitDepth?: number;
  isRaw: boolean;
  isProRaw?: boolean;
  artist?: string;
  copyright?: string;
}

export type ExportFormat = 'jpeg' | 'heic' | 'png' | 'tiff' | 'webp' | 'avif';
export type ExportColorSpace = 'srgb' | 'p3' | 'adobergb';
export type MetadataPolicy = 'all' | 'noLocation' | 'copyright' | 'none';

export interface EncodeOptions {
  format: ExportFormat;
  /** 0..1 */
  quality: number;
  bitDepth: 8 | 16;
  /** Target color space of the file. */
  colorSpace: ExportColorSpace;
  /** rgba8 / rgba16 (little-endian uint16) code values, or rgba16f extended sRGB. */
  inputFormat: PixelFormat;
  /** Space the input code values are encoded in. */
  inputColorSpace: 'srgb' | 'p3';
  /** Copy EXIF/GPS/IPTC from this original file, filtered by `metadata`. */
  metadataSource?: string;
  metadata: MetadataPolicy;
  artist?: string;
  copyright?: string;
  /** Absolute file:// destination. */
  outputPath: string;
}

export interface AssetResources {
  hasRaw: boolean;
  hasPhoto: boolean;
  rawFilename?: string;
  photoFilename?: string;
  isProRaw: boolean;
}

export type SegmentKind = 'subject' | 'person' | 'sky';

export interface MaskResult {
  /** Grayscale PNG, oriented like decodeImage output. */
  path: string;
  width: number;
  height: number;
}

export interface InstancesResult extends MaskResult {
  /** Number of objects; the PNG's red channel holds 1..count per object, 0 for background. */
  count: number;
}

export interface FolderGrant {
  uri: string;
  /** Base64 security-scoped bookmark (iOS) to restore access after relaunch. */
  bookmark: string | null;
  name: string;
}

export interface RefineMaskOptions {
  radius: number;
  eps: number;
  lo: number;
  hi: number;
}

export interface RemoveSpotOptions {
  grow: number;
  feather: number;
  searchMaxDim: number;
  seed: number;
}

export interface RemoveSpotResult {
  /** Float32 bytes, 3 per pixel. */
  pixels: Uint8Array;
  /** Float32 bytes, 1 per pixel. */
  alpha: Uint8Array;
}

export interface NativeHistogram {
  /** 1024 values: 256 bins each of r, g, b, luma. */
  bins: number[];
  total: number;
  clipLow: number;
  clipHigh: number;
}

export interface AutoAdjustResult {
  light: { exposure: number; contrast: number; highlights: number; shadows: number; whites: number; blacks: number };
  temperature: number;
  tint: number;
}

/** A GPU image owned by the native renderer. */
export interface RenderImageObject {
  readonly id: number;
  readonly width: number;
  readonly height: number;
  readonly fullWidth: number;
  readonly fullHeight: number;
  readonly isRaw: boolean;
  readonly isFloat: boolean;
  readRgba8(x: number, y: number, width: number, height: number): Uint8Array;
  /** The whole image's RGBA16 bytes. */
  readRgba16(): Uint8Array;
  /** RGBA, 32-bit floats. */
  readFloats(x: number, y: number, width: number, height: number): Uint8Array;
  encode(format: 'jpeg' | 'png', quality: number): Uint8Array;
  encodeToFile(options: EncodeOptions): Promise<{ path: string; size: number }>;
}

export interface RenderInputsRecord {
  source: number;
  cleaned: number;
  blurN: number;
  blurS: number;
  blurM: number;
  blurL: number;
  curve: number | null;
  lut: number | null;
  masks: number[];
}

export interface StrokeRecord {
  points: number[];
  size: number;
  hardness: number;
  flow: number;
  erase: boolean;
}

export interface WatermarkRecord {
  text: string;
  position: string;
  opacity: number;
  size: number;
}

export interface EditorSurfaceObject {
  setFrame(frame: number[]): void;
  setInputs(inputs: RenderInputsRecord | null): void;
  setCurve(curve: RenderImageObject): void;
}

interface HikariNativeSpec {
  RenderImage: unknown;
  isRendererSupported?(): boolean;
  EditorSurface: new () => EditorSurfaceObject;
  makeRenderImage(pixels: Uint8Array, width: number, height: number, format: 'rgba8' | 'rgba16f'): RenderImageObject;
  loadRenderImage(uri: string, options: DecodeOptions): Promise<RenderImageObject>;
  loadEncodedRenderImage(uri: string): Promise<RenderImageObject>;
  blurRenderImage(image: RenderImageObject, sigma: number, width: number, height: number): RenderImageObject;
  compositeRenderImage(source: RenderImageObject, patches: { image: number; x: number; y: number }[]): RenderImageObject;
  renderOffscreen(inputs: RenderInputsRecord, frame: number[], width: number, height: number, bits: 8 | 16, watermark: WatermarkRecord | null): RenderImageObject;
  rasterizeStrokes(strokes: StrokeRecord[], width: number, height: number, base: RenderImageObject | null): RenderImageObject;
  rasterizeArea(strokes: StrokeRecord[], frameW: number, frameH: number, region: number[], objects: RenderImageObject | null): Uint8Array;
  decodeImage(uri: string, options: DecodeOptions): Promise<DecodeResult>;
  readMetadata(uri: string): Promise<PhotoMetadata>;
  encodeImage(pixels: Uint8Array, width: number, height: number, options: EncodeOptions): Promise<{ path: string; size: number }>;
  segment(uri: string, kind: SegmentKind, maxDim: number, preferRaw: boolean): Promise<MaskResult | null>;
  segmentInstances(uri: string, maxDim: number, preferRaw: boolean): Promise<InstancesResult | null>;
  refineMask(guide: Uint8Array, mask: Uint8Array, width: number, height: number, options: RefineMaskOptions): Promise<Uint8Array>;
  objectMask(guide: Uint8Array, coverage: Uint8Array, selected: Uint8Array | null, width: number, height: number): Promise<Uint8Array>;
  selectInstances(
    labels: Uint8Array,
    labelStride: number,
    count: number,
    coverage: Uint8Array,
    coverageStride: number,
    n: number,
    minCover: number,
    minShare: number,
  ): Promise<{ mask: Uint8Array; picked: number }>;
  removeSpot(pixels: Uint8Array, area: Uint8Array, alpha: Uint8Array, width: number, height: number, options: RemoveSpotOptions): Promise<RemoveSpotResult>;
  computeHistogram(pixels: Uint8Array, step: number): Promise<NativeHistogram>;
  skyMask(pixels: Uint8Array, width: number, height: number): Promise<Uint8Array>;
  autoAdjust(pixels: Uint8Array): Promise<AutoAdjustResult>;
  assetResources(assetId: string): Promise<AssetResources | null>;
  exportAssetResource(assetId: string, kind: 'raw' | 'photo'): Promise<string>;
  saveEditToLibrary(assetId: string, renderedPath: string, adjustmentJson: string, formatVersion: string): Promise<boolean>;
  readLibraryAdjustment(assetId: string): Promise<string | null>;
  readForeignAdjustment(assetId: string, format: string): Promise<string | null>;
  revertLibraryEdit(assetId: string): Promise<boolean>;
  pickFolder(): Promise<FolderGrant | null>;
  resolveBookmark(bookmark: string): Promise<{ uri: string; stale: boolean } | null>;
  supportedRawExtensions(): string[];
}

const Native = requireOptionalNativeModule<HikariNativeSpec>('HikariNative');

/** Native features exist only in a development build (not Expo Go / web). */
export const isNativeAvailable = Native != null;

/** The CPU image math has a native build on this platform. */
export const hasNativeCompute = typeof Native?.refineMask === 'function';

/** The GPU pipeline runs natively; otherwise (old Android GPUs, Expo Go, web) through Skia. */
export const hasNativeRenderer = typeof Native?.RenderImage === 'function' && Native.isRendererSupported?.() !== false;

export const EditorRenderView: ComponentType<ViewProps> | null = hasNativeRenderer ? requireNativeView<ViewProps>('HikariNative') : null;

function native(): HikariNativeSpec {
  if (!Native) throw new Error('HikariNative is unavailable. Build the app with `npx expo run:ios|android`.');
  return Native;
}

export const decodeImage = (uri: string, options: DecodeOptions) => native().decodeImage(uri, options);
export const readMetadata = (uri: string) => native().readMetadata(uri);
export const encodeImage = (pixels: Uint8Array, width: number, height: number, options: EncodeOptions) =>
  native().encodeImage(pixels, width, height, options);
export const segment = (uri: string, kind: SegmentKind, maxDim: number, preferRaw: boolean) =>
  native().segment(uri, kind, maxDim, preferRaw);
export const segmentInstances = (uri: string, maxDim: number, preferRaw: boolean) =>
  native().segmentInstances(uri, maxDim, preferRaw);
export const refineMask = (guide: Uint8Array, mask: Uint8Array, width: number, height: number, options: RefineMaskOptions) =>
  native().refineMask(guide, mask, width, height, options);
export const objectMask = (guide: Uint8Array, coverage: Uint8Array, selected: Uint8Array | null, width: number, height: number) =>
  native().objectMask(guide, coverage, selected, width, height);
export const selectInstances = (
  labels: Uint8Array,
  labelStride: number,
  count: number,
  coverage: Uint8Array,
  coverageStride: number,
  n: number,
  minCover: number,
  minShare: number,
) => native().selectInstances(labels, labelStride, count, coverage, coverageStride, n, minCover, minShare);
export const removeSpot = (pixels: Uint8Array, area: Uint8Array, alpha: Uint8Array, width: number, height: number, options: RemoveSpotOptions) =>
  native().removeSpot(pixels, area, alpha, width, height, options);
export const computeHistogram = (pixels: Uint8Array, step: number) => native().computeHistogram(pixels, step);
export const skyMask = (pixels: Uint8Array, width: number, height: number) => native().skyMask(pixels, width, height);
export const autoAdjust = (pixels: Uint8Array) => native().autoAdjust(pixels);
export const createEditorSurface = (): EditorSurfaceObject => new (native().EditorSurface)();
export const makeRenderImage = (pixels: Uint8Array, width: number, height: number, format: 'rgba8' | 'rgba16f') =>
  native().makeRenderImage(pixels, width, height, format);
export const loadRenderImage = (uri: string, options: DecodeOptions) => native().loadRenderImage(uri, options);
export const loadEncodedRenderImage = (uri: string) => native().loadEncodedRenderImage(uri);
export const blurRenderImage = (image: RenderImageObject, sigma: number, width: number, height: number) =>
  native().blurRenderImage(image, sigma, width, height);
export const compositeRenderImage = (source: RenderImageObject, patches: { image: number; x: number; y: number }[]) =>
  native().compositeRenderImage(source, patches);
export const renderOffscreen = (inputs: RenderInputsRecord, frame: number[], width: number, height: number, bits: 8 | 16, watermark: WatermarkRecord | null) =>
  native().renderOffscreen(inputs, frame, width, height, bits, watermark);
export const rasterizeStrokes = (strokes: StrokeRecord[], width: number, height: number, base: RenderImageObject | null) =>
  native().rasterizeStrokes(strokes, width, height, base);
export const rasterizeArea = (strokes: StrokeRecord[], frameW: number, frameH: number, region: number[], objects: RenderImageObject | null) =>
  native().rasterizeArea(strokes, frameW, frameH, region, objects);
export const assetResources = (assetId: string) => (Native ? Native.assetResources(assetId) : Promise.resolve(null));
export const exportAssetResource = (assetId: string, kind: 'raw' | 'photo') => native().exportAssetResource(assetId, kind);
export const saveEditToLibrary = (assetId: string, renderedPath: string, json: string, version: string) =>
  native().saveEditToLibrary(assetId, renderedPath, json, version);
export const readLibraryAdjustment = (assetId: string) =>
  Native ? Native.readLibraryAdjustment(assetId) : Promise.resolve(null);
/** Adjustment data written by another app (iOS PhotoKit), when its format matches. */
export const readForeignAdjustment = (assetId: string, format: string) =>
  Native?.readForeignAdjustment ? Native.readForeignAdjustment(assetId, format) : Promise.resolve(null);
export const revertLibraryEdit = (assetId: string) => native().revertLibraryEdit(assetId);
export const pickFolder = () => native().pickFolder();
export const resolveBookmark = (bookmark: string) => native().resolveBookmark(bookmark);

export const RAW_EXTENSIONS = [
  'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'raf', 'orf', 'rw2', 'pef', 'srw',
  'x3f', '3fr', 'fff', 'iiq', 'mos', 'mrw', 'erf', 'kdc', 'dcr', 'rwl', 'gpr',
];
export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'heic', 'heif', 'png', 'tif', 'tiff', 'webp', 'avif'];

export function extensionOf(name: string): string {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}
export const isRawName = (name: string) => RAW_EXTENSIONS.includes(extensionOf(name));
export const isImageName = (name: string) => isRawName(name) || IMAGE_EXTENSIONS.includes(extensionOf(name));
