package expo.modules.hikarinative

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions
import kotlinx.coroutines.tasks.await
import java.io.File
import java.io.FileOutputStream
import java.nio.FloatBuffer

/** On-device subject / person masks through ML Kit. Sky masks are computed in JS. */
object Segmenter {
  suspend fun segment(context: Context, uri: Uri, name: String, kind: String, maxDim: Int, preferRaw: Boolean): Map<String, Any>? {
    val dim = if (maxDim > 0) maxDim else 2048
    val bitmap = inputBitmap(context, uri, name, dim, preferRaw)
    val image = InputImage.fromBitmap(bitmap, 0)
    val (mask, w, h) = when (kind) {
      "person" -> {
        val seg = Segmentation.getClient(
          SelfieSegmenterOptions.Builder().setDetectorMode(SelfieSegmenterOptions.SINGLE_IMAGE_MODE).build(),
        )
        val r = seg.process(image).await()
        seg.close()
        Triple(r.buffer.asFloatBuffer(), r.width, r.height)
      }
      else -> {
        val seg = SubjectSegmentation.getClient(
          SubjectSegmenterOptions.Builder().enableForegroundConfidenceMask().build(),
        )
        val r = seg.process(image).await()
        seg.close()
        val buf = r.foregroundConfidenceMask ?: return null
        Triple(buf, bitmap.width, bitmap.height)
      }
    }
    return writeMask(context, mask, w, h)
  }

  /**
   * Every subject ML Kit finds, as a label map (0 = background, k = k-th subject) at bitmap
   * resolution. Lets JS pick the objects a rough brush selection is about.
   */
  suspend fun instances(context: Context, uri: Uri, name: String, maxDim: Int, preferRaw: Boolean): Map<String, Any>? {
    val bitmap = inputBitmap(context, uri, name, if (maxDim > 0) maxDim else 2048, preferRaw)
    val seg = SubjectSegmentation.getClient(
      SubjectSegmenterOptions.Builder()
        .enableMultipleSubjects(SubjectSegmenterOptions.SubjectResultOptions.Builder().enableConfidenceMask().build())
        .build(),
    )
    val r = seg.process(InputImage.fromBitmap(bitmap, 0)).await()
    seg.close()
    val subjects = r.subjects.take(254)
    if (subjects.isEmpty()) return null
    val w = bitmap.width
    val h = bitmap.height
    val labels = IntArray(w * h)
    val best = FloatArray(w * h) { 0.5f }
    subjects.forEachIndexed { k, s ->
      val m = s.confidenceMask ?: return@forEachIndexed
      m.rewind()
      for (y in 0 until s.height) {
        for (x in 0 until s.width) {
          val v = m.get()
          val gx = s.startX + x
          val gy = s.startY + y
          if (gx >= w || gy >= h) continue
          val i = gy * w + gx
          if (v > best[i]) {
            best[i] = v
            labels[i] = k + 1
          }
        }
      }
    }
    val px = IntArray(w * h) { (0xff shl 24) or (labels[it] shl 16) or (labels[it] shl 8) or labels[it] }
    return writePng(context, px, w, h) + ("count" to subjects.size)
  }

  private fun inputBitmap(context: Context, uri: Uri, name: String, maxDim: Int, preferRaw: Boolean): Bitmap {
    if (preferRaw && RawDecoder.isRaw(name)) {
      val decoded = RawDecoder.decode(context, uri, name, maxDim, true, null)
      // Re-decode at 8 bit through the processed path of the developed pixels.
      if (decoded.format == "rgba16f") {
        val f16 = Bitmap.createBitmap(decoded.width, decoded.height, Bitmap.Config.RGBA_F16, true,
          android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.EXTENDED_SRGB))
        f16.copyPixelsFromBuffer(java.nio.ByteBuffer.wrap(File(Uri.parse(decoded.path).path!!).readBytes()))
        return Encoder.convert(f16, android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB), false)
      }
      return BitmapFactory.decodeFile(Uri.parse(decoded.path).path!!)
    }
    val bmp = RawDecoder.decodeBitmap(context, uri, maxDim, allowWide = false).first
    return if (bmp.config == Bitmap.Config.ARGB_8888) bmp else bmp.copy(Bitmap.Config.ARGB_8888, false)
  }

  private fun writeMask(context: Context, mask: FloatBuffer, w: Int, h: Int): Map<String, Any> {
    mask.rewind()
    val px = IntArray(w * h)
    for (i in 0 until w * h) {
      val v = (mask.get().coerceIn(0f, 1f) * 255f).toInt()
      px[i] = (0xff shl 24) or (v shl 16) or (v shl 8) or v
    }
    return writePng(context, px, w, h)
  }

  private fun writePng(context: Context, px: IntArray, w: Int, h: Int): Map<String, Any> {
    val bmp = Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
    val file = RawDecoder.tempFile(context, "png")
    FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    return mapOf("path" to Uri.fromFile(file).toString(), "width" to w, "height" to h)
  }
}

