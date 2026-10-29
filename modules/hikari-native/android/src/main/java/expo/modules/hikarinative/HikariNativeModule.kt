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

    // Android's MediaStore stores RAW and JPEG as separate items; pairing happens in JS.
    AsyncFunction("assetResources") { _: String -> null as Map<String, Any>? }

    AsyncFunction("exportAssetResource") { assetId: String, _: String -> resolve(assetId).toString() }

    AsyncFunction("saveEditToLibrary") { _: String, _: String, _: String, _: String ->
      unsupported<Boolean>("In-place reversible edits are an iOS Photos feature; save a copy instead")
    }

    AsyncFunction("readLibraryAdjustment") { _: String -> null as String? }

    AsyncFunction("revertLibraryEdit") { _: String -> false }

    AsyncFunction("pickFolder") { ->
      unsupported<Map<String, Any>?>("Use Directory.pickDirectoryAsync on Android")
    }

    AsyncFunction("resolveBookmark") { bookmark: String -> mapOf("uri" to bookmark, "stale" to false) }
  }
}
