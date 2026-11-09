// Renders a packed frame with the Metal engine on the host, driven by pipeline.gpu.test.ts.
// usage: harness <dir> <imageW> <imageH> <format 8|16>; files source, curve, mask (optional), frame.
import Foundation
import Metal

let args = CommandLine.arguments
let dir = URL(fileURLWithPath: args[1])
let width = Int(args[2])!
let height = Int(args[3])!
let format: MTLPixelFormat = args[4] == "16" ? .rgba16Unorm : .rgba8Unorm

guard let engine = RenderEngine.shared else {
  FileHandle.standardError.write(Data("Metal unavailable\n".utf8))
  exit(3)
}

func image(_ name: String, _ w: Int, _ h: Int) throws -> RenderImage? {
  guard let data = try? Data(contentsOf: dir.appendingPathComponent(name)), !data.isEmpty else { return nil }
  return try data.withUnsafeBytes { try engine.makeImage(bytes: $0.baseAddress!, width: w, height: h, format: .rgba8Unorm) }
}

do {
  let source = try image("source", width, height)!
  let curve = try image("curve", 256, 1)
  let mask = try image("mask", width, height)
  let raw = try Data(contentsOf: dir.appendingPathComponent("frame"))
  let frame = raw.withUnsafeBytes { Array($0.bindMemory(to: Float.self)) }
  let inputs = RenderInputs(
    source: source, cleaned: source, blurN: source, blurS: source, blurM: source, blurL: source,
    curve: curve, lut: nil, masks: mask.map { [$0] } ?? [])
  let out = try engine.render(inputs: inputs, frame: frame, width: width, height: height, format: format)
  try engine.readBytes(out, x: 0, y: 0, width: width, height: height).write(to: dir.appendingPathComponent("out"))
} catch {
  FileHandle.standardError.write(Data("\(error)\n".utf8))
  exit(1)
}
