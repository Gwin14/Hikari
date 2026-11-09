// Command-line front for modules/hikari-native/ios/compute, driven by computeParity.test.ts.
// usage: harness <op> <dir> <numeric args...>; buffers are files inside <dir>.
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

#include "hikari_compute.h"

using Bytes = std::vector<uint8_t>;

static std::string dir;

static Bytes load(const char *name) {
  std::ifstream f(dir + "/" + name, std::ios::binary);
  return Bytes(std::istreambuf_iterator<char>(f), {});
}

static void save(const char *name, const void *p, size_t n) {
  std::ofstream(dir + "/" + name, std::ios::binary).write(static_cast<const char *>(p), n);
}

int main(int argc, char **argv) {
  if (argc < 3) return 2;
  const std::string op = argv[1];
  dir = argv[2];
  const auto num = [&](int i) { return std::atof(argv[3 + i]); };
  const auto integer = [&](int i) { return (int)std::atoll(argv[3 + i]); };

  if (op == "refine") {
    const Bytes guide = load("guide"), mask = load("mask");
    const int w = integer(0), h = integer(1);
    Bytes out(w * h);
    hk_refine_mask(guide.data(), mask.data(), mask.size(), w, h, integer(2), num(3), num(4), num(5), out.data());
    save("out", out.data(), out.size());
  } else if (op == "object") {
    const Bytes guide = load("guide"), cov = load("cov"), sel = load("sel");
    const int w = integer(0), h = integer(1);
    Bytes out(w * h);
    hk_object_mask(guide.data(), cov.data(), cov.size(), sel.empty() ? nullptr : sel.data(), sel.size(), w, h, out.data());
    save("out", out.data(), out.size());
  } else if (op == "select") {
    const Bytes labels = load("labels"), cov = load("cov");
    const int n = integer(3);
    Bytes out(n);
    const int picked = hk_select_instances(labels.data(), integer(0), integer(1), cov.data(), integer(2), n, num(4), num(5), out.data());
    save("out", out.data(), out.size());
    std::printf("%d", picked);
  } else if (op == "remove") {
    Bytes pixels = load("pixels"), alpha = load("alpha");
    const Bytes area = load("area");
    hk_remove_spot(reinterpret_cast<float *>(pixels.data()), area.data(), reinterpret_cast<float *>(alpha.data()), integer(0), integer(1), integer(2), integer(3), integer(4), (uint32_t)std::strtoull(argv[3 + 5], nullptr, 10));
    save("pixelsOut", pixels.data(), pixels.size());
    save("alphaOut", alpha.data(), alpha.size());
  } else if (op == "histogram") {
    const Bytes px = load("px");
    uint32_t bins[1024], total = 0;
    double lo = 0, hi = 0;
    hk_histogram(px.data(), px.size(), integer(0), bins, &total, &lo, &hi);
    save("out", bins, sizeof(bins));
    std::printf("%u %.17g %.17g", total, lo, hi);
  } else if (op == "sky") {
    const Bytes px = load("px");
    const int w = integer(0), h = integer(1);
    Bytes out(w * h);
    hk_sky_mask(px.data(), w, h, out.data());
    save("out", out.data(), out.size());
  } else if (op == "auto") {
    const Bytes px = load("px");
    double light[6], wb[2];
    hk_auto_adjust(px.data(), px.size(), light, wb);
    std::printf("%.17g %.17g %.17g %.17g %.17g %.17g %.17g %.17g", light[0], light[1], light[2], light[3], light[4], light[5], wb[0], wb[1]);
  } else {
    return 2;
  }
  return 0;
}
