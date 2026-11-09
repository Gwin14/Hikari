#include "hikari_compute.h"

#include <algorithm>
#include <cmath>
#include <cstring>
#include <functional>
#include <limits>
#include <optional>
#include <vector>

// Results must not depend on the compiler fusing a * b + c into one rounding step.
#pragma clang fp contract(off)

/*
 * Intermediates are doubles and stored planes floats on purpose: same arithmetic as the
 * TypeScript fallback in src/core, checked by src/__tests__/computeParity.test.ts.
 */

namespace {

using std::max;
using std::min;
using std::vector;

const double kInfinity = std::numeric_limits<double>::infinity();

inline double jsRound(double v) { return std::floor(v + 0.5); }
inline double clampTo(double v, double lo, double hi) { return max(lo, min(hi, v)); }
inline double smoothstep(double a, double b, double x) {
  const double t = clampTo((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Guided filter (src/core/pipeline/refine.ts)

vector<float> boxFilter(const vector<float> &src, int w, int h, int r) {
  vector<float> tmp(w * h);
  vector<float> dst(w * h);
  for (int y = 0; y < h; y++) {
    const int row = y * w;
    double sum = 0;
    for (int x = 0; x <= min(r, w - 1); x++) sum += src[row + x];
    for (int x = 0; x < w; x++) {
      tmp[row + x] = (float)(sum / (min(w - 1, x + r) - max(0, x - r) + 1));
      if (x + r + 1 < w) sum += src[row + x + r + 1];
      if (x - r >= 0) sum -= src[row + x - r];
    }
  }
  for (int x = 0; x < w; x++) {
    double sum = 0;
    for (int y = 0; y <= min(r, h - 1); y++) sum += tmp[y * w + x];
    for (int y = 0; y < h; y++) {
      dst[y * w + x] = (float)(sum / (min(h - 1, y + r) - max(0, y - r) + 1));
      if (y + r + 1 < h) sum += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) sum -= tmp[(y - r) * w + x];
    }
  }
  return dst;
}

vector<float> downsample(const vector<float> &src, int w, int h, int s, int stride, int ch) {
  const int lw = (w + s - 1) / s;
  const int lh = (h + s - 1) / s;
  vector<float> out(lw * lh);
  for (int ly = 0; ly < lh; ly++) {
    for (int lx = 0; lx < lw; lx++) {
      double sum = 0;
      int n = 0;
      for (int y = ly * s; y < min(h, ly * s + s); y++) {
        for (int x = lx * s; x < min(w, lx * s + s); x++) {
          sum += src[(y * w + x) * stride + ch];
          n++;
        }
      }
      out[ly * lw + lx] = (float)(sum / n);
    }
  }
  return out;
}

vector<float> mul(const vector<float> &a, const vector<float> &b) {
  vector<float> out(a.size());
  for (size_t i = 0; i < a.size(); i++) out[i] = (float)((double)a[i] * (double)b[i]);
  return out;
}

vector<float> guidedFilter(const vector<float> &I, const vector<float> &p, int w, int h, int r, double eps, int s) {
  const int lw = (w + s - 1) / s;
  const int lh = (h + s - 1) / s;
  const int rr = max(1, (int)jsRound((double)r / s));
  const vector<float> R = downsample(I, w, h, s, 3, 0);
  const vector<float> G = downsample(I, w, h, s, 3, 1);
  const vector<float> B = downsample(I, w, h, s, 3, 2);
  const vector<float> P = downsample(p, w, h, s, 1, 0);
  const auto box = [&](const vector<float> &a) { return boxFilter(a, lw, lh, rr); };
  const vector<float> mR = box(R), mG = box(G), mB = box(B), mP = box(P);
  const vector<float> mRP = box(mul(R, P)), mGP = box(mul(G, P)), mBP = box(mul(B, P));
  const vector<float> mRR = box(mul(R, R)), mRG = box(mul(R, G)), mRB = box(mul(R, B));
  const vector<float> mGG = box(mul(G, G)), mGB = box(mul(G, B)), mBB = box(mul(B, B));
  const int ln = lw * lh;
  vector<float> aR(ln), aG(ln), aB(ln), bb(ln);
  for (int i = 0; i < ln; i++) {
    const double dmR = mR[i], dmG = mG[i], dmB = mB[i], dmP = mP[i];
    const double cr = mRP[i] - dmR * dmP;
    const double cg = mGP[i] - dmG * dmP;
    const double cb = mBP[i] - dmB * dmP;
    const double a11 = mRR[i] - dmR * dmR + eps;
    const double a12 = mRG[i] - dmR * dmG;
    const double a13 = mRB[i] - dmR * dmB;
    const double a22 = mGG[i] - dmG * dmG + eps;
    const double a23 = mGB[i] - dmG * dmB;
    const double a33 = mBB[i] - dmB * dmB + eps;
    // inverse of the symmetric covariance through its cofactors
    const double c11 = a22 * a33 - a23 * a23;
    const double c12 = a13 * a23 - a12 * a33;
    const double c13 = a12 * a23 - a13 * a22;
    const double c22 = a11 * a33 - a13 * a13;
    const double c23 = a12 * a13 - a11 * a23;
    const double c33 = a11 * a22 - a12 * a12;
    const double det = a11 * c11 + a12 * c12 + a13 * c13;
    const double inv = std::fabs(det) > 1e-12 ? 1 / det : 0;
    const double xr = (c11 * cr + c12 * cg + c13 * cb) * inv;
    const double xg = (c12 * cr + c22 * cg + c23 * cb) * inv;
    const double xb = (c13 * cr + c23 * cg + c33 * cb) * inv;
    aR[i] = (float)xr;
    aG[i] = (float)xg;
    aB[i] = (float)xb;
    bb[i] = (float)(dmP - xr * dmR - xg * dmG - xb * dmB);
  }
  const vector<float> maR = box(aR), maG = box(aG), maB = box(aB), mb = box(bb);
  vector<float> q(w * h);
  for (int y = 0; y < h; y++) {
    const double fy = min((double)(lh - 1), max(0.0, (y + 0.5) / s - 0.5));
    const int y0 = (int)std::floor(fy);
    const int y1 = min(lh - 1, y0 + 1);
    const double ty = fy - y0;
    for (int x = 0; x < w; x++) {
      const double fx = min((double)(lw - 1), max(0.0, (x + 0.5) / s - 0.5));
      const int x0 = (int)std::floor(fx);
      const int x1 = min(lw - 1, x0 + 1);
      const double tx = fx - x0;
      const int i00 = y0 * lw + x0, i01 = y0 * lw + x1, i10 = y1 * lw + x0, i11 = y1 * lw + x1;
      const double w00 = (1 - tx) * (1 - ty), w01 = tx * (1 - ty), w10 = (1 - tx) * ty, w11 = tx * ty;
      const auto lerp = [&](const vector<float> &v) {
        return (double)v[i00] * w00 + (double)v[i01] * w01 + (double)v[i10] * w10 + (double)v[i11] * w11;
      };
      const int i = y * w + x;
      q[i] = (float)(lerp(maR) * I[i * 3] + lerp(maG) * I[i * 3 + 1] + lerp(maB) * I[i * 3 + 2] + lerp(mb));
    }
  }
  return q;
}

void refine(const uint8_t *guide, const uint8_t *mask, size_t maskLen, int w, int h, int radius, double eps, double lo, double hi, uint8_t *out) {
  const int n = w * h;
  vector<float> I(n * 3);
  for (int i = 0; i < n; i++) {
    I[i * 3] = (float)(guide[i * 4] / 255.0);
    I[i * 3 + 1] = (float)(guide[i * 4 + 1] / 255.0);
    I[i * 3 + 2] = (float)(guide[i * 4 + 2] / 255.0);
  }
  const int stride = maskLen >= (size_t)n * 4 ? 4 : 1;
  vector<float> p(n);
  for (int i = 0; i < n; i++) p[i] = (float)(mask[i * stride] / 255.0);
  const int s = max(1, min(4, radius / 3));
  const vector<float> q = guidedFilter(I, p, w, h, radius, eps, s);
  const double span = max(1e-3, hi - lo);
  for (int i = 0; i < n; i++) {
    double t = ((double)q[i] - lo) / span;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    out[i] = (uint8_t)jsRound(t * t * (3 - 2 * t) * 255);
  }
}

// ---------------------------------------------------------------------------
// Content-aware fill (src/core/retouch/inpaint.ts)

struct Level {
  vector<float> img;
  vector<uint8_t> hole;
  int w = 0;
  int h = 0;
};

using Field = std::optional<vector<int32_t>>;

/** mulberry32: deterministic so a re-render reproduces the same fill. */
struct Random {
  uint32_t s;
  double next() {
    s += 0x6d2b79f5u;
    uint32_t t = s;
    t = (t ^ (t >> 15)) * (t | 1u);
    t ^= t + (t ^ (t >> 7)) * (t | 61u);
    return (double)(t ^ (t >> 14)) / 4294967296.0;
  }
};

vector<uint8_t> dilate(const vector<uint8_t> &m, int w, int h, int r) {
  vector<uint8_t> tmp(w * h);
  vector<uint8_t> out(w * h);
  for (int y = 0; y < h; y++) {
    const int row = y * w;
    int c = 0;
    for (int x = 0; x <= min(r, w - 1); x++) c += m[row + x];
    for (int x = 0; x < w; x++) {
      tmp[row + x] = c > 0 ? 1 : 0;
      if (x + r + 1 < w) c += m[row + x + r + 1];
      if (x - r >= 0) c -= m[row + x - r];
    }
  }
  for (int x = 0; x < w; x++) {
    int c = 0;
    for (int y = 0; y <= min(r, h - 1); y++) c += tmp[y * w + x];
    for (int y = 0; y < h; y++) {
      out[y * w + x] = c > 0 ? 1 : 0;
      if (y + r + 1 < h) c += tmp[(y + r + 1) * w + x];
      if (y - r >= 0) c -= tmp[(y - r) * w + x];
    }
  }
  return out;
}

Level downLevel(const Level &L) {
  const int w = (L.w + 1) / 2;
  const int h = (L.h + 1) / 2;
  Level out;
  out.img.assign(w * h * 3, 0);
  out.hole.assign(w * h, 0);
  out.w = w;
  out.h = h;
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      double r = 0, g = 0, b = 0;
      int n = 0, any = 0;
      for (int yy = y * 2; yy < min(L.h, y * 2 + 2); yy++) {
        for (int xx = x * 2; xx < min(L.w, x * 2 + 2); xx++) {
          const int i = yy * L.w + xx;
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
      const int o = y * w + x;
      // a coarse pixel is known only when all of its children are, so sources stay clean
      out.hole[o] = (uint8_t)any;
      if (n) {
        out.img[o * 3] = (float)(r / n);
        out.img[o * 3 + 1] = (float)(g / n);
        out.img[o * 3 + 2] = (float)(b / n);
      }
    }
  }
  return out;
}

/** Onion-peel diffusion: a smooth first guess for the coarsest level. */
void diffuse(Level &L) {
  vector<float> &img = L.img;
  const int w = L.w, h = L.h;
  vector<uint8_t> known(w * h);
  int left = 0;
  for (int i = 0; i < w * h; i++) {
    known[i] = L.hole[i] ? 0 : 1;
    if (!known[i]) left++;
  }
  vector<int> ring;
  for (int pass = 0; left > 0 && pass < w + h; pass++) {
    ring.clear();
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        const int i = y * w + x;
        if (known[i]) continue;
        double r = 0, g = 0, b = 0;
        int n = 0;
        for (int dy = -1; dy <= 1; dy++) {
          const int yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (int dx = -1; dx <= 1; dx++) {
            const int xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const int j = yy * w + xx;
            if (!known[j]) continue;
            r += img[j * 3];
            g += img[j * 3 + 1];
            b += img[j * 3 + 2];
            n++;
          }
        }
        if (!n) continue;
        img[i * 3] = (float)(r / n);
        img[i * 3 + 1] = (float)(g / n);
        img[i * 3 + 2] = (float)(b / n);
        ring.push_back(i);
      }
    }
    if (ring.empty()) break;
    for (const int i : ring) known[i] = 1;
    left -= (int)ring.size();
  }
}

/** Patch SSD normalized to a full patch; infinite as soon as it can't beat `limit`. */
inline double patchDist(const float *img, int w, int h, int r, int tx, int ty, int sx, int sy, double limit) {
  double ssd = 0;
  int n = 0;
  for (int dy = -r; dy <= r; dy++) {
    const int yy = ty + dy;
    if (yy < 0 || yy >= h) continue;
    const int trow = yy * w;
    const int srow = (sy + dy) * w + sx;
    for (int dx = -r; dx <= r; dx++) {
      const int xx = tx + dx;
      if (xx < 0 || xx >= w) continue;
      const int a = (trow + xx) * 3;
      const int b = (srow + dx) * 3;
      const double d0 = (double)img[a] - (double)img[b];
      const double d1 = (double)img[a + 1] - (double)img[b + 1];
      const double d2 = (double)img[a + 2] - (double)img[b + 2];
      ssd += d0 * d0 + d1 * d1 + d2 * d2;
      n++;
    }
    if (ssd > limit) return kInfinity;
  }
  const int full = (2 * r + 1) * (2 * r + 1);
  return n ? (ssd * full) / n : kInfinity;
}

/** Runs EM iterations on one level. Returns the nearest-neighbour field, empty without sources. */
Field solveLevel(Level &L, Field init, int iters, int passes, bool search, int r, Random &st) {
  float *img = L.img.data();
  const vector<uint8_t> &hole = L.hole;
  const int w = L.w, h = L.h;
  const vector<uint8_t> D = dilate(hole, w, h, r);
  vector<uint8_t> valid(w * h, 0);
  vector<int> sources;
  for (int y = r; y < h - r; y++) {
    for (int x = r; x < w - r; x++) {
      const int i = y * w + x;
      if (!D[i]) {
        valid[i] = 1;
        sources.push_back(i);
      }
    }
  }
  if (sources.empty()) return std::nullopt;
  vector<int> targets;
  for (int i = 0; i < w * h; i++)
    if (D[i]) targets.push_back(i);

  vector<int32_t> nnf = init ? std::move(*init) : vector<int32_t>(w * h, -1);
  for (const int t : targets) {
    const int s = nnf[t];
    if (s < 0 || !valid[s]) nnf[t] = sources[(size_t)std::floor(st.next() * sources.size())];
  }
  vector<float> dist(w * h, 0);
  vector<float> acc(w * h * 3, 0);
  vector<float> wsum(w * h, 0);
  const int maxR = max(w, h);

  for (int it = 0; it < iters; it++) {
    for (const int t : targets) dist[t] = (float)patchDist(img, w, h, r, t % w, t / w, nnf[t] % w, nnf[t] / w, kInfinity);

    for (int pass = 0; pass < passes; pass++) {
      const bool fwd = pass % 2 == 0;
      const int dir = fwd ? 1 : -1;
      const int count = (int)targets.size();
      for (int k = 0; k < count; k++) {
        const int t = targets[fwd ? k : count - 1 - k];
        const int tx = t % w;
        const int ty = t / w;
        int best = nnf[t];
        double bd = dist[t];
        // propagation: the neighbour's match, shifted by one, is likely a good match here too
        const int nx = tx - dir;
        if (nx >= 0 && nx < w && D[t - dir]) {
          const int c = nnf[t - dir] + dir;
          const int cx = nnf[t - dir] % w + dir;
          if (cx >= 0 && cx < w && valid[c] && c != best) {
            const double d = patchDist(img, w, h, r, tx, ty, cx, c / w, bd);
            if (d < bd) {
              bd = d;
              best = c;
            }
          }
        }
        const int ny = ty - dir;
        if (ny >= 0 && ny < h && D[t - dir * w]) {
          const int c = nnf[t - dir * w] + dir * w;
          if (c >= 0 && c < w * h && valid[c] && c != best) {
            const double d = patchDist(img, w, h, r, tx, ty, c % w, c / w, bd);
            if (d < bd) {
              bd = d;
              best = c;
            }
          }
        }
        // random search in shrinking windows around the current best
        if (search) {
          const int bx = best % w;
          const int by = best / w;
          for (int R = maxR; R >= 1; R >>= 1) {
            const int cx = min(w - 1, max(0, bx + (int)std::floor((st.next() * 2 - 1) * R)));
            const int cy = min(h - 1, max(0, by + (int)std::floor((st.next() * 2 - 1) * R)));
            const int c = cy * w + cx;
            if (!valid[c] || c == best) continue;
            const double d = patchDist(img, w, h, r, tx, ty, cx, cy, bd);
            if (d < bd) {
              bd = d;
              best = c;
            }
          }
        }
        nnf[t] = best;
        dist[t] = (float)bd;
      }
    }

    // voting: every patch overlapping a hole pixel proposes a value, weighted by match quality
    double mean = 0;
    for (const int t : targets) mean += dist[t];
    mean = max(1e-6, mean / targets.size());
    std::fill(acc.begin(), acc.end(), 0.f);
    std::fill(wsum.begin(), wsum.end(), 0.f);
    for (const int t : targets) {
      const int s = nnf[t];
      const int tx = t % w;
      const int ty = t / w;
      const int sx = s % w;
      const int sy = s / w;
      const double wt = std::exp(-(double)dist[t] / (2 * mean));
      for (int dy = -r; dy <= r; dy++) {
        const int yy = ty + dy;
        if (yy < 0 || yy >= h) continue;
        for (int dx = -r; dx <= r; dx++) {
          const int xx = tx + dx;
          if (xx < 0 || xx >= w) continue;
          const int p = yy * w + xx;
          if (!hole[p]) continue;
          const int q = ((sy + dy) * w + sx + dx) * 3;
          acc[p * 3] = (float)((double)acc[p * 3] + wt * (double)img[q]);
          acc[p * 3 + 1] = (float)((double)acc[p * 3 + 1] + wt * (double)img[q + 1]);
          acc[p * 3 + 2] = (float)((double)acc[p * 3 + 2] + wt * (double)img[q + 2]);
          wsum[p] = (float)((double)wsum[p] + wt);
        }
      }
    }
    for (int p = 0; p < w * h; p++) {
      if (!hole[p] || wsum[p] <= 0) continue;
      img[p * 3] = (float)((double)acc[p * 3] / (double)wsum[p]);
      img[p * 3 + 1] = (float)((double)acc[p * 3 + 1] / (double)wsum[p]);
      img[p * 3 + 2] = (float)((double)acc[p * 3 + 2] / (double)wsum[p]);
    }
  }
  return nnf;
}

/** Seeds a finer level: hole pixels from the coarse solution, and the coarse matches scaled up. */
Field upLevel(const Level &C, const Field &cnnf, Level &F) {
  const int w = F.w, h = F.h;
  for (int y = 0; y < h; y++) {
    const double fy = min((double)(C.h - 1), max(0.0, (y + 0.5) / 2 - 0.5));
    const int y0 = (int)std::floor(fy);
    const int y1 = min(C.h - 1, y0 + 1);
    const double ty = fy - y0;
    for (int x = 0; x < w; x++) {
      const int i = y * w + x;
      if (!F.hole[i]) continue;
      const double fx = min((double)(C.w - 1), max(0.0, (x + 0.5) / 2 - 0.5));
      const int x0 = (int)std::floor(fx);
      const int x1 = min(C.w - 1, x0 + 1);
      const double tx = fx - x0;
      for (int c = 0; c < 3; c++) {
        const double a = (double)C.img[(y0 * C.w + x0) * 3 + c] * (1 - tx) + (double)C.img[(y0 * C.w + x1) * 3 + c] * tx;
        const double b = (double)C.img[(y1 * C.w + x0) * 3 + c] * (1 - tx) + (double)C.img[(y1 * C.w + x1) * 3 + c] * tx;
        F.img[i * 3 + c] = (float)(a * (1 - ty) + b * ty);
      }
    }
  }
  if (!cnnf) return std::nullopt;
  vector<int32_t> nnf(w * h, -1);
  for (int y = 0; y < h; y++) {
    const int cy = min(C.h - 1, y >> 1);
    for (int x = 0; x < w; x++) {
      const int cx = min(C.w - 1, x >> 1);
      const int cs = (*cnnf)[cy * C.w + cx];
      if (cs < 0) continue;
      const int sx = min(w - 1, (cs % C.w) * 2 + (x - cx * 2));
      const int sy = min(h - 1, (cs / C.w) * 2 + (y - cy * 2));
      nnf[y * w + x] = sy * w + sx;
    }
  }
  return nnf;
}

/** Fills `hole` (non-zero = remove) in place. */
void inpaint(float *pixels, const vector<uint8_t> &hole, int w, int h, int searchMaxDim, uint32_t seed) {
  const int r = 3;
  Random st{seed};
  vector<Level> levels;
  levels.reserve(12);
  Level base;
  base.img.assign(pixels, pixels + w * h * 3);
  base.hole.assign(w * h, 0);
  base.w = w;
  base.h = h;
  bool any = false;
  for (int i = 0; i < w * h; i++) {
    base.hole[i] = hole[i] ? 1 : 0;
    if (hole[i]) any = true;
  }
  if (!any) return;
  levels.push_back(std::move(base));
  while (levels.size() < 12) {
    const Level &L = levels.back();
    if (max(L.w, L.h) <= 48 || min(L.w, L.h) <= 6 * r) break;
    levels.push_back(downLevel(L));
  }
  diffuse(levels.back());
  Field nnf;
  const int top = (int)levels.size() - 1;
  for (int k = top; k >= 0; k--) {
    Level &L = levels[k];
    if (k < top) nnf = upLevel(levels[k + 1], nnf, L);
    const int depth = top - k;
    const bool search = max(L.w, L.h) <= searchMaxDim;
    const int iters = search ? max(2, 8 - 2 * depth) : 1;
    nnf = solveLevel(L, std::move(nnf), iters, search ? 2 : 1, search, r, st);
  }
  std::memcpy(pixels, levels[0].img.data(), sizeof(float) * w * h * 3);
}

// ---------------------------------------------------------------------------
// Auto adjust (src/core/auto/analysis.ts)

struct Light {
  double exposure = 0, contrast = 0, highlights = 0, shadows = 0, whites = 0, blacks = 0;
};

inline double decodeSrgb(double v) { return v <= 0.04045 ? v / 12.92 : std::pow((v + 0.055) / 1.055, 2.4); }
inline double encodeSrgb(double v) { return v <= 0.0031308 ? v * 12.92 : 1.055 * std::pow(v, 1 / 2.4) - 0.055; }

/** Mirror of toneY() in shaders.ts. */
double toneY(double y, double contrast, double highlights, double shadows, double whites, double blacks) {
  const double ws = 1 - smoothstep(0, 0.6, y);
  const double wh = smoothstep(0.4, 1, y);
  y += shadows * 0.45 * ws * ws * (1 - y * 0.5);
  y += highlights * 0.4 * wh * wh * (highlights < 0 ? max(y, 0.4) : 1 - y * 0.6);
  y += whites * 0.3 * smoothstep(0.55, 1, y);
  y += blacks * 0.2 * (1 - smoothstep(0, 0.35, y));
  const double k = contrast >= 0 ? 1 + contrast * 1.2 : 1 / (1 - contrast * 0.8);
  const double yc = clampTo(y, 0, 1);
  const double sc = yc < 0.5 ? 0.5 * std::pow(2 * yc, k) : 1 - 0.5 * std::pow(2 * (1 - yc), k);
  return sc + (y - yc);
}

double developY(double e, const Light &L) {
  double lin = decodeSrgb(e) * std::pow(2, L.exposure);
  if (L.exposure > 0 && lin > 0.8) lin = 0.8 + 0.2 * (1 - std::exp(-(lin - 0.8) / 0.2));
  const double y = toneY(encodeSrgb(lin), L.contrast / 100, L.highlights / 100, L.shadows / 100, L.whites / 100, L.blacks / 100);
  return clampTo(y, 0, 1);
}

double solveBisect(const std::function<double(double)> &f, double target, double lo, double hi) {
  if (f(lo) >= target) return lo;
  if (f(hi) <= target) return hi;
  for (int i = 0; i < 24; i++) {
    const double mid = (lo + hi) / 2;
    if (f(mid) < target) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

double percentile(const uint32_t *bins, double total, double p) {
  const double target = total * p;
  double acc = 0;
  for (int i = 0; i < 256; i++) {
    acc += bins[i];
    if (acc >= target) return i / 255.0;
  }
  return 1;
}

Light autoTone(const uint32_t *lumaBins, uint32_t total, double clipHigh) {
  const double n = total ? total : 1;
  const auto q = [&](double p) { return percentile(lumaBins, n, p); };
  const double p005 = q(0.005), p05 = q(0.05), p10 = q(0.1), p50 = q(0.5), p90 = q(0.9), p95 = q(0.95), p995 = q(0.995);
  Light L;
  const auto withExposure = [&](double e, double x) {
    Light t = L;
    t.exposure = x;
    return developY(e, t);
  };

  // exposure: high-key scenes stay bright, low-key ones stay dark-ish
  const double targetMid = 0.46 + (p50 - 0.46) * (p50 > 0.46 ? 0.7 : 0.5);
  double exposure = solveBisect([&](double x) { return withExposure(p50, x); }, targetMid, -2, 2);
  if (exposure > 0) {
    // brightening must not blow out what is already bright (windows, lights, sky)
    const auto cap = [&](double p, double top) {
      return p < top ? solveBisect([&](double x) { return withExposure(p, x); }, top, 0, 2) : 0.3;
    };
    exposure = min(min(exposure, cap(p90, 0.93)), cap(p95, 0.97));
  }
  L.exposure = jsRound(exposure * 100) / 100;

  // highlights: pull the bright tenth down when it sits high or the image clips
  const double y90 = developY(p90, L);
  L.highlights = -clampTo((y90 - 0.82) * 250 + max(0.0, clipHigh - 0.005) * 150, 0, 60);

  // shadows: lift a crushed dark tenth, less so when most of the frame is dark on purpose
  double dark = 0;
  for (int i = 0; i < 256; i++)
    if (developY(i / 255.0, L) < 0.08) dark += lumaBins[i];
  const double lowKey = clampTo(1.5 - (2 * dark) / n, 0.25, 1);
  L.shadows = clampTo((0.12 - developY(p10, L)) * 220, 0, 35) * lowKey;

  // whites / blacks: only extend the end points the image doesn't reach (anymore)
  if (developY(p995, L) < 0.96) {
    L.whites = solveBisect([&](double x) {
      Light t = L;
      t.whites = x;
      return developY(p995, t);
    }, 0.965, 0, 40);
  }
  if (developY(p005, L) > 0.03) {
    L.blacks = -solveBisect([&](double x) {
      Light t = L;
      t.blacks = -x;
      return -developY(p005, t);
    }, -0.025, 0, 40);
  }

  // contrast: aim for a natural spread between the 5th and 95th percentiles
  const double spread = developY(p95, L) - developY(p05, L);
  L.contrast = clampTo((0.72 - spread) * 70, -15, 25);

  L.contrast = jsRound(L.contrast);
  L.highlights = jsRound(L.highlights);
  L.shadows = jsRound(L.shadows);
  L.whites = jsRound(L.whites);
  L.blacks = jsRound(L.blacks);
  return L;
}

struct Rgb {
  double r, g, b;
};

Rgb kelvinToRgb(double k) {
  const double t = k / 100;
  double r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * std::log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * std::log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * std::pow(t - 60, -0.1332047592);
    g = 288.1221695283 * std::pow(t - 60, -0.0755148492);
    b = 255;
  }
  const auto c = [](double v) { return max(0.0, min(255.0, v)) / 255; };
  return {c(r), c(g), c(b)};
}

Rgb wbMultipliers(double temperature, double tint) {
  if (temperature == 0 && tint == 0) return {1, 1, 1};
  const double mired = 1e6 / 6500 + (temperature / 100) * 90;
  const Rgb target = kelvinToRgb(1e6 / mired);
  const Rgb ref = kelvinToRgb(6500);
  double r = target.r / ref.r;
  double g = target.g / ref.g;
  double b = target.b / ref.b;
  g *= 1 - (tint / 100) * 0.3;
  const double y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return {r / y, g / y, b / y};
}

void autoWhiteBalance(const uint8_t *px, size_t len, double *wb) {
  const size_t stride = 8;
  double sr = 0, sg = 0, sb = 0, sw = 0;
  int count = 0, total = 0;
  for (size_t i = 0; i < len; i += stride) {
    total++;
    const double R = px[i] / 255.0;
    const double G = px[i + 1] / 255.0;
    const double B = px[i + 2] / 255.0;
    const double mx = max(R, max(G, B));
    const double mn = min(R, min(G, B));
    if (mx > 0.96 || mx < 0.06) continue;
    const double sat = (mx - mn) / mx;
    if (sat > 0.35) continue;
    const double f = 1 - sat / 0.35;
    const double w = f * f * (0.3 + mx);
    sr += decodeSrgb(R) * w;
    sg += decodeSrgb(G) * w;
    sb += decodeSrgb(B) * w;
    sw += w;
    count++;
  }
  wb[0] = 0;
  wb[1] = 0;
  if (count < 50 || sw <= 0) return;
  const double lr = std::log(sr / sw);
  const double lg = std::log(sg / sw);
  const double lb = std::log(sb / sw);
  const auto err = [&](double t, double n) {
    const Rgb m = wbMultipliers(t, n);
    const double g = lg + std::log(m.g);
    const double dr = lr + std::log(m.r) - g;
    const double db = lb + std::log(m.b) - g;
    return dr * dr + db * db;
  };
  int bt = 0, bn = 0;
  double best = err(0, 0);
  const int searches[2][2] = {{4, 100}, {1, 4}};
  for (const auto &search : searches) {
    const int stepSize = search[0], span = search[1];
    const int ct = bt, cn = bn;
    for (int t = max(-100, ct - span); t <= min(100, ct + span); t += stepSize)
      for (int n = max(-100, cn - span); n <= min(100, cn + span); n += stepSize) {
        const double e = err(t, n);
        if (e < best) {
          best = e;
          bt = t;
          bn = n;
        }
      }
  }
  // fewer neutral pixels → less confidence in the estimate
  const double confidence = clampTo(count / (total * 0.15), 0, 1);
  const double k = 0.75 * confidence;
  wb[0] = jsRound(clampTo(bt * k * (bt < 0 ? 0.6 : 1), -60, 60));
  wb[1] = jsRound(clampTo(bn * k * 0.8, -40, 40));
}

}  // namespace

// ---------------------------------------------------------------------------
// C API

void hk_refine_mask(const uint8_t *guide, const uint8_t *mask, size_t maskLen, int32_t w, int32_t h, int32_t radius, double eps, double lo, double hi, uint8_t *out) {
  refine(guide, mask, maskLen, w, h, radius, eps, lo, hi, out);
}

void hk_object_mask(const uint8_t *guide, const uint8_t *coverage, size_t coverageLen, const uint8_t *selected, size_t selectedLen, int32_t w, int32_t h, uint8_t *out) {
  const int lng = max(w, h);
  if (selected) refine(guide, selected, selectedLen, w, h, max(2, (int)jsRound(lng * 0.004)), 2e-4, 0.08, 0.92, out);
  else refine(guide, coverage, coverageLen, w, h, max(3, (int)jsRound(lng * 0.012)), 1e-3, 0.3, 0.7, out);
}

int32_t hk_select_instances(const uint8_t *labels, int32_t labelStride, int32_t count, const uint8_t *coverage, int32_t coverageStride, int32_t n, double minCover, double minShare, uint8_t *out) {
  vector<double> area(count + 1, 0);
  vector<double> inter(count + 1, 0);
  double strokeArea = 0;
  for (int i = 0; i < n; i++) {
    const int k = labels[i * labelStride];
    const double c = coverage[i * coverageStride] / 255.0;
    if (k > 0 && k <= count) {
      area[k] += 1;
      inter[k] += c;
    }
    strokeArea += c;
  }
  vector<uint8_t> pick(max(256, count + 1), 0);
  int picked = 0;
  for (int k = 1; k <= count; k++) {
    if (area[k] < 1) continue;
    if (inter[k] / area[k] > minCover || (strokeArea > 0 && inter[k] / strokeArea > minShare)) {
      pick[k] = 1;
      picked++;
    }
  }
  std::memset(out, 0, n);
  if (picked)
    for (int i = 0; i < n; i++)
      if (pick[labels[i * labelStride]]) out[i] = 255;
  return picked;
}

void hk_remove_spot(float *pixels, const uint8_t *area, float *alpha, int32_t w, int32_t h, int32_t grow, int32_t feather, int32_t searchMaxDim, uint32_t seed) {
  const int n = w * h;
  const vector<uint8_t> areaPlane(area, area + n);
  const vector<uint8_t> grown = dilate(areaPlane, w, h, grow);
  // feathered blend weight, fully inside the solved area
  const vector<float> soft = boxFilter(vector<float>(grown.begin(), grown.end()), w, h, feather);
  const vector<uint8_t> solve = dilate(grown, w, h, feather * 2 + 1);
  inpaint(pixels, solve, w, h, searchMaxDim, seed);
  for (int i = 0; i < n; i++)
    if (soft[i] > alpha[i]) alpha[i] = soft[i];
}

void hk_histogram(const uint8_t *px, size_t len, int32_t step, uint32_t *bins, uint32_t *total, double *clipLow, double *clipHigh) {
  std::memset(bins, 0, sizeof(uint32_t) * 1024);
  uint32_t count = 0, lo = 0, hi = 0;
  const size_t stride = 4 * (size_t)step;
  for (size_t i = 0; i < len; i += stride) {
    const int R = px[i], G = px[i + 1], B = px[i + 2];
    bins[R]++;
    bins[256 + G]++;
    bins[512 + B]++;
    bins[768 + (int)jsRound(0.2126 * R + 0.7152 * G + 0.0722 * B)]++;
    if (R <= 1 || G <= 1 || B <= 1) lo++;
    if (R >= 254 || G >= 254 || B >= 254) hi++;
    count++;
  }
  *total = count;
  *clipLow = count ? (double)lo / count : 0;
  *clipHigh = count ? (double)hi / count : 0;
}

void hk_sky_mask(const uint8_t *px, int32_t w, int32_t h, uint8_t *out) {
  const int n = w * h;
  vector<float> score(n), lum(n);
  for (int i = 0; i < n; i++) {
    const double R = px[i * 4] / 255.0, G = px[i * 4 + 1] / 255.0, B = px[i * 4 + 2] / 255.0;
    lum[i] = (float)(0.2126 * R + 0.7152 * G + 0.0722 * B);
  }
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      const int i = y * w + x;
      const double R = px[i * 4] / 255.0, G = px[i * 4 + 1] / 255.0, B = px[i * 4 + 2] / 255.0;
      const double l = lum[i];
      // local gradient magnitude (texture)
      const double lx = (double)lum[y * w + min(w - 1, x + 1)] - (double)lum[y * w + max(0, x - 1)];
      const double ly = (double)lum[min(h - 1, y + 1) * w + x] - (double)lum[max(0, y - 1) * w + x];
      const double grad = std::sqrt(lx * lx + ly * ly);
      const double blueness = clampTo((B - R) * 3 + 0.4, 0, 1);
      const double neutralBright = l > 0.7 && max(R, max(G, B)) - min(R, min(G, B)) < 0.12 ? 0.8 : 0;
      const double color = max(blueness * (B > G * 0.9 ? 1 : 0.5), neutralBright);
      const double bright = clampTo((l - 0.25) * 2.5, 0, 1);
      const double smooth = clampTo(1 - grad * 12, 0, 1);
      const double vertical = clampTo(1.3 - ((double)y / h) * 1.2, 0, 1);
      score[i] = (float)(color * bright * smooth * vertical);
    }
  }
  // flood fill from the top row through pixels above threshold
  std::memset(out, 0, n);
  vector<uint8_t> seen(n, 0);
  vector<int> stack;
  for (int x = 0; x < w; x++)
    if (score[x] > 0.35) stack.push_back(x);
  while (!stack.empty()) {
    const int i = stack.back();
    stack.pop_back();
    if (seen[i]) continue;
    seen[i] = 1;
    if (score[i] < 0.25) continue;
    out[i] = (uint8_t)jsRound(clampTo((double)score[i] * 1.6, 0, 1) * 255);
    const int x = i % w;
    const int y = i / w;
    if (x > 0) stack.push_back(i - 1);
    if (x < w - 1) stack.push_back(i + 1);
    if (y > 0) stack.push_back(i - w);
    if (y < h - 1) stack.push_back(i + w);
  }
  // fill holes inside the sky body: everything above the lowest sky pixel per column with high score
  for (int x = 0; x < w; x++) {
    int lowest = -1;
    for (int y = 0; y < h; y++)
      if (out[y * w + x] > 128) lowest = y;
    for (int y = 0; y < lowest; y++) {
      const int i = y * w + x;
      if (out[i] < 200 && score[i] > 0.1) out[i] = 230;
    }
  }
}

void hk_auto_adjust(const uint8_t *px, size_t len, double *light, double *wb) {
  uint32_t bins[1024];
  uint32_t total = 0;
  double clipLow = 0, clipHigh = 0;
  hk_histogram(px, len, 1, bins, &total, &clipLow, &clipHigh);
  const Light L = autoTone(bins + 768, total, clipHigh);
  light[0] = L.exposure;
  light[1] = L.contrast;
  light[2] = L.highlights;
  light[3] = L.shadows;
  light[4] = L.whites;
  light[5] = L.blacks;
  autoWhiteBalance(px, len, wb);
}

void hk_blur_planar8(uint8_t *plane, int32_t w, int32_t h, double sigma) {
  const int r = (int)std::ceil(3 * sigma);
  vector<float> kernel(2 * r + 1);
  float total = 0;
  for (int i = -r; i <= r; i++) {
    kernel[i + r] = (float)std::exp(-0.5 * i * i / (sigma * sigma));
    total += kernel[i + r];
  }
  for (float &k : kernel) k /= total;
  vector<float> a(w * h), b(w * h);
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      float sum = 0;
      for (int i = -r; i <= r; i++) sum += kernel[i + r] * plane[y * w + min(w - 1, max(0, x + i))];
      a[y * w + x] = sum;
    }
  for (int x = 0; x < w; x++)
    for (int y = 0; y < h; y++) {
      float sum = 0;
      for (int i = -r; i <= r; i++) sum += kernel[i + r] * a[min(h - 1, max(0, y + i)) * w + x];
      b[y * w + x] = sum;
    }
  for (int i = 0; i < w * h; i++) plane[i] = (uint8_t)(b[i] + 0.5f);
}

void hk_compose_stroke(uint8_t *mask, int32_t maskW, int32_t maskH, const uint8_t *coverage, int32_t x, int32_t y, int32_t w, int32_t h, double flow, int32_t erase) {
  for (int row = max(0, -y); row < h && y + row < maskH; row++) {
    for (int col = max(0, -x); col < w && x + col < maskW; col++) {
      const double k = flow * coverage[row * w + col] / 255.0;
      if (k <= 0) continue;
      uint8_t &d = mask[(y + row) * maskW + x + col];
      d = (uint8_t)jsRound(erase ? d * (1 - k) : d + k * (255 - d));
    }
  }
}

void hk_gray_to_rgba(const uint8_t *gray, int32_t n, uint8_t *out) {
  for (int i = 0; i < n; i++) {
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = gray[i];
    out[i * 4 + 3] = 255;
  }
}

void hk_region_area(const uint8_t *rgba, int32_t maskW, int32_t maskH, int32_t W, int32_t H, int32_t x, int32_t y, int32_t w, int32_t h, int32_t threshold, uint8_t *out) {
  const auto red = [&](int px, int py) { return (double)rgba[(min(maskH - 1, max(0, py)) * maskW + min(maskW - 1, max(0, px))) * 4]; };
  for (int j = 0; j < h; j++) {
    const double v = (y + j + 0.5) / H * maskH - 0.5;
    const int v0 = (int)std::floor(v);
    const double tv = v - v0;
    for (int i = 0; i < w; i++) {
      const double u = (x + i + 0.5) / W * maskW - 0.5;
      const int u0 = (int)std::floor(u);
      const double tu = u - u0;
      const double top = red(u0, v0) * (1 - tu) + red(u0 + 1, v0) * tu;
      const double bottom = red(u0, v0 + 1) * (1 - tu) + red(u0 + 1, v0 + 1) * tu;
      out[j * w + i] = top * (1 - tv) + bottom * tv > threshold ? 1 : 0;
    }
  }
}

void hk_apply_watermark(uint8_t *dst, int32_t w, int32_t h, const uint8_t *alpha, int32_t alphaRowBytes, int32_t bits) {
  for (int y = 0; y < h; y++) {
    for (int x = 0; x < w; x++) {
      const double a = alpha[y * alphaRowBytes + x] / 255.0;
      if (a <= 0) continue;
      if (bits == 16) {
        uint16_t *p = reinterpret_cast<uint16_t *>(dst) + (size_t)(y * w + x) * 4;
        for (int c = 0; c < 3; c++) p[c] = (uint16_t)jsRound(p[c] * (1 - a) + 65535 * a);
      } else {
        uint8_t *p = dst + (size_t)(y * w + x) * 4;
        for (int c = 0; c < 3; c++) p[c] = (uint8_t)jsRound(p[c] * (1 - a) + 255 * a);
      }
    }
  }
}
