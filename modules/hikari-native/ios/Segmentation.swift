import CoreImage
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

  /// Converts a one-component mask buffer (8-bit or float) to a grayscale PNG.
  static func writeMask(_ buffer: CVPixelBuffer) throws -> [String: Any] {
    let ci = CIImage(cvPixelBuffer: buffer)
    let gray = CGColorSpace(name: CGColorSpace.linearGray)!
    guard let cg = Decoder.context.createCGImage(ci, from: ci.extent, format: .L8, colorSpace: gray) else {
      throw HikariError("Mask render failed")
    }
    let url = Decoder.tempURL(ext: "png")
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
      throw HikariError("Mask write failed")
    }
    CGImageDestinationAddImage(dest, cg, nil)
    CGImageDestinationFinalize(dest)
    return ["path": url.absoluteString, "width": cg.width, "height": cg.height]
  }
}
