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
    val dim = if (maxDim > 0) maxDim else 1536
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
    val bmp = Bitmap.createBitmap(px, w, h, Bitmap.Config.ARGB_8888)
    val file = RawDecoder.tempFile(context, "png")
    FileOutputStream(file).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
    return mapOf("path" to Uri.fromFile(file).toString(), "width" to w, "height" to h)
  }
}

