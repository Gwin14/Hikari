package expo.modules.hikarinative

import android.content.Context
import android.net.Uri
import androidx.exifinterface.media.ExifInterface
import java.io.File

object Metadata {
  private val captureTags = listOf(
    ExifInterface.TAG_MAKE, ExifInterface.TAG_MODEL, ExifInterface.TAG_LENS_MAKE, ExifInterface.TAG_LENS_MODEL,
    ExifInterface.TAG_DATETIME_ORIGINAL, ExifInterface.TAG_OFFSET_TIME_ORIGINAL, ExifInterface.TAG_SUBSEC_TIME_ORIGINAL,
    ExifInterface.TAG_EXPOSURE_TIME, ExifInterface.TAG_F_NUMBER, ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY,
    ExifInterface.TAG_FOCAL_LENGTH, ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM, ExifInterface.TAG_EXPOSURE_BIAS_VALUE,
    ExifInterface.TAG_EXPOSURE_PROGRAM, ExifInterface.TAG_METERING_MODE, ExifInterface.TAG_FLASH,
    ExifInterface.TAG_WHITE_BALANCE, ExifInterface.TAG_ARTIST, ExifInterface.TAG_COPYRIGHT,
    ExifInterface.TAG_IMAGE_DESCRIPTION, ExifInterface.TAG_BODY_SERIAL_NUMBER, ExifInterface.TAG_LENS_SPECIFICATION,
  )
  private val gpsTags = listOf(
    ExifInterface.TAG_GPS_LATITUDE, ExifInterface.TAG_GPS_LATITUDE_REF, ExifInterface.TAG_GPS_LONGITUDE,
    ExifInterface.TAG_GPS_LONGITUDE_REF, ExifInterface.TAG_GPS_ALTITUDE, ExifInterface.TAG_GPS_ALTITUDE_REF,
    ExifInterface.TAG_GPS_TIMESTAMP, ExifInterface.TAG_GPS_DATESTAMP, ExifInterface.TAG_GPS_IMG_DIRECTION,
    ExifInterface.TAG_GPS_IMG_DIRECTION_REF,
  )

  fun open(context: Context, uri: Uri): ExifInterface? = try {
    if (uri.scheme == null || uri.scheme == "file") ExifInterface(uri.path!!)
    else context.contentResolver.openInputStream(uri)?.use { ExifInterface(it) }
  } catch (e: Exception) {
    null
  }

  fun read(context: Context, uri: Uri, name: String): Map<String, Any?> {
    val e = open(context, uri)
    val isRaw = RawDecoder.isRaw(name)
    var w = e?.getAttributeInt(ExifInterface.TAG_IMAGE_WIDTH, 0) ?: 0
    var h = e?.getAttributeInt(ExifInterface.TAG_IMAGE_LENGTH, 0) ?: 0
    if (e?.rotationDegrees == 90 || e?.rotationDegrees == 270) w = h.also { h = w }
    val out = mutableMapOf<String, Any?>("width" to w, "height" to h, "isRaw" to isRaw)
    if (e == null) return out
    out["make"] = e.getAttribute(ExifInterface.TAG_MAKE)
    out["model"] = e.getAttribute(ExifInterface.TAG_MODEL)
    out["lens"] = e.getAttribute(ExifInterface.TAG_LENS_MODEL)
    out["iso"] = e.getAttributeInt(ExifInterface.TAG_PHOTOGRAPHIC_SENSITIVITY, 0).takeIf { it > 0 }
    out["exposureTime"] = e.getAttributeDouble(ExifInterface.TAG_EXPOSURE_TIME, 0.0).takeIf { it > 0 }
    out["fNumber"] = e.getAttributeDouble(ExifInterface.TAG_F_NUMBER, 0.0).takeIf { it > 0 }
    out["focalLength"] = e.getAttributeDouble(ExifInterface.TAG_FOCAL_LENGTH, 0.0).takeIf { it > 0 }
    out["focalLength35"] = e.getAttributeInt(ExifInterface.TAG_FOCAL_LENGTH_IN_35MM_FILM, 0).takeIf { it > 0 }
    out["exposureBias"] = e.getAttributeDouble(ExifInterface.TAG_EXPOSURE_BIAS_VALUE, 0.0)
    out["flash"] = (e.getAttributeInt(ExifInterface.TAG_FLASH, 0) and 1) == 1
    out["dateTaken"] = e.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
    out["artist"] = e.getAttribute(ExifInterface.TAG_ARTIST)
    out["copyright"] = e.getAttribute(ExifInterface.TAG_COPYRIGHT)
    e.latLong?.let {
      out["latitude"] = it[0]
      out["longitude"] = it[1]
    }
    out["isProRaw"] = isRaw && e.getAttribute(ExifInterface.TAG_MAKE) == "Apple"
    return out.filterValues { it != null }
  }

  /** Copies capture metadata onto an exported file according to the policy. */
  fun copy(context: Context, source: Uri?, dest: File, o: EncodeOptions) {
    if (o.metadata == "none" && o.artist.isNullOrEmpty() && o.copyright.isNullOrEmpty()) return
    try {
      val out = ExifInterface(dest.path)
      val src = source?.let { open(context, it) }
      if (src != null) {
        when (o.metadata) {
          "all" -> out.copyFrom(src, captureTags + gpsTags)
          "noLocation" -> out.copyFrom(src, captureTags)
          "copyright" -> out.copyFrom(src, listOf(ExifInterface.TAG_ARTIST, ExifInterface.TAG_COPYRIGHT))
        }
      }
      o.artist?.takeIf { it.isNotEmpty() }?.let { out.setAttribute(ExifInterface.TAG_ARTIST, it) }
      o.copyright?.takeIf { it.isNotEmpty() }?.let { out.setAttribute(ExifInterface.TAG_COPYRIGHT, it) }
      out.setAttribute(ExifInterface.TAG_SOFTWARE, "Hikari")
      out.setAttribute(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL.toString())
      out.saveAttributes()
    } catch (_: Exception) {
      // Metadata is best effort; the image itself is already written.
    }
  }
}
