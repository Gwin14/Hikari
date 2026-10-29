import { AlphaType, ColorType, ImageFormat, type SkImage } from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';
import { assetResources, readLibraryAdjustment } from 'hikari-native';
import { makeMutable } from 'react-native-reanimated';
import { scheduleOnUI } from 'react-native-worklets';
import { create } from 'zustand';

import { autoTone, autoWhiteBalance, computeHistogram, type Histogram } from '@/core/auto/analysis';
import { bakeCurveLut } from '@/core/color/curve';
import { cubeToStrip, parseCube } from '@/core/color/cube';
import * as db from '@/core/db/db';
import { evictSource, hasSource, loadSource } from '@/core/image/load';
import { aiMaskTexture, renderBrushMask } from '@/core/pipeline/masks';
import {
  blurImage,
  blurSigmas,
  makeRgbaImage,
  nextGpuKey,
  prepareInputs,
  toTexture,
  renderToImage,
  resizeImage,
  type PreparedSource,
  type RenderInputs,
} from '@/core/pipeline/render';
import { createMask, createRecipe } from '@/core/recipe/defaults';
import { applySettings, isEdited, pickSections, recipeHash } from '@/core/recipe/ops';
import type { Mask, MaskType, Recipe, RecipeSection, RecipeSettings } from '@/core/recipe/schema';
import { writeIntoFolder } from '@/core/sources/folders';
import type { PhotoItem } from '@/core/sources/types';
import { readSidecar, sidecarName, writeSidecar } from '@/core/xmp/sidecar';
import { getBool, getPreviewDim } from './prefs';

/**
 * The recipe currently on screen, readable from the UI thread. Sliders write here directly
 * while dragging (no JS round trip), then commit to the store on release.
 */
export const liveRecipe = makeMutable<Recipe | null>(null);
/** Render inputs mirrored for UI-thread rendering. */
export const liveInputs = makeMutable<RenderInputs | null>(null);
/** UI-thread texture copies of the blur images, keyed by RenderInputs.gpuKey. */
const gpuCache = makeMutable<{ key: string; blurN: SkImage; blurS: SkImage; blurM: SkImage; blurL: SkImage } | null>(null);

/** Publish render inputs to the UI thread, swapping the blur rasters for GPU textures there. */
function publishInputs(inputs: RenderInputs | null) {
  scheduleOnUI(() => {
    'worklet';
    if (!inputs) {
      gpuCache.set(null);
      liveInputs.set(null);
      return;
    }
    let c = gpuCache.value;
    if (!c || c.key !== inputs.gpuKey) {
      c = {
        key: inputs.gpuKey,
        blurN: toTexture(inputs.blurN),
        blurS: toTexture(inputs.blurS),
        blurM: toTexture(inputs.blurM),
        blurL: toTexture(inputs.blurL),
      };
      gpuCache.set(c);
    }
    liveInputs.set({ ...inputs, blurN: c.blurN, blurS: c.blurS, blurM: c.blurM, blurL: c.blurL });
  });
}

const HISTORY_LIMIT = 100;

export type ToolId =
  | 'presets'
  | 'auto'
  | 'light'
  | 'color'
  | 'curves'
  | 'hsl'
  | 'grading'
  | 'detail'
  | 'optics'
  | 'geometry'
  | 'effects'
  | 'lut'
  | 'masks'
  | 'raw';

interface Clipboard {
  settings: Partial<RecipeSettings>;
  sections: RecipeSection[];
}

interface EditorState {
  item: PhotoItem | null;
  recipe: Recipe | null;
  past: Recipe[];
  future: Recipe[];
  inputs: RenderInputs | null;
  prepared: PreparedSource | null;
  loading: boolean;
  error: string | null;
  histogram: Histogram | null;
  tool: ToolId;
  activeMaskId: string | null;
  maskOverlay: boolean;
  maskBusy: string | null;
  showClipping: boolean;
  compare: 'off' | 'hold' | 'split';
  clipboard: Clipboard | null;
  hasPair: boolean;

  open(item: PhotoItem): Promise<void>;
  close(): void;
  /** Commit a new recipe (pushes history). */
  commit(next: Recipe): void;
  /** Commit through an updater. */
  update(fn: (r: Recipe) => Recipe): void;
  undo(): void;
  redo(): void;
  setTool(t: ToolId): void;
  setCompare(c: EditorState['compare']): void;
  toggleClipping(): void;
  resetAll(): void;
  copy(sections: RecipeSection[]): void;
  paste(): void;
  /** Apply a preset (optionally onto a given base recipe) as one history step. */
  applyPreset(settings: Partial<RecipeSettings>, amount?: number, onto?: Recipe): void;
  auto(): void;
  setUseRaw(useRaw: boolean): Promise<void>;
  addMask(type: MaskType, name: string): Promise<void>;
  updateMask(id: string, fn: (m: Mask) => Mask): void;
  removeMask(id: string): void;
  setActiveMask(id: string | null): void;
  setMaskOverlay(v: boolean): void;
  importLut(uri: string, name: string): Promise<void>;
  renderPreview(maxDim: number): SkImage | null;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Grid thumbnails are rendered + JPEG-encoded on the JS thread, so they wait for a pause in editing. */
let thumbTimer: ReturnType<typeof setTimeout> | null = null;
let histTimer: ReturnType<typeof setTimeout> | null = null;
let openToken = 0;

const rawOptions = (r: Recipe) => ({
  decodeNoise: r.raw.decodeNoise,
  highlightRecovery: r.raw.highlightRecovery,
  lensCorrection: r.raw.lensCorrection,
  boost: r.raw.boost,
});

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Lerp numeric leaves of `to` from `from` for preset amount. */
function blendSettings<T>(from: T, to: T, t: number): T {
  if (typeof to === 'number' && typeof from === 'number') return (from + (to - from) * t) as T;
  if (Array.isArray(to) || to === null || typeof to !== 'object') return t >= 0.5 ? to : from;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(to as object)) {
    out[k] = blendSettings((from as Record<string, unknown>)?.[k], (to as Record<string, unknown>)[k], t);
  }
  return out as T;
}

function loadLutImage(id: string | null): { image: SkImage; size: number } | null {
  if (!id) return null;
  const row = db.getLut(id);
  if (!row) return null;
  try {
    const lut = parseCube(new File(row.path).textSync());
    const strip = cubeToStrip(lut);
    return { image: makeRgbaImage(strip.pixels, strip.width, strip.height), size: lut.size };
  } catch {
    return null;
  }
}

const thumbDir = () => {
  const d = new Directory(Paths.cache, 'thumbs');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
};

export const useEditor = create<EditorState>((set, get) => {
  /** Rebuild GPU resources affected by a recipe change. */
  async function syncResources(prev: Recipe | null, next: Recipe) {
    const s = get();
    const item = s.item;
    let inputs = s.inputs;
    if (!item || !inputs || !s.prepared) return;
    let changed = false;

    const sourceChanged =
      !prev || prev.source.useRaw !== next.source.useRaw || (next.source.useRaw && !sameJson(prev.raw, next.raw));
    if (sourceChanged && prev) {
      const prepared = await loadSource(next.source, getPreviewDim(), rawOptions(next));
      if (get().item?.key !== item.key) return;
      inputs = prepareInputs(prepared, next.detail.sharpenRadius, {
        curve: inputs.curve,
        lut: inputs.lut,
        maskTextures: {},
      });
      set({ prepared });
      changed = true;
      prev = { ...prev, masks: [] }; // force mask textures to rebuild
    }
    if (!prev || !sameJson(prev.curves, next.curves)) {
      inputs = { ...inputs, curve: makeRgbaImage(bakeCurveLut(next.curves), 256, 1) };
      changed = true;
    }
    if (prev && prev.detail.sharpenRadius !== next.detail.sharpenRadius) {
      const src = inputs.source;
      const sg = blurSigmas(src.width(), src.height(), Math.max(s.prepared.fullWidth, s.prepared.fullHeight), next.detail.sharpenRadius);
      inputs = { ...inputs, blurS: blurImage(src, sg.s), gpuKey: nextGpuKey() };
      changed = true;
    }
    if (!prev || prev.lut.id !== next.lut.id) {
      inputs = { ...inputs, lut: loadLutImage(next.lut.id) };
      changed = true;
    }
    // masks: brush textures follow strokes; AI masks are generated once per type
    const textures = { ...inputs.maskTextures };
    const aspect = inputs.frame.width / inputs.frame.height;
    for (const m of next.masks) {
      const old = prev?.masks.find((x) => x.id === m.id);
      if (m.type === 'brush') {
        if (!old || !textures[m.id] || !sameJson(old.strokes, m.strokes)) {
          const img = renderBrushMask(m.strokes, aspect);
          if (img) textures[m.id] = img;
          changed = true;
        }
      } else if (['subject', 'sky', 'background', 'person'].includes(m.type) && !textures[m.id]) {
        set({ maskBusy: m.id });
        try {
          const img = await aiMaskTexture(item.key, next.source, m, inputs.source);
          if (img) textures[m.id] = img;
        } finally {
          set({ maskBusy: null });
        }
        changed = true;
      }
    }
    for (const id of Object.keys(textures)) if (!next.masks.some((m) => m.id === id)) delete textures[id];
    if (changed || Object.keys(textures).length !== Object.keys(inputs.maskTextures).length) {
      inputs = { ...inputs, maskTextures: textures };
      if (get().item?.key !== item.key) return;
      set({ inputs });
      publishInputs(inputs);
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 450);
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(writeThumb, 1800);
    if (histTimer) clearTimeout(histTimer);
    histTimer = setTimeout(updateHistogram, 120);
  }

  function updateHistogram() {
    const img = get().renderPreview(256);
    if (!img) return;
    const px = img.readPixels(0, 0, {
      width: img.width(),
      height: img.height(),
      colorType: ColorType.RGBA_8888,
      alphaType: AlphaType.Unpremul,
    });
    if (px) set({ histogram: computeHistogram(px as Uint8Array) });
  }

  function persist() {
    const { item, recipe } = get();
    if (!item || !recipe) return;
    const edited = isEdited(recipe);
    const hash = recipeHash(recipe);
    db.saveRecipe(item.key, recipe, edited, hash, item.folderId);
    if (item.kind === 'file' && item.dirUri && getBool('writeSidecars', true)) {
      try {
        writeIntoFolder(item.dirUri, sidecarName(item.filename), 'application/rdf+xml', writeSidecar(recipe));
      } catch {
        // read-only folders still keep the recipe in the catalog
      }
    }
    saveTimer = null;
    import('./library').then((m) => m.useLibrary.getState().refreshMeta([item.key]));
  }

  /** Edited thumbnail for the grids. */
  function writeThumb() {
    thumbTimer = null;
    const { item, recipe, inputs } = get();
    if (!item || !recipe || !inputs) return;
    try {
      const edited = isEdited(recipe);
      const thumb = edited ? get().renderPreview(640) : null;
      if (thumb) {
        const f = new File(thumbDir(), `${recipeHash(recipe)}.jpg`);
        if (!f.exists) f.write(thumb.encodeToBytes(ImageFormat.JPEG, 85));
        db.setThumb(item.key, f.uri);
      } else {
        db.setThumb(item.key, null);
      }
      import('./library').then((m) => m.useLibrary.getState().refreshMeta([item.key]));
    } catch {
      // thumbnails are a cache; never block saving
    }
  }

  function flushPending() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      persist();
    }
    if (thumbTimer) {
      clearTimeout(thumbTimer);
      writeThumb();
    }
  }

  return {
    item: null,
    recipe: null,
    past: [],
    future: [],
    inputs: null,
    prepared: null,
    loading: false,
    error: null,
    histogram: null,
    tool: 'light',
    activeMaskId: null,
    maskOverlay: true,
    maskBusy: null,
    showClipping: false,
    compare: 'off',
    clipboard: null,
    hasPair: false,

    async open(item) {
      // swiping to another photo: save the one being left before its state is replaced
      flushPending();
      const token = ++openToken;
      liveRecipe.value = null;
      publishInputs(null);
      set({
        item,
        recipe: null,
        past: [],
        future: [],
        inputs: null,
        prepared: null,
        loading: true,
        error: null,
        histogram: null,
        activeMaskId: null,
        compare: 'off',
      });
      try {
        const { recipe, hasPair } = await resolveRecipe(item);
        const prepared = await loadSource(recipe.source, getPreviewDim(), rawOptions(recipe));
        if (token !== openToken) return;
        const inputs = prepareInputs(prepared, recipe.detail.sharpenRadius, {
          curve: makeRgbaImage(bakeCurveLut(recipe.curves), 256, 1),
          lut: loadLutImage(recipe.lut.id),
          maskTextures: {},
        });
        set({ recipe, inputs, prepared, loading: false, hasPair });
        publishInputs(inputs);
        liveRecipe.value = recipe;
        await syncResources({ ...recipe, masks: [] }, recipe);
        updateHistogram();
      } catch (e) {
        recipeCache.delete(item.key);
        if (token === openToken) set({ loading: false, error: e instanceof Error ? e.message : String(e) });
      }
    },

    close() {
      flushPending();
      openToken++;
      liveRecipe.value = null;
      publishInputs(null);
      set({ item: null, recipe: null, inputs: null, prepared: null, past: [], future: [], histogram: null });
    },

    commit(next) {
      const { recipe: prev, past } = get();
      if (!prev || sameJson(prev, next)) {
        liveRecipe.value = prev;
        return;
      }
      const stamped = { ...next, updatedAt: Date.now() };
      set({ recipe: stamped, past: [...past.slice(-HISTORY_LIMIT + 1), prev], future: [] });
      liveRecipe.value = stamped;
      syncResources(prev, stamped);
      scheduleSave();
    },

    update(fn) {
      const r = get().recipe;
      if (r) get().commit(fn(r));
    },

    undo() {
      const { past, recipe, future } = get();
      if (!past.length || !recipe) return;
      const prev = past[past.length - 1];
      set({ recipe: prev, past: past.slice(0, -1), future: [recipe, ...future] });
      liveRecipe.value = prev;
      syncResources(recipe, prev);
      scheduleSave();
    },

    redo() {
      const { past, recipe, future } = get();
      if (!future.length || !recipe) return;
      const next = future[0];
      set({ recipe: next, past: [...past, recipe], future: future.slice(1) });
      liveRecipe.value = next;
      syncResources(recipe, next);
      scheduleSave();
    },

    setTool: (tool) => set({ tool, activeMaskId: tool === 'masks' ? get().activeMaskId : null }),
    setCompare: (compare) => set({ compare }),
    toggleClipping: () => set({ showClipping: !get().showClipping }),

    resetAll() {
      const r = get().recipe;
      if (!r) return;
      get().commit({ ...createRecipe(r.source), updatedAt: Date.now() });
    },

    copy(sections) {
      const r = get().recipe;
      if (r) set({ clipboard: { settings: pickSections(r, sections), sections } });
    },

    paste() {
      const { clipboard, recipe } = get();
      if (clipboard && recipe) get().commit(applySettings(recipe, clipboard.settings));
    },

    applyPreset(settings, amount = 1, onto) {
      const r = onto ?? get().recipe;
      if (!r) return;
      let s = settings;
      if (amount !== 1) {
        const blended: Partial<RecipeSettings> = {};
        for (const k of Object.keys(settings) as RecipeSection[]) {
          (blended as Record<string, unknown>)[k] = blendSettings(r[k], settings[k], amount);
        }
        s = blended;
      }
      get().commit(applySettings(r, s));
    },

    auto() {
      const { recipe, inputs } = get();
      if (!recipe || !inputs) return;
      // analyze the unadjusted source
      const small = resizeImage(inputs.source, 320);
      const px = small.readPixels(0, 0, {
        width: small.width(),
        height: small.height(),
        colorType: ColorType.RGBA_8888,
        alphaType: AlphaType.Unpremul,
      });
      if (!px) return;
      const hist = computeHistogram(px as Uint8Array);
      const light = autoTone(hist);
      const wb = autoWhiteBalance(px as Uint8Array);
      get().commit({
        ...recipe,
        light,
        color: { ...recipe.color, ...wb, vibrance: Math.max(recipe.color.vibrance, 10) },
      });
    },

    async setUseRaw(useRaw) {
      const r = get().recipe;
      if (!r || r.source.useRaw === useRaw) return;
      evictSource(r.source);
      get().commit({ ...r, source: { ...r.source, useRaw } });
    },

    async addMask(type, name) {
      const r = get().recipe;
      if (!r) return;
      const m = createMask(type, name);
      set({ activeMaskId: m.id });
      get().commit({ ...r, masks: [...r.masks, m] });
    },

    updateMask(id, fn) {
      get().update((r) => ({ ...r, masks: r.masks.map((m) => (m.id === id ? fn(m) : m)) }));
    },

    removeMask(id) {
      get().update((r) => ({ ...r, masks: r.masks.filter((m) => m.id !== id) }));
      if (get().activeMaskId === id) set({ activeMaskId: null });
    },

    setActiveMask: (activeMaskId) => set({ activeMaskId }),
    setMaskOverlay: (maskOverlay) => set({ maskOverlay }),

    async importLut(uri, name) {
      const text = await new File(uri).text();
      const lut = parseCube(text);
      const dir = new Directory(Paths.document, 'luts');
      if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
      const id = db.newId();
      const dest = new File(dir, `${id}.cube`);
      dest.write(text);
      db.addLut({ id, name: lut.title !== 'LUT' ? lut.title : name.replace(/\.cube$/i, ''), size: lut.size, path: dest.uri });
      get().update((r) => ({ ...r, lut: { id, name: name.replace(/\.cube$/i, ''), intensity: 100 } }));
    },

    renderPreview(maxDim) {
      const { inputs, recipe } = get();
      if (!inputs || !recipe) return null;
      const long = Math.max(inputs.frame.width, inputs.frame.height);
      return renderToImage(inputs, recipe, Math.min(1, maxDim / long));
    },
  };
});

/** Recipes resolved by `prefetch`, reused by the next `open` of that photo. */
const recipeCache = new Map<string, { recipe: Recipe; hasPair: boolean }>();

/** The stored (catalog, Photos adjustment or sidecar) recipe for a photo, or a fresh one. */
async function resolveRecipe(item: PhotoItem): Promise<{ recipe: Recipe; hasPair: boolean }> {
  const cached = recipeCache.get(item.key);
  if (cached) {
    // the catalog wins if the photo was edited since it was prefetched
    const stored = db.loadRecipe(item.key);
    recipeCache.delete(item.key);
    return stored ? { recipe: stored, hasPair: cached.hasPair } : cached;
  }
  let hasPair = !!item.pair;
  let isRaw = item.isRaw;
  // iOS RAW+JPEG captures are a single asset with two resources
  if (item.kind === 'library') {
    const res = await assetResources(item.id);
    if (res?.hasRaw && res.hasPhoto) hasPair = true;
    else if (res?.hasRaw) isRaw = true;
  }
  let recipe = db.loadRecipe(item.key);
  if (!recipe && item.kind === 'library') {
    const json = await readLibraryAdjustment(item.id);
    if (json) {
      const { migrateRecipe } = await import('@/core/recipe/ops');
      recipe = migrateRecipe(JSON.parse(json));
    }
  }
  if (!recipe && item.kind === 'file' && item.dirUri) {
    recipe = recipeFromSidecar(item);
  }
  if (!recipe) {
    recipe = createRecipe({
      kind: item.kind,
      id: item.id,
      uri: item.uri,
      filename: item.filename,
      pairedUri: item.pair?.uri ?? (hasPair ? item.id : null),
      useRaw: isRaw || (hasPair && getBool('rawDefault', true)),
      isRaw,
    });
  }
  return { recipe, hasPair };
}

/**
 * Decode a photo's preview ahead of time (the neighbours of the open photo) so swiping to it
 * shows the image immediately. Runs one at a time and never evicts the open photo.
 */
let prefetchChain: Promise<void> = Promise.resolve();
export function prefetchPhoto(item: PhotoItem) {
  prefetchChain = prefetchChain.then(async () => {
    try {
      if (useEditor.getState().item?.key === item.key) return;
      const resolved = await resolveRecipe(item);
      const { recipe } = resolved;
      recipeCache.set(item.key, resolved);
      if (recipeCache.size > 4) recipeCache.delete(recipeCache.keys().next().value!);
      if (hasSource(recipe.source, getPreviewDim(), rawOptions(recipe))) return;
      await loadSource(recipe.source, getPreviewDim(), rawOptions(recipe));
    } catch {
      recipeCache.delete(item.key);
    }
  });
}

function recipeFromSidecar(item: PhotoItem): Recipe | null {
  try {
    const dir = new Directory(item.dirUri!);
    const name = sidecarName(item.filename).toLowerCase();
    const f = dir.list().find((e) => !(e instanceof Directory) && e.name.toLowerCase() === name) as File | undefined;
    if (!f) return null;
    const data = readSidecar(f.textSync());
    if (data.recipe) return { ...data.recipe, source: { ...data.recipe.source, id: item.id, uri: item.uri } };
    if (Object.keys(data.crs).length) {
      const r = createRecipe({
        kind: 'file',
        id: item.id,
        uri: item.uri,
        filename: item.filename,
        pairedUri: item.pair?.uri ?? null,
        useRaw: item.isRaw || !!item.pair,
        isRaw: item.isRaw,
      });
      const c = data.crs;
      r.light = {
        exposure: c.exposure ?? 0,
        contrast: c.contrast ?? 0,
        highlights: c.highlights ?? 0,
        shadows: c.shadows ?? 0,
        whites: c.whites ?? 0,
        blacks: c.blacks ?? 0,
      };
      r.detail = { ...r.detail, clarity: c.clarity ?? 0, dehaze: c.dehaze ?? 0, texture: c.texture ?? 0 };
      r.color = { ...r.color, vibrance: c.vibrance ?? 0, saturation: c.saturation ?? 0 };
      return r;
    }
  } catch {
    // unreadable sidecar → start fresh
  }
  return null;
}
