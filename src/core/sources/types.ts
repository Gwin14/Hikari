export type SourceKind = 'library' | 'file';

/** One browsable photo — a single file or a RAW+JPEG pair shown as one item. */
export interface PhotoItem {
  /** Stable catalog key: `lib:<assetId>` or `file:<uri>`. */
  key: string;
  kind: SourceKind;
  /** MediaLibrary asset id, or file uri. */
  id: string;
  /** Uri usable by expo-image for a quick thumbnail (null when only we can render it). */
  thumbUri: string | null;
  /** Uri of the primary file (or `ph://` id on iOS library). */
  uri: string;
  filename: string;
  width: number;
  height: number;
  createdAt: number;
  isRaw: boolean;
  isFavorite: boolean;
  /** Other half of a RAW+JPEG pair. */
  pair: { uri: string; filename: string; isRaw: boolean } | null;
  folderId: string | null;
  /** Directory holding the file (folder mode), for sidecars and "next to original" exports. */
  dirUri: string | null;
}

export interface FolderEntry {
  name: string;
  uri: string;
}

export const libraryKey = (id: string) => `lib:${id}`;
export const fileKey = (uri: string) => `file:${uri}`;

export const rawUriOf = (p: PhotoItem) => (p.isRaw ? p.uri : p.pair?.isRaw ? p.pair.uri : null);
export const processedUriOf = (p: PhotoItem) => (!p.isRaw ? p.uri : p.pair && !p.pair.isRaw ? p.pair.uri : null);
export const hasRaw = (p: PhotoItem) => rawUriOf(p) !== null;
