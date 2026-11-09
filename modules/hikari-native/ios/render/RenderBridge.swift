import Accelerate
import CoreText
import ExpoModulesCore
import Foundation
import ImageIO
import Metal
import QuartzCore
import UIKit
import UniformTypeIdentifiers

struct RenderInputsRecord: Record {
  @Field var source: Int = 0
  @Field var cleaned: Int = 0
  @Field var blurN: Int = 0
  @Field var blurS: Int = 0
  @Field var blurM: Int = 0
  @Field var blurL: Int = 0
  @Field var curve: Int?
  @Field var lut: Int?
  @Field var masks: [Int] = []
}

struct RenderPatchRecord: Record {
  @Field var image: Int = 0
  @Field var x: Int = 0
  @Field var y: Int = 0
}

struct StrokeRecord: Record {
  @Field var points: [Double] = []
  @Field var size: Double = 0
  @Field var hardness: Double = 1
  @Field var flow: Double = 1
  @Field var erase: Bool = false
}

struct WatermarkRecord: Record {
  @Field var text: String = ""
  @Field var position: String = "br"
  @Field var opacity: Double = 100
  @Field var size: Double = 3
}

/** JS handle of a GPU image. JS passes ids inside records; the object keeps the texture alive. */
public final class NativeRenderImage: SharedObject {
  private static let lock = NSLock()
  private static var nextId = 1
  private static let live = NSMapTable<NSNumber, NativeRenderImage>.strongToWeakObjects()

  let id: Int
  let image: RenderImage

  init(_ image: RenderImage) {
    self.image = image
    Self.lock.lock()
    id = Self.nextId
    Self.nextId += 1
    Self.lock.unlock()
    super.init()
    Self.lock.lock()
    Self.live.setObject(self, forKey: NSNumber(value: id))
    Self.lock.unlock()
  }

  static func find(_ id: Int) -> NativeRenderImage? {
    lock.lock()
    defer { lock.unlock() }
    return live.object(forKey: NSNumber(value: id))
  }

  public override func getAdditionalMemoryPressure() -> Int { image.byteSize }
}

enum RenderBridge {
  static func engine() throws -> RenderEngine {
    guard let engine = RenderEngine.shared else { throw HikariError("Metal is unavailable") }
    return engine
  }

  private static func image(_ id: Int) throws -> RenderImage {
    guard let found = NativeRenderImage.find(id) else { throw HikariError("Image \(id) is gone") }
    return found.image
  }

  static func resolve(_ r: RenderInputsRecord) throws -> RenderInputs {
    RenderInputs(
      source: try image(r.source), cleaned: try image(r.cleaned), blurN: try image(r.blurN), blurS: try image(r.blurS),
      blurM: try image(r.blurM), blurL: try image(r.blurL), curve: try r.curve.map(image), lut: try r.lut.map(image),
      masks: try r.masks.map(image))
  }

  static func makeImage(pixels: Data, width: Int, height: Int, format: String) throws -> NativeRenderImage {
    let pixelFormat: MTLPixelFormat = format == "rgba16f" ? .rgba16Float : .rgba8Unorm
    let bytes = width * height * RenderEngine.bytesPerPixel(pixelFormat)
    guard bytes > 0, pixels.count >= bytes else { throw HikariError("Pixel buffer too small") }
    return NativeRenderImage(
      try pixels.withUnsafeBytes { try engine().makeImage(bytes: $0.baseAddress!, width: width, height: height, format: pixelFormat) })
  }

  static func load(_ decoded: DecodeResult) throws -> NativeRenderImage {
    defer { try? FileManager.default.removeItem(at: decoded.path) }
    let data = try Data(contentsOf: decoded.path)
    let out = try makeImage(pixels: data, width: decoded.width, height: decoded.height, format: decoded.format)
    out.image.fullWidth = decoded.fullWidth
    out.image.fullHeight = decoded.fullHeight
    out.image.isRaw = decoded.isRaw
    return out
  }

  /** An encoded file as sRGB RGBA8 (cached masks). */
  static func loadEncoded(uri: String) throws -> NativeRenderImage {
    guard let url = URL(string: uri), let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let img = CGImageSourceCreateImageAtIndex(src, 0, nil)
    else { throw HikariError("Could not read \(uri)") }
    let w = img.width
    let h = img.height
    var data = Data(count: w * h * 4)
    try data.withUnsafeMutableBytes { buf in
      guard
        let ctx = CGContext(
          data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: Decoder.sRGB,
          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
      else { throw HikariError("Bitmap context failed") }
      ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    }
    return try makeImage(pixels: data, width: w, height: h, format: "rgba8")
  }

  static func composite(_ source: NativeRenderImage, patches: [RenderPatchRecord]) throws -> NativeRenderImage {
    let out = try engine().composite(source.image, patches: try patches.map { (try image($0.image), $0.x, $0.y) })
    return out === source.image ? source : NativeRenderImage(out)
  }

  static func readRgba8(_ image: RenderImage, x: Int, y: Int, width: Int, height: Int) throws -> Data {
    let engine = try engine()
    guard image.isFloat else { return engine.readBytes(image, x: x, y: y, width: width, height: height) }
    let floats = engine.readFloats(image, x: x, y: y, width: width, height: height)
    let values = width * height * 4
    var out = Data(count: values)
    floats.withUnsafeBytes { src in
      out.withUnsafeMutableBytes { dst in
        var s = vImage_Buffer(data: UnsafeMutableRawPointer(mutating: src.baseAddress!), height: 1, width: vImagePixelCount(values), rowBytes: values * 4)
        var d = vImage_Buffer(data: dst.baseAddress!, height: 1, width: vImagePixelCount(values), rowBytes: values)
        vImageConvert_PlanarFtoPlanar8(&s, &d, 1, 0, vImage_Flags(kvImageNoFlags))
      }
    }
    return out
  }

  static func encode(_ image: RenderImage, format: String, quality: Double) throws -> Data {
    let pixels = try readRgba8(image, x: 0, y: 0, width: image.width, height: image.height)
    guard let provider = CGDataProvider(data: pixels as CFData),
      let cg = CGImage(
        width: image.width, height: image.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: image.width * 4,
        space: Decoder.sRGB, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue), provider: provider,
        decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { throw HikariError("Could not build the image") }
    let out = NSMutableData()
    let type: UTType = format == "png" ? .png : .jpeg
    guard let dest = CGImageDestinationCreateWithData(out, type.identifier as CFString, 1, nil) else {
      throw HikariError("Could not create the encoder")
    }
    CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: quality / 100] as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw HikariError("Encoding failed") }
    return out as Data
  }

  static func renderOffscreen(inputs: RenderInputsRecord, frame: [Float], width: Int, height: Int, bits: Int, watermark: WatermarkRecord?) throws -> NativeRenderImage {
    let engine = try engine()
    let format: MTLPixelFormat = bits == 16 ? .rgba16Unorm : .rgba8Unorm
    let out = try engine.render(inputs: try resolve(inputs), frame: frame, width: width, height: height, format: format)
    if let watermark {
      try drawWatermark(watermark, on: out, sixteen: bits == 16)
    }
    return NativeRenderImage(out)
  }

  /** Same placement as the Skia export path: opacity-blended white text in the image's own code values. */
  private static func drawWatermark(_ wm: WatermarkRecord, on image: RenderImage, sixteen: Bool) throws {
    let w = image.width
    let h = image.height
    var pixels = try engine().readBytes(image, x: 0, y: 0, width: w, height: h)
    let px = CGFloat(max(10, Int((Double(min(w, h)) * wm.size / 100).rounded())))
    let font = CTFontCreateWithName("HelveticaNeue-Medium" as CFString, px, nil)
    let color = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: wm.opacity / 100)
    let text = NSAttributedString(string: wm.text, attributes: [
      NSAttributedString.Key(kCTFontAttributeName as String): font,
      NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
    ])
    let line = CTLineCreateWithAttributedString(text)
    let tw = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    let W = CGFloat(w)
    let H = CGFloat(h)
    let x: CGFloat = wm.position == "tl" || wm.position == "bl" ? px : wm.position == "center" ? (W - tw) / 2 : W - tw - px
    let y: CGFloat = wm.position == "tl" || wm.position == "tr" ? px + px : wm.position == "center" ? H / 2 + px / 3 : H - px

    var info = CGImageAlphaInfo.noneSkipLast.rawValue
    if sixteen { info |= CGBitmapInfo.byteOrder16Little.rawValue }
    pixels.withUnsafeMutableBytes { buf in
      guard
        let ctx = CGContext(
          data: buf.baseAddress, width: w, height: h, bitsPerComponent: sixteen ? 16 : 8, bytesPerRow: w * (sixteen ? 8 : 4),
          space: Decoder.sRGB, bitmapInfo: info)
      else { return }
      ctx.textPosition = CGPoint(x: x, y: H - y)
      CTLineDraw(line, ctx)
    }
    pixels.withUnsafeBytes {
      image.texture.replace(
        region: MTLRegionMake2D(0, 0, w, h), mipmapLevel: 0, withBytes: $0.baseAddress!, bytesPerRow: w * image.bytesPerPixel)
    }
  }
}

/** Brush masks, rasterized with Core Graphics. */
enum MaskRaster {
  private static func path(_ s: StrokeRecord, _ W: CGFloat, _ H: CGFloat) -> CGPath? {
    guard s.points.count >= 2 else { return nil }
    let p = CGMutablePath()
    p.move(to: CGPoint(x: s.points[0] * W, y: s.points[1] * H))
    var i = 2
    while i + 1 < s.points.count {
      p.addLine(to: CGPoint(x: s.points[i] * W, y: s.points[i + 1] * H))
      i += 2
    }
    if s.points.count == 2 { p.addLine(to: CGPoint(x: s.points[0] * W + 0.01, y: s.points[1] * H)) }
    return p
  }

  /** White-on-black coverage of `path` in the given rectangle (top-left origin). */
  private static func coverage(_ path: CGPath, lineWidth: CGFloat, x: Int, y: Int, w: Int, h: Int) -> [UInt8] {
    var plane = [UInt8](repeating: 0, count: w * h)
    plane.withUnsafeMutableBytes { buf in
      guard
        let ctx = CGContext(
          data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue)
      else { return }
      ctx.translateBy(x: 0, y: CGFloat(h))
      ctx.scaleBy(x: 1, y: -1)
      ctx.translateBy(x: CGFloat(-x), y: CGFloat(-y))
      ctx.addPath(path)
      ctx.setLineWidth(lineWidth)
      ctx.setLineCap(.round)
      ctx.setLineJoin(.round)
      ctx.setStrokeColor(gray: 1, alpha: 1)
      ctx.strokePath()
    }
    return plane
  }

  /** Rasterizes strokes (normalized) into a gray RGBA8 mask, optionally over a base mask's red channel. */
  static func strokes(_ strokes: [StrokeRecord], width: Int, height: Int, base: RenderImage?) throws -> NativeRenderImage {
    let n = width * height
    var mask = [UInt8](repeating: 0, count: n)
    if let base {
      let px = try RenderBridge.readRgba8(base, x: 0, y: 0, width: width, height: height)
      px.withUnsafeBytes { src in
        let s = src.bindMemory(to: UInt8.self)
        for i in 0..<n { mask[i] = s[i * 4] }
      }
    }
    let W = CGFloat(width)
    let H = CGFloat(height)
    let long = Double(max(width, height))
    for s in strokes {
      guard let p = path(s, W, H) else { continue }
      let full = s.size * long
      let lineWidth = full * (0.5 + s.hardness * 0.5)
      let sigma = (1 - s.hardness) * full * 0.25
      let blurred = sigma > 0.3
      let margin = lineWidth / 2 + (blurred ? ceil(3 * sigma) : 0) + 2
      let box = p.boundingBoxOfPath.insetBy(dx: -margin, dy: -margin).integral
        .intersection(CGRect(x: 0, y: 0, width: width, height: height))
      guard !box.isNull, box.width > 0, box.height > 0 else { continue }
      let (x, y, w, h) = (Int(box.minX), Int(box.minY), Int(box.width), Int(box.height))
      var plane = coverage(p, lineWidth: lineWidth, x: x, y: y, w: w, h: h)
      if blurred { hk_blur_planar8(&plane, Int32(w), Int32(h), sigma) }
      hk_compose_stroke(&mask, Int32(width), Int32(height), plane, Int32(x), Int32(y), Int32(w), Int32(h), s.flow, s.erase ? 1 : 0)
    }
    var rgba = Data(count: n * 4)
    rgba.withUnsafeMutableBytes { hk_gray_to_rgba(mask, Int32(n), $0.bindMemory(to: UInt8.self).baseAddress!) }
    return try RenderBridge.makeImage(pixels: rgba, width: width, height: height, format: "rgba8")
  }

  /**
   The 0/1 area to remove in `region` (x, y, w, h of a frameW × frameH frame): the detected objects
   when given, otherwise the hard strokes.
   */
  static func area(_ strokes: [StrokeRecord], frameW: Int, frameH: Int, region: [Int], objects: RenderImage?) throws -> Data {
    guard region.count == 4, region[2] > 0, region[3] > 0 else { throw HikariError("Bad region") }
    let (x, y, w, h) = (region[0], region[1], region[2], region[3])
    var out = Data(count: w * h)
    if let objects {
      let px = try RenderBridge.readRgba8(objects, x: 0, y: 0, width: objects.width, height: objects.height)
      px.withUnsafeBytes { src in
        out.withUnsafeMutableBytes { dst in
          hk_region_area(
            src.bindMemory(to: UInt8.self).baseAddress!, Int32(objects.width), Int32(objects.height), Int32(frameW), Int32(frameH),
            Int32(x), Int32(y), Int32(w), Int32(h), 24, dst.bindMemory(to: UInt8.self).baseAddress!)
        }
      }
      return out
    }
    let long = Double(max(frameW, frameH))
    var mask = [UInt8](repeating: 0, count: w * h)
    for s in strokes {
      guard let p = path(s, CGFloat(frameW), CGFloat(frameH)) else { continue }
      let plane = coverage(p, lineWidth: s.size * long, x: x, y: y, w: w, h: h)
      hk_compose_stroke(&mask, Int32(w), Int32(h), plane, 0, 0, Int32(w), Int32(h), 1, 0)
    }
    out.withUnsafeMutableBytes { dst in
      let d = dst.bindMemory(to: UInt8.self)
      for i in 0..<(w * h) { d[i] = mask[i] > 24 ? 1 : 0 }
    }
    return out
  }
}

/** What the editor view shows. Written from the UI runtime (frames) and the JS thread (inputs). */
public final class EditorSurface: SharedObject {
  nonisolated(unsafe) static weak var current: EditorSurface?

  private let lock = NSLock()
  private var inputs: RenderInputs?
  private var frame: [Float] = []
  private var dirty = true

  public override init() {
    super.init()
    EditorSurface.current = self
  }

  func setFrame(_ next: [Float]) {
    lock.lock()
    frame = next
    dirty = true
    lock.unlock()
  }

  func setInputs(_ next: RenderInputs?) {
    lock.lock()
    inputs = next
    dirty = true
    lock.unlock()
  }

  func setCurve(_ curve: RenderImage) {
    lock.lock()
    inputs?.curve = curve
    dirty = true
    lock.unlock()
  }

  func invalidate() {
    lock.lock()
    dirty = true
    lock.unlock()
  }

  /** The state to draw if anything changed since the last call. */
  func takeDirty() -> (inputs: RenderInputs?, frame: [Float])? {
    lock.lock()
    defer { lock.unlock() }
    guard dirty else { return nil }
    dirty = false
    return (inputs, frame)
  }
}

/** Presents the editor's EditorSurface in a CAMetalLayer, once per display frame when it changed. */
public final class EditorRenderView: ExpoView {
  private let metalLayer = CAMetalLayer()
  private var link: CADisplayLink?

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    metalLayer.device = RenderEngine.shared?.device
    metalLayer.pixelFormat = .bgra8Unorm
    metalLayer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    metalLayer.isOpaque = false
    metalLayer.framebufferOnly = true
    layer.addSublayer(metalLayer)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    let scale = window?.screen.scale ?? UIScreen.main.scale
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    metalLayer.contentsScale = scale
    metalLayer.frame = bounds
    metalLayer.drawableSize = CGSize(width: bounds.width * scale, height: bounds.height * scale)
    CATransaction.commit()
    EditorSurface.current?.invalidate()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    link?.invalidate()
    link = nil
    guard window != nil else { return }
    EditorSurface.current?.invalidate()
    let next = CADisplayLink(target: self, selector: #selector(tick))
    next.add(to: .main, forMode: .common)
    link = next
  }

  @objc private func tick() {
    guard bounds.width > 0, bounds.height > 0, let engine = RenderEngine.shared, let state = EditorSurface.current?.takeDirty(),
      let drawable = metalLayer.nextDrawable()
    else { return }
    do {
      try engine.draw(
        into: drawable.texture, inputs: state.inputs, frame: state.frame, scale: Float(metalLayer.contentsScale),
        present: { $0.present(drawable) })
    } catch {
      NSLog("Hikari render failed: %@", String(describing: error))
    }
  }
}
