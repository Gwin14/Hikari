import Foundation
import ImageIO
import UniformTypeIdentifiers

enum Encoder {
  static func colorSpace(_ name: String) -> CGColorSpace {
    switch name {
    case "p3": return CGColorSpace(name: CGColorSpace.displayP3)!
    case "adobergb": return CGColorSpace(name: CGColorSpace.adobeRGB1998)!
    default: return CGColorSpace(name: CGColorSpace.sRGB)!
    }
  }

  static func utType(_ format: String) throws -> UTType {
    switch format {
    case "jpeg": return .jpeg
    case "heic": return .heic
    case "png": return .png
    case "tiff": return .tiff
    default: throw HikariError("Format \(format) is not supported on iOS")
    }
  }

  /// Builds a CGImage over the JS pixel buffer (opaque RGBA).
  static func inputImage(pixels: Data, width: Int, height: Int, format: String, space: String) throws -> CGImage {
    let half = format == "rgba16f"
    let wide = format == "rgba16f" || format == "rgba16"
    let bpc = wide ? 16 : 8
    let bpp = wide ? 64 : 32
    let rowBytes = width * (wide ? 8 : 4)
    guard pixels.count >= rowBytes * height, let provider = CGDataProvider(data: pixels as CFData) else {
      throw HikariError("Pixel buffer too small")
    }
    var info = CGImageAlphaInfo.noneSkipLast.rawValue
    if wide { info |= CGBitmapInfo.byteOrder16Little.rawValue }
    if half { info |= CGBitmapInfo.floatComponents.rawValue }
    let cs: CGColorSpace =
      half ? Decoder.extendedSRGB : (space == "p3" ? CGColorSpace(name: CGColorSpace.displayP3)! : Decoder.sRGB)
    guard
      let img = CGImage(
        width: width, height: height, bitsPerComponent: bpc, bitsPerPixel: bpp, bytesPerRow: rowBytes,
        space: cs, bitmapInfo: CGBitmapInfo(rawValue: info),
        provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)
    else { throw HikariError("Could not wrap pixels") }
    return img
  }

  /// Converts into the destination color space and bit depth (opaque output).
  static func convert(_ img: CGImage, space: CGColorSpace, bitDepth: Int) throws -> CGImage {
    let w = img.width
    let h = img.height
    let bpc = bitDepth == 16 ? 16 : 8
    let info: UInt32 =
      CGImageAlphaInfo.noneSkipLast.rawValue | (bpc == 16 ? CGBitmapInfo.byteOrder16Little.rawValue : 0)
    guard
      let ctx = CGContext(
        data: nil, width: w, height: h, bitsPerComponent: bpc, bytesPerRow: 0, space: space, bitmapInfo: info)
    else { throw HikariError("Conversion context failed") }
    ctx.interpolationQuality = .none
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    guard let out = ctx.makeImage() else { throw HikariError("Conversion failed") }
    return out
  }

  static func metadata(from source: URL?, policy: String, options: EncodeOptions) -> [CFString: Any] {
    var props: [CFString: Any] = [:]
    if policy != "none", let source,
      let src = CGImageSourceCreateWithURL(source as CFURL, nil),
      let original = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
    {
      if policy == "copyright" {
        if let tiff = original[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
          props[kCGImagePropertyTIFFDictionary] = tiff.filter {
            $0.key == kCGImagePropertyTIFFArtist || $0.key == kCGImagePropertyTIFFCopyright
          }
        }
        if let iptc = original[kCGImagePropertyIPTCDictionary] as? [CFString: Any] {
          props[kCGImagePropertyIPTCDictionary] = iptc.filter {
            $0.key == kCGImagePropertyIPTCCopyrightNotice || $0.key == kCGImagePropertyIPTCByline
          }
        }
      } else {
        for key in [
          kCGImagePropertyExifDictionary, kCGImagePropertyTIFFDictionary, kCGImagePropertyIPTCDictionary,
          kCGImagePropertyExifAuxDictionary, kCGImagePropertyGPSDictionary,
        ] {
          if let v = original[key] { props[key] = v }
        }
        if policy == "noLocation" { props.removeValue(forKey: kCGImagePropertyGPSDictionary) }
      }
    }
    var tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
    tiff[kCGImagePropertyTIFFSoftware] = "Hikari"
    tiff[kCGImagePropertyTIFFOrientation] = 1
    if let a = options.artist, !a.isEmpty { tiff[kCGImagePropertyTIFFArtist] = a }
    if let c = options.copyright, !c.isEmpty { tiff[kCGImagePropertyTIFFCopyright] = c }
    props[kCGImagePropertyTIFFDictionary] = tiff
    props[kCGImagePropertyOrientation] = 1
    if var exif = props[kCGImagePropertyExifDictionary] as? [CFString: Any] {
      exif.removeValue(forKey: kCGImagePropertyExifPixelXDimension)
      exif.removeValue(forKey: kCGImagePropertyExifPixelYDimension)
      props[kCGImagePropertyExifDictionary] = exif
    }
    return props
  }

  static func encode(pixels: Data, width: Int, height: Int, options: EncodeOptions, metadataSource: URL?) throws
    -> [String: Any]
  {
    let type = try utType(options.format)
    let input = try inputImage(
      pixels: pixels, width: width, height: height, format: options.inputFormat, space: options.inputColorSpace)
    let depth = (options.format == "tiff" || options.format == "png") ? options.bitDepth : 8
    let image = try convert(input, space: colorSpace(options.colorSpace), bitDepth: depth)
    guard let url = URL(string: options.outputPath) else { throw HikariError("Invalid output path") }
    try? FileManager.default.removeItem(at: url)
    guard let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else {
      throw HikariError("Cannot create \(options.format) file")
    }
    var props = metadata(from: metadataSource, policy: options.metadata, options: options)
    props[kCGImageDestinationLossyCompressionQuality] = options.quality
    if options.format == "tiff" {
      var tiff = props[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
      tiff[kCGImagePropertyTIFFCompression] = 5  // LZW
      props[kCGImagePropertyTIFFDictionary] = tiff
    }
    CGImageDestinationAddImage(dest, image, props as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { throw HikariError("Encoding failed") }
    let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
    return ["path": url.absoluteString, "size": size]
  }
}
