// JNI bridge to LibRaw: demosaics a RAW file into an RGBA half-float buffer holding
// gamma-encoded *extended* sRGB (values above 1.0 preserve recovered highlights), oriented
// and box-downscaled to the requested long edge. Mirrors what CIRAWFilter produces on iOS.
#include <jni.h>
#include <android/log.h>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <vector>

#include "libraw/libraw.h"

#define LOG_TAG "HikariRaw"
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, LOG_TAG, __VA_ARGS__)

namespace {

uint16_t toHalf(float f) {
  uint32_t x;
  std::memcpy(&x, &f, 4);
  uint32_t sign = (x >> 16) & 0x8000;
  int32_t exp = static_cast<int32_t>((x >> 23) & 0xff) - 127 + 15;
  uint32_t mant = x & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return static_cast<uint16_t>(sign);
    mant = (mant | 0x800000) >> (1 - exp);
    return static_cast<uint16_t>(sign | ((mant + 0x1000) >> 13));
  }
  if (exp >= 31) return static_cast<uint16_t>(sign | 0x7c00);
  return static_cast<uint16_t>(sign | (exp << 10) | ((mant + 0x1000) >> 13));
}

float encodeSrgb(float v) {
  float a = std::fabs(v);
  float e = a <= 0.0031308f ? a * 12.92f : 1.055f * std::pow(a, 1.0f / 2.4f) - 0.055f;
  return v < 0 ? -e : e;
}

// LibRaw is asked for half brightness so one stop of highlight headroom survives the 16-bit output.
constexpr float kHeadroom = 2.0f;

}  // namespace

extern "C" JNIEXPORT jintArray JNICALL
Java_expo_modules_hikarinative_RawDecoder_nativeDecode(JNIEnv* env, jclass, jstring jpath, jstring jout,
                                                       jint maxDim, jfloat noise, jboolean highlight) {
  const char* path = env->GetStringUTFChars(jpath, nullptr);
  const char* out = env->GetStringUTFChars(jout, nullptr);
  auto raw = std::make_unique<LibRaw>();
  jintArray result = nullptr;

  do {
    if (raw->open_file(path) != LIBRAW_SUCCESS) { LOGE("open_file failed"); break; }
    int fullW = raw->imgdata.sizes.width;
    int fullH = raw->imgdata.sizes.height;
    if (raw->imgdata.sizes.flip & 4) std::swap(fullW, fullH);
    // Half-size demosaic is 4x faster and plenty for previews.
    bool half = maxDim > 0 && std::max(fullW, fullH) / 2 >= maxDim;

    auto& p = raw->imgdata.params;
    p.output_bps = 16;
    p.gamm[0] = 1.0;
    p.gamm[1] = 1.0;
    p.no_auto_bright = 1;
    p.bright = 1.0f / kHeadroom;
    p.use_camera_wb = 1;
    p.use_camera_matrix = 1;
    p.output_color = 1;  // sRGB primaries
    p.half_size = half ? 1 : 0;
    p.highlight = highlight ? 2 : 0;
    p.user_qual = 3;  // AHD
    if (noise > 0.01f) {
      p.threshold = 50.0f + noise * 450.0f;
      p.fbdd_noiserd = noise > 0.5f ? 2 : 1;
    }

    if (raw->unpack() != LIBRAW_SUCCESS) { LOGE("unpack failed"); break; }
    if (raw->dcraw_process() != LIBRAW_SUCCESS) { LOGE("dcraw_process failed"); break; }
    int err = 0;
    libraw_processed_image_t* img = raw->dcraw_make_mem_image(&err);
    if (!img || img->type != LIBRAW_IMAGE_BITMAP || img->colors != 3 || img->bits != 16) {
      LOGE("make_mem_image failed %d", err);
      if (img) LibRaw::dcraw_clear_mem(img);
      break;
    }
    const int sw = img->width;
    const int sh = img->height;
    const uint16_t* src = reinterpret_cast<const uint16_t*>(img->data);

    // Integer box factor so the long edge ends up <= maxDim (never upscales).
    int factor = 1;
    if (maxDim > 0) factor = std::max(1, (std::max(sw, sh) + maxDim - 1) / maxDim);
    const int dw = std::max(1, sw / factor);
    const int dh = std::max(1, sh / factor);
    std::vector<uint16_t> dst(static_cast<size_t>(dw) * dh * 4);
    const float inv = kHeadroom / (65535.0f * factor * factor);
    const uint16_t one = toHalf(1.0f);

    for (int y = 0; y < dh; y++) {
      for (int x = 0; x < dw; x++) {
        float r = 0, g = 0, b = 0;
        for (int yy = 0; yy < factor; yy++) {
          const uint16_t* row = src + (static_cast<size_t>(y * factor + yy) * sw + x * factor) * 3;
          for (int xx = 0; xx < factor; xx++) {
            r += row[xx * 3];
            g += row[xx * 3 + 1];
            b += row[xx * 3 + 2];
          }
        }
        uint16_t* o = &dst[(static_cast<size_t>(y) * dw + x) * 4];
        o[0] = toHalf(encodeSrgb(r * inv));
        o[1] = toHalf(encodeSrgb(g * inv));
        o[2] = toHalf(encodeSrgb(b * inv));
        o[3] = one;
      }
    }
    LibRaw::dcraw_clear_mem(img);

    FILE* f = std::fopen(out, "wb");
    if (!f) { LOGE("cannot write %s", out); break; }
    std::fwrite(dst.data(), sizeof(uint16_t), dst.size(), f);
    std::fclose(f);

    jint dims[4] = {dw, dh, fullW, fullH};
    result = env->NewIntArray(4);
    env->SetIntArrayRegion(result, 0, 4, dims);
  } while (false);

  raw->recycle();
  env->ReleaseStringUTFChars(jpath, path);
  env->ReleaseStringUTFChars(jout, out);
  return result;
}

extern "C" JNIEXPORT jbyteArray JNICALL
Java_expo_modules_hikarinative_RawDecoder_nativeThumbnail(JNIEnv* env, jclass, jstring jpath) {
  const char* path = env->GetStringUTFChars(jpath, nullptr);
  auto raw = std::make_unique<LibRaw>();
  jbyteArray result = nullptr;
  if (raw->open_file(path) == LIBRAW_SUCCESS && raw->unpack_thumb() == LIBRAW_SUCCESS) {
    int err = 0;
    libraw_processed_image_t* t = raw->dcraw_make_mem_thumb(&err);
    if (t && t->type == LIBRAW_IMAGE_JPEG) {
      result = env->NewByteArray(static_cast<jsize>(t->data_size));
      env->SetByteArrayRegion(result, 0, static_cast<jsize>(t->data_size), reinterpret_cast<const jbyte*>(t->data));
    }
    if (t) LibRaw::dcraw_clear_mem(t);
  }
  raw->recycle();
  env->ReleaseStringUTFChars(jpath, path);
  return result;
}
