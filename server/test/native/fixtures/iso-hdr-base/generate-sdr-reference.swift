// Independent synthetic-fixture reference. Run on macOS; no Frameleaf codec is used.
import Foundation
import CoreImage
import CoreGraphics
import CryptoKit
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let p3 = CommandLine.arguments.contains("--display-p3")
let space = CGColorSpace(name: p3 ? CGColorSpace.extendedLinearDisplayP3 : CGColorSpace.extendedLinearITUR_2020)!
let context = CIContext(options: [.workingColorSpace: space, .outputColorSpace: space])
let original = CIImage(contentsOf: url, options: [.expandToHDR: true])!
let alternate = CommandLine.arguments.contains("--alternate")
let scale = [0.125, alternate ? 0.0625 : 0.125, alternate ? 0.03125 : 0.125]
let image = original.applyingFilter("CIColorMatrix", parameters: ["inputRVector": CIVector(x: 0.125, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: scale[1], z: 0, w: 0), "inputBVector": CIVector(x: 0, y: 0, z: scale[2], w: 0), "inputBiasVector": CIVector(x: 0.00002 * scale[0] - 0.00001, y: 0.00002 * scale[1] - 0.00001, z: 0.00002 * scale[2] - 0.00001, w: 0)])
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
    "decoder": "CIImage expandToHDR, inverse authored per-channel gain + offsets, RGBAf color-managed BT2020",
    "colorSpace": p3 ? "extended-linear-display-p3" : "extended-linear-bt2020",
    "width": width, "height": height, "sampleY": rows, "sampleStep": 4, "sampleOffset": 2, "rgb": samples
]
try JSONSerialization.data(withJSONObject: reference, options: [.prettyPrinted, .sortedKeys])
    .write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
