import Foundation
import UIKit
import UniformTypeIdentifiers

/// Folder picking with security-scoped bookmarks so access survives app relaunches.
final class FolderPicker: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {
  private let completion: ([String: Any]?) -> Void
  private var finished = false

  init(completion: @escaping ([String: Any]?) -> Void) {
    self.completion = completion
  }

  func present(from vc: UIViewController) {
    let picker = UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)
    picker.delegate = self
    picker.presentationController?.delegate = self
    vc.present(picker, animated: true)
  }

  private func finish(_ value: [String: Any]?) {
    guard !finished else { return }
    finished = true
    completion(value)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first, url.startAccessingSecurityScopedResource() else {
      finish(nil)
      return
    }
    let bookmark = try? url.bookmarkData(options: [], includingResourceValuesForKeys: nil, relativeTo: nil)
    finish(["uri": url.absoluteString, "bookmark": bookmark?.base64EncodedString() as Any, "name": url.lastPathComponent])
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { finish(nil) }
  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) { finish(nil) }

  /// Resolves a stored bookmark and starts accessing the folder for this app session.
  static func resolve(bookmark: String) -> [String: Any]? {
    guard let data = Data(base64Encoded: bookmark) else { return nil }
    var stale = false
    guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
    else { return nil }
    _ = url.startAccessingSecurityScopedResource()
    return ["uri": url.absoluteString, "stale": stale]
  }
}
