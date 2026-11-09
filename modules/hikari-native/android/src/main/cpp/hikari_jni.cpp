// JNI bridge to the shared image math in ios/compute.
#include <jni.h>

#include <cstdint>

#include "hikari_compute.h"

namespace {

/** Byte array pinned (or copied) for the call; writes back on destruction unless read-only. */
class Bytes {
 public:
  Bytes(JNIEnv *env, jbyteArray array, bool readOnly = true) : env_(env), array_(array), readOnly_(readOnly) {
    if (array_) {
      data_ = env_->GetByteArrayElements(array_, nullptr);
      size_ = env_->GetArrayLength(array_);
    }
  }
  ~Bytes() {
    if (array_) env_->ReleaseByteArrayElements(array_, data_, readOnly_ ? JNI_ABORT : 0);
  }
  uint8_t *u8() const { return reinterpret_cast<uint8_t *>(data_); }
  float *f32() const { return reinterpret_cast<float *>(data_); }
  size_t size() const { return static_cast<size_t>(size_); }

 private:
  JNIEnv *env_;
  jbyteArray array_;
  bool readOnly_;
  jbyte *data_ = nullptr;
  jsize size_ = 0;
};

}  // namespace

#define JNI_FN(ret, name) extern "C" JNIEXPORT ret JNICALL Java_expo_modules_hikarinative_ComputeJni_##name

JNI_FN(jbyteArray, refineMask)(JNIEnv *env, jobject, jbyteArray guide, jbyteArray mask, jint w, jint h, jint radius, jdouble eps, jdouble lo, jdouble hi) {
  Bytes g(env, guide), m(env, mask);
  jbyteArray out = env->NewByteArray(w * h);
  Bytes o(env, out, false);
  hk_refine_mask(g.u8(), m.u8(), m.size(), w, h, radius, eps, lo, hi, o.u8());
  return out;
}

JNI_FN(jbyteArray, objectMask)(JNIEnv *env, jobject, jbyteArray guide, jbyteArray coverage, jbyteArray selected, jint w, jint h) {
  Bytes g(env, guide), c(env, coverage), s(env, selected);
  jbyteArray out = env->NewByteArray(w * h);
  Bytes o(env, out, false);
  hk_object_mask(g.u8(), c.u8(), c.size(), selected ? s.u8() : nullptr, s.size(), w, h, o.u8());
  return out;
}

JNI_FN(jint, selectInstances)(JNIEnv *env, jobject, jbyteArray labels, jint labelStride, jint count, jbyteArray coverage, jint coverageStride, jint n, jdouble minCover, jdouble minShare, jbyteArray out) {
  Bytes l(env, labels), c(env, coverage), o(env, out, false);
  return hk_select_instances(l.u8(), labelStride, count, c.u8(), coverageStride, n, minCover, minShare, o.u8());
}

JNI_FN(void, removeSpot)(JNIEnv *env, jobject, jbyteArray pixels, jbyteArray area, jbyteArray alpha, jint w, jint h, jint grow, jint feather, jint searchMaxDim, jint seed) {
  Bytes p(env, pixels, false), r(env, area), a(env, alpha, false);
  hk_remove_spot(p.f32(), r.u8(), a.f32(), w, h, grow, feather, searchMaxDim, static_cast<uint32_t>(seed));
}

JNI_FN(void, histogram)(JNIEnv *env, jobject, jbyteArray pixels, jint step, jintArray bins, jdoubleArray stats) {
  Bytes p(env, pixels);
  uint32_t b[1024];
  uint32_t total = 0;
  double low = 0, high = 0;
  hk_histogram(p.u8(), p.size() - p.size() % 4, step, b, &total, &low, &high);
  env->SetIntArrayRegion(bins, 0, 1024, reinterpret_cast<const jint *>(b));
  const double values[3] = {static_cast<double>(total), low, high};
  env->SetDoubleArrayRegion(stats, 0, 3, values);
}

JNI_FN(jbyteArray, skyMask)(JNIEnv *env, jobject, jbyteArray pixels, jint w, jint h) {
  Bytes p(env, pixels);
  jbyteArray out = env->NewByteArray(w * h);
  Bytes o(env, out, false);
  hk_sky_mask(p.u8(), w, h, o.u8());
  return out;
}

JNI_FN(void, autoAdjust)(JNIEnv *env, jobject, jbyteArray pixels, jdoubleArray values) {
  Bytes p(env, pixels);
  double light[6], wb[2];
  hk_auto_adjust(p.u8(), p.size() - p.size() % 4, light, wb);
  env->SetDoubleArrayRegion(values, 0, 6, light);
  env->SetDoubleArrayRegion(values, 6, 2, wb);
}

JNI_FN(void, blurPlanar8)(JNIEnv *env, jobject, jbyteArray plane, jint w, jint h, jdouble sigma) {
  Bytes p(env, plane, false);
  hk_blur_planar8(p.u8(), w, h, sigma);
}

JNI_FN(void, composeStroke)(JNIEnv *env, jobject, jbyteArray mask, jint maskW, jint maskH, jbyteArray coverage, jint x, jint y, jint w, jint h, jdouble flow, jboolean erase) {
  Bytes m(env, mask, false), c(env, coverage);
  hk_compose_stroke(m.u8(), maskW, maskH, c.u8(), x, y, w, h, flow, erase ? 1 : 0);
}

JNI_FN(void, grayToRgba)(JNIEnv *env, jobject, jbyteArray gray, jint n, jbyteArray out) {
  Bytes g(env, gray), o(env, out, false);
  hk_gray_to_rgba(g.u8(), n, o.u8());
}

JNI_FN(void, regionArea)(JNIEnv *env, jobject, jbyteArray rgba, jint maskW, jint maskH, jint W, jint H, jint x, jint y, jint w, jint h, jint threshold, jbyteArray out) {
  Bytes r(env, rgba), o(env, out, false);
  hk_region_area(r.u8(), maskW, maskH, W, H, x, y, w, h, threshold, o.u8());
}

JNI_FN(void, applyWatermark)(JNIEnv *env, jobject, jbyteArray dst, jint w, jint h, jbyteArray alpha, jint alphaRowBytes, jint bits) {
  Bytes d(env, dst, false), a(env, alpha);
  hk_apply_watermark(d.u8(), w, h, a.u8(), alphaRowBytes, bits);
}
