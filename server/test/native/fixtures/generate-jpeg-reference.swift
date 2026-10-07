// Independent reference for capture-metadata-stripped synthetic HDR JPEG exports.
// Core Image URL loading adjusts an adaptive JPEG's SDR baseline even with expandToHDR:false.
// Keep the original JPEG pixels/ICC, omit its adaptive routing metadata, then apply the original map.
import Foundation
import CoreImage
import CoreGraphics
import ImageIO
import CryptoKit
precondition(CommandLine.arguments.count == 3 || (CommandLine.arguments.count == 4 && CommandLine.arguments[3] == "--display-p3"))
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let encoded = try Data(contentsOf: url)
precondition(encoded.count <= 128 * 1024 * 1024 && encoded.prefix(2) == Data([255, 216]))
var primary = Data([255, 216]), offset = 2
while offset + 4 <= encoded.count {
    precondition(encoded[offset] == 255)
    let marker = encoded[offset + 1]
    if marker == 218 {
        let end = encoded.range(of: Data([255, 217]), in: offset..<encoded.count)!
        primary.append(encoded[offset..<end.upperBound])
        break
    }
    let length = Int(encoded[offset + 2]) * 256 + Int(encoded[offset + 3])
    precondition(length >= 2 && offset + 2 + length <= encoded.count)
    let body = encoded[(offset + 4)..<(offset + 2 + length)]
    let captureOrRouting = marker == 225 || (marker == 226 && !body.starts(with: Data("ICC_PROFILE\0".utf8)))
    if !captureOrRouting { primary.append(encoded[offset..<(offset + 2 + length)]) }
    offset += 2 + length
}
let source = CGImageSourceCreateWithData(encoded as CFData, nil)!
let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil)! as NSDictionary
let headroom = (properties["Headroom"] as! NSNumber).floatValue
precondition(headroom.isFinite && headroom >= 1)
let base = CIImage(data: primary, options: [.expandToHDR: false])!
let map = CIImage(data: encoded, options: [.auxiliaryHDRGainMap: true])!
let image = base.applyingGainMap(map, headroom: headroom)
let width = Int(image.extent.width), height = Int(image.extent.height)
precondition(width > 0 && height > 0 && width * height <= 4_000_000)
let p3 = CommandLine.arguments.contains("--display-p3")
let space = CGColorSpace(name: p3 ? CGColorSpace.extendedLinearDisplayP3 : CGColorSpace.extendedLinearITUR_2020)!
let context = CIContext(options: [.workingColorSpace: space, .outputColorSpace: space])
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
    "sourceSha256": SHA256.hash(data: encoded).map { String(format: "%02x", $0) }.joined(),
    "platform": ProcessInfo.processInfo.operatingSystemVersionString,
    "decoder": "Untouched primary JPEG/ICC + Core Image applyingGainMap at full content headroom, RGBAf",
    "colorSpace": p3 ? "extended-linear-display-p3" : "extended-linear-bt2020",
    "headroom": headroom, "width": width, "height": height, "sampleY": rows,
    "sampleStep": 4, "sampleOffset": 2, "rgb": samples
]
try JSONSerialization.data(withJSONObject: reference, options: [.prettyPrinted, .sortedKeys])
    .write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
