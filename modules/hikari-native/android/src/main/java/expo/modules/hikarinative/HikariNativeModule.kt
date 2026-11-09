package expo.modules.hikarinative

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import android.provider.OpenableColumns
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.hikarinative.render.EditorRenderView
import expo.modules.hikarinative.render.EditorSurface
import expo.modules.hikarinative.render.GlEngine
import expo.modules.hikarinative.render.MaskRaster
import expo.modules.hikarinative.render.NativeRenderImage
import expo.modules.hikarinative.render.RenderBridge
import expo.modules.hikarinative.render.RenderInputsRecord
import expo.modules.hikarinative.render.RenderPatchRecord
import expo.modules.hikarinative.render.StrokeRecord
import expo.modules.hikarinative.render.WatermarkRecord
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class RawDecodeOptions : Record {
  @Field var decodeNoise: Double = 0.0
  @Field var highlightRecovery: Boolean = true
  @Field var lensCorrection: Boolean = true
  @Field var boost: Double = 100.0
}

class DecodeOptions : Record {
  @Field var maxDim: Int = 0
  @Field var preferRaw: Boolean = true
  @Field var raw: RawDecodeOptions? = null
}

class EncodeOptions : Record {
  @Field var format: String = "jpeg"
  @Field var quality: Double = 0.92
  @Field var bitDepth: Int = 8
  @Field var colorSpace: String = "srgb"
  @Field var inputFormat: String = "rgba8"
  @Field var inputColorSpace: String = "srgb"
  @Field var metadataSource: String? = null
  @Field var metadata: String = "all"
  @Field var artist: String? = null
  @Field var copyright: String? = null
  @Field var outputPath: String = ""
}

class RefineOptions : Record {
  @Field var radius: Int = 1
  @Field var eps: Double = 1e-4
  @Field var lo: Double = 0.0
  @Field var hi: Double = 1.0
}

class RemoveOptions : Record {
  @Field var grow: Int = 0
  @Field var feather: Int = 1
  @Field var searchMaxDim: Int = 1024
  @Field var seed: Double = 1234567.0
}

class HikariException(message: String) : CodedException(message)

private fun <T> unsupported(message: String): T = throw HikariException(message)

class HikariNativeModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw HikariException("React context unavailable")

  /** Accepts file://, content:// and bare MediaStore ids (from expo-media-library). */
  private fun resolve(uri: String): Uri {
    if (uri.all { it.isDigit() }) {
      return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, uri.toLong())
    }
    val parsed = Uri.parse(uri)
    return if (parsed.scheme == null) Uri.fromFile(java.io.File(uri)) else parsed
  }

  private fun displayName(uri: Uri): String {
    if (uri.scheme == null || uri.scheme == "file") return uri.lastPathSegment ?: ""
    return try {
      context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
        if (c.moveToFirst()) c.getString(0) else null
      } ?: (uri.lastPathSegment ?: "")
    } catch (_: Exception) {
      uri.lastPathSegment ?: ""
    }
  }

  override fun definition() = ModuleDefinition {
    Name("HikariNative")

    Function("supportedRawExtensions") { RawDecoder.rawExtensions }

    Function("isRendererSupported") { GlEngine.isSupported }

    Class("RenderImage", NativeRenderImage::class) {
      Property("id") { o: NativeRenderImage -> o.id }
      Property("width") { o: NativeRenderImage -> o.width }
      Property("height") { o: NativeRenderImage -> o.height }
      Property("fullWidth") { o: NativeRenderImage -> o.fullWidth }
      Property("fullHeight") { o: NativeRenderImage -> o.fullHeight }
      Property("isRaw") { o: NativeRenderImage -> o.isRaw }
      Property("isFloat") { o: NativeRenderImage -> o.isFloat }
      Function("readRgba8") { o: NativeRenderImage, x: Int, y: Int, width: Int, height: Int -> RenderBridge.readRgba8(o, x, y, width, height) }
      Function("readRgba16") { o: NativeRenderImage -> RenderBridge.readRgba16(o) }
      Function("readFloats") { o: NativeRenderImage, x: Int, y: Int, width: Int, height: Int -> RenderBridge.readFloats(o, x, y, width, height) }
      Function("encode") { o: NativeRenderImage, format: String, quality: Double -> RenderBridge.encode(o, format, quality) }
      AsyncFunction("encodeToFile") Coroutine { o: NativeRenderImage, options: EncodeOptions ->
        withContext(Dispatchers.Default) {
          val pixels = if (o.bits16 != null) o.bits16!! else RenderBridge.readRgba8(o, 0, 0, o.width, o.height)
          Encoder.encode(context, pixels, o.width, o.height, options, options.metadataSource?.let { resolve(it) })
        }
      }
    }

    Class("EditorSurface", EditorSurface::class) {
      Constructor { -> EditorSurface() }
      Function("setFrame") { surface: EditorSurface, frame: FloatArray -> surface.setFrame(frame) }
      Function("setInputs") { surface: EditorSurface, inputs: RenderInputsRecord? -> surface.setInputs(inputs?.let { RenderBridge.resolve(it) }) }
      Function("setCurve") { surface: EditorSurface, curve: NativeRenderImage -> surface.setCurve(curve.image!!) }
    }

    View(EditorRenderView::class) {}

    Function("makeRenderImage") { pixels: ByteArray, width: Int, height: Int, format: String -> RenderBridge.makeImage(pixels, width, height, format) }

    AsyncFunction("loadRenderImage") Coroutine { uri: String, options: DecodeOptions ->
      withContext(Dispatchers.IO) {
        val u = resolve(uri)
        val maxDim = GlEngine.maxTextureSize.let { if (options.maxDim in 1..it) options.maxDim else it }
        RenderBridge.load(RawDecoder.decode(context, u, displayName(u), maxDim, options.preferRaw, options.raw))
      }
    }

    AsyncFunction("loadEncodedRenderImage") Coroutine { uri: String ->
      withContext(Dispatchers.IO) { RenderBridge.loadEncoded(context, resolve(uri)) }
    }

    Function("blurRenderImage") { image: NativeRenderImage, sigma: Double, width: Int, height: Int -> RenderBridge.blur(image, sigma.toFloat(), width, height) }

    Function("compositeRenderImage") { source: NativeRenderImage, patches: List<RenderPatchRecord> -> RenderBridge.composite(source, patches) }

    Function("renderOffscreen") { inputs: RenderInputsRecord, frame: FloatArray, width: Int, height: Int, bits: Int, watermark: WatermarkRecord? ->
      RenderBridge.renderOffscreen(inputs, frame, width, height, bits, watermark)
    }

    Function("rasterizeStrokes") { strokes: List<StrokeRecord>, width: Int, height: Int, base: NativeRenderImage? -> MaskRaster.strokes(strokes, width, height, base) }

    Function("rasterizeArea") { strokes: List<StrokeRecord>, frameW: Int, frameH: Int, region: IntArray, objects: NativeRenderImage? ->
      MaskRaster.area(strokes, frameW, frameH, region, objects)
    }

    AsyncFunction("refineMask") Coroutine { guide: ByteArray, mask: ByteArray, width: Int, height: Int, o: RefineOptions ->
      withContext(Dispatchers.Default) { ComputeJni.refineMask(guide, mask, width, height, o.radius, o.eps, o.lo, o.hi) }
    }

    AsyncFunction("objectMask") Coroutine { guide: ByteArray, coverage: ByteArray, selected: ByteArray?, width: Int, height: Int ->
      withContext(Dispatchers.Default) { ComputeJni.objectMask(guide, coverage, selected, width, height) }
    }

    AsyncFunction("selectInstances") Coroutine { labels: ByteArray, labelStride: Int, count: Int, coverage: ByteArray, coverageStride: Int, n: Int, minCover: Double, minShare: Double ->
      withContext(Dispatchers.Default) {
        val mask = ByteArray(n)
        val picked = ComputeJni.selectInstances(labels, labelStride, count, coverage, coverageStride, n, minCover, minShare, mask)
        mapOf("mask" to mask, "picked" to picked)
      }
    }

    AsyncFunction("removeSpot") Coroutine { pixels: ByteArray, area: ByteArray, alpha: ByteArray, width: Int, height: Int, o: RemoveOptions ->
      withContext(Dispatchers.Default) {
        ComputeJni.removeSpot(pixels, area, alpha, width, height, o.grow, o.feather, o.searchMaxDim, o.seed.toLong().toInt())
        mapOf("pixels" to pixels, "alpha" to alpha)
      }
    }

    AsyncFunction("computeHistogram") Coroutine { pixels: ByteArray, step: Int ->
      withContext(Dispatchers.Default) {
        val bins = IntArray(1024)
        val stats = DoubleArray(3)
        ComputeJni.histogram(pixels, step, bins, stats)
        mapOf("bins" to bins.toList(), "total" to stats[0].toInt(), "clipLow" to stats[1], "clipHigh" to stats[2])
      }
    }

    AsyncFunction("skyMask") Coroutine { pixels: ByteArray, width: Int, height: Int ->
      withContext(Dispatchers.Default) { ComputeJni.skyMask(pixels, width, height) }
    }

    AsyncFunction("autoAdjust") Coroutine { pixels: ByteArray ->
      withContext(Dispatchers.Default) {
        val v = DoubleArray(8)
        ComputeJni.autoAdjust(pixels, v)
        mapOf(
          "light" to mapOf("exposure" to v[0], "contrast" to v[1], "highlights" to v[2], "shadows" to v[3], "whites" to v[4], "blacks" to v[5]),
          "temperature" to v[6],
          "tint" to v[7],
        )
      }
    }

    AsyncFunction("decodeImage") Coroutine { uri: String, options: DecodeOptions ->
      withContext(Dispatchers.IO) {
        val u = resolve(uri)
        RawDecoder.decode(context, u, displayName(u), options.maxDim, options.preferRaw, options.raw).toMap()
      }
    }

    AsyncFunction("readMetadata") Coroutine { uri: String ->
      withContext(Dispatchers.IO) {
        val u = resolve(uri)
        Metadata.read(context, u, displayName(u))
      }
    }

    AsyncFunction("encodeImage") Coroutine { pixels: ByteArray, width: Int, height: Int, options: EncodeOptions ->
      withContext(Dispatchers.Default) {
        Encoder.encode(context, pixels, width, height, options, options.metadataSource?.let { resolve(it) })
      }
    }

    AsyncFunction("segment") Coroutine { uri: String, kind: String, maxDim: Int, preferRaw: Boolean ->
      val u = resolve(uri)
      Segmenter.segment(context, u, displayName(u), kind, maxDim, preferRaw)
    }

    AsyncFunction("segmentInstances") Coroutine { uri: String, maxDim: Int, preferRaw: Boolean ->
      val u = resolve(uri)
      Segmenter.instances(context, u, displayName(u), maxDim, preferRaw)
    }

    // Android's MediaStore stores RAW and JPEG as separate items; pairing happens in JS.
    AsyncFunction("assetResources") { _: String -> null as Map<String, Any>? }

    AsyncFunction("exportAssetResource") { assetId: String, _: String -> resolve(assetId).toString() }

    AsyncFunction("saveEditToLibrary") { _: String, _: String, _: String, _: String ->
      unsupported<Boolean>("In-place reversible edits are an iOS Photos feature; save a copy instead")
    }

    AsyncFunction("readLibraryAdjustment") { _: String -> null as String? }
    AsyncFunction("readForeignAdjustment") { _: String, _: String -> null as String? }

    AsyncFunction("revertLibraryEdit") { _: String -> false }

    AsyncFunction("pickFolder") { ->
      unsupported<Map<String, Any>?>("Use Directory.pickDirectoryAsync on Android")
    }

    AsyncFunction("resolveBookmark") { bookmark: String -> mapOf("uri" to bookmark, "stale" to false) }
  }
}
