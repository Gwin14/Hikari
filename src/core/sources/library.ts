import { isRawName } from 'hikari-native';
import { Album, AssetField, MediaType, Query, type AssetMetadata } from 'expo-media-library';
import { Platform } from 'react-native';

import { pairItems } from './pairing';
import { libraryKey, type PhotoItem } from './types';

export interface AlbumInfo {
  id: string;
  title: string;
}

/** Uri expo-image can load for a library asset. */
export function libraryThumbUri(id: string): string {
  if (id.includes('://')) return id;
  return Platform.OS === 'ios' ? `ph://${id}` : `content://media/external/images/media/${id}`;
}

function toItem(m: AssetMetadata): PhotoItem {
  const filename = m.filename ?? m.id;
  const raw = isRawName(filename);
  return {
    key: libraryKey(m.id),
    kind: 'library',
    id: m.id,
    // Most platforms can't thumbnail proprietary RAW; DNG/ProRAW work natively.
    thumbUri: !raw || /\.dng$/i.test(filename) || Platform.OS === 'ios' ? libraryThumbUri(m.id) : null,
    uri: libraryThumbUri(m.id),
    filename,
    width: m.width ?? 0,
    height: m.height ?? 0,
    createdAt: (m.creationTime ?? 0) > 1e12 ? (m.creationTime ?? 0) : (m.creationTime ?? 0) * 1000,
    isRaw: raw,
    isFavorite: m.isFavorite,
    pair: null,
    folderId: null,
    dirUri: null,
  };
}

export interface LibraryPage {
  /** Unpaired items; see pairLibraryItems. */
  items: PhotoItem[];
  consumed: number;
  done: boolean;
}

/**
 * On iOS a RAW+JPEG capture is a single PHAsset (resources are inspected in the editor).
 * Android stores both files separately, so they are paired by name across the whole list.
 */
export const pairLibraryItems = (items: PhotoItem[]) => (Platform.OS === 'android' ? pairItems(items) : items);

export async function listLibrary(opts: {
  albumId: string | null;
  offset: number;
  limit: number;
  ascending: boolean;
  favoritesOnly?: boolean;
}): Promise<LibraryPage> {
  let q = new Query().eq(AssetField.MEDIA_TYPE, MediaType.IMAGE);
  if (opts.albumId) q = q.album(new Album(opts.albumId));
  if (opts.favoritesOnly) q = q.eq(AssetField.IS_FAVORITE, true);
  const meta = await q
    .orderBy({ key: AssetField.CREATION_TIME, ascending: opts.ascending })
    .offset(opts.offset)
    .limit(opts.limit)
    .exeForMetadata();
  return { items: meta.map(toItem), consumed: meta.length, done: meta.length < opts.limit };
}

export async function listAlbums(): Promise<AlbumInfo[]> {
  const albums = await Album.getAlbumsMetadata();
  return albums.map((a) => ({ id: a.id, title: a.title })).sort((a, b) => a.title.localeCompare(b.title));
}
