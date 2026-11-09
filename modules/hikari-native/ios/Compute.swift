import ExpoModulesCore
import Foundation

struct RefineOptions: Record {
  @Field var radius: Int = 1
  @Field var eps: Double = 1e-4
  @Field var lo: Double = 0
  @Field var hi: Double = 1
}

struct RemoveOptions: Record {
  @Field var grow: Int = 0
  @Field var feather: Int = 1
  @Field var searchMaxDim: Int = 1024
  @Field var seed: UInt32 = 1234567
}

/** Swift face of compute/hikari_compute. Sizes are checked here: the C side trusts its buffers. */
enum Compute {
  private static func require(_ data: Data, _ bytes: Int, _ name: String) throws {
    guard bytes > 0, data.count >= bytes else {
      throw HikariError("\(name): expected \(bytes) bytes, got \(data.count)")
    }
  }

  private static func filled(_ count: Int, _ body: (UnsafeMutablePointer<UInt8>) -> Void) -> Data {
    var out = Data(count: count)
    out.withUnsafeMutableBytes { body($0.bindMemory(to: UInt8.self).baseAddress!) }
    return out
  }

  private static func bytes<R>(_ data: Data, _ body: (UnsafePointer<UInt8>) -> R) -> R {
    data.withUnsafeBytes { body($0.bindMemory(to: UInt8.self).baseAddress!) }
  }

  static func refineMask(guide: Data, mask: Data, width: Int, height: Int, options: RefineOptions) throws -> Data {
    let n = width * height
    try require(guide, n * 4, "guide")
    try require(mask, n, "mask")
    return filled(n) { out in
      bytes(guide) { g in
        bytes(mask) { m in
          hk_refine_mask(g, m, mask.count, Int32(width), Int32(height), Int32(options.radius), options.eps, options.lo, options.hi, out)
        }
      }
    }
  }

  static func objectMask(guide: Data, coverage: Data, selected: Data?, width: Int, height: Int) throws -> Data {
    let n = width * height
    try require(guide, n * 4, "guide")
    try require(coverage, n, "coverage")
    if let selected { try require(selected, n, "selected") }
    return filled(n) { out in
      bytes(guide) { g in
        bytes(coverage) { c in
          if let selected {
            bytes(selected) { s in hk_object_mask(g, c, coverage.count, s, selected.count, Int32(width), Int32(height), out) }
          } else {
            hk_object_mask(g, c, coverage.count, nil, 0, Int32(width), Int32(height), out)
          }
        }
      }
    }
  }

  static func selectInstances(labels: Data, labelStride: Int, count: Int, coverage: Data, coverageStride: Int, n: Int, minCover: Double, minShare: Double) throws -> [String: Any] {
    try require(labels, n * labelStride, "labels")
    try require(coverage, n * coverageStride, "coverage")
    var picked: Int32 = 0
    let mask = filled(n) { out in
      bytes(labels) { l in
        bytes(coverage) { c in
          picked = hk_select_instances(l, Int32(labelStride), Int32(count), c, Int32(coverageStride), Int32(n), minCover, minShare, out)
        }
      }
    }
    return ["mask": mask, "picked": Int(picked)]
  }

  static func removeSpot(pixels: Data, area: Data, alpha: Data, width: Int, height: Int, options: RemoveOptions) throws -> [String: Any] {
    let n = width * height
    let floatSize = MemoryLayout<Float>.size
    try require(pixels, n * 3 * floatSize, "pixels")
    try require(area, n, "area")
    try require(alpha, n * floatSize, "alpha")
    var outPixels = pixels
    var outAlpha = alpha
    outPixels.withUnsafeMutableBytes { p in
      outAlpha.withUnsafeMutableBytes { a in
        bytes(area) { areaPtr in
          hk_remove_spot(
            p.bindMemory(to: Float.self).baseAddress!, areaPtr, a.bindMemory(to: Float.self).baseAddress!,
            Int32(width), Int32(height), Int32(options.grow), Int32(options.feather), Int32(options.searchMaxDim), options.seed)
        }
      }
    }
    return ["pixels": outPixels, "alpha": outAlpha]
  }

  static func histogram(pixels: Data, step: Int) throws -> [String: Any] {
    guard step > 0 else { throw HikariError("histogram: step must be positive") }
    var bins = [UInt32](repeating: 0, count: 1024)
    var total: UInt32 = 0
    var clipLow = 0.0
    var clipHigh = 0.0
    if !pixels.isEmpty {
      bytes(pixels) { hk_histogram($0, pixels.count - pixels.count % 4, Int32(step), &bins, &total, &clipLow, &clipHigh) }
    }
    return ["bins": bins.map { Int($0) }, "total": Int(total), "clipLow": clipLow, "clipHigh": clipHigh]
  }

  static func skyMask(pixels: Data, width: Int, height: Int) throws -> Data {
    let n = width * height
    try require(pixels, n * 4, "pixels")
    return filled(n) { out in bytes(pixels) { hk_sky_mask($0, Int32(width), Int32(height), out) } }
  }

  static func autoAdjust(pixels: Data) throws -> [String: Any] {
    guard !pixels.isEmpty else { throw HikariError("autoAdjust: no pixels") }
    var light = [Double](repeating: 0, count: 6)
    var wb = [Double](repeating: 0, count: 2)
    bytes(pixels) { hk_auto_adjust($0, pixels.count - pixels.count % 4, &light, &wb) }
    return [
      "light": [
        "exposure": light[0], "contrast": light[1], "highlights": light[2],
        "shadows": light[3], "whites": light[4], "blacks": light[5],
      ],
      "temperature": wb[0],
      "tint": wb[1],
    ]
  }
}
