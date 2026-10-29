package expo.modules.hikarinative

import android.content.Context
import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.net.Uri
import java.io.File
import java.nio.ByteBuffer
import java.util.UUID

data class DecodeResult(
  val path: String,
  val width: Int,
  val height: Int,
  val fullWidth: Int,
  val fullHeight: Int,
  val format: String,
  val isRaw: Boolean,
) {
  fun toMap() = mapOf(
    "path" to path, "width" to width, "height" to height,
    "fullWidth" to fullWidth, "fullHeight" to fullHeight, "format" to format, "isRaw" to isRaw,
  )
}

object RawDecoder {
  init {
    System.loadLibrary("hikari_raw")
  }

  val rawExtensions = listOf(
    "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw",
    "x3f", "3fr", "fff", "iiq", "mos", "mrw", "erf", "kdc", "dcr", "rwl", "gpr",
  )

  @JvmStatic external fun nativeDecode(path: String, out: String, maxDim: Int, noise: Float, highlight: Boolean): IntArray?
  @JvmStatic external fun nativeThumbnail(path: String): ByteArray?

  fun tempFile(context: Context, ext: String): File {
    val dir = File(context.cacheDir, "hikari").apply { mkdirs() }
    return File(dir, "${UUID.randomUUID()}.$ext")
  }

  fun isRaw(name: String) = rawExtensions.contains(name.substringAfterLast('.', "").lowercase())

  /** LibRaw needs a real path; content:// sources are copied into the cache once. */
  fun localPath(context: Context, uri: Uri, name: String): String {
    if (uri.scheme == null || uri.scheme == "file") return uri.path!!
    val cached = File(File(context.cacheDir, "hikari-src").apply { mkdirs() }, "${uri.toString().hashCode()}-$name")
    if (!cached.exists()) {
      context.contentResolver.openInputStream(uri)!!.use { input -> cached.outputStream().use { input.copyTo(it) } }
    }
    return cached.path
  }

  fun decode(context: Context, uri: Uri, name: String, maxDim: Int, preferRaw: Boolean, raw: RawDecodeOptions?): DecodeResult {
    if (preferRaw && isRaw(name)) {
      val path = localPath(context, uri, name)
      val out = tempFile(context, "f16")
      val dims = nativeDecode(path, out.path, maxDim, ((raw?.decodeNoise ?: 0.0) / 100.0).toFloat(), raw?.highlightRecovery ?: true)
      if (dims != null) {
        return DecodeResult(Uri.fromFile(out).toString(), dims[0], dims[1], dims[2], dims[3], "rgba16f", true)
      }
      // LibRaw failed (unsupported camera): fall back to the embedded preview.
      nativeThumbnail(path)?.let { jpeg ->
        val f = tempFile(context, "jpg").apply { writeBytes(jpeg) }
        return decodeProcessed(context, Uri.fromFile(f), maxDim)
      }
    }
    return decodeProcessed(context, uri, maxDim)
  }

  fun source(context: Context, uri: Uri): ImageDecoder.Source =
    if (uri.scheme == null || uri.scheme == "file") ImageDecoder.createSource(File(uri.path!!))
    else ImageDecoder.createSource(context.contentResolver, uri)

  /** Decodes into a software bitmap, oriented, scaled to maxDim; wide-gamut sources stay in F16. */
  fun decodeBitmap(context: Context, uri: Uri, maxDim: Int, allowWide: Boolean = true): Triple<Bitmap, Int, Int> {
    var fullW = 0
    var fullH = 0
    var wide = false
    val bmp = ImageDecoder.decodeBitmap(source(context, uri)) { decoder, info, _ ->
      fullW = info.size.width
      fullH = info.size.height
      decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
      decoder.isMutableRequired = false
      val cs = info.colorSpace
      wide = allowWide && cs != null && cs.isWideGamut
      decoder.setTargetColorSpace(ColorSpace.get(if (wide) ColorSpace.Named.EXTENDED_SRGB else ColorSpace.Named.SRGB))
      val long = maxOf(fullW, fullH)
      if (maxDim in 1 until long) {
        val s = maxDim.toFloat() / long
        decoder.setTargetSize(maxOf(1, (fullW * s).toInt()), maxOf(1, (fullH * s).toInt()))
      }
    }
    val out = if (wide && bmp.config != Bitmap.Config.RGBA_F16) bmp.copy(Bitmap.Config.RGBA_F16, false) else bmp
    return Triple(out, fullW, fullH)
  }

  fun decodeProcessed(context: Context, uri: Uri, maxDim: Int): DecodeResult {
    val (bmp, fullW, fullH) = decodeBitmap(context, uri, maxDim)
    val half = bmp.config == Bitmap.Config.RGBA_F16
    val src = if (!half && bmp.config != Bitmap.Config.ARGB_8888) bmp.copy(Bitmap.Config.ARGB_8888, false) else bmp
    val buf = ByteBuffer.allocate(src.byteCount)
    src.copyPixelsToBuffer(buf)
    val out = tempFile(context, if (half) "f16" else "rgba")
    out.writeBytes(buf.array())
    return DecodeResult(Uri.fromFile(out).toString(), src.width, src.height, fullW, fullH, if (half) "rgba16f" else "rgba8", false)
  }
}
