package expo.modules.hikarinative

/** The image math shared with iOS (ios/compute), through cpp/hikari_jni.cpp. */
object ComputeJni {
  init {
    System.loadLibrary("hikari_raw")
  }

  @JvmStatic external fun refineMask(guide: ByteArray, mask: ByteArray, w: Int, h: Int, radius: Int, eps: Double, lo: Double, hi: Double): ByteArray
  @JvmStatic external fun objectMask(guide: ByteArray, coverage: ByteArray, selected: ByteArray?, w: Int, h: Int): ByteArray
  @JvmStatic external fun selectInstances(labels: ByteArray, labelStride: Int, count: Int, coverage: ByteArray, coverageStride: Int, n: Int, minCover: Double, minShare: Double, out: ByteArray): Int
  @JvmStatic external fun removeSpot(pixels: ByteArray, area: ByteArray, alpha: ByteArray, w: Int, h: Int, grow: Int, feather: Int, searchMaxDim: Int, seed: Int)
  @JvmStatic external fun histogram(pixels: ByteArray, step: Int, bins: IntArray, stats: DoubleArray)
  @JvmStatic external fun skyMask(pixels: ByteArray, w: Int, h: Int): ByteArray
  @JvmStatic external fun autoAdjust(pixels: ByteArray, values: DoubleArray)
  @JvmStatic external fun blurPlanar8(plane: ByteArray, w: Int, h: Int, sigma: Double)
  @JvmStatic external fun composeStroke(mask: ByteArray, maskW: Int, maskH: Int, coverage: ByteArray, x: Int, y: Int, w: Int, h: Int, flow: Double, erase: Boolean)
  @JvmStatic external fun grayToRgba(gray: ByteArray, n: Int, out: ByteArray)
  @JvmStatic external fun regionArea(rgba: ByteArray, maskW: Int, maskH: Int, W: Int, H: Int, x: Int, y: Int, w: Int, h: Int, threshold: Int, out: ByteArray)
  @JvmStatic external fun applyWatermark(dst: ByteArray, w: Int, h: Int, alpha: ByteArray, alphaRowBytes: Int, bits: Int)
}
