/**
 * Edge-aware mask refinement. AI segmentation comes out soft and slightly misaligned at
 * object borders (hair, fur, foliage against sky); a color guided filter (He et al.) makes the
 * mask follow the photo's own edges. Everything here runs on the compute runtime, so every
 * function is a worklet and works on plain typed arrays.
 */

/** Mean over a (2r+1)² window, normalized by the in-bounds count (no darkening at borders). */
export function boxFilter(src: Float32Array, w: number, h: number, r: number): Float32Array {
  'worklet';
  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) sum += src[row + x];
    for (let x = 0; x < w; x++) {
      tmp[row + x] = sum / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
      if (x + r + 1 < w) sum += src[row + x + r + 1];
      if (x - r >= 0) sum -= src[row + x - r];
    }
  }
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = 0; y <= Math.min(r, h - 1); y++) sum += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / (Math.min(h - 1, y + r) - Math.max(0, y - r) + 1);
      if (y + r + 1 < h) sum += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) sum -= tmp[(y - r) * w + x];
    }
  }
  return dst;
}

/** Box-averages a plane (or one channel of an interleaved buffer) down by an integer factor. */
function downsample(src: Float32Array, w: number, h: number, s: number, stride: number, ch: number): Float32Array {
  'worklet';
  const lw = Math.ceil(w / s);
  const lh = Math.ceil(h / s);
  const out = new Float32Array(lw * lh);
  for (let ly = 0; ly < lh; ly++) {
    for (let lx = 0; lx < lw; lx++) {
      let sum = 0;
      let n = 0;
      for (let y = ly * s; y < Math.min(h, ly * s + s); y++) {
        for (let x = lx * s; x < Math.min(w, lx * s + s); x++) {
          sum += src[(y * w + x) * stride + ch];
          n++;
        }
      }
      out[ly * lw + lx] = sum / n;
    }
  }
  return out;
}

function mul(a: Float32Array, b: Float32Array): Float32Array {
  'worklet';
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * b[i];
  return out;
}

/**
 * Fast color guided filter: the linear coefficients are solved at 1/s resolution and
 * upsampled, which is visually identical to the full-resolution filter at a fraction of the cost.
 * @param I guide, interleaved RGB in 0..1
 * @param p input to filter, 0..1
 */
export function guidedFilter(I: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number, s: number): Float32Array {
  'worklet';
  const lw = Math.ceil(w / s);
  const lh = Math.ceil(h / s);
  const rr = Math.max(1, Math.round(r / s));
  const R = downsample(I, w, h, s, 3, 0);
  const G = downsample(I, w, h, s, 3, 1);
  const B = downsample(I, w, h, s, 3, 2);
  const P = downsample(p, w, h, s, 1, 0);
  const box = (a: Float32Array) => boxFilter(a, lw, lh, rr);
  const mR = box(R);
  const mG = box(G);
  const mB = box(B);
  const mP = box(P);
  const mRP = box(mul(R, P));
  const mGP = box(mul(G, P));
  const mBP = box(mul(B, P));
  const mRR = box(mul(R, R));
  const mRG = box(mul(R, G));
  const mRB = box(mul(R, B));
  const mGG = box(mul(G, G));
  const mGB = box(mul(G, B));
  const mBB = box(mul(B, B));
  const aR = new Float32Array(lw * lh);
  const aG = new Float32Array(lw * lh);
  const aB = new Float32Array(lw * lh);
  const bb = new Float32Array(lw * lh);
  for (let i = 0; i < lw * lh; i++) {
    const cr = mRP[i] - mR[i] * mP[i];
    const cg = mGP[i] - mG[i] * mP[i];
    const cb = mBP[i] - mB[i] * mP[i];
    const a11 = mRR[i] - mR[i] * mR[i] + eps;
    const a12 = mRG[i] - mR[i] * mG[i];
    const a13 = mRB[i] - mR[i] * mB[i];
    const a22 = mGG[i] - mG[i] * mG[i] + eps;
    const a23 = mGB[i] - mG[i] * mB[i];
    const a33 = mBB[i] - mB[i] * mB[i] + eps;
    // inverse of the symmetric covariance through its cofactors
    const c11 = a22 * a33 - a23 * a23;
    const c12 = a13 * a23 - a12 * a33;
    const c13 = a12 * a23 - a13 * a22;
    const c22 = a11 * a33 - a13 * a13;
    const c23 = a12 * a13 - a11 * a23;
    const c33 = a11 * a22 - a12 * a12;
    const det = a11 * c11 + a12 * c12 + a13 * c13;
    const inv = Math.abs(det) > 1e-12 ? 1 / det : 0;
    const xr = (c11 * cr + c12 * cg + c13 * cb) * inv;
    const xg = (c12 * cr + c22 * cg + c23 * cb) * inv;
    const xb = (c13 * cr + c23 * cg + c33 * cb) * inv;
    aR[i] = xr;
    aG[i] = xg;
    aB[i] = xb;
    bb[i] = mP[i] - xr * mR[i] - xg * mG[i] - xb * mB[i];
  }
  const maR = box(aR);
  const maG = box(aG);
  const maB = box(aB);
  const mb = box(bb);
  const q = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(lh - 1, Math.max(0, (y + 0.5) / s - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(lh - 1, y0 + 1);
    const ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(lw - 1, Math.max(0, (x + 0.5) / s - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(lw - 1, x0 + 1);
      const tx = fx - x0;
      const i00 = y0 * lw + x0;
      const i01 = y0 * lw + x1;
      const i10 = y1 * lw + x0;
      const i11 = y1 * lw + x1;
      const w00 = (1 - tx) * (1 - ty);
      const w01 = tx * (1 - ty);
      const w10 = (1 - tx) * ty;
      const w11 = tx * ty;
      const i = y * w + x;
      const ar = maR[i00] * w00 + maR[i01] * w01 + maR[i10] * w10 + maR[i11] * w11;
      const ag = maG[i00] * w00 + maG[i01] * w01 + maG[i10] * w10 + maG[i11] * w11;
      const ab = maB[i00] * w00 + maB[i01] * w01 + maB[i10] * w10 + maB[i11] * w11;
      const b0 = mb[i00] * w00 + mb[i01] * w01 + mb[i10] * w10 + mb[i11] * w11;
      q[i] = ar * I[i * 3] + ag * I[i * 3 + 1] + ab * I[i * 3 + 2] + b0;
    }
  }
  return q;
}

export interface RefineOptions {
  /** Filter window radius in pixels. */
  radius: number;
  /** Edge sensitivity: smaller follows finer edges (hair), larger smooths more. */
  eps: number;
  /** Output levels: values ≤ lo become 0, ≥ hi become 1 (smoothstep in between). */
  lo: number;
  hi: number;
}

/**
 * Snaps a soft mask to the photo's edges.
 * @param guide RGBA8 photo pixels, same size as the mask
 * @param mask RGBA8 mask (red channel) or one byte per pixel
 * @returns one byte per pixel
 */
export function refineMask(guide: Uint8Array, mask: Uint8Array, w: number, h: number, o: RefineOptions): Uint8Array {
  'worklet';
  const n = w * h;
  const I = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    I[i * 3] = guide[i * 4] / 255;
    I[i * 3 + 1] = guide[i * 4 + 1] / 255;
    I[i * 3 + 2] = guide[i * 4 + 2] / 255;
  }
  const stride = mask.length >= n * 4 ? 4 : 1;
  const p = new Float32Array(n);
  for (let i = 0; i < n; i++) p[i] = mask[i * stride] / 255;
  const s = Math.max(1, Math.min(4, Math.floor(o.radius / 3)));
  const q = guidedFilter(I, p, w, h, o.radius, o.eps, s);
  const out = new Uint8Array(n);
  const span = Math.max(1e-3, o.hi - o.lo);
  for (let i = 0; i < n; i++) {
    let t = (q[i] - o.lo) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out[i] = Math.round(t * t * (3 - 2 * t) * 255);
  }
  return out;
}

/**
 * Picks the segmented objects a rough brush selection is about: an object is taken when the
 * strokes cover at least `minCover` of it, or when `minShare` of the strokes fall on it.
 * @param labels instance id per pixel (0 = background)
 * @param coverage brush coverage per pixel (0..255), same size
 * @returns per-pixel selection (0/255) and how many objects were picked
 */
export function selectInstances(
  labels: Uint8Array,
  labelStride: number,
  count: number,
  coverage: Uint8Array,
  covStride: number,
  n: number,
  minCover = 0.08,
  minShare = 0.3,
): { mask: Uint8Array; picked: number } {
  'worklet';
  const area = new Float64Array(count + 1);
  const inter = new Float64Array(count + 1);
  let strokeArea = 0;
  for (let i = 0; i < n; i++) {
    const k = labels[i * labelStride];
    const c = coverage[i * covStride] / 255;
    if (k > 0 && k <= count) {
      area[k] += 1;
      inter[k] += c;
    }
    strokeArea += c;
  }
  const pick = new Uint8Array(count + 1);
  let picked = 0;
  for (let k = 1; k <= count; k++) {
    if (area[k] < 1) continue;
    if (inter[k] / area[k] > minCover || (strokeArea > 0 && inter[k] / strokeArea > minShare)) {
      pick[k] = 1;
      picked++;
    }
  }
  const mask = new Uint8Array(n);
  if (picked) for (let i = 0; i < n; i++) if (pick[labels[i * labelStride]]) mask[i] = 255;
  return { mask, picked };
}

/**
 * Object mask from a rough brush selection: the picked segmented objects (`selected`), or,
 * when the strokes aren't on a detected object, the strokes themselves snapped to nearby edges.
 * All buffers are w × h; guide and coverage are RGBA8, selected one byte per pixel.
 */
export function objectMask(guide: Uint8Array, coverage: Uint8Array, selected: Uint8Array | null, w: number, h: number): Uint8Array {
  'worklet';
  const long = Math.max(w, h);
  if (selected) return refineMask(guide, selected, w, h, { radius: Math.max(2, Math.round(long * 0.004)), eps: 2e-4, lo: 0.08, hi: 0.92 });
  return refineMask(guide, coverage, w, h, { radius: Math.max(3, Math.round(long * 0.012)), eps: 1e-3, lo: 0.3, hi: 0.7 });
}
