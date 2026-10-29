import { Directory, File } from 'expo-file-system';
import { isImageName, isNativeAvailable, isRawName, pickFolder, resolveBookmark } from 'hikari-native';
import { Platform } from 'react-native';

import { addFolder, listFolders, updateFolderUri, type FolderRow } from '../db/db';
import { pairItems } from './pairing';
import { fileKey, type FolderEntry, type PhotoItem } from './types';

/** Asks the user for a folder and stores persistent access to it. */
export async function addFolderInteractive(): Promise<FolderRow | null> {
  if (Platform.OS === 'ios' && isNativeAvailable) {
    const grant = await pickFolder();
    if (!grant) return null;
    return addFolder(decodeURIComponent(grant.name), grant.uri, grant.bookmark);
  }
  // Android: SAF tree picker; expo-file-system takes a persistable permission.
  const dir = await Directory.pickDirectoryAsync();
  if (!dir) return null;
  return addFolder(displayName(dir), dir.uri, null);
}

function displayName(dir: Directory): string {
  const n = dir.name;
  if (n && !n.includes('%3A')) return decodeURIComponent(n);
  // SAF tree uris look like .../tree/primary%3ADCIM%2FCamera
  const tail = decodeURIComponent(dir.uri.split('/').pop() ?? dir.uri);
  return tail.split(':').pop()?.split('/').pop() || tail;
}

/** Re-acquires access after relaunch (iOS bookmarks may move the uri). */
export async function openFolder(row: FolderRow): Promise<string> {
  if (Platform.OS === 'ios' && row.bookmark && isNativeAvailable) {
    const res = await resolveBookmark(row.bookmark);
    if (!res) throw new Error('access-lost');
    if (res.uri !== row.uri) updateFolderUri(row.id, res.uri);
    return res.uri;
  }
  return row.uri;
}

export interface FolderListing {
  folders: FolderEntry[];
  photos: PhotoItem[];
  /** Hikari sidecar files present (basename → uri). */
  sidecars: Map<string, string>;
}

export function listFolder(uri: string, folderId: string): FolderListing {
  const dir = new Directory(uri);
  const entries = dir.list();
  const folders: FolderEntry[] = [];
  const raw: PhotoItem[] = [];
  const sidecars = new Map<string, string>();
  for (const e of entries) {
    if (e instanceof Directory) {
      if (!e.name.startsWith('.')) folders.push({ name: e.name, uri: e.uri });
      continue;
    }
    const f = e as File;
    const name = f.name;
    if (name.startsWith('.')) continue;
    if (/\.xmp$/i.test(name)) {
      sidecars.set(name.replace(/\.xmp$/i, '').toLowerCase(), f.uri);
      continue;
    }
    if (!isImageName(name)) continue;
    const isRaw = isRawName(name);
    raw.push({
      key: fileKey(f.uri),
      kind: 'file',
      id: f.uri,
      // Platform decoders thumbnail JPEG/HEIC/PNG/DNG; other RAWs are rendered by Hikari.
      thumbUri: !isRaw || /\.dng$/i.test(name) ? f.uri : null,
      uri: f.uri,
      filename: name,
      width: 0,
      height: 0,
      createdAt: f.modificationTime ?? 0,
      isRaw,
      isFavorite: false,
      pair: null,
      folderId,
      dirUri: uri,
    });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  raw.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  return { folders, photos: pairItems(raw), sidecars };
}

export { listFolders };

/** Writes a file next to a source within a folder (works for SAF trees and plain dirs). */
export function writeIntoFolder(folderUri: string, name: string, mime: string, bytes: Uint8Array | string): string {
  const dir = new Directory(folderUri);
  const existing = dir.list().find((e) => !(e instanceof Directory) && e.name === name) as File | undefined;
  const file = existing ?? dir.createFile(name, mime);
  file.write(bytes);
  return file.uri;
}
