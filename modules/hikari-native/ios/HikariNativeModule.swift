import ExpoModulesCore
import Photos
import UIKit
import UniformTypeIdentifiers

struct RawDecodeOptions: Record {
  @Field var decodeNoise: Double = 0
  @Field var highlightRecovery: Bool = true
  @Field var lensCorrection: Bool = true
  @Field var boost: Double = 100
}

struct DecodeOptions: Record {
  @Field var maxDim: Int = 0
  @Field var preferRaw: Bool = true
  @Field var raw: RawDecodeOptions?
}

struct EncodeOptions: Record {
  @Field var format: String = "jpeg"
  @Field var quality: Double = 0.92
  @Field var bitDepth: Int = 8
  @Field var colorSpace: String = "srgb"
  @Field var inputFormat: String = "rgba8"
  @Field var inputColorSpace: String = "srgb"
  @Field var metadataSource: String?
  @Field var metadata: String = "all"
  @Field var artist: String?
  @Field var copyright: String?
  @Field var outputPath: String = ""
}

final class HikariError: GenericException<String> {
  override var reason: String { param }
}

public class HikariNativeModule: Module {
  private var folderPicker: FolderPicker?

  public func definition() -> ModuleDefinition {
    Name("HikariNative")

    Class("RenderImage", NativeRenderImage.self) {
      Property("id") { (o: NativeRenderImage) in o.id }
      Property("width") { (o: NativeRenderImage) in o.image.width }
      Property("height") { (o: NativeRenderImage) in o.image.height }
      Property("fullWidth") { (o: NativeRenderImage) in o.image.fullWidth }
      Property("fullHeight") { (o: NativeRenderImage) in o.image.fullHeight }
      Property("isRaw") { (o: NativeRenderImage) in o.image.isRaw }
      Property("isFloat") { (o: NativeRenderImage) in o.image.isFloat }

      Function("readRgba8") { (o: NativeRenderImage, x: Int, y: Int, width: Int, height: Int) throws -> Data in
        try RenderBridge.readRgba8(o.image, x: x, y: y, width: width, height: height)
      }
      Function("readRgba16") { (o: NativeRenderImage) throws -> Data in
        try RenderBridge.engine().readBytes(o.image, x: 0, y: 0, width: o.image.width, height: o.image.height)
      }
      Function("readFloats") { (o: NativeRenderImage, x: Int, y: Int, width: Int, height: Int) throws -> Data in
        try RenderBridge.engine().readFloats(o.image, x: x, y: y, width: width, height: height)
      }
      Function("encode") { (o: NativeRenderImage, format: String, quality: Double) throws -> Data in
        try RenderBridge.encode(o.image, format: format, quality: quality)
      }
      AsyncFunction("encodeToFile") { (o: NativeRenderImage, options: EncodeOptions) async throws -> [String: Any] in
        var source: URL?
        if let s = options.metadataSource {
          source = try? await Library.resolve(uri: s, preferRaw: false)
        }
        let pixels = try RenderBridge.engine().readBytes(o.image, x: 0, y: 0, width: o.image.width, height: o.image.height)
        return try Encoder.encode(pixels: pixels, width: o.image.width, height: o.image.height, options: options, metadataSource: source)
      }
    }

    Class("EditorSurface", EditorSurface.self) {
      Constructor { EditorSurface() }
      Function("setFrame") { (surface: EditorSurface, frame: [Float]) in
        surface.setFrame(frame)
      }
      Function("setInputs") { (surface: EditorSurface, inputs: RenderInputsRecord?) throws in
        surface.setInputs(try inputs.map { try RenderBridge.resolve($0) })
      }
      Function("setCurve") { (surface: EditorSurface, curve: NativeRenderImage) in
        surface.setCurve(curve.image)
      }
    }

    View(EditorRenderView.self) {}

    Function("makeRenderImage") { (pixels: Data, width: Int, height: Int, format: String) throws -> NativeRenderImage in
      try RenderBridge.makeImage(pixels: pixels, width: width, height: height, format: format)
    }

    AsyncFunction("loadRenderImage") { (uri: String, options: DecodeOptions) async throws -> NativeRenderImage in
      let url = try await Library.resolve(uri: uri, preferRaw: options.preferRaw)
      return try RenderBridge.load(try Decoder.decode(url: url, options: options))
    }

    AsyncFunction("loadEncodedRenderImage") { (uri: String) async throws -> NativeRenderImage in
      try RenderBridge.loadEncoded(uri: uri)
    }

    Function("blurRenderImage") { (image: NativeRenderImage, sigma: Double, width: Int, height: Int) throws -> NativeRenderImage in
      NativeRenderImage(try RenderBridge.engine().blur(image.image, sigma: Float(sigma), width: width, height: height))
    }

    Function("compositeRenderImage") { (source: NativeRenderImage, patches: [RenderPatchRecord]) throws -> NativeRenderImage in
      try RenderBridge.composite(source, patches: patches)
    }

    Function("renderOffscreen") { (inputs: RenderInputsRecord, frame: [Float], width: Int, height: Int, bits: Int, watermark: WatermarkRecord?) throws -> NativeRenderImage in
      try RenderBridge.renderOffscreen(inputs: inputs, frame: frame, width: width, height: height, bits: bits, watermark: watermark)
    }

    Function("rasterizeStrokes") { (strokes: [StrokeRecord], width: Int, height: Int, base: NativeRenderImage?) throws -> NativeRenderImage in
      try MaskRaster.strokes(strokes, width: width, height: height, base: base?.image)
    }

    Function("rasterizeArea") { (strokes: [StrokeRecord], frameW: Int, frameH: Int, region: [Int], objects: NativeRenderImage?) throws -> Data in
      try MaskRaster.area(strokes, frameW: frameW, frameH: frameH, region: region, objects: objects?.image)
    }

    Function("supportedRawExtensions") { () -> [String] in
      Decoder.rawExtensions
    }

    AsyncFunction("decodeImage") { (uri: String, options: DecodeOptions) -> [String: Any] in
      let url = try await Library.resolve(uri: uri, preferRaw: options.preferRaw)
      let result = try Decoder.decode(url: url, options: options)
      return result.dictionary
    }

    AsyncFunction("readMetadata") { (uri: String) -> [String: Any] in
      let url = try await Library.resolve(uri: uri, preferRaw: true)
      return try Metadata.read(url: url)
    }

    AsyncFunction("encodeImage") { (pixels: Data, width: Int, height: Int, options: EncodeOptions) -> [String: Any] in
      var source: URL?
      if let s = options.metadataSource {
        source = try? await Library.resolve(uri: s, preferRaw: false)
      }
      return try Encoder.encode(pixels: pixels, width: width, height: height, options: options, metadataSource: source)
    }

    AsyncFunction("segment") { (uri: String, kind: String, maxDim: Int, preferRaw: Bool) -> [String: Any]? in
      let url = try await Library.resolve(uri: uri, preferRaw: preferRaw)
      return try Segmentation.segment(url: url, kind: kind, maxDim: maxDim, preferRaw: preferRaw)
    }

    AsyncFunction("segmentInstances") { (uri: String, maxDim: Int, preferRaw: Bool) -> [String: Any]? in
      let url = try await Library.resolve(uri: uri, preferRaw: preferRaw)
      return try Segmentation.instances(url: url, maxDim: maxDim, preferRaw: preferRaw)
    }

    AsyncFunction("refineMask") { (guide: Data, mask: Data, width: Int, height: Int, options: RefineOptions) async throws -> Data in
      try Compute.refineMask(guide: guide, mask: mask, width: width, height: height, options: options)
    }

    AsyncFunction("objectMask") { (guide: Data, coverage: Data, selected: Data?, width: Int, height: Int) async throws -> Data in
      try Compute.objectMask(guide: guide, coverage: coverage, selected: selected, width: width, height: height)
    }

    AsyncFunction("selectInstances") { (labels: Data, labelStride: Int, count: Int, coverage: Data, coverageStride: Int, n: Int, minCover: Double, minShare: Double) async throws -> [String: Any] in
      try Compute.selectInstances(labels: labels, labelStride: labelStride, count: count, coverage: coverage, coverageStride: coverageStride, n: n, minCover: minCover, minShare: minShare)
    }

    AsyncFunction("removeSpot") { (pixels: Data, area: Data, alpha: Data, width: Int, height: Int, options: RemoveOptions) async throws -> [String: Any] in
      try Compute.removeSpot(pixels: pixels, area: area, alpha: alpha, width: width, height: height, options: options)
    }

    AsyncFunction("computeHistogram") { (pixels: Data, step: Int) async throws -> [String: Any] in
      try Compute.histogram(pixels: pixels, step: step)
    }

    AsyncFunction("skyMask") { (pixels: Data, width: Int, height: Int) async throws -> Data in
      try Compute.skyMask(pixels: pixels, width: width, height: height)
    }

    AsyncFunction("autoAdjust") { (pixels: Data) async throws -> [String: Any] in
      try Compute.autoAdjust(pixels: pixels)
    }

    AsyncFunction("assetResources") { (assetId: String) -> [String: Any]? in
      Library.resources(assetId: assetId)
    }

    AsyncFunction("exportAssetResource") { (assetId: String, kind: String) -> String in
      try await Library.exportResource(assetId: assetId, raw: kind == "raw").absoluteString
    }

    AsyncFunction("saveEditToLibrary") { (assetId: String, renderedPath: String, json: String, version: String) -> Bool in
      try await Library.saveEdit(assetId: assetId, renderedPath: renderedPath, json: json, version: version)
    }

    AsyncFunction("readLibraryAdjustment") { (assetId: String) -> String? in
      await Library.readAdjustment(assetId: assetId)
    }

    AsyncFunction("readForeignAdjustment") { (assetId: String, format: String) -> String? in
      await Library.readForeignAdjustment(assetId: assetId, format: format)
    }

    AsyncFunction("revertLibraryEdit") { (assetId: String) -> Bool in
      try await Library.revert(assetId: assetId)
    }

    AsyncFunction("pickFolder") { (promise: Promise) in
      guard let vc = self.appContext?.utilities?.currentViewController() else {
        promise.reject(HikariError("No view controller to present the folder picker"))
        return
      }
      let picker = FolderPicker { [weak self] grant in
        promise.resolve(grant)
        self?.folderPicker = nil
      }
      self.folderPicker = picker
      picker.present(from: vc)
    }.runOnQueue(.main)

    AsyncFunction("resolveBookmark") { (bookmark: String) -> [String: Any]? in
      FolderPicker.resolve(bookmark: bookmark)
    }
  }
}
