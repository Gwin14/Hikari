import { boxFilter, objectMask, refineMask, selectInstances } from '@/core/pipeline/refine';
import { dilate, inpaint } from '@/core/retouch/inpaint';

/** Left half dark, right half bright, as RGBA8. */
function split(w: number, h: number, edge: number) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const v = x < edge ? 30 : 220;
      px.set([v, v, v, 255], (y * w + x) * 4);
    }
  return px;
}

describe('mask refinement', () => {
  it('box filter keeps constants at the borders', () => {
    const a = new Float32Array(20 * 10).fill(0.7);
    const b = boxFilter(a, 20, 10, 3);
    for (const v of b) expect(v).toBeCloseTo(0.7, 5);
  });

  it('snaps a misaligned soft mask onto the photo edge', () => {
    const w = 96;
    const h = 32;
    const guide = split(w, h, 48);
    // coarse mask: soft ramp centered 6px off the real edge
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) mask[y * w + x] = Math.round(Math.min(1, Math.max(0, (x - 42 + 10) / 20)) * 255);
    const out = refineMask(guide, mask, w, h, { radius: 8, eps: 1e-4, lo: 0.05, hi: 0.95 });
    const row = 16 * w;
    // the soft ramp becomes a hard step exactly at the photo's edge
    expect(out[row + 48] - out[row + 47]).toBeGreaterThan(80);
    expect(out[row + 48]).toBeGreaterThan(245);
    expect(out[row + 52]).toBe(255);
    expect(out[row + 30]).toBeLessThan(10);
  });

  it('selects the object the strokes are on', () => {
    const n = 100;
    const labels = new Uint8Array(n);
    labels.fill(1, 10, 40);
    labels.fill(2, 60, 90);
    const cov = new Uint8Array(n);
    cov.fill(255, 15, 25);
    const sel = selectInstances(labels, 1, 2, cov, 1, n);
    expect(sel.picked).toBe(1);
    expect(sel.mask[20]).toBe(255);
    expect(sel.mask[30]).toBe(255);
    expect(sel.mask[70]).toBe(0);
  });

  it('falls back to edge-snapped strokes off detected objects', () => {
    const w = 64;
    const h = 32;
    const guide = split(w, h, 32);
    const cov = new Uint8Array(w * h * 4);
    // a stroke on the bright half that spills 4px over the edge
    for (let y = 8; y < 24; y++) for (let x = 28; x < 60; x++) cov[(y * w + x) * 4] = 255;
    const m = objectMask(guide, cov, null, w, h);
    expect(m[16 * w + 45]).toBeGreaterThan(200);
    expect(m[16 * w + 10]).toBe(0);
  });
});

describe('content-aware fill', () => {
  it('dilates a mask by its radius', () => {
    const m = new Uint8Array(25);
    m[12] = 1;
    const d = dilate(m, 5, 5, 1);
    expect([...d].reduce((a, b) => a + b, 0)).toBe(9);
  });

  it('removes an object from a striped background with matching texture', () => {
    const w = 96;
    const h = 96;
    const px = new Float32Array(w * h * 3);
    const stripe = (x: number) => (Math.floor(x / 4) % 2 ? 0.8 : 0.2);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const v = stripe(x);
        px[i] = v;
        px[i + 1] = v * 0.9;
        px[i + 2] = v * 0.7;
      }
    const hole = new Uint8Array(w * h);
    // a red blob in the middle
    for (let y = 36; y < 60; y++)
      for (let x = 36; x < 60; x++) {
        const i = y * w + x;
        hole[i] = 1;
        px[i * 3] = 1;
        px[i * 3 + 1] = 0;
        px[i * 3 + 2] = 0;
      }
    const t0 = Date.now();
    const out = inpaint(px, hole, w, h, { seed: 7 });
    const ms = Date.now() - t0;
    let err = 0;
    let n = 0;
    for (let y = 38; y < 58; y++)
      for (let x = 38; x < 58; x++) {
        const i = (y * w + x) * 3;
        err += Math.abs(out[i] - stripe(x));
        n++;
        // no red left
        expect(out[i] - out[i + 2]).toBeLessThan(0.45);
      }
    expect(err / n).toBeLessThan(0.12);
    // untouched outside the hole
    expect(out[(10 * w + 10) * 3]).toBeCloseTo(px[(10 * w + 10) * 3], 6);
    expect(ms).toBeLessThan(5000);
  });

  it('fills a hole touching the image border', () => {
    const w = 64;
    const h = 64;
    const px = new Float32Array(w * h * 3).fill(0.5);
    const hole = new Uint8Array(w * h);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 20; x++) hole[y * w + x] = 1;
    for (let i = 0; i < w * h; i++) if (hole[i]) px[i * 3] = 1;
    const out = inpaint(px, hole, w, h);
    expect(out[0]).toBeCloseTo(0.5, 2);
    expect(out[(5 * w + 5) * 3]).toBeCloseTo(0.5, 2);
  });
});
