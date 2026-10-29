import { create } from 'zustand';

import * as db from '@/core/db/db';
import type { ColorLabel, Flag, PhotoMeta } from '@/core/db/db';
import { listLibrary, pairLibraryItems } from '@/core/sources/library';
import type { PhotoItem } from '@/core/sources/types';
import { hasRaw } from '@/core/sources/types';
import { prefs } from './prefs';

export type FilterId = 'all' | 'edited' | 'raw' | 'pairs' | 'favorites' | 'picks' | 'rejected';
export type SortId = 'newest' | 'oldest' | 'name';

export interface ViewFilter {
  filter: FilterId;
  minRating: number;
  sort: SortId;
}

export const defaultFilter: ViewFilter = { filter: 'all', minRating: 0, sort: 'newest' };

const PAGE = 300;
/** First screens of the gallery, cached so a cold start paints photos before MediaLibrary answers. */
const SNAPSHOT_KEY = 'librarySnapshot';
const SNAPSHOT_SIZE = 120;

function readSnapshot(): PhotoItem[] {
  try {
    const json = prefs.getString(SNAPSHOT_KEY);
    return json ? (JSON.parse(json) as PhotoItem[]) : [];
  } catch {
    return [];
  }
}

const sameMeta = (a: PhotoMeta | undefined, b: PhotoMeta) =>
  !!a &&
  a.rating === b.rating &&
  a.flag === b.flag &&
  a.label === b.label &&
  a.edited === b.edited &&
  a.thumb === b.thumb &&
  a.recipeHash === b.recipeHash;

/** Merge fresh catalog rows into `meta`, keeping object identity for unchanged rows. Returns null if nothing changed. */
function mergeMeta(meta: Map<string, PhotoMeta>, keys: string[], removeMissing: boolean): Map<string, PhotoMeta> | null {
  const fresh = db.getPhotoMeta(keys);
  let out: Map<string, PhotoMeta> | null = null;
  for (const k of keys) {
    const v = fresh.get(k);
    const old = meta.get(k);
    if (v) {
      if (sameMeta(old, v)) continue;
      out ??= new Map(meta);
      out.set(k, v);
    } else if (old && removeMissing) {
      out ??= new Map(meta);
      out.delete(k);
    }
  }
  return out;
}

/** Reuse item objects whose content didn't change so memoized grid cells skip re-rendering. */
function reuseItems(prev: PhotoItem[], next: PhotoItem[]): PhotoItem[] {
  if (!prev.length) return next;
  const byKey = new Map(prev.map((i) => [i.key, i]));
  return next.map((n) => {
    const o = byKey.get(n.key);
    return o && o.filename === n.filename && o.isFavorite === n.isFavorite && o.width === n.width && o.height === n.height ? o : n;
  });
}

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

interface LibraryState {
  /** Gallery listing (current album). */
  albumId: string | null;
  libraryRaw: PhotoItem[];
  libraryDone: boolean;
  libraryLoading: boolean;
  libraryOffset: number;
  /** Folder listing currently open (same shape so both modes share UI). */
  folderItems: PhotoItem[];
  meta: Map<string, PhotoMeta>;
  /** Items in the order the user is browsing — used to swipe between photos in the editor. */
  sequence: PhotoItem[];
  selection: Set<string>;
  selecting: boolean;

  loadLibrary(albumId: string | null, sort: SortId, reset?: boolean): Promise<void>;
  /** Re-list after the library changed (new/deleted photos), keeping everything already scrolled. Debounced. */
  refreshLibrary(sort: SortId): void;
  setFolderItems(items: PhotoItem[]): void;
  refreshMeta(keys: string[]): void;
  setSequence(items: PhotoItem[]): void;
  setMeta(item: PhotoItem, patch: Partial<{ rating: number; flag: Flag; label: ColorLabel }>): void;
  toggleSelect(key: string): void;
  setSelecting(v: boolean): void;
  clearSelection(): void;
  selectAll(keys: string[]): void;
}

const snapshot = readSnapshot();

function snapshotMeta(): Map<string, PhotoMeta> {
  try {
    return db.getPhotoMeta(snapshot.map((i) => i.key));
  } catch {
    return new Map();
  }
}

export const useLibrary = create<LibraryState>((set, get) => ({
  albumId: null,
  libraryRaw: snapshot,
  libraryDone: false,
  libraryLoading: false,
  libraryOffset: 0,
  folderItems: [],
  meta: snapshotMeta(),
  sequence: [],
  selection: new Set(),
  selecting: false,

  async loadLibrary(albumId, sort, reset = false) {
    const s = get();
    if (s.libraryLoading) return;
    const fresh = reset || s.albumId !== albumId;
    if (!fresh && s.libraryDone) return;
    set({ libraryLoading: true, albumId });
    try {
      const offset = fresh ? 0 : s.libraryOffset;
      const ascending = sort === 'oldest';
      const page = await listLibrary({ albumId, offset, limit: PAGE, ascending });
      const raw = fresh ? reuseItems(get().libraryRaw, page.items) : [...get().libraryRaw, ...page.items];
      const meta = mergeMeta(get().meta, page.items.map((i) => i.key), true) ?? get().meta;
      set({ libraryRaw: raw, libraryDone: page.done, libraryOffset: offset + page.consumed, meta });
      if (fresh && !albumId && !ascending) saveSnapshot(page.items);
    } finally {
      set({ libraryLoading: false });
    }
  },

  refreshLibrary(sort) {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      refreshTimer = null;
      const s = get();
      if (s.libraryLoading) return s.refreshLibrary(sort);
      set({ libraryLoading: true });
      try {
        const ascending = sort === 'oldest';
        // Re-list as much as was already loaded so the scroll position and later pages survive.
        const limit = Math.max(PAGE, s.libraryOffset);
        const page = await listLibrary({ albumId: s.albumId, offset: 0, limit, ascending });
        const meta = mergeMeta(get().meta, page.items.map((i) => i.key), true) ?? get().meta;
        set({ libraryRaw: reuseItems(get().libraryRaw, page.items), libraryDone: page.done, libraryOffset: page.consumed, meta });
        if (!s.albumId && !ascending) saveSnapshot(page.items);
      } finally {
        set({ libraryLoading: false });
      }
    }, 350);
  },

  setFolderItems(items) {
    const meta = mergeMeta(get().meta, items.map((i) => i.key), false) ?? get().meta;
    set({ folderItems: reuseItems(get().folderItems, items), meta });
  },

  refreshMeta(keys) {
    const meta = mergeMeta(get().meta, keys, true);
    if (meta) set({ meta });
  },

  setSequence: (sequence) => set({ sequence }),

  setMeta(item, patch) {
    db.setRating(item.key, { kind: item.kind, uri: item.uri, filename: item.filename, folderId: item.folderId }, patch);
    get().refreshMeta([item.key]);
  },

  toggleSelect(key) {
    const selection = new Set(get().selection);
    if (selection.has(key)) selection.delete(key);
    else selection.add(key);
    set({ selection, selecting: true });
  },
  setSelecting: (selecting) => set({ selecting, selection: selecting ? get().selection : new Set() }),
  clearSelection: () => set({ selection: new Set(), selecting: false }),
  selectAll: (keys) => set({ selection: new Set(keys), selecting: true }),
}));

function saveSnapshot(items: PhotoItem[]) {
  try {
    prefs.set(SNAPSHOT_KEY, JSON.stringify(items.slice(0, SNAPSHOT_SIZE)));
  } catch {
    // snapshot is only a startup cache
  }
}

/** Resolve catalog keys to items from whatever listings are loaded. */
export function findItems(keys: string[]): PhotoItem[] {
  const s = useLibrary.getState();
  const all = new Map<string, PhotoItem>();
  for (const list of [pairLibraryItems(s.libraryRaw), s.folderItems, s.sequence]) for (const it of list) all.set(it.key, it);
  return keys.flatMap((k) => {
    const it = all.get(k);
    return it ? [it] : [];
  });
}

/** Applies a filter + sort to any listing (gallery or folder) the same way. */
export function applyFilter(items: PhotoItem[], meta: Map<string, PhotoMeta>, f: ViewFilter): PhotoItem[] {
  let out = items.filter((it) => {
    const m = meta.get(it.key);
    if (f.minRating > 0 && (m?.rating ?? 0) < f.minRating) return false;
    switch (f.filter) {
      case 'edited':
        return !!m?.edited;
      case 'raw':
        return hasRaw(it);
      case 'pairs':
        return !!it.pair;
      case 'favorites':
        return it.isFavorite || (m?.rating ?? 0) >= 4;
      case 'picks':
        return m?.flag === 1;
      case 'rejected':
        return m?.flag === -1;
      default:
        return true;
    }
  });
  if (f.sort === 'name') out = [...out].sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
  else if (items.length && items[0].kind === 'file') {
    out = [...out].sort((a, b) => (f.sort === 'oldest' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
  }
  return out;
}
