/**
 * Content-aware fill: multi-scale PatchMatch with EM voting (Wexler et al. "Space-Time
 * Completion", Barnes et al. "PatchMatch"). The hole is first solved on a small copy of the
 * region, where structure (horizons, edges) is cheap to get right, then refined level by level
 * so the final pixels are real texture copied from the surroundings, not a blur.
 *
 * Runs on the compute runtime: every function is a worklet over plain typed arrays.
 * Pixels are 3 floats per pixel in the source's encoded values (may exceed 1 for RAW).
 */

interface Level {
  img: Float32Array;
  /** 1 = unknown pixel to fill. */
  hole: Uint8Array;
  w: number;
  h: number;
}

export interface InpaintOptions {
  /** Patch radius (patches are (2r+1)²). */
  radius?: number;
  /**
   * Levels whose long edge is above this only refine the coarser solution (propagation and
   * voting, no random search): keeps full-resolution exports fast while staying sharp.
   */
  searchMaxDim?: number;
  seed?: number;
}

function rand(st: { s: number }): number {
  'worklet';
  // mulberry32: deterministic so a re-render reproduces the same fill
  st.s = (st.s + 0x6d2b79f5) | 0;
  let t = st.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Square dilation of a 0/1 mask by r (separable running counts). */
export function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  'worklet';
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let c = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) c += m[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = c > 0 ? 1 : 0;
      if (x + r + 1 < w) c += m[row + x + r + 1];
      if (x - r >= 0) c -= m[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let c = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) c += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = c > 0 ? 1 : 0;
      if (y + r + 1 < h) c += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) c -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

function downLevel(L: Level): Level {
  'worklet';
  const w = Math.ceil(L.w / 2);
  const h = Math.ceil(L.h / 2);
  const img = new Float32Array(w * h * 3);
  const hole = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      let any = 0;
      for (let yy = y * 2; yy < Math.min(L.h, y * 2 + 2); yy++) {
        for (let xx = x * 2; xx < Math.min(L.w, x * 2 + 2); xx++) {
          const i = yy * L.w + xx;
          if (L.hole[i]) {
            any = 1;
            continue;
          }
          r += L.img[i * 3];
          g += L.img[i * 3 + 1];
          b += L.img[i * 3 + 2];
          n++;
        }
      }
      const o = y * w + x;
      // a coarse pixel is known only when all of its children are, so sources stay clean
      hole[o] = any;
      if (n) {
        img[o * 3] = r / n;
        img[o * 3 + 1] = g / n;
        img[o * 3 + 2] = b / n;
      }
    }
  }
  return { img, hole, w, h };
}

/** Onion-peel diffusion: a smooth first guess for the coarsest level. */
function diffuse(L: Level) {
  'worklet';
  const { img, w, h } = L;
  const known = new Uint8Array(w * h);
  let left = 0;
  for (let i = 0; i < w * h; i++) {
    known[i] = L.hole[i] ? 0 : 1;
    if (!known[i]) left++;
  }
  const ring: number[] = [];
  for (let pass = 0; left > 0 && pass < w + h; pass++) {
    ring.length = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (known[i]) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = yy * w + xx;
            if (!known[j]) continue;
            r += img[j * 3];
            g += img[j * 3 + 1];
            b += img[j * 3 + 2];
            n++;
          }
        }
        if (!n) continue;
        img[i * 3] = r / n;
        img[i * 3 + 1] = g / n;
        img[i * 3 + 2] = b / n;
        ring.push(i);
      }
    }
    if (!ring.length) break;
    for (const i of ring) known[i] = 1;
    left -= ring.length;
  }
}

/** Patch SSD normalized to a full patch; returns Infinity as soon as it can't beat `limit`. */
function patchDist(img: Float32Array, w: number, h: number, r: number, tx: number, ty: number, sx: number, sy: number, limit: number): number {
  'worklet';
  let ssd = 0;
  let n = 0;
  for (let dy = -r; dy <= r; dy++) {
    const yy = ty + dy;
    if (yy < 0 || yy >= h) continue;
    const trow = yy * w;
    const srow = (sy + dy) * w + sx;
    for (let dx = -r; dx <= r; dx++) {
      const xx = tx + dx;
      if (xx < 0 || xx >= w) continue;
      const a = (trow + xx) * 3;
      const b = (srow + dx) * 3;
      const d0 = img[a] - img[b];
      const d1 = img[a + 1] - img[b + 1];
      const d2 = img[a + 2] - img[b + 2];
      ssd += d0 * d0 + d1 * d1 + d2 * d2;
      n++;
    }
    if (ssd > limit) return Infinity;
  }
  const full = (2 * r + 1) * (2 * r + 1);
  return n ? (ssd * full) / n : Infinity;
}

/** Runs EM iterations on one level. Returns the nearest-neighbour field, or null without sources. */
function solveLevel(L: Level, init: Int32Array | null, iters: number, passes: number, search: boolean, r: number, st: { s: number }): Int32Array | null {
  'worklet';
  const { img, hole, w, h } = L;
  const D = dilate(hole, w, h, r);
  const valid = new Uint8Array(w * h);
  const sources: number[] = [];
  for (let y = r; y < h - r; y++) {
    for (let x = r; x < w - r; x++) {
      const i = y * w + x;
      if (!D[i]) {
        valid[i] = 1;
        sources.push(i);
      }
    }
  }
  if (!sources.length) return null;
  const targets: number[] = [];
  for (let i = 0; i < w * h; i++) if (D[i]) targets.push(i);

  const nnf = init ?? new Int32Array(w * h).fill(-1);
  for (const t of targets) {
    const s = nnf[t];
    if (s < 0 || !valid[s]) nnf[t] = sources[Math.floor(rand(st) * sources.length)];
  }
  const dist = new Float32Array(w * h);
  const acc = new Float32Array(w * h * 3);
  const wsum = new Float32Array(w * h);
  const maxR = Math.max(w, h);

  for (let it = 0; it < iters; it++) {
    for (const t of targets) dist[t] = patchDist(img, w, h, r, t % w, (t / w) | 0, nnf[t] % w, (nnf[t] / w) | 0, Infinity);

    for (let pass = 0; pass < passes; pass++) {
      const fwd = pass % 2 === 0;
      const dir = fwd ? 1 : -1;
      for (let k = 0; k < targets.length; k++) {
        const t = targets[fwd ? k : targets.length - 1 - k];
        const tx = t % w;
        const ty = (t / w) | 0;
        let best = nnf[t];
        let bd = dist[t];
        // propagation: the neighbour's match, shifted by one, is likely a good match here too
        const nx = tx - dir;
        if (nx >= 0 && nx < w && D[t - dir]) {
          const c = nnf[t - dir] + dir;
          const cx = nnf[t - dir] % w + dir;
          if (cx >= 0 && cx < w && valid[c] && c !== best) {
            const d = patchDist(img, w, h, r, tx, ty, cx, (c / w) | 0, bd);
            if (d < bd) {
              bd = d;
              best = c;
            }
          }
        }
        const ny = ty - dir;
        if (ny >= 0 && ny < h && D[t - dir * w]) {
          const c = nnf[t - dir * w] + dir * w;
          if (c >= 0 && c < w * h && valid[c] && c !== best) {
            const d = patchDist(img, w, h, r, tx, ty, c % w, (c / w) | 0, bd);
            if (d < bd) {
              bd = d;
              best = c;
            }
          }
        }
        // random search in shrinking windows around the current best
        if (search) {
          const bx = best % w;
          const by = (best / w) | 0;
          for (let R = maxR; R >= 1; R >>= 1) {
            const cx = Math.min(w - 1, Math.max(0, bx + Math.floor((rand(st) * 2 - 1) * R)));
            const cy = Math.min(h - 1, Math.max(0, by + Math.floor((rand(st) * 2 - 1) * R)));
            const c = cy * w + cx;
            if (!valid[c] || c === best) continue;
            const d = patchDist(img, w, h, r, tx, ty, cx, cy, bd);
            if (d < bd) {
              bd = d;
              best = c;
            }
          }
        }
        nnf[t] = best;
        dist[t] = bd;
      }
    }

    // voting: every patch overlapping a hole pixel proposes a value, weighted by match quality
    let mean = 0;
    for (const t of targets) mean += dist[t];
    mean = Math.max(1e-6, mean / targets.length);
    acc.fill(0);
    wsum.fill(0);
    for (const t of targets) {
      const s = nnf[t];
      const tx = t % w;
      const ty = (t / w) | 0;
      const sx = s % w;
      const sy = (s / w) | 0;
      const wt = Math.exp(-dist[t] / (2 * mean));
      for (let dy = -r; dy <= r; dy++) {
        const yy = ty + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = tx + dx;
          if (xx < 0 || xx >= w) continue;
          const p = yy * w + xx;
          if (!hole[p]) continue;
          const q = ((sy + dy) * w + sx + dx) * 3;
          acc[p * 3] += wt * img[q];
          acc[p * 3 + 1] += wt * img[q + 1];
          acc[p * 3 + 2] += wt * img[q + 2];
          wsum[p] += wt;
        }
      }
    }
    for (let p = 0; p < w * h; p++) {
      if (!hole[p] || wsum[p] <= 0) continue;
      img[p * 3] = acc[p * 3] / wsum[p];
      img[p * 3 + 1] = acc[p * 3 + 1] / wsum[p];
      img[p * 3 + 2] = acc[p * 3 + 2] / wsum[p];
    }
  }
  return nnf;
}

/** Seeds a finer level: hole pixels from the coarse solution, and the coarse matches scaled up. */
function upLevel(C: Level, cnnf: Int32Array | null, F: Level): Int32Array | null {
  'worklet';
  const { w, h } = F;
  for (let y = 0; y < h; y++) {
    const fy = Math.min(C.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(C.h - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!F.hole[i]) continue;
      const fx = Math.min(C.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(C.w - 1, x0 + 1);
      const tx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const a = C.img[(y0 * C.w + x0) * 3 + c] * (1 - tx) + C.img[(y0 * C.w + x1) * 3 + c] * tx;
        const b = C.img[(y1 * C.w + x0) * 3 + c] * (1 - tx) + C.img[(y1 * C.w + x1) * 3 + c] * tx;
        F.img[i * 3 + c] = a * (1 - ty) + b * ty;
      }
    }
  }
  if (!cnnf) return null;
  const nnf = new Int32Array(w * h).fill(-1);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(C.h - 1, y >> 1);
    for (let x = 0; x < w; x++) {
      const cx = Math.min(C.w - 1, x >> 1);
      const cs = cnnf[cy * C.w + cx];
      if (cs < 0) continue;
      const sx = Math.min(w - 1, (cs % C.w) * 2 + (x - cx * 2));
      const sy = Math.min(h - 1, ((cs / C.w) | 0) * 2 + (y - cy * 2));
      nnf[y * w + x] = sy * w + sx;
    }
  }
  return nnf;
}

/**
 * Fills `hole` (1 = remove) from the rest of the region.
 * @param pixels 3 floats per pixel
 * @returns a new buffer with the hole filled
 */
export function inpaint(pixels: Float32Array, hole: Uint8Array, w: number, h: number, o: InpaintOptions = {}): Float32Array {
  'worklet';
  const r = o.radius ?? 3;
  const searchMax = o.searchMaxDim ?? 1e9;
  const st = { s: o.seed ?? 1234567 };
  const base: Level = { img: new Float32Array(pixels), hole: new Uint8Array(w * h), w, h };
  let any = false;
  for (let i = 0; i < w * h; i++) {
    base.hole[i] = hole[i] ? 1 : 0;
    if (hole[i]) any = true;
  }
  if (!any) return base.img;
  const levels: Level[] = [base];
  while (levels.length < 12) {
    const L = levels[levels.length - 1];
    if (Math.max(L.w, L.h) <= 48 || Math.min(L.w, L.h) <= 6 * r) break;
    levels.push(downLevel(L));
  }
  diffuse(levels[levels.length - 1]);
  let nnf: Int32Array | null = null;
  for (let k = levels.length - 1; k >= 0; k--) {
    const L = levels[k];
    if (k < levels.length - 1) nnf = upLevel(levels[k + 1], nnf, L);
    const depth = levels.length - 1 - k;
    const search = Math.max(L.w, L.h) <= searchMax;
    const iters = search ? Math.max(2, 8 - 2 * depth) : 1;
    nnf = solveLevel(L, nnf, iters, search ? 2 : 1, search, r, st);
  }
  return base.img;
}
