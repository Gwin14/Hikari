import { bakeCurveLut, buildSpline } from '@/core/color/curve';
import { cubeToStrip, parseCube } from '@/core/color/cube';
import { createRecipe, defaultSettings } from '@/core/recipe/defaults';
import { applySettings, isEdited, migrateRecipe, pickSections, recipeHash } from '@/core/recipe/ops';
import { getIn, setIn } from '@/core/recipe/path';
import type { SourceRef } from '@/core/recipe/schema';

const src: SourceRef = { kind: 'file', id: 'f', uri: 'file:///a.jpg', filename: 'a.jpg', pairedUri: null, useRaw: false, isRaw: false };

describe('recipe', () => {
  it('starts unedited and detects edits', () => {
    const r = createRecipe(src);
    expect(isEdited(r)).toBe(false);
    expect(isEdited({ ...r, light: { ...r.light, exposure: 0.5 } })).toBe(true);
  });

  it('gives RAW sources capture sharpening and color NR', () => {
    const r = createRecipe({ ...src, isRaw: true, useRaw: true, filename: 'a.cr3' });
    expect(r.detail.sharpenAmount).toBeGreaterThan(0);
    expect(r.detail.noiseColor).toBeGreaterThan(0);
  });

  it('migrates partial/old recipes by filling defaults', () => {
    const m = migrateRecipe({ source: src, light: { exposure: 1.5 }, unknown: 1 });
    expect(m).not.toBeNull();
    expect(m!.light.exposure).toBe(1.5);
    expect(m!.light.contrast).toBe(0);
    expect(m!.curves.rgb).toHaveLength(2);
    expect(m!.hsl.blue).toEqual({ hue: 0, sat: 0, lum: 0 });
    expect(migrateRecipe(null)).toBeNull();
    expect(migrateRecipe({})).toBeNull();
  });

  it('copies selected sections and keeps the target crop', () => {
    const a = createRecipe(src);
    a.light.exposure = 1;
    a.color.temperature = 30;
    a.geometry.crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
    const b = createRecipe({ ...src, id: 'g' });
    const pasted = applySettings(b, pickSections(a, ['light', 'geometry']));
    expect(pasted.light.exposure).toBe(1);
    expect(pasted.color.temperature).toBe(0);
    expect(pasted.geometry.crop).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(pasted.source.id).toBe('g');
  });

  it('hashes only render-affecting state', () => {
    const a = createRecipe(src);
    const b = { ...a, updatedAt: a.updatedAt + 1000 };
    expect(recipeHash(a)).toBe(recipeHash(b));
    expect(recipeHash(a)).not.toBe(recipeHash({ ...a, light: { ...a.light, blacks: -5 } }));
  });

  it('sets nested values immutably', () => {
    const r = createRecipe(src);
    const next = setIn(r, ['hsl', 'blue', 'sat'], -40);
    expect(getIn(next, ['hsl', 'blue', 'sat'])).toBe(-40);
    expect(r.hsl.blue.sat).toBe(0);
    expect(next.hsl.red).toBe(r.hsl.red);
    const masks = setIn({ masks: [{ a: 1 }, { a: 2 }] }, ['masks', 1, 'a'], 5);
    expect(masks.masks).toEqual([{ a: 1 }, { a: 5 }]);
  });

  it('default settings are independent objects', () => {
    const a = defaultSettings();
    a.hsl.red.hue = 10;
    expect(defaultSettings().hsl.red.hue).toBe(0);
  });
});

describe('curves', () => {
  it('interpolates through control points without overshoot', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 0.25, y: 0.1 },
      { x: 0.5, y: 0.5 },
      { x: 0.75, y: 0.9 },
      { x: 1, y: 1 },
    ];
    const f = buildSpline(pts);
    for (const p of pts) expect(f(p.x)).toBeCloseTo(p.y, 6);
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = f(i / 100);
      expect(v).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      prev = v;
    }
  });

  it('bakes an identity LUT for identity curves', () => {
    const id = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    const lut = bakeCurveLut({ rgb: id, r: id, g: id, b: id });
    for (let i = 0; i < 256; i++) {
      expect(lut[i * 4]).toBe(i);
      expect(lut[i * 4 + 1]).toBe(i);
      expect(lut[i * 4 + 2]).toBe(i);
    }
  });

  it('composes master then channel curve', () => {
    const id = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];
    const inv = [
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ];
    const lut = bakeCurveLut({ rgb: inv, r: inv, g: id, b: id });
    expect(lut[0]).toBe(0); // inverted twice
    expect(lut[1]).toBe(255);
  });
});

describe('.cube LUTs', () => {
  const identity = (n: number) => {
    const lines = ['TITLE "Identity"', `LUT_3D_SIZE ${n}`];
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) lines.push(`${r / (n - 1)} ${g / (n - 1)} ${b / (n - 1)}`);
    return lines.join('\n');
  };

  it('parses and lays out slices by blue', () => {
    const lut = parseCube(identity(4));
    expect(lut.title).toBe('Identity');
    expect(lut.size).toBe(4);
    const strip = cubeToStrip(lut);
    expect(strip.width).toBe(16);
    expect(strip.height).toBe(4);
    // texel (x = b*n + r, y = g) holds (r, g, b)
    const at = (r: number, g: number, b: number) => {
      const i = (g * strip.width + b * 4 + r) * 4;
      return [strip.pixels[i], strip.pixels[i + 1], strip.pixels[i + 2]];
    };
    expect(at(3, 0, 0)).toEqual([255, 0, 0]);
    expect(at(0, 3, 0)).toEqual([0, 255, 0]);
    expect(at(0, 0, 3)).toEqual([0, 0, 255]);
    expect(at(1, 2, 3)).toEqual([85, 170, 255]);
  });

  it('rejects malformed files', () => {
    expect(() => parseCube('LUT_1D_SIZE 4')).toThrow();
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow();
  });
});
