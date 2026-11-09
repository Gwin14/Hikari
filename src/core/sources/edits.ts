import { Directory, File } from 'expo-file-system';
import { isNativeAvailable, readLibraryAdjustment } from 'hikari-native';
import { Platform } from 'react-native';

import * as db from '../db/db';
import { createRecipe } from '../recipe/defaults';
import { applySettings } from '../recipe/ops';
import type { Recipe } from '../recipe/schema';
import { parseLibraryAdjustment, readSidecar, sidecarName, type SavedVersion } from '../xmp/sidecar';
import type { PhotoItem } from './types';

/**
 * A photo's saved edit lives with the photo: a .xmp sidecar in a folder, the Photos adjustment
 * data of a library asset. The app's catalog only keeps what the grid shows.
 */
export interface PhotoEdit {
  recipe: Recipe | null;
  versions: SavedVersion[];
}

/** Library edits rely on PhotoKit, so Android library photos can only be exported as copies. */
export const canSaveEdit = (item: PhotoItem) => (item.kind === 'file' ? !!item.dirUri : Platform.OS === 'ios' && isNativeAvailable);

function fromSidecar(item: PhotoItem): PhotoEdit {
  if (!item.dirUri) return { recipe: null, versions: [] };
  try {
    const name = sidecarName(item.filename).toLowerCase();
    const f = new Directory(item.dirUri).list().find((e) => !(e instanceof Directory) && e.name.toLowerCase() === name) as File | undefined;
    if (!f) return { recipe: null, versions: [] };
    const data = readSidecar(f.textSync());
    if (data.recipe) return { recipe: { ...data.recipe, source: { ...data.recipe.source, id: item.id, uri: item.uri } }, versions: data.versions };
    if (Object.keys(data.crs).length) {
      const fresh = createRecipe({
        kind: 'file',
        id: item.id,
        uri: item.uri,
        filename: item.filename,
        pairedUri: item.pair?.uri ?? null,
        useRaw: item.isRaw || !!item.pair,
        isRaw: item.isRaw,
      });
      return { recipe: applySettings(fresh, data.crs, false), versions: [] };
    }
  } catch {
    // unreadable sidecar → start fresh
  }
  return { recipe: null, versions: [] };
}

async function fromLibrary(item: PhotoItem): Promise<PhotoEdit> {
  const json = await readLibraryAdjustment(item.id);
  return json ? parseLibraryAdjustment(json) : { recipe: null, versions: [] };
}

/** The saved edit of a photo. Edits from before saving was explicit stay readable until saved again. */
export async function loadPhotoEdit(item: PhotoItem): Promise<PhotoEdit> {
  const saved = item.kind === 'library' ? await fromLibrary(item) : fromSidecar(item);
  const legacy = db.loadRecipe(item.key);
  const recipe = legacy && (!saved.recipe || legacy.updatedAt > saved.recipe.updatedAt) ? legacy : saved.recipe;
  return { recipe, versions: saved.versions.length ? saved.versions : db.listVersions(item.key) };
}

/** Removes what older builds kept in the catalog, now that the edit is saved with the photo. */
export function deleteLegacyVersionThumbs(key: string) {
  for (const v of db.listVersions(key)) {
    if (!v.thumb) continue;
    try {
      const f = new File(v.thumb);
      if (f.exists) f.delete();
    } catch {
      // a leftover thumbnail is harmless
    }
  }
}

let draft: ({ key: string } & PhotoEdit) | null = null;

/** The open photo's unsaved edit, so exporting from the editor gets what is on screen. */
export function setEditDraft(next: typeof draft) {
  draft = next;
}

export const editDraft = (key: string): PhotoEdit | null => (draft?.key === key ? draft : null);
