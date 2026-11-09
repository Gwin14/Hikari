import { autoTone, autoWhiteBalance, computeHistogram, skyMask } from '@/core/auto/analysis';
import { boxFilter, objectMask, refineMask, selectInstances } from '@/core/pipeline/refine';
import { dilate, inpaint } from '@/core/retouch/inpaint';

/* eslint-disable @typescript-eslint/no-require-imports */
const { execFileSync, spawnSync } = require('child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
declare const __dirname: string;

/**
 * The C++ math (modules/hikari-native/ios/compute) must match the TypeScript fallback. The
 * C++ is built for the host and fed the same synthetic inputs.
 */

const hasCompiler = spawnSync('clang++', ['--version']).status === 0;
const root = join(__dirname, '..', '..');
const computeDir = join(root, 'modules/hikari-native/ios/compute');

let work: string;
let harness: string;

const run = (op: string, ...args: (string | number)[]) => execFileSync(harness, [op, work, ...args.map(String)], { encoding: 'utf8' });
const put = (name: string, b: ArrayBufferView) => writeFileSync(join(work, name), new Uint8Array(b.buffer, b.byteOffset, b.byteLength));
const get = (name: string) => new Uint8Array(readFileSync(join(work, name)));
const floats = (name: string) => {
  const b = get(name);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4).slice();
};

/** Deterministic photo-like RGBA8: gradients, an object edge and fine noise. */
function photo(w: number, h: number): Uint8Array {
  const px = new Uint8Array(w * h * 4);
  let s = 12345;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      const noise = (s >> 16) % 7;
      const inObject = (x - w / 2) ** 2 + (y - h * 0.6) ** 2 < (h * 0.25) ** 2;
      const i = (y * w + x) * 4;
      px[i] = (inObject ? 190 : 90 + (y / h) * 60 + 20 * Math.sin(x / 9)) + noise;
      px[i + 1] = (inObject ? 70 : 120 + (y / h) * 40) + noise;
      px[i + 2] = (inObject ? 50 : 220 - (y / h) * 120) + noise;
      px[i + 3] = 255;
    }
  return px;
}

const expectClose = (a: ArrayLike<number>, b: ArrayLike<number>, tolerance: number) => {
  expect(a.length).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  expect(worst).toBeLessThanOrEqual(tolerance);
};

(hasCompiler ? describe : describe.skip)('native compute parity', () => {
  const W = 160;
  const H = 120;
  const guide = photo(W, H);
  // soft ramp, deliberately off the object's edges
  const softMask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) softMask[y * W + x] = Math.min(255, Math.max(0, Math.round((x - 50) * 4)));

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'hikari-parity-'));
    harness = join(work, 'harness');
    execFileSync('clang++', [
      '-std=c++17',
      '-O2',
      `-I${computeDir}`,
      join(computeDir, 'hikari_compute.cpp'),
      join(root, 'scripts/compute-parity/harness.cpp'),
      '-o',
      harness,
    ]);
  }, 120_000);

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('refineMask', () => {
    put('guide', guide);
    put('mask', softMask);
    run('refine', W, H, 8, 1e-4, 0.05, 0.95);
    expect(get('out')).toEqual(refineMask(guide, softMask, W, H, { radius: 8, eps: 1e-4, lo: 0.05, hi: 0.95 }));
  });

  it('objectMask, with and without a selection', () => {
    const coverage = new Uint8Array(W * H * 4);
    for (let i = 0; i < W * H; i++) coverage[i * 4] = softMask[i];
    put('guide', guide);
    put('cov', coverage);
    put('sel', new Uint8Array(0));
    run('object', W, H);
    expect(get('out')).toEqual(objectMask(guide, coverage, null, W, H));
    put('sel', softMask);
    run('object', W, H);
    expect(get('out')).toEqual(objectMask(guide, coverage, softMask, W, H));
  });

  it('selectInstances', () => {
    const labels = new Uint8Array(100);
    labels.fill(1, 10, 40);
    labels.fill(2, 60, 90);
    const cov = new Uint8Array(100);
    cov.fill(255, 15, 25);
    put('labels', labels);
    put('cov', cov);
    const picked = Number(run('select', 1, 2, 1, 100, 0.08, 0.3));
    const js = selectInstances(labels, 1, 2, cov, 1, 100, 0.08, 0.3);
    expect(picked).toBe(js.picked);
    expect(get('out')).toEqual(js.mask);
  });

  it('removeSpot (content-aware fill)', () => {
    const n = W * H;
    const pixels = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) pixels[i * 3 + c] = guide[i * 4 + c] / 255;
    const area = new Uint8Array(n);
    for (let y = 50; y < 80; y++) area.fill(1, y * W + 60, y * W + 90);
    const alpha = new Float32Array(n);
    const [grow, feather, searchMaxDim, seed] = [2, 1, 1024, 3141592653];
    put('pixels', pixels);
    put('alpha', alpha);
    put('area', area);
    run('remove', W, H, grow, feather, searchMaxDim, seed);

    const grown = dilate(area, W, H, grow);
    const soft = boxFilter(Float32Array.from(grown), W, H, feather);
    const solve = dilate(grown, W, H, feather * 2 + 1);
    const filled = inpaint(pixels, solve, W, H, { searchMaxDim, seed });
    expect(floats('alphaOut')).toEqual(soft);
    // Math.exp may differ from libm in the last bit, which only nudges the vote weights
    expectClose(floats('pixelsOut'), filled, 2e-4);
  });

  it('histogram', () => {
    put('px', guide);
    const [total, lo, hi] = run('histogram', 1).split(' ').map(Number);
    const js = computeHistogram(guide, 1);
    const b = get('out');
    const bins = new Uint32Array(b.buffer, b.byteOffset, 1024);
    expect(Array.from(bins.subarray(0, 256))).toEqual(Array.from(js.r));
    expect(Array.from(bins.subarray(256, 512))).toEqual(Array.from(js.g));
    expect(Array.from(bins.subarray(512, 768))).toEqual(Array.from(js.b));
    expect(Array.from(bins.subarray(768))).toEqual(Array.from(js.l));
    expect([total, lo, hi]).toEqual([js.total, js.clipLow, js.clipHigh]);
  });

  it('skyMask', () => {
    put('px', guide);
    run('sky', W, H);
    expect(get('out')).toEqual(skyMask(guide, W, H));
  });

  it('autoAdjust', () => {
    put('px', guide);
    const [exposure, contrast, highlights, shadows, whites, blacks, temperature, tint] = run('auto').split(' ').map(Number);
    const light = autoTone(computeHistogram(guide));
    const wb = autoWhiteBalance(guide);
    expect(exposure).toBeCloseTo(light.exposure, 6);
    expect([contrast, highlights, shadows, whites, blacks].map((v) => v + 0)).toEqual(
      [light.contrast, light.highlights, light.shadows, light.whites, light.blacks].map((v) => v + 0),
    );
    expect([temperature + 0, tint + 0]).toEqual([wb.temperature + 0, wb.tint + 0]);
  });
});
