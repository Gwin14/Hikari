import Foundation
import Photos
import UniformTypeIdentifiers

/// PhotoKit integration: RAW+JPEG resources, original access and reversible edits
/// stored as PHAdjustmentData (the Photos app can revert them, and Hikari can resume them).
enum Library {
  static let formatIdentifier = "app.hikari.editor.recipe"

  static func asset(_ id: String) -> PHAsset? {
    let local = id.hasPrefix("ph://") ? String(id.dropFirst(5)) : id
    return PHAsset.fetchAssets(withLocalIdentifiers: [local], options: nil).firstObject
  }

  /// Turns `ph://` ids into a readable file URL; passes file URLs through.
  static func resolve(uri: String, preferRaw: Bool) async throws -> URL {
    if uri.hasPrefix("ph://") || !uri.contains("://") && !uri.hasPrefix("/") {
      return try await exportResource(assetId: uri, raw: preferRaw)
    }
    if let url = URL(string: uri), url.scheme != nil { return url }
    return URL(fileURLWithPath: uri)
  }

  static func isRawResource(_ r: PHAssetResource) -> Bool {
    if let t = UTType(r.uniformTypeIdentifier), t.conforms(to: .rawImage) { return true }
    return Decoder.rawExtensions.contains((r.originalFilename as NSString).pathExtension.lowercased())
  }

  static func resources(assetId: String) -> [String: Any]? {
    guard let a = asset(assetId) else { return nil }
    let res = PHAssetResource.assetResources(for: a)
    let raw = res.first { ($0.type == .photo || $0.type == .alternatePhoto) && isRawResource($0) }
    let photo = res.first { ($0.type == .photo || $0.type == .alternatePhoto) && !isRawResource($0) }
    var out: [String: Any] = ["hasRaw": raw != nil, "hasPhoto": photo != nil, "isProRaw": false]
    if let raw {
      out["rawFilename"] = raw.originalFilename
      out["isProRaw"] = raw.uniformTypeIdentifier == "com.adobe.raw-image" && raw.originalFilename.hasPrefix("IMG_")
    }
    if let photo { out["photoFilename"] = photo.originalFilename }
    return out
  }

  /// Copies the *original* (unedited) RAW or processed resource into the cache.
  static func exportResource(assetId: String, raw: Bool) async throws -> URL {
    guard let a = asset(assetId) else { throw HikariError("Asset not found") }
    let res = PHAssetResource.assetResources(for: a)
    let originals = res.filter { $0.type == .photo || $0.type == .alternatePhoto }
    let pick =
      (raw ? originals.first(where: isRawResource) : originals.first(where: { !isRawResource($0) }))
      ?? originals.first ?? res.first
    guard let resource = pick else { throw HikariError("Asset has no image data") }
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("hikari-assets", isDirectory: true)
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    let safeId = a.localIdentifier.replacingOccurrences(of: "/", with: "_")
    let url = dir.appendingPathComponent("\(safeId)-\(resource.originalFilename)")
    if FileManager.default.fileExists(atPath: url.path) { return url }
    let opts = PHAssetResourceRequestOptions()
    opts.isNetworkAccessAllowed = true
    try await PHAssetResourceManager.default().writeData(for: resource, toFile: url, options: opts)
    return url
  }

  static func editingInput(_ a: PHAsset) async -> PHContentEditingInput? {
    await withCheckedContinuation { cont in
      let opts = PHContentEditingInputRequestOptions()
      opts.isNetworkAccessAllowed = true
      opts.canHandleAdjustmentData = { $0.formatIdentifier == formatIdentifier }
      a.requestContentEditingInput(with: opts) { input, _ in cont.resume(returning: input) }
    }
  }

  static func saveEdit(assetId: String, renderedPath: String, json: String, version: String) async throws -> Bool {
    guard let a = asset(assetId) else { throw HikariError("Asset not found") }
    guard let input = await editingInput(a) else { throw HikariError("Cannot edit this asset") }
    let output = PHContentEditingOutput(contentEditingInput: input)
    output.adjustmentData = PHAdjustmentData(
      formatIdentifier: formatIdentifier, formatVersion: version, data: Data(json.utf8))
    guard let src = URL(string: renderedPath) else { throw HikariError("Invalid rendered path") }
    let dest = output.renderedContentURL
    try? FileManager.default.removeItem(at: dest)
    try FileManager.default.copyItem(at: src, to: dest)
    try await PHPhotoLibrary.shared().performChanges {
      PHAssetChangeRequest(for: a).contentEditingOutput = output
    }
    return true
  }

  static func readAdjustment(assetId: String) async -> String? {
    guard let a = asset(assetId), let input = await editingInput(a),
      let adj = input.adjustmentData, adj.formatIdentifier == formatIdentifier
    else { return nil }
    return String(data: adj.data, encoding: .utf8)
  }

  /// Adjustment data another app left on the asset (e.g. Komorebi's "app.komorebi.effects"
  /// recipe), without claiming it as ours. Only the data is read, never the rendition.
  static func readForeignAdjustment(assetId: String, format: String) async -> String? {
    guard let a = asset(assetId) else { return nil }
    let input: PHContentEditingInput? = await withCheckedContinuation { cont in
      let opts = PHContentEditingInputRequestOptions()
      opts.isNetworkAccessAllowed = true
      opts.canHandleAdjustmentData = { $0.formatIdentifier == format }
      a.requestContentEditingInput(with: opts) { input, _ in cont.resume(returning: input) }
    }
    guard let adj = input?.adjustmentData, adj.formatIdentifier == format else { return nil }
    return String(data: adj.data, encoding: .utf8)
  }

  static func revert(assetId: String) async throws -> Bool {
    guard let a = asset(assetId) else { throw HikariError("Asset not found") }
    try await PHPhotoLibrary.shared().performChanges {
      PHAssetChangeRequest(for: a).revertAssetContentToOriginal()
    }
    return true
  }
}
