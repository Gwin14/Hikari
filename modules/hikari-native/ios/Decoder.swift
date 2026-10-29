import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers

struct DecodeResult {
  let path: URL
  let width: Int
  let height: Int
  let fullWidth: Int
  let fullHeight: Int
  let format: String
  let isRaw: Bool

  var dictionary: [String: Any] {
    [
      "path": path.absoluteString, "width": width, "height": height,
      "fullWidth": fullWidth, "fullHeight": fullHeight, "format": format, "isRaw": isRaw,
    ]
  }
}

enum Decoder {
  static let rawExtensions = [
    "dng", "cr2", "cr3", "crw", "nef", "nrw", "arw", "srf", "sr2", "raf", "orf", "rw2", "pef", "srw",
    "x3f", "3fr", "fff", "iiq", "mos", "mrw", "erf", "kdc", "dcr", "rwl", "gpr",
  ]

  /// Shared context: linear extended working space with half-float intermediates keeps RAW headroom.
  static let context: CIContext = {
    CIContext(options: [
      .workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
      .workingFormat: CIFormat.RGBAh,
      .cacheIntermediates: false,
    ])
  }()

  static let extendedSRGB = CGColorSpace(name: CGColorSpace.extendedSRGB)!
  static let sRGB = CGColorSpace(name: CGColorSpace.sRGB)!

  static func isRaw(url: URL) -> Bool {
    if rawExtensions.contains(url.pathExtension.lowercased()) { return true }
    if let type = UTType(filenameExtension: url.pathExtension), type.conforms(to: .rawImage) { return true }
    return false
  }

  /// Developed RAW as a CIImage, oriented, scaled so its long edge ≤ maxDim (0 = full).
  static func rawImage(url: URL, maxDim: Int, options: RawDecodeOptions?) -> (CIImage, Int, Int)? {
    guard let filter = CIRAWFilter(imageURL: url) else { return nil }
    let full = filter.nativeSize
    // nativeSize is unoriented; orientation is applied by the filter's output.
    let o = filter.orientation.rawValue
    let swap = o >= 5 && o <= 8
    let fullW = Int(swap ? full.height : full.width)
    let fullH = Int(swap ? full.width : full.height)
    let long = max(fullW, fullH)
    if maxDim > 0 && long > maxDim {
      filter.scaleFactor = Float(maxDim) / Float(long)
    }
    if let o = options {
      filter.boostAmount = Float(o.boost / 100)
      if filter.isLuminanceNoiseReductionSupported {
        filter.luminanceNoiseReductionAmount = Float(o.decodeNoise / 100)
      }
      if filter.isColorNoiseReductionSupported {
        filter.colorNoiseReductionAmount = Float(max(0.1, o.decodeNoise / 100))
      }
      if filter.isLensCorrectionSupported {
        filter.isLensCorrectionEnabled = o.lensCorrection
      }
      // Keep values > 1 so highlights can be recovered in the shader.
      filter.extendedDynamicRangeAmount = o.highlightRecovery ? 1 : 0
    }
    filter.isGamutMappingEnabled = false
    guard let out = filter.outputImage else { return nil }
    return (out, fullW, fullH)
  }

  static func decode(url: URL, options: DecodeOptions) throws -> DecodeResult {
    if options.preferRaw && isRaw(url: url),
      let (image, fw, fh) = rawImage(url: url, maxDim: options.maxDim, options: options.raw ?? RawDecodeOptions())
    {
      let path = try renderHalf(image: image)
      return DecodeResult(
        path: path.0, width: path.1, height: path.2, fullWidth: fw, fullHeight: fh, format: "rgba16f", isRaw: true)
    }
    return try decodeProcessed(url: url, maxDim: options.maxDim)
  }

  /// Render a CIImage to an RGBA half-float buffer in extended sRGB (gamma encoded).
  static func renderHalf(image: CIImage) throws -> (URL, Int, Int) {
    let extent = image.extent.integral
    let w = Int(extent.width)
    let h = Int(extent.height)
    let rowBytes = w * 8
    var data = Data(count: rowBytes * h)
    data.withUnsafeMutableBytes { buf in
      context.render(
        image.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY)),
        toBitmap: buf.baseAddress!, rowBytes: rowBytes,
        bounds: CGRect(x: 0, y: 0, width: w, height: h), format: .RGBAh, colorSpace: extendedSRGB)
    }
    let out = tempURL(ext: "f16")
    try data.write(to: out)
    return (out, w, h)
  }

  static func cgImage(url: URL, maxDim: Int) throws -> (CGImage, Int, Int) {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else {
      throw HikariError("Unsupported image: \(url.lastPathComponent)")
    }
    let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any] ?? [:]
    var pw = props[kCGImagePropertyPixelWidth] as? Int ?? 0
    var ph = props[kCGImagePropertyPixelHeight] as? Int ?? 0
    let orientation = props[kCGImagePropertyOrientation] as? Int ?? 1
    if orientation >= 5 { swap(&pw, &ph) }
    let long = max(pw, ph)
    let target = maxDim > 0 ? min(maxDim, long) : long
    let opts: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceThumbnailMaxPixelSize: max(target, 1),
      kCGImageSourceShouldCacheImmediately: true,
    ]
    guard let img = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
      throw HikariError("Could not decode \(url.lastPathComponent)")
    }
    return (img, pw, ph)
  }

  /// JPEG/HEIC/PNG/TIFF (or the processed preview of a RAW). Wide-gamut or >8-bit sources
  /// are kept in half float so P3 colors survive.
  static func decodeProcessed(url: URL, maxDim: Int) throws -> DecodeResult {
    let (img, fw, fh) = try cgImage(url: url, maxDim: maxDim)
    let w = img.width
    let h = img.height
    let wide = (img.colorSpace?.isWideGamutRGB ?? false) || img.bitsPerComponent > 8
    let out: URL
    if wide {
      let rowBytes = w * 8
      var data = Data(count: rowBytes * h)
      try data.withUnsafeMutableBytes { buf in
        guard
          let ctx = CGContext(
            data: buf.baseAddress, width: w, height: h, bitsPerComponent: 16, bytesPerRow: rowBytes,
            space: extendedSRGB,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.floatComponents.rawValue
              | CGBitmapInfo.byteOrder16Little.rawValue)
        else { throw HikariError("Bitmap context failed") }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
      }
      out = tempURL(ext: "f16")
      try data.write(to: out)
    } else {
      let rowBytes = w * 4
      var data = Data(count: rowBytes * h)
      try data.withUnsafeMutableBytes { buf in
        guard
          let ctx = CGContext(
            data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: rowBytes,
            space: sRGB, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { throw HikariError("Bitmap context failed") }
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
      }
      out = tempURL(ext: "rgba")
      try data.write(to: out)
    }
    return DecodeResult(
      path: out, width: w, height: h, fullWidth: fw, fullHeight: fh, format: wide ? "rgba16f" : "rgba8",
      isRaw: false)
  }

  /// Oriented CGImage of the developed (RAW) or processed image, used by segmentation.
  static func orientedCGImage(url: URL, maxDim: Int, preferRaw: Bool) throws -> CGImage {
    if preferRaw && isRaw(url: url), let (image, _, _) = rawImage(url: url, maxDim: maxDim, options: nil) {
      guard let cg = context.createCGImage(image, from: image.extent, format: .RGBA8, colorSpace: sRGB) else {
        throw HikariError("RAW render failed")
      }
      return cg
    }
    return try cgImage(url: url, maxDim: maxDim).0
  }

  static func tempURL(ext: String) -> URL {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("hikari", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent("\(UUID().uuidString).\(ext)")
  }
}
