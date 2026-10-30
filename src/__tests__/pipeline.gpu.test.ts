/**
 * @jest-environment node
 *
 * Renders the real SkSL pipeline with CanvasKit (same SkSL compiler as react-native-skia)
 * and checks known input → output values.
 */
import { identityStrip, parseCube, stripToCube } from '@/core/color/cube';
import { bakeCurveLut } from '@/core/color/curve';
import { createMask, createRecipe } from '@/core/recipe/defaults';
import type { Recipe } from '@/core/recipe/schema';
import { DEVELOP_SKSL, FINISH_SKSL, LOCAL_SKSL } from '@/core/pipeline/shaders';
import { developUniforms, finishUniforms, localUniforms, packUniforms, type UniformLayout } from '@/core/pipeline/uniforms';

/* eslint-disable @typescript-eslint/no-require-imports */
const CanvasKitInit = require('canvaskit-wasm/bin/full/canvaskit.js');
const resolveModule = (require as unknown as { resolve(p: string): string }).resolve;
let CK: any;
const W = 64;
const H = 16;

function layout(effect: any): UniformLayout {
  const raw: { name: string; slot: number }[] = [];
  for (let i = 0; i < effect.getUniformCount(); i++) raw.push({ name: effect.getUniformName(i), slot: effect.getUniform(i).slot });
  raw.sort((a, b) => a.slot - b.slot);
  const floats = effect.getUniformFloatCount();
  return { floats, entries: raw.map((u, i) => ({ ...u, size: (i + 1 < raw.length ? raw[i + 1].slot : floats) - u.slot })) };
}

let programs: Record<'develop' | 'local' | 'finish', { effect: any; layout: UniformLayout }>;

beforeAll(async () => {
  CK = await CanvasKitInit({ locateFile: (f: string) => resolveModule('canvaskit-wasm/bin/full/' + f) });
  const make = (src: string) => {
    let err = '';
    const effect = CK.RuntimeEffect.Make(src, (e: string) => (err += e));
    if (!effect) throw new Error(err);
    return { effect, layout: layout(effect) };
  };
  programs = { develop: make(DEVELOP_SKSL), local: make(LOCAL_SKSL), finish: make(FINISH_SKSL) };
});

function image(pixels: Uint8Array, w: number, h: number) {
  return CK.MakeImage(
    { width: w, height: h, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB },
    pixels,
    w * 4,
  );
}
const shaderOf = (img: any) => img.makeShaderOptions(CK.TileMode.Clamp, CK.TileMode.Clamp, CK.FilterMode.Linear, CK.MipmapMode.None);

/** Horizontal grey ramp 0..255 with a red/green/blue band in the last rows. */
function testImage() {
  const px = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = Math.round((x / (W - 1)) * 255);
      const i = (y * W + x) * 4;
      if (y < 12) px.set([v, v, v, 255], i);
      else if (y < 13) px.set([200, 60, 50, 255], i);
      else if (y < 14) px.set([60, 180, 70, 255], i);
      else px.set([50, 80, 210, 255], i);
    }
  return px;
}

function render(r: Recipe, opts: { outMode?: number; maskTex?: Uint8Array } = {}): Uint8Array {
  const src = testImage();
  const srcSh = shaderOf(image(src, W, H));
  const curve = shaderOf(image(bakeCurveLut(r.curves), 256, 1));
  const frame = { width: W, height: H, isRaw: false };
  let sh = programs.develop.effect.makeShaderWithChildren(packUniforms(programs.develop.layout, developUniforms(r, frame)), [
    srcSh, srcSh, srcSh, srcSh, curve,
  ]);
  for (const m of r.masks) {
    const tex = opts.maskTex ? shaderOf(image(opts.maskTex, W, H)) : srcSh;
    sh = programs.local.effect.makeShaderWithChildren(packUniforms(programs.local.layout, localUniforms(m, frame, false)), [sh, tex, srcSh, srcSh]);
  }
  sh = programs.finish.effect.makeShaderWithChildren(
    packUniforms(programs.finish.layout, finishUniforms(r, frame, { crop: [0, 0, W, H], lutSize: 0, clip: false, outMode: opts.outMode ?? 0 })),
    [sh, srcSh, srcSh, srcSh, srcSh, srcSh],
  );
  const surface = CK.MakeSurface(W, H);
  const paint = new CK.Paint();
  paint.setShader(sh);
  surface.getCanvas().drawRect(CK.XYWHRect(0, 0, W, H), paint);
  surface.flush();
  const out = surface.makeImageSnapshot().readPixels(0, 0, {
    width: W,
    height: H,
    colorType: CK.ColorType.RGBA_8888,
    alphaType: CK.AlphaType.Unpremul,
    colorSpace: CK.ColorSpace.SRGB,
  });
  surface.delete();
  return out as Uint8Array;
}

const base = () =>
  createRecipe({ kind: 'file', id: 't', uri: 't', filename: 't.png', pairedUri: null, useRaw: false, isRaw: false });
const px = (buf: Uint8Array, x: number, y: number) => {
  const i = (y * W + x) * 4;
  return [buf[i], buf[i + 1], buf[i + 2]];
};
const srgbToLin = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
};

describe('develop pipeline (CanvasKit)', () => {
  it('default recipe is an identity transform', () => {
    const src = testImage();
    const out = render(base());
    let maxErr = 0;
    for (let i = 0; i < out.length; i++) if (i % 4 !== 3) maxErr = Math.max(maxErr, Math.abs(out[i] - src[i]));
    expect(maxErr).toBeLessThanOrEqual(2);
  });

  it('+1 EV doubles linear light', () => {
    const r = base();
    r.light.exposure = 1;
    const out = render(r);
    for (const x of [8, 16, 24]) {
      const inLin = srgbToLin(testImage()[(2 * W + x) * 4]);
      const outLin = srgbToLin(px(out, x, 2)[0]);
      expect(outLin / inLin).toBeGreaterThan(1.85);
      expect(outLin / inLin).toBeLessThan(2.15);
    }
  });

  it('positive contrast spreads tones around mid grey', () => {
    const r = base();
    r.light.contrast = 60;
    const out = render(r);
    expect(px(out, 12, 2)[0]).toBeLessThan(px(render(base()), 12, 2)[0]);
    expect(px(out, 52, 2)[0]).toBeGreaterThan(px(render(base()), 52, 2)[0]);
  });

  it('saturation -100 produces neutral greys', () => {
    const r = base();
    r.color.saturation = -100;
    const [R, G, B] = px(render(r), 10, 12);
    expect(Math.max(R, G, B) - Math.min(R, G, B)).toBeLessThanOrEqual(2);
  });

  it('warming increases red relative to blue on neutrals', () => {
    const r = base();
    r.color.temperature = 60;
    const [R, , B] = px(render(r), 40, 2);
    expect(R - B).toBeGreaterThan(10);
  });

  it('HSL blue saturation only affects blue', () => {
    const r = base();
    r.hsl.blue.sat = -100;
    const out = render(r);
    const blue = px(out, 10, 15);
    expect(Math.max(...blue) - Math.min(...blue)).toBeLessThan(40);
    const red = px(out, 10, 12);
    expect(red[0] - red[2]).toBeGreaterThan(100);
  });

  it('tone curve inversion inverts the ramp', () => {
    const r = base();
    r.curves.rgb = [
      { x: 0, y: 1 },
      { x: 1, y: 0 },
    ];
    const out = render(r);
    expect(px(out, 0, 2)[0]).toBeGreaterThan(250);
    expect(px(out, W - 1, 2)[0]).toBeLessThan(5);
  });

  it('black & white mixer produces grey output', () => {
    const r = base();
    r.effects.bw = true;
    const [R, G, B] = px(render(r), 10, 13);
    expect(R).toBe(G);
    expect(G).toBe(B);
  });

  it('a linear gradient mask applies exposure to one side only', () => {
    const r = base();
    const m = createMask('linear', 'g');
    // fully applied on the left, fading out to the right
    m.geometry = { ...m.geometry, x1: 0.1, y1: 0.5, x2: 0.5, y2: 0.5 };
    m.adjust.exposure = 50; // +2 EV
    r.masks = [m];
    const out = render(r);
    const ref = render(base());
    expect(px(out, 4, 2)[0]).toBeGreaterThan(px(ref, 4, 2)[0] + 10);
    expect(Math.abs(px(out, 60, 2)[0] - px(ref, 60, 2)[0])).toBeLessThanOrEqual(1);
  });

  it('a texture (brush/AI) mask selects by its pixels', () => {
    const r = base();
    const m = createMask('brush', 'b');
    m.adjust.exposure = -50;
    r.masks = [m];
    const tex = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) tex.set(i % W < W / 2 ? [255, 255, 255, 255] : [0, 0, 0, 255], i * 4);
    const out = render(r, { maskTex: tex });
    const ref = render(base());
    expect(px(out, 20, 2)[0]).toBeLessThan(px(ref, 20, 2)[0] - 10);
    expect(Math.abs(px(out, 50, 2)[0] - px(ref, 50, 2)[0])).toBeLessThanOrEqual(1);
  });

  it('16-bit export passes reconstruct the display value', () => {
    const r = base();
    r.light.exposure = 0.37;
    const display = render(r);
    const hi = render(r, { outMode: 2 });
    const lo = render(r, { outMode: 3 });
    for (const x of [5, 20, 33, 47, 60]) {
      const v16 = hi[(2 * W + x) * 4] * 256 + lo[(2 * W + x) * 4];
      expect(Math.abs(v16 / 257 - display[(2 * W + x) * 4])).toBeLessThanOrEqual(1);
    }
    // the low byte carries real information (not just zeros)
    let nonZero = 0;
    for (let x = 0; x < W; x++) if (lo[(2 * W + x) * 4] !== 0) nonZero++;
    expect(nonZero).toBeGreaterThan(W / 2);
  });

  it('8-bit data mode matches the display render', () => {
    const r = base();
    r.light.shadows = 40;
    const a = render(r);
    const b = render(r, { outMode: 1 });
    let maxErr = 0;
    for (let i = 0; i < a.length; i++) maxErr = Math.max(maxErr, Math.abs(a[i] - b[i]));
    expect(maxErr).toBeLessThanOrEqual(1);
  });
});

describe('LUT export (CanvasKit)', () => {
  const n = 9;
  const bake = (r: Recipe) => {
    const w = n * n;
    const srcSh = shaderOf(image(identityStrip(n), w, n));
    const curve = shaderOf(image(bakeCurveLut(r.curves), 256, 1));
    const frame = { width: w, height: n, isRaw: false };
    const dev = programs.develop.effect.makeShaderWithChildren(packUniforms(programs.develop.layout, developUniforms(r, frame)), [
      srcSh, srcSh, srcSh, srcSh, curve,
    ]);
    const pass = (outMode: number) => {
      const sh = programs.finish.effect.makeShaderWithChildren(
        packUniforms(programs.finish.layout, finishUniforms(r, frame, { crop: [0, 0, w, n], lutSize: 0, clip: false, outMode })),
        [dev, srcSh, srcSh, srcSh, srcSh, srcSh],
      );
      const surface = CK.MakeSurface(w, n);
      const paint = new CK.Paint();
      paint.setShader(sh);
      surface.getCanvas().drawRect(CK.XYWHRect(0, 0, w, n), paint);
      surface.flush();
      const out = surface.makeImageSnapshot().readPixels(0, 0, {
        width: w, height: n, colorType: CK.ColorType.RGBA_8888, alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB,
      });
      surface.delete();
      return out as Uint8Array;
    };
    return parseCube(stripToCube(pass(2), pass(3), n, 'T'));
  };

  it('bakes the default recipe into an identity LUT', () => {
    const cube = bake(base());
    let maxErr = 0;
    for (let b = 0; b < n; b++)
      for (let g = 0; g < n; g++)
        for (let r = 0; r < n; r++) {
          const i = (b * n * n + g * n + r) * 3;
          const exp = [r, g, b].map((v) => Math.round((v / (n - 1)) * 255) / 255);
          for (let c = 0; c < 3; c++) maxErr = Math.max(maxErr, Math.abs(cube.data[i + c] - exp[c]));
        }
    expect(maxErr).toBeLessThan(2 / 255);
  });

  it('bakes adjustments into the LUT', () => {
    const r = base();
    r.light.exposure = 1;
    const cube = bake(r);
    const mid = (4 * n * n + 4 * n + 4) * 3; // 50% grey
    expect(cube.data[mid]).toBeGreaterThan(0.6);
  });
});

describe('light effects (CanvasKit)', () => {
  it('bloom and halation brighten bright tones and are off by default', () => {
    const r = base();
    r.effects = { ...r.effects, bloomAmount: 80, bloomThreshold: 40, halationAmount: 80, halationThreshold: 40 };
    const plain = render(base());
    const lit = render(r);
    const x = Math.floor(W * 0.8);
    expect(px(lit, x, 2)[0]).toBeGreaterThan(px(plain, x, 2)[0]);
    // halation is warm: red grows more than blue
    expect(px(lit, x, 2)[0] - px(plain, x, 2)[0]).toBeGreaterThan(px(lit, x, 2)[2] - px(plain, x, 2)[2]);
    // shadows stay put
    expect(Math.abs(px(lit, 2, 2)[0] - px(plain, 2, 2)[0])).toBeLessThanOrEqual(2);
  });
});
