import { autoTone, autoWhiteBalance, computeHistogram, skyMask } from '@/core/auto/analysis';
import { pairItems } from '@/core/sources/pairing';
import type { PhotoItem } from '@/core/sources/types';
import { expandFilename, outputSize } from '@/core/export/options';
import { apply, geometryMatrix, invert, rotatedSize } from '@/core/pipeline/geometry';
import { readSidecar, sidecarName, writeSidecar } from '@/core/xmp/sidecar';
import { createRecipe, defaultSettings } from '@/core/recipe/defaults';

jest.mock('hikari-native', () => ({
  isRawName: (n: string) => /\.(cr3|nef|arw|dng|raf)$/i.test(n),
}));

function solid(w: number, h: number, rgb: [number, number, number]) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px.set([...rgb, 255], i * 4);
  return px;
}

describe('auto adjustments', () => {
  it('brightens a dark image and darkens a bright one', () => {
    const dark = autoTone(computeHistogram(solid(32, 32, [30, 30, 30])));
    const bright = autoTone(computeHistogram(solid(32, 32, [235, 235, 235])));
    expect(dark.exposure).toBeGreaterThan(0.5);
    expect(bright.exposure).toBeLessThan(0);
  });

  it('warms a blue cast and neutralizes a green cast', () => {
    expect(autoWhiteBalance(solid(32, 32, [110, 125, 160])).temperature).toBeGreaterThan(10);
    expect(autoWhiteBalance(solid(32, 32, [130, 165, 130])).tint).toBeGreaterThan(10);
    const neutral = autoWhiteBalance(solid(32, 32, [128, 128, 128]));
    expect(Math.abs(neutral.temperature)).toBeLessThan(2);
    expect(Math.abs(neutral.tint)).toBeLessThan(2);
  });

  it('flags clipping in the histogram', () => {
    const h = computeHistogram(solid(8, 8, [255, 255, 255]));
    expect(h.clipHigh).toBe(1);
    expect(h.total).toBe(64);
  });

  it('finds a blue sky above a dark textured ground', () => {
    const w = 40;
    const h = 30;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (y < 15) px.set([110, 160, 235, 255], i);
        else px.set((x + y) % 2 ? [40, 60, 30, 255] : [90, 80, 50, 255], i);
      }
    const m = skyMask(px, w, h);
    expect(m[5 * w + 20]).toBeGreaterThan(150);
    expect(m[25 * w + 20]).toBeLessThan(30);
  });
});

describe('RAW+JPEG pairing', () => {
  const item = (name: string): PhotoItem => ({
    key: `file:${name}`,
    kind: 'file',
    id: name,
    thumbUri: name,
    uri: name,
    filename: name,
    width: 0,
    height: 0,
    createdAt: 0,
    isRaw: /\.(cr3|nef)$/i.test(name),
    isFavorite: false,
    pair: null,
    folderId: 'f',
    dirUri: 'dir',
  });

  it('merges same-name RAW and JPEG into one item, keeping order', () => {
    const out = pairItems([item('IMG_1.CR3'), item('IMG_1.JPG'), item('IMG_2.JPG'), item('DSC_3.NEF')]);
    expect(out.map((o) => o.filename)).toEqual(['IMG_1.JPG', 'IMG_2.JPG', 'DSC_3.NEF']);
    expect(out[0].pair).toEqual({ uri: 'IMG_1.CR3', filename: 'IMG_1.CR3', isRaw: true });
    expect(out[1].pair).toBeNull();
  });
});

describe('export options', () => {
  it('computes sizes without upscaling', () => {
    expect(outputSize(6000, 4000, 'long', 2048)).toEqual({ width: 2048, height: 1365 });
    expect(outputSize(6000, 4000, 'short', 1080)).toEqual({ width: 1620, height: 1080 });
    expect(outputSize(6000, 4000, 'percent', 50)).toEqual({ width: 3000, height: 2000 });
    expect(outputSize(1000, 500, 'long', 4000)).toEqual({ width: 1000, height: 500 });
    const mp = outputSize(6000, 4000, 'megapixels', 6);
    expect(Math.abs(mp.width * mp.height - 6e6)).toBeLessThan(10000);
  });

  it('expands filename templates safely', () => {
    const d = new Date(2026, 9, 29, 8, 5, 3);
    expect(expandFilename('{name}_{date}_{seq}', { name: 'IMG_0001.CR3', date: d, seq: 7 })).toBe('IMG_0001_2026-10-29_007');
    expect(expandFilename('a/b:{name}', { name: 'x.jpg', date: d, seq: 1 })).toBe('a_b_x');
    expect(expandFilename('', { name: 'x.jpg', date: d, seq: 1 })).toBe('x');
  });
});

describe('geometry', () => {
  it('identity geometry maps pixels to themselves', () => {
    const g = geometryMatrix(defaultSettings().geometry, 400, 300);
    expect(g.outW).toBe(400);
    expect(g.outH).toBe(300);
    expect(apply(g.matrix, 10, 20)).toEqual([10, 20]);
  });

  it('quarter turns swap the frame and keep corners inside', () => {
    const geo = { ...defaultSettings().geometry, rotate90: 1 as const };
    const g = geometryMatrix(geo, 400, 300);
    expect([g.outW, g.outH]).toEqual(rotatedSize(400, 300, 1));
    const [x, y] = apply(g.matrix, 0, 0); // top-left goes to top-right after a clockwise turn
    expect(x).toBeCloseTo(300);
    expect(y).toBeCloseTo(0);
  });

  it('crop + straighten round-trips through the inverse', () => {
    const geo = { ...defaultSettings().geometry, straighten: 7, crop: { x: 0.1, y: 0.2, w: 0.5, h: 0.6 } };
    const g = geometryMatrix(geo, 1200, 800);
    const inv = invert(g.matrix);
    const [ix, iy] = apply(inv, ...apply(g.matrix, 333, 444));
    expect(ix).toBeCloseTo(333, 6);
    expect(iy).toBeCloseTo(444, 6);
    expect(g.outW).toBeCloseTo(600);
    expect(g.outH).toBeCloseTo(480);
    // straightened output corners must sample inside the image (auto cover-scale)
    for (const [ox, oy] of [[0, 0], [g.outW, 0], [0, g.outH], [g.outW, g.outH]]) {
      const [px, py] = apply(inv, ox, oy);
      expect(px).toBeGreaterThanOrEqual(-1e-6);
      expect(py).toBeGreaterThanOrEqual(-1e-6);
      expect(px).toBeLessThanOrEqual(1200 + 1e-6);
      expect(py).toBeLessThanOrEqual(800 + 1e-6);
    }
  });
});

describe('XMP sidecars', () => {
  it('round-trips the full recipe and exposes Camera Raw values', () => {
    const r = createRecipe({ kind: 'file', id: 'x', uri: 'file:///IMG.CR3', filename: 'IMG.CR3', pairedUri: null, useRaw: true, isRaw: true });
    r.light.exposure = 0.75;
    r.light.shadows = 40;
    r.hsl.blue.sat = -30;
    r.masks = [];
    const xml = writeSidecar(r, 4);
    expect(xml).toContain('crs:Exposure2012="+0.75"');
    expect(xml).toContain('crs:SaturationAdjustmentBlue="-30"');
    const back = readSidecar(xml);
    expect(back.rating).toBe(4);
    expect(back.recipe?.light).toEqual(r.light);
    expect(back.recipe?.hsl.blue.sat).toBe(-30);
    expect(sidecarName('IMG_0001.CR3')).toBe('IMG_0001.xmp');
  });

  it('reads basic settings from a Lightroom sidecar', () => {
    const lr = '<x:xmpmeta><rdf:Description crs:Exposure2012="-0.50" crs:Contrast2012="+12" crs:Vibrance="8" xmp:Rating="3"/></x:xmpmeta>';
    const d = readSidecar(lr);
    expect(d.recipe).toBeNull();
    expect(d.crs).toEqual({ exposure: -0.5, contrast: 12, vibrance: 8 });
    expect(d.rating).toBe(3);
  });
});
