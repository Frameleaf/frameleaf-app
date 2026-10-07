// Independent synthetic-fixture reference. Run on macOS; no Frameleaf codec is used.
import Foundation
import CoreImage
import CoreGraphics
import CryptoKit
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let space = CGColorSpace(name: CGColorSpace.extendedLinearITUR_2020)!
let context = CIContext(options: [.workingColorSpace: space, .outputColorSpace: space])
let image = CIImage(contentsOf: url, options: [.expandToHDR: true])!
let width = Int(image.extent.width), height = Int(image.extent.height)
var pixels = [Float](repeating: 0, count: width * height * 4)
pixels.withUnsafeMutableBytes {
    context.render(image, toBitmap: $0.baseAddress!, rowBytes: width * 16,
                   bounds: image.extent, format: .RGBAf, colorSpace: space)
}
let rows = [height / 8, height * 3 / 8, height * 5 / 8, height * 7 / 8]
let samples = rows.map { y in
    (0..<width / 4).map { x in
        Array(pixels[(y * width + x * 4 + 2) * 4..<(y * width + x * 4 + 2) * 4 + 3])
    }
}
let reference: [String: Any] = [
    "sourceSha256": SHA256.hash(data: try Data(contentsOf: url)).map { String(format: "%02x", $0) }.joined(),
    "platform": ProcessInfo.processInfo.operatingSystemVersionString,
    "decoder": "CIImage expandToHDR, RGBAf extendedLinearITUR_2020",
    "width": width, "height": height, "sampleY": rows, "sampleStep": 4, "sampleOffset": 2, "rgb": samples
]
try JSONSerialization.data(withJSONObject: reference, options: [.prettyPrinted, .sortedKeys])
    .write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
