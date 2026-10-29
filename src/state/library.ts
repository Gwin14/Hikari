import { create } from 'zustand';

import * as db from '@/core/db/db';
import type { ColorLabel, Flag, PhotoMeta } from '@/core/db/db';
import { listLibrary, pairLibraryItems } from '@/core/sources/library';
import type { PhotoItem } from '@/core/sources/types';
import { hasRaw } from '@/core/sources/types';

export type FilterId = 'all' | 'edited' | 'raw' | 'pairs' | 'favorites' | 'picks' | 'rejected';
export type SortId = 'newest' | 'oldest' | 'name';

export interface ViewFilter {
  filter: FilterId;
  minRating: number;
  sort: SortId;
}

export const defaultFilter: ViewFilter = { filter: 'all', minRating: 0, sort: 'newest' };

const PAGE = 300;

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
  setFolderItems(items: PhotoItem[]): void;
  refreshMeta(keys: string[]): void;
  setSequence(items: PhotoItem[]): void;
  setMeta(item: PhotoItem, patch: Partial<{ rating: number; flag: Flag; label: ColorLabel }>): void;
  toggleSelect(key: string): void;
  setSelecting(v: boolean): void;
  clearSelection(): void;
  selectAll(keys: string[]): void;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  albumId: null,
  libraryRaw: [],
  libraryDone: false,
  libraryLoading: false,
  libraryOffset: 0,
  folderItems: [],
  meta: new Map(),
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
      const page = await listLibrary({ albumId, offset, limit: PAGE, ascending: sort === 'oldest' });
      const raw = fresh ? page.items : [...get().libraryRaw, ...page.items];
      const meta = new Map(fresh ? [] : get().meta);
      for (const [k, v] of db.getPhotoMeta(page.items.map((i) => i.key))) meta.set(k, v);
      set({ libraryRaw: raw, libraryDone: page.done, libraryOffset: offset + page.consumed, meta });
    } finally {
      set({ libraryLoading: false });
    }
  },

  setFolderItems(items) {
    const meta = new Map(get().meta);
    for (const [k, v] of db.getPhotoMeta(items.map((i) => i.key))) meta.set(k, v);
    set({ folderItems: items, meta });
  },

  refreshMeta(keys) {
    const meta = new Map(get().meta);
    const fresh = db.getPhotoMeta(keys);
    for (const k of keys) {
      const v = fresh.get(k);
      if (v) meta.set(k, v);
      else meta.delete(k);
    }
    set({ meta });
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
