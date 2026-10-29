import CoreGraphics
import CoreVideo
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// On-device masks through Vision. Sky segmentation is done in JS (heuristic) since Vision
/// has no sky request.
enum Segmentation {
  static func segment(url: URL, kind: String, maxDim: Int, preferRaw: Bool) throws -> [String: Any]? {
    let image = try Decoder.orientedCGImage(url: url, maxDim: maxDim > 0 ? maxDim : 2048, preferRaw: preferRaw)
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    var buffer: CVPixelBuffer?
    switch kind {
    case "person":
      let req = VNGeneratePersonSegmentationRequest()
      req.qualityLevel = .accurate
      req.outputPixelFormat = kCVPixelFormatType_OneComponent8
      try handler.perform([req])
      buffer = req.results?.first?.pixelBuffer
    default:
      let req = VNGenerateForegroundInstanceMaskRequest()
      try handler.perform([req])
      guard let obs = req.results?.first else { return nil }
      buffer = try obs.generateScaledMaskForImage(forInstances: obs.allInstances, from: handler)
    }
    guard let buffer else { return nil }
    return try writeMask(buffer)
  }

  /// Every foreground object Vision finds, as a label map (0 = background, k = k-th object) at
  /// image resolution. Lets JS pick the objects a rough brush selection is about.
  static func instances(url: URL, maxDim: Int, preferRaw: Bool) throws -> [String: Any]? {
    let image = try Decoder.orientedCGImage(url: url, maxDim: maxDim > 0 ? maxDim : 2048, preferRaw: preferRaw)
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    let req = VNGenerateForegroundInstanceMaskRequest()
    try handler.perform([req])
    guard let obs = req.results?.first, !obs.allInstances.isEmpty else { return nil }
    let w = image.width
    let h = image.height
    var labels = [UInt8](repeating: 0, count: w * h)
    var best = [Float](repeating: 0.5, count: w * h)
    var count = 0
    for instance in obs.allInstances.prefix(254) {
      count += 1
      let buffer = try obs.generateScaledMaskForImage(forInstances: IndexSet(integer: instance), from: handler)
      try forEachValue(buffer, width: w, height: h) { i, v in
        if v > best[i] {
          best[i] = v
          labels[i] = UInt8(count)
        }
      }
    }
    var out = try writeGray(labels, width: w, height: h)
    out["count"] = count
    return out
  }

  /// Visits a one-component mask buffer resampled (nearest) to width × height, values 0..1.
  static func forEachValue(_ buffer: CVPixelBuffer, width: Int, height: Int, _ body: (Int, Float) -> Void) throws {
    let format = CVPixelBufferGetPixelFormatType(buffer)
    guard format == kCVPixelFormatType_OneComponent8 || format == kCVPixelFormatType_OneComponent32Float else {
      throw HikariError("Unsupported mask format \(format)")
    }
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw HikariError("Mask read failed") }
    let bw = CVPixelBufferGetWidth(buffer)
    let bh = CVPixelBufferGetHeight(buffer)
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    for y in 0..<height {
      let row = base.advanced(by: min(bh - 1, y * bh / height) * rowBytes)
      for x in 0..<width {
        let sx = min(bw - 1, x * bw / width)
        let v: Float =
          format == kCVPixelFormatType_OneComponent8
          ? Float(row.load(fromByteOffset: sx, as: UInt8.self)) / 255
          : row.load(fromByteOffset: sx * 4, as: Float.self)
        body(y * width + x, v)
      }
    }
  }

  /// Copies a one-component mask buffer (8-bit or float) into an sRGB-tagged gray PNG.
  static func writeMask(_ buffer: CVPixelBuffer) throws -> [String: Any] {
    let w = CVPixelBufferGetWidth(buffer)
    let h = CVPixelBufferGetHeight(buffer)
    var gray = [UInt8](repeating: 0, count: w * h)
    try forEachValue(buffer, width: w, height: h) { i, v in
      gray[i] = UInt8(max(0, min(1, v)) * 255 + 0.5)
    }
    return try writeGray(gray, width: w, height: h)
  }

  /// The values are data, not light: they are copied verbatim (no Core Image color matching)
  /// and tagged sRGB so the shader's dataOf() reads back exactly what was stored. A
  /// linear-gray tag would make Skia re-encode them, inflating soft edges into halos.
  static func writeGray(_ gray: [UInt8], width w: Int, height h: Int) throws -> [String: Any] {
    var rgba = [UInt8](repeating: 255, count: w * h * 4)
    for i in 0..<(w * h) {
      rgba[i * 4] = gray[i]
      rgba[i * 4 + 1] = gray[i]
      rgba[i * 4 + 2] = gray[i]
    }
    guard let provider = CGDataProvider(data: Data(rgba) as CFData),
      let cg = CGImage(
        width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4,
        space: Decoder.sRGB, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else {
      throw HikariError("Mask render failed")
    }
    let url = Decoder.tempURL(ext: "png")
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
      throw HikariError("Mask write failed")
    }
    CGImageDestinationAddImage(dest, cg, nil)
    guard CGImageDestinationFinalize(dest) else { throw HikariError("Mask write failed") }
    return ["path": url.absoluteString, "width": w, "height": h]
  }
}
