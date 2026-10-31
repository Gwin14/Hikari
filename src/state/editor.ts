import { AlphaType, ColorType, ImageFormat, type SkImage } from '@shopify/react-native-skia';
import { Directory, File, Paths } from 'expo-file-system';
import { assetResources, readLibraryAdjustment } from 'hikari-native';
import { makeMutable } from 'react-native-reanimated';
import { scheduleOnUI } from 'react-native-worklets';
import { create } from 'zustand';

import { autoTone, autoWhiteBalance, computeHistogram, type Histogram } from '@/core/auto/analysis';
import { bakeCurveLut } from '@/core/color/curve';
import { komorebiStartingLook } from '@/core/companion/komorebi';
import { cubeToStrip, parseCube } from '@/core/color/cube';
import * as db from '@/core/db/db';
import { evictSource, hasSource, loadSource } from '@/core/image/load';
import { composeMask, isAiMask, maskBase, maskBaseKey, peekMaskBase, renderBrushMask } from '@/core/pipeline/masks';
import {
  makeRgbaImage,
  prepareInputs,
  rebuildBlurS,
  toTexture,
  renderToImage,
  resizeImage,
  type PreparedSource,
  type RenderInputs,
} from '@/core/pipeline/render';
import { createMask, createRecipe } from '@/core/recipe/defaults';
import { applySettings, isEdited, pickSections, recipeHash } from '@/core/recipe/ops';
import type { BrushStroke, Mask, MaskType, Recipe, RecipeSection, RecipeSettings, RetouchSpot } from '@/core/recipe/schema';
import { recipeFromVersion } from '@/core/recipe/versions';
import { buildRetouch } from '@/core/retouch/remove';
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
  | 'retouch'
  | 'raw'
  | 'versions';

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
  /** AI masks whose detection found nothing (or failed); not retried until the photo reopens. */
  maskFailed: string[];
  /** Painting add / subtract refinements on an AI mask (instead of panning the photo). */
  maskBrushing: boolean;
  /** Object removals being computed. */
  retouchBusy: boolean;
  /** New removals grow to the whole detected object under the strokes. */
  removeObjects: boolean;
  showClipping: boolean;
  compare: 'off' | 'hold' | 'split';
  clipboard: Clipboard | null;
  hasPair: boolean;
  /** Saved versions of the open photo, newest first. */
  versions: db.PhotoVersion[];

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
  setMaskBrushing(v: boolean): void;
  /** Adds one removal from a brush stroke. */
  addRetouch(stroke: BrushStroke): void;
  removeRetouch(id: string): void;
  clearRetouch(): void;
  setRemoveObjects(v: boolean): void;
  importLut(uri: string, name: string): Promise<void>;
  renderPreview(maxDim: number): SkImage | null;
  /** Save the current settings as a new named version. */
  createVersion(name: string): void;
  /** Load a version's settings as one (undoable) history step. */
  applyVersion(id: string): void;
  /** Overwrite a version with the current settings. */
  updateVersion(id: string): void;
  renameVersion(id: string, name: string): void;
  deleteVersion(id: string): void;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** Grid thumbnails are rendered + JPEG-encoded on the JS thread, so they wait for a pause in editing. */
let thumbTimer: ReturnType<typeof setTimeout> | null = null;
let histTimer: ReturnType<typeof setTimeout> | null = null;
/** AI mask detections in flight: detection key → mask id. */
const pendingAi = new Map<string, string>();
let openToken = 0;
/** Latest removal computation; older ones are dropped when they land. */
let retouchSeq = 0;
let spotSeq = 0;

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

/** Version thumbnails are kept with the documents: unlike grid thumbs they can't be re-rendered without opening each version. */
const versionDir = () => {
  const d = new Directory(Paths.document, 'versions');
  if (!d.exists) d.create({ intermediates: true, idempotent: true });
  return d;
};

function deleteFileUri(uri: string | null) {
  if (!uri) return;
  try {
    const f = new File(uri);
    if (f.exists) f.delete();
  } catch {
    // a missing thumbnail only shows a placeholder
  }
}

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
        retouch: [],
      });
      set({ prepared });
      changed = true;
      prev = { ...prev, masks: [], retouch: [] }; // force mask textures and removals to rebuild
    }
    if (!prev || !sameJson(prev.curves, next.curves)) {
      inputs = { ...inputs, curve: makeRgbaImage(bakeCurveLut(next.curves), 256, 1) };
      changed = true;
    }
    if (prev && prev.detail.sharpenRadius !== next.detail.sharpenRadius) {
      inputs = rebuildBlurS(inputs, Math.max(s.prepared.fullWidth, s.prepared.fullHeight), next.detail.sharpenRadius);
      changed = true;
    }
    if (!prev || prev.lut.id !== next.lut.id) {
      inputs = { ...inputs, lut: loadLutImage(next.lut.id) };
      changed = true;
    }
    // masks: brush textures follow strokes; AI detections are computed once and refined with strokes
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
      } else if (isAiMask(m)) {
        if (m.type === 'object' && !m.strokes.some((x) => !x.erase)) {
          delete textures[m.id];
          continue;
        }
        const base = peekMaskBase(maskBaseKey(item.key, next.source, m));
        if (base) {
          if (!old || !textures[m.id] || !sameJson(old.strokes, m.strokes)) {
            textures[m.id] = composeMask(m, base);
            changed = true;
          }
        } else if (m.type === 'object' || !get().maskFailed.includes(m.id)) {
          // runs in the background so edits made meanwhile aren't overwritten when it lands
          generateAiMask(item.key, next, m, inputs.source);
        }
      }
    }
    for (const id of Object.keys(textures)) if (!next.masks.some((m) => m.id === id)) delete textures[id];
    if (changed || Object.keys(textures).length !== Object.keys(inputs.maskTextures).length) {
      inputs = { ...inputs, maskTextures: textures };
      if (get().item?.key !== item.key) return;
      set({ inputs });
      publishInputs(inputs);
    }
    if (!prev || !sameJson(prev.retouch, next.retouch)) applyRetouch(item.key, next);
  }

  /** Solves the removals in the background, then rebuilds the source-derived inputs around them. */
  async function applyRetouch(itemKey: string, recipe: Recipe) {
    const seq = ++retouchSeq;
    const s = get();
    if (!s.inputs || !s.prepared) return;
    const prepared = s.prepared;
    set({ retouchBusy: recipe.retouch.length > 0 });
    let patches: RenderInputs['retouch'] = [];
    try {
      if (recipe.retouch.length) patches = await buildRetouch(itemKey, recipe.source, prepared.source, recipe.retouch);
    } catch (e) {
      console.warn('Removal failed', e);
    }
    const now = get();
    if (seq !== retouchSeq) return;
    set({ retouchBusy: false });
    if (now.item?.key !== itemKey || !now.inputs || now.prepared !== prepared || !now.recipe) return;
    if (!patches.length && !now.inputs.retouch.length) return;
    const inputs = {
      ...prepareInputs(prepared, now.recipe.detail.sharpenRadius, {
        curve: now.inputs.curve,
        lut: now.inputs.lut,
        maskTextures: now.inputs.maskTextures,
        retouch: patches,
      }),
    };
    set({ inputs });
    publishInputs(inputs);
    scheduleSave();
  }

  /** Detects an AI mask once (however many edits arrive meanwhile) and merges it into the current inputs. */
  async function generateAiMask(itemKey: string, recipe: Recipe, m: Mask, proxy: SkImage) {
    const key = maskBaseKey(itemKey, recipe.source, m);
    if (pendingAi.has(key)) return;
    pendingAi.set(key, m.id);
    set({ maskBusy: m.id });
    let img: SkImage | null = null;
    try {
      img = await maskBase(itemKey, recipe.source, m, proxy);
    } catch (e) {
      console.warn('AI mask failed', e);
    } finally {
      pendingAi.delete(key);
      if (get().maskBusy === m.id && ![...pendingAi.values()].includes(m.id)) set({ maskBusy: null });
    }
    const s = get();
    if (s.item?.key !== itemKey || !s.inputs || !s.recipe) return;
    // only the detection the mask currently asks for lands (object selections change with strokes)
    const cur = s.recipe.masks.find((x) => x.id === m.id);
    if (!cur || maskBaseKey(itemKey, s.recipe.source, cur) !== key) return;
    if (!img) {
      if (cur.type !== 'object') set({ maskFailed: [...s.maskFailed, m.id] });
      return;
    }
    const inputs = { ...s.inputs, maskTextures: { ...s.inputs.maskTextures, [m.id]: composeMask(cur, img) } };
    set({ inputs });
    publishInputs(inputs);
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

  /** Small thumbnail of what's on screen for the versions list (the name carries the hash so updates bust image caches). */
  function writeVersionThumb(id: string): string | null {
    const { recipe } = get();
    if (!recipe) return null;
    try {
      const img = get().renderPreview(320);
      if (!img) return null;
      const f = new File(versionDir(), `${id}-${recipeHash(recipe)}.jpg`);
      if (!f.exists) f.write(img.encodeToBytes(ImageFormat.JPEG, 80));
      return f.uri;
    } catch {
      return null;
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
    maskFailed: [],
    maskBrushing: false,
    retouchBusy: false,
    removeObjects: true,
    showClipping: false,
    compare: 'off',
    clipboard: null,
    hasPair: false,
    versions: [],

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
        maskFailed: [],
        maskBrushing: false,
        retouchBusy: false,
        compare: 'off',
        versions: db.listVersions(item.key),
      });
      try {
        const { recipe, hasPair } = await resolveRecipe(item);
        const prepared = await loadSource(recipe.source, getPreviewDim(), rawOptions(recipe));
        if (token !== openToken) return;
        const inputs = prepareInputs(prepared, recipe.detail.sharpenRadius, {
          curve: makeRgbaImage(bakeCurveLut(recipe.curves), 256, 1),
          lut: loadLutImage(recipe.lut.id),
          maskTextures: {},
          retouch: [],
        });
        set({ recipe, inputs, prepared, loading: false, hasPair });
        publishInputs(inputs);
        liveRecipe.value = recipe;
        await syncResources({ ...recipe, masks: [], retouch: [] }, recipe);
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
      set({ item: null, recipe: null, inputs: null, prepared: null, past: [], future: [], histogram: null, versions: [] });
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

    setTool: (tool) => set({ tool, activeMaskId: tool === 'masks' ? get().activeMaskId : null, maskBrushing: false }),
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

    setActiveMask: (activeMaskId) => set({ activeMaskId, maskBrushing: false }),
    setMaskOverlay: (maskOverlay) => set({ maskOverlay }),
    setMaskBrushing: (maskBrushing) => set({ maskBrushing }),

    addRetouch(stroke) {
      const r = get().recipe;
      if (!r) return;
      spotSeq += 1;
      const spot: RetouchSpot = { id: `r${Date.now().toString(36)}${spotSeq}`, strokes: [stroke], objectAware: get().removeObjects };
      get().commit({ ...r, retouch: [...r.retouch, spot] });
    },

    removeRetouch(id) {
      get().update((r) => ({ ...r, retouch: r.retouch.filter((x) => x.id !== id) }));
    },

    clearRetouch() {
      get().update((r) => ({ ...r, retouch: [] }));
    },

    setRemoveObjects: (removeObjects) => set({ removeObjects }),

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

    createVersion(name) {
      const { item, recipe, versions } = get();
      if (!item || !recipe) return;
      const id = db.newId();
      const v: db.PhotoVersion = { id, name, recipe, thumb: writeVersionThumb(id), createdAt: Date.now() };
      db.addVersion(item.key, v);
      set({ versions: [v, ...versions] });
    },

    applyVersion(id) {
      const { recipe, versions, activeMaskId } = get();
      const v = versions.find((x) => x.id === id);
      if (!recipe || !v) return;
      const next = recipeFromVersion(v.recipe, recipe);
      if (next.source.useRaw !== recipe.source.useRaw) evictSource(recipe.source);
      if (activeMaskId && !next.masks.some((m) => m.id === activeMaskId)) set({ activeMaskId: null });
      get().commit(next);
    },

    updateVersion(id) {
      const { recipe, versions } = get();
      const v = versions.find((x) => x.id === id);
      if (!recipe || !v) return;
      const thumb = writeVersionThumb(id);
      if (thumb !== v.thumb) deleteFileUri(v.thumb);
      db.updateVersion(id, { recipe, thumb });
      set({ versions: versions.map((x) => (x.id === id ? { ...x, recipe, thumb } : x)) });
    },

    renameVersion(id, name) {
      db.updateVersion(id, { name });
      set({ versions: get().versions.map((x) => (x.id === id ? { ...x, name } : x)) });
    },

    deleteVersion(id) {
      const v = get().versions.find((x) => x.id === id);
      if (!v) return;
      db.deleteVersion(id);
      deleteFileUri(v.thumb);
      set({ versions: get().versions.filter((x) => x.id !== id) });
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
    // a Komorebi capture starts from the look it was shot with (LUT and effects, all editable)
    if (item.kind === 'library') {
      const look = await komorebiStartingLook(item.id, recipe.source.useRaw || recipe.source.isRaw);
      if (look) recipe = { ...recipe, lut: look.lut ?? recipe.lut, effects: { ...recipe.effects, ...look.effects } };
    }
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
      return applySettings(r, data.crs, false);
    }
  } catch {
    // unreadable sidecar → start fresh
  }
  return null;
}
