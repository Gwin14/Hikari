import Accelerate
import Foundation
import Metal

enum RenderError: Error, CustomStringConvertible {
  case failed(String)
  var description: String {
    switch self {
    case .failed(let message): return message
    }
  }
}

/** A GPU image. Sources are sRGB-encoded (8-bit or extended half float); data images are 8-bit. */
final class RenderImage {
  let texture: MTLTexture
  var fullWidth: Int
  var fullHeight: Int
  var isRaw = false

  init(texture: MTLTexture) {
    self.texture = texture
    fullWidth = texture.width
    fullHeight = texture.height
  }

  var width: Int { texture.width }
  var height: Int { texture.height }
  var isFloat: Bool { texture.pixelFormat == .rgba16Float }
  var bytesPerPixel: Int { RenderEngine.bytesPerPixel(texture.pixelFormat) }
  var byteSize: Int { width * height * bytesPerPixel }
}

/** Everything one photo needs to be drawn at one resolution. */
struct RenderInputs {
  var source: RenderImage
  /** The source with object removals baked in. */
  var cleaned: RenderImage
  var blurN: RenderImage
  var blurS: RenderImage
  var blurM: RenderImage
  var blurL: RenderImage
  var curve: RenderImage?
  var lut: RenderImage?
  var masks: [RenderImage]
}

/**
 Layout of a packed frame, written by src/core/pipeline/nativeFrame.ts:
 matrix (9, row-major, image px to target) · clip x y w h · split x y w h · original · local count ·
 develop uniforms · finish uniforms · local uniforms per mask.
 */
enum FrameLayout {
  static let header = 19
  static let develop = 74
  static let finish = 28
  static let local = 38
  static let maskSlots = 24
}

final class RenderEngine {
  static let shared: RenderEngine? = try? RenderEngine()

  let device: MTLDevice
  private let queue: MTLCommandQueue
  private let library: MTLLibrary
  private let lock = NSLock()
  private var pipelines: [String: MTLRenderPipelineState] = [:]

  private init() throws {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else {
      throw RenderError.failed("Metal is unavailable")
    }
    self.device = device
    self.queue = queue
    library = try device.makeLibrary(source: hikariMetalSource, options: nil)
  }

  static func bytesPerPixel(_ format: MTLPixelFormat) -> Int {
    switch format {
    case .rgba16Float, .rgba16Unorm: return 8
    default: return 4
    }
  }

  private func pipeline(vertex: String, fragment: String, format: MTLPixelFormat, blend: Bool = false) throws -> MTLRenderPipelineState {
    let key = "\(vertex)|\(fragment)|\(format.rawValue)|\(blend)"
    lock.lock()
    defer { lock.unlock() }
    if let found = pipelines[key] { return found }
    let d = MTLRenderPipelineDescriptor()
    d.vertexFunction = library.makeFunction(name: vertex)
    d.fragmentFunction = library.makeFunction(name: fragment)
    d.colorAttachments[0].pixelFormat = format
    if blend {
      let c = d.colorAttachments[0]!
      c.isBlendingEnabled = true
      c.sourceRGBBlendFactor = .sourceAlpha
      c.destinationRGBBlendFactor = .oneMinusSourceAlpha
      c.sourceAlphaBlendFactor = .one
      c.destinationAlphaBlendFactor = .oneMinusSourceAlpha
    }
    let state = try device.makeRenderPipelineState(descriptor: d)
    pipelines[key] = state
    return state
  }

  private func makeTexture(_ format: MTLPixelFormat, _ w: Int, _ h: Int) throws -> MTLTexture {
    let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: w, height: h, mipmapped: false)
    d.usage = [.shaderRead, .renderTarget]
    d.storageMode = .shared
    guard w > 0, h > 0, let tex = device.makeTexture(descriptor: d) else {
      throw RenderError.failed("Could not allocate a \(w)x\(h) texture")
    }
    return tex
  }

  private func commandBuffer() throws -> MTLCommandBuffer {
    guard let cmd = queue.makeCommandBuffer() else { throw RenderError.failed("Could not create a command buffer") }
    return cmd
  }

  private func finish(_ cmd: MTLCommandBuffer) throws {
    cmd.commit()
    cmd.waitUntilCompleted()
    if let error = cmd.error { throw RenderError.failed("GPU error: \(error.localizedDescription)") }
  }

  private func encoder(_ cmd: MTLCommandBuffer, target: MTLTexture, load: MTLLoadAction = .dontCare) throws -> MTLRenderCommandEncoder {
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = target
    pass.colorAttachments[0].loadAction = load
    pass.colorAttachments[0].storeAction = .store
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    guard let enc = cmd.makeRenderCommandEncoder(descriptor: pass) else { throw RenderError.failed("Could not create an encoder") }
    return enc
  }

  // MARK: Images

  func makeImage(bytes: UnsafeRawPointer, width: Int, height: Int, format: MTLPixelFormat) throws -> RenderImage {
    let tex = try makeTexture(format, width, height)
    tex.replace(
      region: MTLRegionMake2D(0, 0, width, height), mipmapLevel: 0, withBytes: bytes,
      bytesPerRow: width * Self.bytesPerPixel(format))
    return RenderImage(texture: tex)
  }

  private func drawRect(_ enc: MTLRenderCommandEncoder, _ rect: [Float]) {
    var r = rect
    enc.setVertexBytes(&r, length: MemoryLayout<Float>.size * 4, index: 0)
    enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
  }

  private func copy(_ cmd: MTLCommandBuffer, from src: MTLTexture, to dst: MTLTexture) throws {
    let enc = try encoder(cmd, target: dst)
    enc.setRenderPipelineState(try pipeline(vertex: "rectVertex", fragment: "copyFragment", format: dst.pixelFormat))
    enc.setFragmentTexture(src, index: 0)
    drawRect(enc, [0, 0, 1, 1])
    enc.endEncoding()
  }

  private func gauss(_ cmd: MTLCommandBuffer, from src: MTLTexture, to dst: MTLTexture, sigma: Float, dir: (Int32, Int32)) throws {
    let enc = try encoder(cmd, target: dst)
    enc.setRenderPipelineState(try pipeline(vertex: "rectVertex", fragment: "gaussFragment", format: dst.pixelFormat))
    var s = sigma
    var d = [dir.0, dir.1]
    enc.setFragmentBytes(&s, length: 4, index: 0)
    enc.setFragmentBytes(&d, length: 8, index: 1)
    enc.setFragmentTexture(src, index: 0)
    drawRect(enc, [0, 0, 1, 1])
    enc.endEncoding()
  }

  /** Resamples to width × height (8-bit) and, with sigma > 0, applies a Gaussian in the output's pixels. */
  func blur(_ image: RenderImage, sigma: Float, width: Int, height: Int) throws -> RenderImage {
    let result = try makeTexture(.rgba8Unorm, width, height)
    let cmd = try commandBuffer()
    if sigma > 0.05 {
      let resized = try makeTexture(.rgba8Unorm, width, height)
      let horizontal = try makeTexture(.rgba8Unorm, width, height)
      try copy(cmd, from: image.texture, to: resized)
      try gauss(cmd, from: resized, to: horizontal, sigma: sigma, dir: (1, 0))
      try gauss(cmd, from: horizontal, to: result, sigma: sigma, dir: (0, 1))
    } else {
      try copy(cmd, from: image.texture, to: result)
    }
    try finish(cmd)
    return RenderImage(texture: result)
  }

  /** The source with feathered patches (alpha = blend weight) drawn over it, in the source's format. */
  func composite(_ source: RenderImage, patches: [(image: RenderImage, x: Int, y: Int)]) throws -> RenderImage {
    if patches.isEmpty { return source }
    let dst = try makeTexture(source.texture.pixelFormat, source.width, source.height)
    let cmd = try commandBuffer()
    try copy(cmd, from: source.texture, to: dst)
    let enc = try encoder(cmd, target: dst, load: .load)
    enc.setRenderPipelineState(try pipeline(vertex: "rectVertex", fragment: "copyFragment", format: dst.pixelFormat, blend: true))
    let W = Float(source.width)
    let H = Float(source.height)
    for p in patches {
      enc.setFragmentTexture(p.image.texture, index: 0)
      drawRect(enc, [Float(p.x) / W, Float(p.y) / H, Float(p.image.width) / W, Float(p.image.height) / H])
    }
    enc.endEncoding()
    try finish(cmd)
    let out = RenderImage(texture: dst)
    out.fullWidth = source.fullWidth
    out.fullHeight = source.fullHeight
    out.isRaw = source.isRaw
    return out
  }

  // MARK: Reading back

  func readBytes(_ image: RenderImage, x: Int, y: Int, width: Int, height: Int) -> Data {
    let rowBytes = width * image.bytesPerPixel
    var data = Data(count: rowBytes * height)
    data.withUnsafeMutableBytes { buf in
      image.texture.getBytes(
        buf.baseAddress!, bytesPerRow: rowBytes, from: MTLRegionMake2D(x, y, width, height), mipmapLevel: 0)
    }
    return data
  }

  /** RGBA as 32-bit floats; half-float and 8-bit images alike. */
  func readFloats(_ image: RenderImage, x: Int, y: Int, width: Int, height: Int) -> Data {
    let raw = readBytes(image, x: x, y: y, width: width, height: height)
    let values = width * height * 4
    var out = Data(count: values * 4)
    if image.isFloat {
      raw.withUnsafeBytes { src in
        out.withUnsafeMutableBytes { dst in
          var s = vImage_Buffer(data: UnsafeMutableRawPointer(mutating: src.baseAddress!), height: 1, width: vImagePixelCount(values), rowBytes: values * 2)
          var d = vImage_Buffer(data: dst.baseAddress!, height: 1, width: vImagePixelCount(values), rowBytes: values * 4)
          vImageConvert_Planar16FtoPlanarF(&s, &d, vImage_Flags(kvImageNoFlags))
        }
      }
    } else {
      raw.withUnsafeBytes { src in
        out.withUnsafeMutableBytes { dst in
          let s = src.bindMemory(to: UInt8.self)
          let d = dst.bindMemory(to: Float.self)
          for i in 0..<values { d[i] = Float(s[i]) / 255 }
        }
      }
    }
    return out
  }

  // MARK: Drawing a recipe

  private func scissor(_ r: ArraySlice<Float>, scale: Float, width: Int, height: Int) -> MTLScissorRect? {
    let v = Array(r)
    let x0 = max(0, min(width, Int((v[0] * scale).rounded(.down))))
    let y0 = max(0, min(height, Int((v[1] * scale).rounded(.down))))
    let x1 = max(0, min(width, Int(((v[0] + v[2]) * scale).rounded(.up))))
    let y1 = max(0, min(height, Int(((v[1] + v[3]) * scale).rounded(.up))))
    guard x1 > x0, y1 > y0 else { return nil }
    return MTLScissorRect(x: x0, y: y0, width: x1 - x0, height: y1 - y0)
  }

  /** Draws a packed frame into an open encoder. `scale` converts the frame's units to target pixels. */
  func encodeFrame(_ enc: MTLRenderCommandEncoder, target: MTLTexture, inputs: RenderInputs, frame: [Float], scale: Float) throws {
    guard frame.count >= FrameLayout.header + FrameLayout.develop + FrameLayout.finish else {
      throw RenderError.failed("Malformed frame")
    }
    let localCount = Int(frame[18])
    let total = FrameLayout.header + FrameLayout.develop + FrameLayout.finish + localCount * FrameLayout.local
    guard frame.count == total, localCount >= 0 else { throw RenderError.failed("Malformed frame") }

    var matrix = Array(frame[0..<9])
    for i in 0..<6 { matrix[i] *= scale }
    var targetSize = [Float(target.width), Float(target.height)]
    var imageSize = [frame[FrameLayout.header], frame[FrameLayout.header + 1]]
    let format = target.pixelFormat

    enc.setVertexBytes(&matrix, length: 9 * 4, index: 0)
    enc.setVertexBytes(&targetSize, length: 8, index: 1)
    enc.setVertexBytes(&imageSize, length: 8, index: 2)

    let drawOriginal: (MTLScissorRect) throws -> Void = { rect in
      enc.setRenderPipelineState(try self.pipeline(vertex: "imageVertex", fragment: "originalFragment", format: format))
      enc.setScissorRect(rect)
      enc.setFragmentBytes(&imageSize, length: 8, index: 0)
      enc.setFragmentTexture(inputs.source.texture, index: 0)
      enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)
    }

    guard let clip = scissor(frame[9..<13], scale: scale, width: target.width, height: target.height) else { return }
    if frame[17] > 0.5 {
      try drawOriginal(clip)
      return
    }

    enc.setRenderPipelineState(try pipeline(vertex: "imageVertex", fragment: "recipeFragment", format: format))
    enc.setScissorRect(clip)
    try frame.withUnsafeBytes { raw in
      let float = MemoryLayout<Float>.size
      let base = raw.baseAddress!
      enc.setFragmentBytes(base + FrameLayout.header * float, length: FrameLayout.develop * float, index: 0)
      enc.setFragmentBytes(base + (FrameLayout.header + FrameLayout.develop) * float, length: FrameLayout.finish * float, index: 1)
      let localBytes = localCount * FrameLayout.local * float
      let localBase = base + (FrameLayout.header + FrameLayout.develop + FrameLayout.finish) * float
      if localBytes == 0 {
        var empty = [Float](repeating: 0, count: FrameLayout.local)
        enc.setFragmentBytes(&empty, length: FrameLayout.local * float, index: 2)
      } else if localBytes <= 4096 {
        enc.setFragmentBytes(localBase, length: localBytes, index: 2)
      } else {
        guard let buffer = device.makeBuffer(bytes: localBase, length: localBytes) else {
          throw RenderError.failed("Could not allocate mask uniforms")
        }
        enc.setFragmentBuffer(buffer, offset: 0, index: 2)
      }
    }
    var count = UInt32(localCount)
    enc.setFragmentBytes(&count, length: 4, index: 3)

    let fallback = inputs.blurM.texture
    enc.setFragmentTexture(inputs.cleaned.texture, index: 0)
    enc.setFragmentTexture(inputs.blurN.texture, index: 1)
    enc.setFragmentTexture(inputs.blurS.texture, index: 2)
    enc.setFragmentTexture(fallback, index: 3)
    enc.setFragmentTexture(inputs.blurL.texture, index: 4)
    enc.setFragmentTexture(inputs.curve?.texture ?? fallback, index: 5)
    enc.setFragmentTexture(inputs.lut?.texture ?? fallback, index: 6)
    var masks = [MTLTexture?](repeating: fallback, count: FrameLayout.maskSlots)
    for (i, m) in inputs.masks.prefix(FrameLayout.maskSlots).enumerated() { masks[i] = m.texture }
    enc.setFragmentTextures(masks, range: 7..<(7 + FrameLayout.maskSlots))
    enc.drawPrimitives(type: .triangleStrip, vertexStart: 0, vertexCount: 4)

    if frame[15] > 0, frame[16] > 0, let split = scissor(frame[13..<17], scale: scale, width: target.width, height: target.height) {
      try drawOriginal(split)
    }
  }

  func draw(into target: MTLTexture, inputs: RenderInputs?, frame: [Float], scale: Float, present: ((MTLCommandBuffer) -> Void)?) throws {
    let cmd = try commandBuffer()
    let enc = try encoder(cmd, target: target, load: .clear)
    if let inputs, !frame.isEmpty { try encodeFrame(enc, target: target, inputs: inputs, frame: frame, scale: scale) }
    enc.endEncoding()
    present?(cmd)
    cmd.commit()
  }

  /** Renders a packed frame offscreen and waits for it. */
  func render(inputs: RenderInputs, frame: [Float], width: Int, height: Int, format: MTLPixelFormat) throws -> RenderImage {
    let target = try makeTexture(format, width, height)
    let cmd = try commandBuffer()
    let enc = try encoder(cmd, target: target, load: .clear)
    do {
      try encodeFrame(enc, target: target, inputs: inputs, frame: frame, scale: 1)
    } catch {
      enc.endEncoding()
      throw error
    }
    enc.endEncoding()
    try finish(cmd)
    return RenderImage(texture: target)
  }
}
