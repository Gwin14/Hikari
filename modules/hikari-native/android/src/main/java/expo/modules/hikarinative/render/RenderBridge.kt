package expo.modules.hikarinative.render

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.SurfaceTexture
import android.graphics.Typeface
import android.net.Uri
import android.opengl.EGLSurface
import android.util.Log
import android.view.Choreographer
import android.view.Surface
import android.view.TextureView
import expo.modules.hikarinative.ComputeJni
import expo.modules.hikarinative.DecodeResult
import expo.modules.hikarinative.HikariException
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.sharedobjects.SharedObject
import expo.modules.kotlin.views.ExpoView
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.lang.ref.WeakReference
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

class RenderInputsRecord : Record {
  @Field var source: Int = 0
  @Field var cleaned: Int = 0
  @Field var blurN: Int = 0
  @Field var blurS: Int = 0
  @Field var blurM: Int = 0
  @Field var blurL: Int = 0
  @Field var curve: Int? = null
  @Field var lut: Int? = null
  @Field var masks: List<Int> = emptyList()
}

class RenderPatchRecord : Record {
  @Field var image: Int = 0
  @Field var x: Int = 0
  @Field var y: Int = 0
}

class StrokeRecord : Record {
  @Field var points: DoubleArray = DoubleArray(0)
  @Field var size: Double = 0.0
  @Field var hardness: Double = 1.0
  @Field var flow: Double = 1.0
  @Field var erase: Boolean = false
}

class WatermarkRecord : Record {
  @Field var text: String = ""
  @Field var position: String = "br"
  @Field var opacity: Double = 100.0
  @Field var size: Double = 3.0
}

/** JS handle of a GPU image. JS passes ids inside records; this object owns one reference to the texture. */
class NativeRenderImage internal constructor(internal val image: GlImage?, val bits16: ByteArray? = null, private val size: Pair<Int, Int>? = null) : SharedObject() {
  val id = nextId.getAndIncrement()

  val width get() = image?.width ?: size!!.first
  val height get() = image?.height ?: size!!.second
  val fullWidth get() = image?.fullWidth ?: width
  val fullHeight get() = image?.fullHeight ?: height
  val isRaw get() = image?.isRaw ?: false
  val isFloat get() = image?.isFloat ?: false

  init {
    live[id] = WeakReference(this)
  }

  override fun getAdditionalMemoryPressure(): Int = image?.byteSize ?: (bits16?.size ?: 0)

  override fun sharedObjectDidRelease() {
    live.remove(id)
    image?.release()
  }

  companion object {
    private val nextId = AtomicInteger(1)
    private val live = ConcurrentHashMap<Int, WeakReference<NativeRenderImage>>()
    fun find(id: Int) = live[id]?.get()
  }
}

internal object RenderBridge {
  private fun image(id: Int): GlImage =
    NativeRenderImage.find(id)?.image ?: throw HikariException("Image $id is gone")

  fun resolve(r: RenderInputsRecord) = RenderInputs(
    image(r.source), image(r.cleaned), image(r.blurN), image(r.blurS), image(r.blurM), image(r.blurL),
    r.curve?.let(::image), r.lut?.let(::image), r.masks.map(::image),
  )

  fun makeImage(pixels: ByteArray, width: Int, height: Int, format: String): NativeRenderImage {
    val half = format == "rgba16f"
    if (pixels.size < width * height * (if (half) 8 else 4)) throw HikariException("Pixel buffer too small")
    return NativeRenderImage(GlEngine.makeImage(ByteBuffer.wrap(pixels), width, height, half))
  }

  fun load(decoded: DecodeResult): NativeRenderImage {
    val file = File(Uri.parse(decoded.path).path!!)
    try {
      val half = decoded.format == "rgba16f"
      val mapped = RandomAccessFile(file, "r").use { it.channel.map(FileChannel.MapMode.READ_ONLY, 0, it.length()) }
      val image = GlEngine.makeImage(mapped, decoded.width, decoded.height, half)
      image.fullWidth = decoded.fullWidth
      image.fullHeight = decoded.fullHeight
      image.isRaw = decoded.isRaw
      return NativeRenderImage(image)
    } finally {
      file.delete()
    }
  }

  /** An encoded file as RGBA8, without alpha premultiplication (cached masks). */
  fun loadEncoded(context: Context, uri: Uri): NativeRenderImage {
    val options = BitmapFactory.Options().apply {
      inPreferredConfig = Bitmap.Config.ARGB_8888
      inPremultiplied = false
    }
    val bitmap = (context.contentResolver.openInputStream(uri) ?: throw HikariException("Could not read $uri")).use {
      BitmapFactory.decodeStream(it, null, options)
    } ?: throw HikariException("Could not decode $uri")
    val pixels = ByteBuffer.allocateDirect(bitmap.byteCount)
    bitmap.copyPixelsToBuffer(pixels)
    pixels.rewind()
    return NativeRenderImage(GlEngine.makeImage(pixels, bitmap.width, bitmap.height, false))
  }

  fun blur(image: NativeRenderImage, sigma: Float, width: Int, height: Int) =
    NativeRenderImage(GlEngine.blur(image.image!!, sigma, width, height))

  fun composite(source: NativeRenderImage, patches: List<RenderPatchRecord>): NativeRenderImage {
    if (patches.isEmpty()) return source
    return NativeRenderImage(GlEngine.composite(source.image!!, patches.map { GlEngine.Patch(image(it.image), it.x, it.y) }))
  }

  fun readRgba8(o: NativeRenderImage, x: Int, y: Int, width: Int, height: Int): ByteArray =
    GlEngine.readRgba8(o.image!!, x, y, width, height)

  fun readRgba16(o: NativeRenderImage): ByteArray = o.bits16 ?: throw HikariException("Not a 16-bit image")

  fun readFloats(o: NativeRenderImage, x: Int, y: Int, width: Int, height: Int): ByteArray =
    GlEngine.readFloats(o.image!!, x, y, width, height)

  fun encode(o: NativeRenderImage, format: String, quality: Double): ByteArray {
    val pixels = readRgba8(o, 0, 0, o.width, o.height)
    val bitmap = Bitmap.createBitmap(o.width, o.height, Bitmap.Config.ARGB_8888)
    bitmap.copyPixelsFromBuffer(ByteBuffer.wrap(pixels))
    val out = ByteArrayOutputStream()
    bitmap.compress(if (format == "png") Bitmap.CompressFormat.PNG else Bitmap.CompressFormat.JPEG, quality.roundToInt(), out)
    return out.toByteArray()
  }

  fun renderOffscreen(record: RenderInputsRecord, frame: FloatArray, width: Int, height: Int, bits: Int, watermark: WatermarkRecord?): NativeRenderImage {
    val inputs = resolve(record)
    if (bits == 16) {
      val pixels = GlEngine.render16(inputs, frame, width, height)
      watermark?.let { applyWatermark(it, pixels, width, height, 16) }
      return NativeRenderImage(null, pixels, width to height)
    }
    val image = GlEngine.render(inputs, frame, width, height)
    if (watermark != null) {
      val pixels = GlEngine.readRgba8(image, 0, 0, width, height)
      applyWatermark(watermark, pixels, width, height, 8)
      GlEngine.replaceRgba8(image, pixels)
    }
    return NativeRenderImage(image)
  }

  /** Same placement as the iOS and Skia paths: opacity-blended white text in the image's code values. */
  private fun applyWatermark(wm: WatermarkRecord, pixels: ByteArray, w: Int, h: Int, bits: Int) {
    val px = max(10, (min(w, h) * wm.size / 100).roundToInt()).toFloat()
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      textSize = px
      typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      alpha = (wm.opacity / 100 * 255).roundToInt()
    }
    val tw = paint.measureText(wm.text)
    val x = when (wm.position) {
      "tl", "bl" -> px
      "center" -> (w - tw) / 2
      else -> w - tw - px
    }
    val y = when (wm.position) {
      "tl", "tr" -> px + px
      "center" -> h / 2f + px / 3
      else -> h - px
    }
    val mask = Bitmap.createBitmap(w, h, Bitmap.Config.ALPHA_8)
    Canvas(mask).drawText(wm.text, x, y, paint)
    val alpha = ByteArray(mask.rowBytes * h)
    mask.copyPixelsToBuffer(ByteBuffer.wrap(alpha))
    ComputeJni.applyWatermark(pixels, w, h, alpha, mask.rowBytes, bits)
  }
}

/** Brush masks, rasterized with android.graphics. */
internal object MaskRaster {
  private fun path(s: StrokeRecord, W: Float, H: Float): Path? {
    if (s.points.size < 2) return null
    val p = Path()
    p.moveTo((s.points[0] * W).toFloat(), (s.points[1] * H).toFloat())
    var i = 2
    while (i + 1 < s.points.size) {
      p.lineTo((s.points[i] * W).toFloat(), (s.points[i + 1] * H).toFloat())
      i += 2
    }
    if (s.points.size == 2) p.lineTo((s.points[0] * W).toFloat() + 0.01f, (s.points[1] * H).toFloat())
    return p
  }

  /** White-on-black coverage of `path` in the given rectangle, one byte per pixel. */
  private fun coverage(path: Path, lineWidth: Float, x: Int, y: Int, w: Int, h: Int): ByteArray {
    val bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ALPHA_8)
    val canvas = Canvas(bitmap)
    canvas.translate(-x.toFloat(), -y.toFloat())
    canvas.drawPath(path, Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = lineWidth
      strokeCap = Paint.Cap.ROUND
      strokeJoin = Paint.Join.ROUND
    })
    val rows = ByteArray(bitmap.rowBytes * h)
    bitmap.copyPixelsToBuffer(ByteBuffer.wrap(rows))
    if (bitmap.rowBytes == w) return rows
    val out = ByteArray(w * h)
    for (row in 0 until h) System.arraycopy(rows, row * bitmap.rowBytes, out, row * w, w)
    return out
  }

  fun strokes(strokes: List<StrokeRecord>, width: Int, height: Int, base: NativeRenderImage?): NativeRenderImage {
    val n = width * height
    val mask = ByteArray(n)
    if (base != null) {
      val px = GlEngine.readRgba8(base.image!!, 0, 0, width, height)
      for (i in 0 until n) mask[i] = px[i * 4]
    }
    val long = max(width, height).toDouble()
    val bounds = android.graphics.RectF()
    for (s in strokes) {
      val p = path(s, width.toFloat(), height.toFloat()) ?: continue
      val full = s.size * long
      val lineWidth = full * (0.5 + s.hardness * 0.5)
      val sigma = (1 - s.hardness) * full * 0.25
      val blurred = sigma > 0.3
      val margin = lineWidth / 2 + (if (blurred) ceil(3 * sigma) else 0.0) + 2
      p.computeBounds(bounds, true)
      val x = max(0, kotlin.math.floor(bounds.left - margin).toInt())
      val y = max(0, kotlin.math.floor(bounds.top - margin).toInt())
      val right = min(width, ceil(bounds.right + margin).toInt())
      val bottom = min(height, ceil(bounds.bottom + margin).toInt())
      if (right <= x || bottom <= y) continue
      val w = right - x
      val h = bottom - y
      val plane = coverage(p, lineWidth.toFloat(), x, y, w, h)
      if (blurred) ComputeJni.blurPlanar8(plane, w, h, sigma)
      ComputeJni.composeStroke(mask, width, height, plane, x, y, w, h, s.flow, s.erase)
    }
    val rgba = ByteArray(n * 4)
    ComputeJni.grayToRgba(mask, n, rgba)
    return RenderBridge.makeImage(rgba, width, height, "rgba8")
  }

  /** The 0/1 area to remove in `region`: the detected objects when given, otherwise the hard strokes. */
  fun area(strokes: List<StrokeRecord>, frameW: Int, frameH: Int, region: IntArray, objects: NativeRenderImage?): ByteArray {
    if (region.size != 4 || region[2] <= 0 || region[3] <= 0) throw HikariException("Bad region")
    val (x, y) = region[0] to region[1]
    val (w, h) = region[2] to region[3]
    val out = ByteArray(w * h)
    if (objects != null) {
      val px = GlEngine.readRgba8(objects.image!!, 0, 0, objects.width, objects.height)
      ComputeJni.regionArea(px, objects.width, objects.height, frameW, frameH, x, y, w, h, 24, out)
      return out
    }
    val long = max(frameW, frameH).toDouble()
    val mask = ByteArray(w * h)
    for (s in strokes) {
      val p = path(s, frameW.toFloat(), frameH.toFloat()) ?: continue
      val plane = coverage(p, (s.size * long).toFloat(), x, y, w, h)
      ComputeJni.composeStroke(mask, w, h, plane, 0, 0, w, h, 1.0, false)
    }
    for (i in out.indices) out[i] = if ((mask[i].toInt() and 0xff) > 24) 1 else 0
    return out
  }
}

/** What the editor view shows. Written from the UI runtime (frames) and the JS thread (inputs). */
class EditorSurface : SharedObject() {
  private val lock = Any()
  private var inputs: RenderInputs? = null
  private var frame = FloatArray(0)
  private var masks: MaskArray? = null
  private val dirty = AtomicBoolean(true)

  init {
    current = WeakReference(this)
  }

  fun setFrame(next: FloatArray) {
    synchronized(lock) { frame = next }
    dirty.set(true)
  }

  internal fun setInputs(next: RenderInputs?) {
    next?.retain()
    val old = synchronized(lock) {
      val previous = inputs
      inputs = next
      previous
    }
    old?.release()
    dirty.set(true)
  }

  internal fun setCurve(curve: GlImage) {
    val stale = synchronized(lock) {
      val previous = inputs ?: return
      curve.retain()
      inputs = previous.withCurve(curve)
      previous.curve
    }
    stale?.release()
    dirty.set(true)
  }

  fun invalidate() = dirty.set(true)

  val isDirty get() = dirty.get()

  /** Draws if anything changed since the last call; runs on the GL thread. */
  internal fun drawIfDirty(surface: EGLSurface, width: Int, height: Int, scale: Float) {
    if (!dirty.getAndSet(false)) return
    val (state, snapshot) = synchronized(lock) { inputs?.retain() to frame }
    try {
      val array = state?.let { GlEngine.maskArray(it.masks, masks) }
      masks = array
      GlEngine.present(surface, state, array, snapshot, width, height, scale)
    } catch (e: Exception) {
      Log.e("Hikari", "Render failed", e)
    } finally {
      state?.release()
    }
  }

  override fun sharedObjectDidRelease() {
    setInputs(null)
    masks?.let { GlEngine.deleteMaskArray(it) }
    masks = null
  }

  companion object {
    @Volatile private var current = WeakReference<EditorSurface>(null)
    val active: EditorSurface? get() = current.get()
  }
}

/** Presents the editor's EditorSurface in a TextureView, once per display frame when it changed. */
class EditorRenderView(context: Context, appContext: AppContext) : ExpoView(context, appContext), TextureView.SurfaceTextureListener, Choreographer.FrameCallback {
  override val shouldUseAndroidLayout = true

  private val textureView = TextureView(context).apply { isOpaque = false }
  private var eglSurface: EGLSurface? = null
  private var windowSurface: Surface? = null
  private var surfaceW = 0
  private var surfaceH = 0
  private var attached = false
  private val drawing = AtomicBoolean(false)

  init {
    textureView.surfaceTextureListener = this
    addView(textureView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    attached = true
    EditorSurface.active?.invalidate()
    Choreographer.getInstance().postFrameCallback(this)
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    attached = false
    Choreographer.getInstance().removeFrameCallback(this)
  }

  override fun doFrame(frameTimeNanos: Long) {
    if (!attached) return
    Choreographer.getInstance().postFrameCallback(this)
    val surface = eglSurface ?: return
    val editor = EditorSurface.active ?: return
    if (!editor.isDirty || !drawing.compareAndSet(false, true)) return
    val (w, h) = surfaceW to surfaceH
    val scale = resources.displayMetrics.density
    GlEngine.post {
      try {
        if (eglSurface === surface) editor.drawIfDirty(surface, w, h, scale)
      } finally {
        drawing.set(false)
      }
    }
  }

  override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) {
    surfaceW = width
    surfaceH = height
    val window = Surface(texture)
    windowSurface = window
    eglSurface = GlEngine.createWindowSurface(window)
    EditorSurface.active?.invalidate()
  }

  override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) {
    surfaceW = width
    surfaceH = height
    EditorSurface.active?.invalidate()
  }

  override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
    eglSurface?.let { GlEngine.destroyWindowSurface(it) }
    eglSurface = null
    windowSurface?.release()
    windowSurface = null
    return true
  }

  override fun onSurfaceTextureUpdated(texture: SurfaceTexture) = Unit
}
