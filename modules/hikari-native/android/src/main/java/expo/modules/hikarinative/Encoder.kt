package expo.modules.hikarinative

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorSpace
import android.graphics.Paint
import android.net.Uri
import android.os.Build
import androidx.exifinterface.media.ExifInterface
import androidx.heifwriter.HeifWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

object Encoder {
  fun colorSpace(name: String): ColorSpace = ColorSpace.get(
    when (name) {
      "p3" -> ColorSpace.Named.DISPLAY_P3
      "adobergb" -> ColorSpace.Named.ADOBE_RGB
      else -> ColorSpace.Named.SRGB
    },
  )

  /** Wraps the JS pixel buffer in a Bitmap tagged with its color space. */
  fun inputBitmap(pixels: ByteArray, width: Int, height: Int, format: String, space: String): Bitmap {
    val cs = when {
      format == "rgba16f" -> ColorSpace.get(ColorSpace.Named.EXTENDED_SRGB)
      space == "p3" -> ColorSpace.get(ColorSpace.Named.DISPLAY_P3)
      else -> ColorSpace.get(ColorSpace.Named.SRGB)
    }
    if (format == "rgba16") {
      // 16-bit integer code values → half floats (Android has no 16-bit integer bitmap config)
      val src = ByteBuffer.wrap(pixels).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
      val dst = ByteBuffer.allocate(width * height * 8).order(ByteOrder.nativeOrder())
      val out = dst.asShortBuffer()
      for (i in 0 until width * height * 4) {
        val v = (src.get(i).toInt() and 0xffff) / 65535f
        out.put(i, android.util.Half.toHalf(if (i % 4 == 3) 1f else v))
      }
      val bmp = Bitmap.createBitmap(width, height, Bitmap.Config.RGBA_F16, true, cs)
      bmp.copyPixelsFromBuffer(dst)
      return bmp
    }
    val half = format == "rgba16f"
    val bmp = Bitmap.createBitmap(width, height, if (half) Bitmap.Config.RGBA_F16 else Bitmap.Config.ARGB_8888, true, cs)
    bmp.copyPixelsFromBuffer(ByteBuffer.wrap(pixels))
    return bmp
  }

  /** Color-managed conversion into the export color space. */
  fun convert(src: Bitmap, target: ColorSpace, wide: Boolean): Bitmap {
    val config = if (wide) Bitmap.Config.RGBA_F16 else Bitmap.Config.ARGB_8888
    if (src.colorSpace == target && src.config == config) return src
    val out = Bitmap.createBitmap(src.width, src.height, config, false, target)
    Canvas(out).drawBitmap(src, 0f, 0f, Paint(Paint.FILTER_BITMAP_FLAG))
    return out
  }

  fun encode(context: Context, pixels: ByteArray, width: Int, height: Int, o: EncodeOptions, metadataSource: Uri?): Map<String, Any> {
    val out = File(Uri.parse(o.outputPath).path!!)
    out.parentFile?.mkdirs()
    if (out.exists()) out.delete()
    val input = inputBitmap(pixels, width, height, o.inputFormat, o.inputColorSpace)
    val sixteen = o.bitDepth == 16 && (o.format == "tiff" || o.format == "png")
    val bmp = convert(input, colorSpace(o.colorSpace), sixteen)
    val q = (o.quality * 100).toInt().coerceIn(1, 100)
    when (o.format) {
      "jpeg" -> FileOutputStream(out).use { bmp.compress(Bitmap.CompressFormat.JPEG, q, it) }
      "png" -> FileOutputStream(out).use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
      "webp" -> FileOutputStream(out).use {
        val fmt = if (Build.VERSION.SDK_INT >= 30) {
          if (q >= 100) Bitmap.CompressFormat.WEBP_LOSSLESS else Bitmap.CompressFormat.WEBP_LOSSY
        } else @Suppress("DEPRECATION") Bitmap.CompressFormat.WEBP
        bmp.compress(fmt, q, it)
      }
      "heic" -> {
        val writer = HeifWriter.Builder(out.path, width, height, HeifWriter.INPUT_MODE_BITMAP)
          .setQuality(q).setMaxImages(1).build()
        writer.start()
        writer.addBitmap(if (bmp.config == Bitmap.Config.ARGB_8888) bmp else bmp.copy(Bitmap.Config.ARGB_8888, false))
        writer.stop(30_000)
        writer.close()
      }
      "tiff" -> FileOutputStream(out).use { TiffWriter.write(bmp, sixteen, it) }
      else -> throw IllegalArgumentException("Unsupported format ${o.format}")
    }
    if (o.format == "jpeg" || o.format == "png" || o.format == "webp") {
      Metadata.copy(context, metadataSource, out, o)
    }
    return mapOf("path" to Uri.fromFile(out).toString(), "size" to out.length())
  }
}

/** Minimal baseline TIFF writer (RGB, 8 or 16 bits per sample, uncompressed, single strip). */
object TiffWriter {
  fun write(bmp: Bitmap, sixteen: Boolean, os: OutputStream) {
    val w = bmp.width
    val h = bmp.height
    val bps = if (sixteen) 16 else 8
    val bytesPerSample = bps / 8
    val dataSize = w * h * 3 * bytesPerSample
    val entries = 11
    val ifdOffset = 8
    val ifdSize = 2 + entries * 12 + 4
    val bpsOffset = ifdOffset + ifdSize
    val resOffset = bpsOffset + 6
    val dataOffset = resOffset + 16
    val header = ByteBuffer.allocate(dataOffset).order(ByteOrder.LITTLE_ENDIAN)
    header.put('I'.code.toByte()).put('I'.code.toByte()).putShort(42).putInt(ifdOffset)
    header.putShort(entries.toShort())
    fun tag(t: Int, type: Int, count: Int, value: Int) {
      header.putShort(t.toShort()).putShort(type.toShort()).putInt(count)
      if (type == 3 && count == 1) header.putShort(value.toShort()).putShort(0) else header.putInt(value)
    }
    tag(256, 4, 1, w) // ImageWidth
    tag(257, 4, 1, h) // ImageLength
    tag(258, 3, 3, bpsOffset) // BitsPerSample
    tag(259, 3, 1, 1) // Compression: none
    tag(262, 3, 1, 2) // Photometric: RGB
    tag(273, 4, 1, dataOffset) // StripOffsets
    tag(277, 3, 1, 3) // SamplesPerPixel
    tag(278, 4, 1, h) // RowsPerStrip
    tag(279, 4, 1, dataSize) // StripByteCounts
    tag(282, 5, 1, resOffset) // XResolution
    tag(283, 5, 1, resOffset + 8) // YResolution
    header.putInt(0)
    repeat(3) { header.putShort(bps.toShort()) }
    header.putInt(300).putInt(1).putInt(300).putInt(1)
    os.write(header.array())

    val row = ByteBuffer.allocate(w * 3 * bytesPerSample).order(ByteOrder.LITTLE_ENDIAN)
    if (sixteen) {
      // RGBA_F16 → clamp → 16-bit integers.
      val px = ByteBuffer.allocate(bmp.byteCount).order(ByteOrder.nativeOrder())
      bmp.copyPixelsToBuffer(px)
      px.rewind()
      val shorts = px.asShortBuffer()
      for (y in 0 until h) {
        row.clear()
        for (x in 0 until w) {
          val i = (y * w + x) * 4
          for (c in 0 until 3) {
            val f = android.util.Half.toFloat(shorts.get(i + c)).coerceIn(0f, 1f)
            row.putShort((f * 65535f + 0.5f).toInt().toShort())
          }
        }
        os.write(row.array())
      }
    } else {
      val line = IntArray(w)
      for (y in 0 until h) {
        row.clear()
        bmp.getPixels(line, 0, w, 0, y, w, 1)
        for (p in line) {
          row.put(((p shr 16) and 0xff).toByte()).put(((p shr 8) and 0xff).toByte()).put((p and 0xff).toByte())
        }
        os.write(row.array())
      }
    }
  }
}

fun ExifInterface.copyFrom(src: ExifInterface, tags: List<String>) {
  for (t in tags) src.getAttribute(t)?.let { setAttribute(t, it) }
}
