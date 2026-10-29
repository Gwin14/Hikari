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
    let image = try Decoder.orientedCGImage(url: url, maxDim: maxDim > 0 ? maxDim : 1536, preferRaw: preferRaw)
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

  /// Copies a one-component mask buffer (8-bit or float) into an sRGB-tagged RGBA PNG.
  /// The values are data, not light: they are copied verbatim (no Core Image color matching)
  /// and tagged sRGB so the shader's dataOf() reads back exactly what Vision produced. A
  /// linear-gray tag would make Skia re-encode them, inflating soft edges into halos.
  static func writeMask(_ buffer: CVPixelBuffer) throws -> [String: Any] {
    let format = CVPixelBufferGetPixelFormatType(buffer)
    guard format == kCVPixelFormatType_OneComponent8 || format == kCVPixelFormatType_OneComponent32Float else {
      throw HikariError("Unsupported mask format \(format)")
    }
    CVPixelBufferLockBaseAddress(buffer, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw HikariError("Mask read failed") }
    let w = CVPixelBufferGetWidth(buffer)
    let h = CVPixelBufferGetHeight(buffer)
    let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
    var rgba = [UInt8](repeating: 255, count: w * h * 4)
    for y in 0..<h {
      let row = base.advanced(by: y * rowBytes)
      for x in 0..<w {
        let v: UInt8
        if format == kCVPixelFormatType_OneComponent8 {
          v = row.load(fromByteOffset: x, as: UInt8.self)
        } else {
          let f = row.load(fromByteOffset: x * 4, as: Float.self)
          v = UInt8(max(0, min(1, f)) * 255 + 0.5)
        }
        let i = (y * w + x) * 4
        rgba[i] = v
        rgba[i + 1] = v
        rgba[i + 2] = v
      }
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
