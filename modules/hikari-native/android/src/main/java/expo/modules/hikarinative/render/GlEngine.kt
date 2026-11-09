package expo.modules.hikarinative.render

import android.opengl.EGL14
import android.opengl.EGLConfig
import android.opengl.EGLContext
import android.opengl.EGLDisplay
import android.opengl.EGLSurface
import android.opengl.GLES20
import android.opengl.GLES30
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.view.Surface
import expo.modules.hikarinative.HikariException
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.CountDownLatch
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** Packed frame layout, shared with RenderEngine.swift and src/core/pipeline/nativeFrame.ts. */
internal object FrameLayout {
  const val HEADER = 19
  const val DEVELOP = 74
  const val FINISH = 28
  const val LOCAL = 38
  const val MAX_LOCALS = 64
  /** Offset of uOutMode inside the finish uniforms. */
  const val OUT_MODE = 26
}

/** A GL texture holding sRGB-encoded (extended) values or plain data, reference counted across JS and native. */
internal class GlImage(val texture: Int, val width: Int, val height: Int, val internalFormat: Int) {
  var fullWidth = width
  var fullHeight = height
  var isRaw = false
  val isFloat get() = internalFormat == GLES30.GL_RGBA16F
  val byteSize get() = width * height * (if (isFloat) 8 else 4)
  private val refs = AtomicInteger(1)

  fun retain(): GlImage {
    refs.incrementAndGet()
    return this
  }

  fun release() {
    if (refs.decrementAndGet() == 0) GlEngine.post { GLES20.glDeleteTextures(1, intArrayOf(texture), 0) }
  }
}

internal class RenderInputs(
  val source: GlImage,
  val cleaned: GlImage,
  val blurN: GlImage,
  val blurS: GlImage,
  val blurM: GlImage,
  val blurL: GlImage,
  val curve: GlImage?,
  val lut: GlImage?,
  val masks: List<GlImage>,
) {
  private fun all() = listOfNotNull(source, cleaned, blurN, blurS, blurM, blurL, curve, lut) + masks
  fun retain() = apply { all().forEach { it.retain() } }
  fun release() = all().forEach { it.release() }
  fun withCurve(next: GlImage) = RenderInputs(source, cleaned, blurN, blurS, blurM, blurL, next, lut, masks)
}

/** Mask textures resampled into one array texture: GLSL ES 3.0 can't index sampler arrays dynamically. */
internal class MaskArray(val texture: Int, val key: List<Int>)

/**
 * The OpenGL ES renderer. GL contexts belong to a thread, so every call runs on one GL thread:
 * callers on the JS thread wait for their result the way they waited for Skia.
 */
internal object GlEngine {
  private val thread = HandlerThread("hikari-gl").apply { start() }
  private val handler = Handler(thread.looper)

  private var display: EGLDisplay = EGL14.EGL_NO_DISPLAY
  private var context: EGLContext = EGL14.EGL_NO_CONTEXT
  private var config: EGLConfig? = null
  private var pbuffer: EGLSurface = EGL14.EGL_NO_SURFACE
  private var fbo = 0
  private var ubo = 0
  private var blockBytes = 0
  private lateinit var uniformData: ByteBuffer

  private lateinit var recipe: Program
  private lateinit var original: Program
  private lateinit var copy: Program
  private lateinit var gauss: Program

  private var ready = false
  private var supported = false
  private var maxSize = 0

  private class Program(val id: Int) {
    private val locations = HashMap<String, Int>()
    fun loc(name: String) = locations.getOrPut(name) { GLES20.glGetUniformLocation(id, name) }
  }

  val isSupported: Boolean get() = run { supported }
  val maxTextureSize: Int get() = run { maxSize }

  fun post(block: () -> Unit) {
    handler.post { block() }
  }

  /** Runs on the GL thread and returns its result; exceptions surface in the caller. */
  fun <T> run(block: () -> T): T {
    if (Looper.myLooper() == thread.looper) {
      ensureReady()
      return block()
    }
    val latch = CountDownLatch(1)
    var value: Result<T>? = null
    handler.post {
      value = runCatching {
        ensureReady()
        block()
      }
      latch.countDown()
    }
    latch.await()
    return value!!.getOrThrow()
  }

  private fun fail(message: String): Nothing = throw HikariException(message)

  private fun ensureReady() {
    if (ready) return
    ready = true
    display = EGL14.eglGetDisplay(EGL14.EGL_DEFAULT_DISPLAY)
    val version = IntArray(2)
    if (!EGL14.eglInitialize(display, version, 0, version, 1)) fail("EGL is unavailable")
    val attrs = intArrayOf(
      EGL14.EGL_RED_SIZE, 8, EGL14.EGL_GREEN_SIZE, 8, EGL14.EGL_BLUE_SIZE, 8, EGL14.EGL_ALPHA_SIZE, 8,
      EGL14.EGL_RENDERABLE_TYPE, 0x40, // EGL_OPENGL_ES3_BIT_KHR
      EGL14.EGL_SURFACE_TYPE, EGL14.EGL_WINDOW_BIT or EGL14.EGL_PBUFFER_BIT,
      EGL14.EGL_NONE,
    )
    val configs = arrayOfNulls<EGLConfig>(1)
    val count = IntArray(1)
    if (!EGL14.eglChooseConfig(display, attrs, 0, configs, 0, 1, count, 0) || count[0] == 0) return
    config = configs[0]
    context = EGL14.eglCreateContext(display, config, EGL14.EGL_NO_CONTEXT, intArrayOf(EGL14.EGL_CONTEXT_CLIENT_VERSION, 3, EGL14.EGL_NONE), 0)
    if (context == EGL14.EGL_NO_CONTEXT) return
    pbuffer = EGL14.eglCreatePbufferSurface(display, config, intArrayOf(EGL14.EGL_WIDTH, 1, EGL14.EGL_HEIGHT, 1, EGL14.EGL_NONE), 0)
    makeOffscreenCurrent()

    // half-float sources must be renderable (removals) and readable
    supported = (GLES20.glGetString(GLES20.GL_EXTENSIONS) ?: "").split(' ').contains("GL_EXT_color_buffer_float")
    if (!supported) return
    val limit = IntArray(1)
    GLES20.glGetIntegerv(GLES20.GL_MAX_TEXTURE_SIZE, limit, 0)
    maxSize = limit[0]

    recipe = program(GlShaders.IMAGE_VERTEX, GlShaders.RECIPE_FRAGMENT)
    original = program(GlShaders.IMAGE_VERTEX, GlShaders.ORIGINAL_FRAGMENT)
    copy = program(GlShaders.RECT_VERTEX, GlShaders.COPY_FRAGMENT)
    gauss = program(GlShaders.RECT_VERTEX, GlShaders.GAUSS_FRAGMENT)

    val ids = IntArray(1)
    GLES30.glGenVertexArrays(1, ids, 0)
    GLES30.glBindVertexArray(ids[0])
    GLES20.glGenFramebuffers(1, ids, 0)
    fbo = ids[0]
    GLES20.glGenBuffers(1, ids, 0)
    ubo = ids[0]

    val block = GLES30.glGetUniformBlockIndex(recipe.id, "Frame")
    val size = IntArray(1)
    GLES30.glGetActiveUniformBlockiv(recipe.id, block, GLES30.GL_UNIFORM_BLOCK_DATA_SIZE, size, 0)
    blockBytes = size[0]
    uniformData = ByteBuffer.allocateDirect(blockBytes).order(ByteOrder.nativeOrder())
    GLES30.glUniformBlockBinding(recipe.id, block, 0)
    GLES20.glUseProgram(recipe.id)
    listOf("uImage", "uBlurN", "uBlurS", "uBlurM", "uBlurL", "uCurve", "uLut").forEachIndexed { unit, name ->
      GLES20.glUniform1i(recipe.loc(name), unit)
    }
    GLES20.glUniform1i(recipe.loc("uMasks"), 7)
    GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1)
    GLES20.glPixelStorei(GLES20.GL_PACK_ALIGNMENT, 1)
  }

  private fun makeOffscreenCurrent() {
    EGL14.eglMakeCurrent(display, pbuffer, pbuffer, context)
  }

  private fun compile(type: Int, source: String): Int {
    val shader = GLES20.glCreateShader(type)
    GLES20.glShaderSource(shader, source)
    GLES20.glCompileShader(shader)
    val ok = IntArray(1)
    GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, ok, 0)
    if (ok[0] == 0) fail("Shader failed: ${GLES20.glGetShaderInfoLog(shader)}")
    return shader
  }

  private fun program(vertex: String, fragment: String): Program {
    val id = GLES20.glCreateProgram()
    GLES20.glAttachShader(id, compile(GLES20.GL_VERTEX_SHADER, vertex))
    GLES20.glAttachShader(id, compile(GLES20.GL_FRAGMENT_SHADER, fragment))
    GLES20.glLinkProgram(id)
    val ok = IntArray(1)
    GLES20.glGetProgramiv(id, GLES20.GL_LINK_STATUS, ok, 0)
    if (ok[0] == 0) fail("Program failed: ${GLES20.glGetProgramInfoLog(id)}")
    return Program(id)
  }

  // ---- textures

  private fun setSampling(target: Int) {
    GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR)
    GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE)
    GLES20.glTexParameteri(target, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE)
  }

  private fun allocate(internal: Int, width: Int, height: Int): GlImage {
    if (width <= 0 || height <= 0) fail("Invalid image size ${width}x$height")
    if (width > maxSize || height > maxSize) fail("${width}x$height is larger than this device's GPU limit of $maxSize")
    val ids = IntArray(1)
    GLES20.glGenTextures(1, ids, 0)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, ids[0])
    GLES30.glTexStorage2D(GLES20.GL_TEXTURE_2D, 1, internal, width, height)
    setSampling(GLES20.GL_TEXTURE_2D)
    return GlImage(ids[0], width, height, internal)
  }

  fun makeImage(pixels: ByteBuffer, width: Int, height: Int, half: Boolean): GlImage = run {
    val image = allocate(if (half) GLES30.GL_RGBA16F else GLES30.GL_RGBA8, width, height)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, image.texture)
    GLES20.glTexSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, width, height, GLES20.GL_RGBA, if (half) GLES30.GL_HALF_FLOAT else GLES20.GL_UNSIGNED_BYTE, pixels)
    image
  }

  private fun bindTarget(image: GlImage) {
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo)
    GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, image.texture, 0)
    GLES20.glViewport(0, 0, image.width, image.height)
    GLES20.glDisable(GLES20.GL_SCISSOR_TEST)
  }

  private fun drawRect(p: Program, x: Float, y: Float, w: Float, h: Float) {
    GLES20.glUniform4f(p.loc("uRect"), x, y, w, h)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
  }

  private fun copyInto(src: GlImage, target: GlImage) {
    bindTarget(target)
    GLES20.glUseProgram(copy.id)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, src.texture)
    GLES20.glUniform1i(copy.loc("uSrc"), 0)
    drawRect(copy, 0f, 0f, 1f, 1f)
  }

  private fun gaussInto(src: GlImage, target: GlImage, sigma: Float, dx: Int, dy: Int) {
    bindTarget(target)
    GLES20.glUseProgram(gauss.id)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, src.texture)
    GLES20.glUniform1i(gauss.loc("uSrc"), 0)
    GLES20.glUniform1f(gauss.loc("uSigma"), sigma)
    GLES20.glUniform2i(gauss.loc("uDir"), dx, dy)
    drawRect(gauss, 0f, 0f, 1f, 1f)
  }

  /** Resamples to width × height (8-bit) and, with sigma > 0, applies a Gaussian in the output's pixels. */
  fun blur(image: GlImage, sigma: Float, width: Int, height: Int): GlImage = run {
    val result = allocate(GLES30.GL_RGBA8, width, height)
    if (sigma > 0.05f) {
      val resized = allocate(GLES30.GL_RGBA8, width, height)
      val horizontal = allocate(GLES30.GL_RGBA8, width, height)
      copyInto(image, resized)
      gaussInto(resized, horizontal, sigma, 1, 0)
      gaussInto(horizontal, result, sigma, 0, 1)
      GLES20.glDeleteTextures(2, intArrayOf(resized.texture, horizontal.texture), 0)
    } else {
      copyInto(image, result)
    }
    GLES20.glFinish()
    result
  }

  class Patch(val image: GlImage, val x: Int, val y: Int)

  /** The source with feathered patches (alpha = blend weight) drawn over it, in the source's format. */
  fun composite(source: GlImage, patches: List<Patch>): GlImage = run {
    val out = allocate(source.internalFormat, source.width, source.height)
    copyInto(source, out)
    bindTarget(out)
    GLES20.glUseProgram(copy.id)
    GLES20.glEnable(GLES20.GL_BLEND)
    GLES20.glBlendFuncSeparate(GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA, GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glUniform1i(copy.loc("uSrc"), 0)
    val w = source.width.toFloat()
    val h = source.height.toFloat()
    for (p in patches) {
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, p.image.texture)
      drawRect(copy, p.x / w, p.y / h, p.image.width / w, p.image.height / h)
    }
    GLES20.glDisable(GLES20.GL_BLEND)
    GLES20.glFinish()
    out.fullWidth = source.fullWidth
    out.fullHeight = source.fullHeight
    out.isRaw = source.isRaw
    out
  }

  fun replaceRgba8(image: GlImage, pixels: ByteArray) = run {
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, image.texture)
    GLES20.glTexSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, image.width, image.height, GLES20.GL_RGBA, GLES20.GL_UNSIGNED_BYTE, ByteBuffer.wrap(pixels))
  }

  // ---- reading back

  private fun read(image: GlImage, x: Int, y: Int, w: Int, h: Int, type: Int, out: ByteBuffer) {
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo)
    GLES20.glFramebufferTexture2D(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, GLES20.GL_TEXTURE_2D, image.texture, 0)
    GLES20.glReadPixels(x, y, w, h, GLES20.GL_RGBA, type, out)
  }

  fun readRgba8(image: GlImage, x: Int, y: Int, w: Int, h: Int): ByteArray = run {
    if (image.isFloat) {
      val floats = ByteBuffer.allocateDirect(w * h * 16).order(ByteOrder.nativeOrder())
      read(image, x, y, w, h, GLES20.GL_FLOAT, floats)
      val values = floats.asFloatBuffer()
      ByteArray(w * h * 4) { i -> (values.get(i).coerceIn(0f, 1f) * 255f + 0.5f).toInt().toByte() }
    } else {
      val out = ByteArray(w * h * 4)
      read(image, x, y, w, h, GLES20.GL_UNSIGNED_BYTE, ByteBuffer.wrap(out))
      out
    }
  }

  fun readFloats(image: GlImage, x: Int, y: Int, w: Int, h: Int): ByteArray = run {
    val out = ByteArray(w * h * 16)
    if (image.isFloat) {
      val buf = ByteBuffer.wrap(out).order(ByteOrder.nativeOrder())
      read(image, x, y, w, h, GLES20.GL_FLOAT, buf)
    } else {
      val bytes = readRgba8(image, x, y, w, h)
      val floats = ByteBuffer.wrap(out).order(ByteOrder.nativeOrder()).asFloatBuffer()
      for (i in bytes.indices) floats.put(i, (bytes[i].toInt() and 0xff) / 255f)
    }
    out
  }

  // ---- masks

  /** Builds the mask array for `masks`, reusing `previous` when the images are the same. */
  fun maskArray(masks: List<GlImage>, previous: MaskArray?): MaskArray = run {
    val key = masks.map { it.texture }
    if (previous != null && previous.key == key) return@run previous
    previous?.let { GLES20.glDeleteTextures(1, intArrayOf(it.texture), 0) }
    val width = max(1, masks.maxOfOrNull { it.width } ?: 1)
    val height = max(1, masks.maxOfOrNull { it.height } ?: 1)
    val ids = IntArray(1)
    GLES20.glGenTextures(1, ids, 0)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GLES30.GL_TEXTURE_2D_ARRAY, ids[0])
    GLES30.glTexStorage3D(GLES30.GL_TEXTURE_2D_ARRAY, 1, GLES30.GL_RGBA8, width, height, max(1, masks.size))
    setSampling(GLES30.GL_TEXTURE_2D_ARRAY)
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fbo)
    GLES20.glViewport(0, 0, width, height)
    GLES20.glDisable(GLES20.GL_SCISSOR_TEST)
    GLES20.glUseProgram(copy.id)
    GLES20.glUniform1i(copy.loc("uSrc"), 0)
    masks.forEachIndexed { layer, mask ->
      GLES30.glFramebufferTextureLayer(GLES20.GL_FRAMEBUFFER, GLES20.GL_COLOR_ATTACHMENT0, ids[0], 0, layer)
      GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, mask.texture)
      drawRect(copy, 0f, 0f, 1f, 1f)
    }
    GLES20.glBindTexture(GLES30.GL_TEXTURE_2D_ARRAY, 0)
    MaskArray(ids[0], key)
  }

  fun deleteMaskArray(array: MaskArray) = post { GLES20.glDeleteTextures(1, intArrayOf(array.texture), 0) }

  // ---- drawing a recipe

  private fun bind(unit: Int, texture: Int) {
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0 + unit)
    GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, texture)
  }

  private fun setImageVertex(p: Program, matrix: FloatArray, targetW: Int, targetH: Int, flipY: Boolean, imageW: Float, imageH: Float) {
    GLES20.glUniform1fv(p.loc("uM"), 9, matrix, 0)
    GLES20.glUniform2f(p.loc("uTarget"), targetW.toFloat(), targetH.toFloat())
    GLES20.glUniform2f(p.loc("uImageSize"), imageW, imageH)
    GLES20.glUniform1f(p.loc("uFlipY"), if (flipY) 1f else 0f)
  }

  private fun scissor(frame: FloatArray, at: Int, scale: Float, targetW: Int, targetH: Int, flipY: Boolean): Boolean {
    val x0 = floor(frame[at] * scale).toInt().coerceIn(0, targetW)
    val y0 = floor(frame[at + 1] * scale).toInt().coerceIn(0, targetH)
    val x1 = ceil((frame[at] + frame[at + 2]) * scale).toInt().coerceIn(0, targetW)
    val y1 = ceil((frame[at + 1] + frame[at + 3]) * scale).toInt().coerceIn(0, targetH)
    if (x1 <= x0 || y1 <= y0) return false
    GLES20.glEnable(GLES20.GL_SCISSOR_TEST)
    GLES20.glScissor(x0, if (flipY) targetH - y1 else y0, x1 - x0, y1 - y0)
    return true
  }

  private fun drawFrame(inputs: RenderInputs, masks: MaskArray, frame: FloatArray, targetW: Int, targetH: Int, scale: Float, flipY: Boolean) {
    val fixed = FrameLayout.HEADER + FrameLayout.DEVELOP + FrameLayout.FINISH
    if (frame.size < fixed) fail("Malformed frame")
    val declared = frame[18].toInt()
    if (frame.size != fixed + declared * FrameLayout.LOCAL) fail("Malformed frame")
    val localCount = min(declared, FrameLayout.MAX_LOCALS)
    val matrix = frame.copyOfRange(0, 9)
    for (i in 0 until 6) matrix[i] *= scale
    val imageW = frame[FrameLayout.HEADER]
    val imageH = frame[FrameLayout.HEADER + 1]

    val drawOriginal = {
      GLES20.glUseProgram(original.id)
      setImageVertex(original, matrix, targetW, targetH, flipY, imageW, imageH)
      bind(0, inputs.source.texture)
      GLES20.glUniform1i(original.loc("uImage"), 0)
      GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    }

    if (!scissor(frame, 9, scale, targetW, targetH, flipY)) return
    if (frame[17] > 0.5f) {
      drawOriginal()
      return
    }

    GLES20.glUseProgram(recipe.id)
    setImageVertex(recipe, matrix, targetW, targetH, flipY, imageW, imageH)
    GLES20.glUniform1i(recipe.loc("uLocalCount"), localCount)
    uniformData.clear()
    uniformData.asFloatBuffer().put(frame, FrameLayout.HEADER, FrameLayout.DEVELOP + FrameLayout.FINISH + localCount * FrameLayout.LOCAL)
    uniformData.position(0).limit(blockBytes)
    GLES20.glBindBuffer(GLES30.GL_UNIFORM_BUFFER, ubo)
    GLES20.glBufferData(GLES30.GL_UNIFORM_BUFFER, blockBytes, uniformData, GLES20.GL_STREAM_DRAW)
    GLES30.glBindBufferBase(GLES30.GL_UNIFORM_BUFFER, 0, ubo)

    bind(0, inputs.cleaned.texture)
    bind(1, inputs.blurN.texture)
    bind(2, inputs.blurS.texture)
    bind(3, inputs.blurM.texture)
    bind(4, inputs.blurL.texture)
    bind(5, (inputs.curve ?: inputs.blurM).texture)
    bind(6, (inputs.lut ?: inputs.blurM).texture)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE7)
    GLES20.glBindTexture(GLES30.GL_TEXTURE_2D_ARRAY, masks.texture)
    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)

    if (frame[15] > 0f && frame[16] > 0f && scissor(frame, 13, scale, targetW, targetH, flipY)) drawOriginal()
  }

  /** Renders a packed frame offscreen, into a new image. */
  fun render(inputs: RenderInputs, frame: FloatArray, width: Int, height: Int): GlImage = run {
    val target = allocate(GLES30.GL_RGBA8, width, height)
    val masks = maskArray(inputs.masks, null)
    try {
      bindTarget(target)
      GLES20.glClearColor(0f, 0f, 0f, 0f)
      GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
      drawFrame(inputs, masks, frame, width, height, 1f, false)
      GLES20.glDisable(GLES20.GL_SCISSOR_TEST)
      GLES20.glFinish()
    } finally {
      GLES20.glDeleteTextures(1, intArrayOf(masks.texture), 0)
    }
    target
  }

  /** RGBA16 little-endian code values, from the two byte passes GLES can render without 16-bit targets. */
  fun render16(inputs: RenderInputs, frame: FloatArray, width: Int, height: Int): ByteArray = run {
    val mode = FrameLayout.HEADER + FrameLayout.DEVELOP + FrameLayout.OUT_MODE
    fun pass(value: Float): ByteArray {
      val f = frame.copyOf()
      f[mode] = value
      val image = render(inputs, f, width, height)
      val pixels = readRgba8(image, 0, 0, width, height)
      image.release()
      return pixels
    }
    val hi = pass(2f)
    val lo = pass(3f)
    val out = ByteArray(width * height * 8)
    for (i in 0 until width * height * 4) {
      val isAlpha = i and 3 == 3
      out[i * 2] = if (isAlpha) 0xff.toByte() else lo[i]
      out[i * 2 + 1] = if (isAlpha) 0xff.toByte() else hi[i]
    }
    out
  }

  // ---- view surfaces

  fun createWindowSurface(surface: Surface): EGLSurface = run {
    EGL14.eglCreateWindowSurface(display, config, surface, intArrayOf(EGL14.EGL_NONE), 0)
  }

  fun destroyWindowSurface(surface: EGLSurface) = run {
    makeOffscreenCurrent()
    EGL14.eglDestroySurface(display, surface)
  }

  /** Called on the GL thread: draws the editor's state and presents it. */
  fun present(surface: EGLSurface, inputs: RenderInputs?, masks: MaskArray?, frame: FloatArray, width: Int, height: Int, scale: Float) {
    ensureReady()
    if (!EGL14.eglMakeCurrent(display, surface, surface, context)) return
    GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, 0)
    GLES20.glViewport(0, 0, width, height)
    GLES20.glDisable(GLES20.GL_SCISSOR_TEST)
    GLES20.glClearColor(0f, 0f, 0f, 0f)
    GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
    try {
      if (inputs != null && masks != null && frame.isNotEmpty()) drawFrame(inputs, masks, frame, width, height, scale, true)
    } finally {
      GLES20.glDisable(GLES20.GL_SCISSOR_TEST)
      EGL14.eglSwapBuffers(display, surface)
      makeOffscreenCurrent()
    }
  }
}
