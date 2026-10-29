import * as SQLite from 'expo-sqlite';

import { migrateRecipe } from '../recipe/ops';
import type { Recipe } from '../recipe/schema';

let db: SQLite.SQLiteDatabase | null = null;

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS photos (
     key TEXT PRIMARY KEY NOT NULL,
     kind TEXT NOT NULL,
     uri TEXT NOT NULL,
     filename TEXT NOT NULL,
     folder_id TEXT,
     rating INTEGER NOT NULL DEFAULT 0,
     flag INTEGER NOT NULL DEFAULT 0,
     label TEXT,
     edited INTEGER NOT NULL DEFAULT 0,
     recipe TEXT,
     recipe_hash TEXT,
     thumb TEXT,
     updated_at INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX IF NOT EXISTS photos_folder ON photos(folder_id);
   CREATE TABLE IF NOT EXISTS snapshots (
     id TEXT PRIMARY KEY NOT NULL,
     photo_key TEXT NOT NULL,
     name TEXT NOT NULL,
     recipe TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS presets (
     id TEXT PRIMARY KEY NOT NULL,
     name TEXT NOT NULL,
     settings TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS export_presets (
     id TEXT PRIMARY KEY NOT NULL,
     name TEXT NOT NULL,
     options TEXT NOT NULL
   );
   CREATE TABLE IF NOT EXISTS folders (
     id TEXT PRIMARY KEY NOT NULL,
     name TEXT NOT NULL,
     uri TEXT NOT NULL,
     bookmark TEXT,
     added_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS luts (
     id TEXT PRIMARY KEY NOT NULL,
     name TEXT NOT NULL,
     size INTEGER NOT NULL,
     path TEXT NOT NULL
   );`,
  `ALTER TABLE snapshots ADD COLUMN thumb TEXT;
   CREATE INDEX IF NOT EXISTS snapshots_photo ON snapshots(photo_key, created_at);`,
];

export function getDb(): SQLite.SQLiteDatabase {
  if (db) return db;
  db = SQLite.openDatabaseSync('hikari.db');
  db.execSync('PRAGMA journal_mode = WAL;');
  const row = db.getFirstSync<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.withTransactionSync(() => {
      db!.execSync(MIGRATIONS[v]);
      db!.execSync(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ---------------------------------------------------------------------------- photos

export type Flag = -1 | 0 | 1;
export type ColorLabel = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null;

export interface PhotoRow {
  key: string;
  kind: 'library' | 'file';
  uri: string;
  filename: string;
  folder_id: string | null;
  rating: number;
  flag: Flag;
  label: ColorLabel;
  edited: number;
  recipe: string | null;
  recipe_hash: string | null;
  thumb: string | null;
  updated_at: number;
}

export interface PhotoMeta {
  rating: number;
  flag: Flag;
  label: ColorLabel;
  edited: boolean;
  thumb: string | null;
  recipeHash: string | null;
}

export function getPhotoMeta(keys: string[]): Map<string, PhotoMeta> {
  const out = new Map<string, PhotoMeta>();
  if (keys.length === 0) return out;
  const d = getDb();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = d.getAllSync<PhotoRow>(
      `SELECT key, rating, flag, label, edited, thumb, recipe_hash FROM photos WHERE key IN (${chunk.map(() => '?').join(',')})`,
      chunk,
    );
    for (const r of rows) {
      out.set(r.key, {
        rating: r.rating,
        flag: r.flag,
        label: r.label,
        edited: !!r.edited,
        thumb: r.thumb,
        recipeHash: r.recipe_hash,
      });
    }
  }
  return out;
}

export function loadRecipe(key: string): Recipe | null {
  const row = getDb().getFirstSync<{ recipe: string | null }>('SELECT recipe FROM photos WHERE key = ?', [key]);
  if (!row?.recipe) return null;
  try {
    return migrateRecipe(JSON.parse(row.recipe));
  } catch {
    return null;
  }
}

function ensureRow(key: string, kind: string, uri: string, filename: string, folderId: string | null) {
  getDb().runSync(
    `INSERT INTO photos (key, kind, uri, filename, folder_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO NOTHING`,
    [key, kind, uri, filename, folderId, Date.now()],
  );
}

export function saveRecipe(key: string, recipe: Recipe, edited: boolean, hash: string, folderId: string | null) {
  ensureRow(key, recipe.source.kind, recipe.source.uri, recipe.source.filename, folderId);
  getDb().runSync('UPDATE photos SET recipe = ?, edited = ?, recipe_hash = ?, updated_at = ? WHERE key = ?', [
    JSON.stringify(recipe),
    edited ? 1 : 0,
    hash,
    Date.now(),
    key,
  ]);
}

export function setThumb(key: string, thumb: string | null) {
  getDb().runSync('UPDATE photos SET thumb = ? WHERE key = ?', [thumb, key]);
}

export function setRating(
  key: string,
  info: { kind: string; uri: string; filename: string; folderId: string | null },
  patch: Partial<{ rating: number; flag: Flag; label: ColorLabel }>,
) {
  ensureRow(key, info.kind, info.uri, info.filename, info.folderId);
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    vals.push(v as string | number | null);
  }
  if (!sets.length) return;
  getDb().runSync(`UPDATE photos SET ${sets.join(', ')} WHERE key = ?`, [...vals, key]);
}

export function clearEdit(key: string) {
  getDb().runSync('UPDATE photos SET recipe = NULL, edited = 0, recipe_hash = NULL, thumb = NULL WHERE key = ?', [key]);
}

// ---------------------------------------------------------------------------- versions

/** A named, saved state of a photo's edit (Lightroom "versions"); stored in the `snapshots` table. */
export interface PhotoVersion {
  id: string;
  name: string;
  recipe: Recipe;
  thumb: string | null;
  createdAt: number;
}

export function listVersions(photoKey: string): PhotoVersion[] {
  return getDb()
    .getAllSync<{ id: string; name: string; recipe: string; thumb: string | null; created_at: number }>(
      'SELECT * FROM snapshots WHERE photo_key = ? ORDER BY created_at DESC',
      [photoKey],
    )
    .flatMap((r) => {
      let recipe: Recipe | null = null;
      try {
        recipe = migrateRecipe(JSON.parse(r.recipe));
      } catch {
        // skip unreadable rows
      }
      return recipe ? [{ id: r.id, name: r.name, recipe, thumb: r.thumb, createdAt: r.created_at }] : [];
    });
}

export function addVersion(photoKey: string, v: PhotoVersion) {
  getDb().runSync('INSERT INTO snapshots (id, photo_key, name, recipe, thumb, created_at) VALUES (?, ?, ?, ?, ?, ?)', [
    v.id,
    photoKey,
    v.name,
    JSON.stringify(v.recipe),
    v.thumb,
    v.createdAt,
  ]);
}

export function updateVersion(id: string, patch: Partial<Pick<PhotoVersion, 'name' | 'recipe' | 'thumb'>>) {
  const sets: string[] = [];
  const vals: (string | null)[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    vals.push(patch.name);
  }
  if (patch.recipe !== undefined) {
    sets.push('recipe = ?');
    vals.push(JSON.stringify(patch.recipe));
  }
  if (patch.thumb !== undefined) {
    sets.push('thumb = ?');
    vals.push(patch.thumb);
  }
  if (!sets.length) return;
  getDb().runSync(`UPDATE snapshots SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
}

export function deleteVersion(id: string) {
  getDb().runSync('DELETE FROM snapshots WHERE id = ?', [id]);
}

// ---------------------------------------------------------------------------- generic JSON tables

export function listJson<T>(table: 'presets' | 'export_presets', column: 'settings' | 'options') {
  return getDb()
    .getAllSync<{ id: string; name: string } & Record<string, string>>(`SELECT * FROM ${table} ORDER BY name`)
    .map((r) => ({ id: r.id, name: r.name, value: JSON.parse(r[column]) as T }));
}

export function upsertJson(table: 'presets' | 'export_presets', column: 'settings' | 'options', id: string, name: string, value: unknown) {
  const extra = table === 'presets' ? ', created_at' : '';
  const extraVal = table === 'presets' ? ', ?' : '';
  const params: (string | number)[] = [id, name, JSON.stringify(value)];
  if (table === 'presets') params.push(Date.now());
  getDb().runSync(
    `INSERT INTO ${table} (id, name, ${column}${extra}) VALUES (?, ?, ?${extraVal})
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, ${column} = excluded.${column}`,
    params,
  );
}

export function deleteRow(table: 'presets' | 'export_presets' | 'folders' | 'luts', id: string) {
  getDb().runSync(`DELETE FROM ${table} WHERE id = ?`, [id]);
}

// ---------------------------------------------------------------------------- folders & luts

export interface FolderRow {
  id: string;
  name: string;
  uri: string;
  bookmark: string | null;
  added_at: number;
}

export const listFolders = () => getDb().getAllSync<FolderRow>('SELECT * FROM folders ORDER BY added_at DESC');

export function addFolder(name: string, uri: string, bookmark: string | null): FolderRow {
  const existing = getDb().getFirstSync<FolderRow>('SELECT * FROM folders WHERE uri = ?', [uri]);
  if (existing) {
    getDb().runSync('UPDATE folders SET bookmark = ? WHERE id = ?', [bookmark, existing.id]);
    return { ...existing, bookmark };
  }
  const row = { id: newId(), name, uri, bookmark, added_at: Date.now() };
  getDb().runSync('INSERT INTO folders (id, name, uri, bookmark, added_at) VALUES (?, ?, ?, ?, ?)', [
    row.id,
    name,
    uri,
    bookmark,
    row.added_at,
  ]);
  return row;
}

export function updateFolderUri(id: string, uri: string) {
  getDb().runSync('UPDATE folders SET uri = ? WHERE id = ?', [uri, id]);
}

export interface LutRow {
  id: string;
  name: string;
  size: number;
  path: string;
}
export const listLuts = () => getDb().getAllSync<LutRow>('SELECT * FROM luts ORDER BY name');
export function addLut(row: LutRow) {
  getDb().runSync('INSERT OR REPLACE INTO luts (id, name, size, path) VALUES (?, ?, ?, ?)', [row.id, row.name, row.size, row.path]);
}
export const getLut = (id: string) => getDb().getFirstSync<LutRow>('SELECT * FROM luts WHERE id = ?', [id]);

/** Thumbnails live in the cache directory; drop references when it is cleared. */
export const clearThumbRefs = () => getDb().runSync('UPDATE photos SET thumb = NULL');
