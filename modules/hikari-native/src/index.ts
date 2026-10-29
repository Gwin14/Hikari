import { requireOptionalNativeModule } from 'expo';

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

interface HikariNativeSpec {
  decodeImage(uri: string, options: DecodeOptions): Promise<DecodeResult>;
  readMetadata(uri: string): Promise<PhotoMetadata>;
  encodeImage(pixels: Uint8Array, width: number, height: number, options: EncodeOptions): Promise<{ path: string; size: number }>;
  segment(uri: string, kind: SegmentKind, maxDim: number, preferRaw: boolean): Promise<MaskResult | null>;
  segmentInstances(uri: string, maxDim: number, preferRaw: boolean): Promise<InstancesResult | null>;
  assetResources(assetId: string): Promise<AssetResources | null>;
  exportAssetResource(assetId: string, kind: 'raw' | 'photo'): Promise<string>;
  saveEditToLibrary(assetId: string, renderedPath: string, adjustmentJson: string, formatVersion: string): Promise<boolean>;
  readLibraryAdjustment(assetId: string): Promise<string | null>;
  revertLibraryEdit(assetId: string): Promise<boolean>;
  pickFolder(): Promise<FolderGrant | null>;
  resolveBookmark(bookmark: string): Promise<{ uri: string; stale: boolean } | null>;
  supportedRawExtensions(): string[];
}

const Native = requireOptionalNativeModule<HikariNativeSpec>('HikariNative');

/** Native features exist only in a development build (not Expo Go / web). */
export const isNativeAvailable = Native != null;

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
export const assetResources = (assetId: string) => (Native ? Native.assetResources(assetId) : Promise.resolve(null));
export const exportAssetResource = (assetId: string, kind: 'raw' | 'photo') => native().exportAssetResource(assetId, kind);
export const saveEditToLibrary = (assetId: string, renderedPath: string, json: string, version: string) =>
  native().saveEditToLibrary(assetId, renderedPath, json, version);
export const readLibraryAdjustment = (assetId: string) =>
  Native ? Native.readLibraryAdjustment(assetId) : Promise.resolve(null);
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
