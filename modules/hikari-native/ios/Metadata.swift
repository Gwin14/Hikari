import CoreImage
import Foundation
import ImageIO

enum Metadata {
  static func read(url: URL) throws -> [String: Any] {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
      let p = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
    else { throw HikariError("Cannot read metadata") }
    let exif = p[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
    let tiff = p[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
    let aux = p[kCGImagePropertyExifAuxDictionary] as? [CFString: Any] ?? [:]
    let gps = p[kCGImagePropertyGPSDictionary] as? [CFString: Any] ?? [:]
    let dng = p[kCGImagePropertyDNGDictionary] as? [CFString: Any]
    var w = p[kCGImagePropertyPixelWidth] as? Int ?? 0
    var h = p[kCGImagePropertyPixelHeight] as? Int ?? 0
    if let o = p[kCGImagePropertyOrientation] as? Int, o >= 5 { swap(&w, &h) }
    let isRaw = Decoder.isRaw(url: url)
    if isRaw, let f = CIRAWFilter(imageURL: url) {
      let s = f.nativeSize
      let o = f.orientation.rawValue
      w = Int(o >= 5 ? s.height : s.width)
      h = Int(o >= 5 ? s.width : s.height)
    }
    var out: [String: Any] = ["width": w, "height": h, "isRaw": isRaw]
    out["make"] = tiff[kCGImagePropertyTIFFMake]
    out["model"] = tiff[kCGImagePropertyTIFFModel]
    out["artist"] = tiff[kCGImagePropertyTIFFArtist]
    out["copyright"] = tiff[kCGImagePropertyTIFFCopyright]
    out["lens"] = exif[kCGImagePropertyExifLensModel] ?? aux[kCGImagePropertyExifAuxLensModel]
    if let iso = exif[kCGImagePropertyExifISOSpeedRatings] as? [Int] { out["iso"] = iso.first }
    out["exposureTime"] = exif[kCGImagePropertyExifExposureTime]
    out["fNumber"] = exif[kCGImagePropertyExifFNumber]
    out["focalLength"] = exif[kCGImagePropertyExifFocalLength]
    out["focalLength35"] = exif[kCGImagePropertyExifFocalLenIn35mmFilm]
    out["exposureBias"] = exif[kCGImagePropertyExifExposureBiasValue]
    if let flash = exif[kCGImagePropertyExifFlash] as? Int { out["flash"] = flash & 1 == 1 }
    out["dateTaken"] = exif[kCGImagePropertyExifDateTimeOriginal]
    if let lat = gps[kCGImagePropertyGPSLatitude] as? Double, let lon = gps[kCGImagePropertyGPSLongitude] as? Double {
      out["latitude"] = (gps[kCGImagePropertyGPSLatitudeRef] as? String) == "S" ? -lat : lat
      out["longitude"] = (gps[kCGImagePropertyGPSLongitudeRef] as? String) == "W" ? -lon : lon
    }
    out["colorProfile"] = p[kCGImagePropertyProfileName]
    out["bitDepth"] = p[kCGImagePropertyDepth]
    if let dng {
      // Apple ProRAW identifies itself through the DNG camera model / profile.
      let profile = (dng[kCGImagePropertyDNGProfileName] as? String) ?? ""
      out["isProRaw"] = profile.contains("Apple") || ((tiff[kCGImagePropertyTIFFMake] as? String) == "Apple")
    }
    return out.compactMapValues { $0 }
  }
}
