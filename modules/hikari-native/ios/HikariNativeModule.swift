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
