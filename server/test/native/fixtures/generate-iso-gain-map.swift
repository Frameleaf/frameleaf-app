// Synthetic ISO HEIC fixture written by Core Image; not a camera or display qualification.
import Foundation
import CoreImage
import CoreGraphics
import ImageIO
import CryptoKit
precondition(CommandLine.arguments.count == 3)
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
let baseSource = CGImageSourceCreateWithData(primary as CFData, nil)!
let base = CGImageSourceCreateImageAtIndex(baseSource, 0, nil)!
precondition(CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeISOGainMap) != nil)
let space = CGColorSpace(name: CGColorSpace.displayP3)!
let context = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)!])
let hdr = CIImage(data: encoded, options: [.expandToHDR: true])!
try context.writeHEIFRepresentation(of: CIImage(cgImage: base), to: URL(fileURLWithPath: CommandLine.arguments[2]), format: .RGBA8, colorSpace: space, options: [.hdrImage: hdr, .hdrGainMapAsRGB: true])
let generated = CGImageSourceCreateWithURL(URL(fileURLWithPath: CommandLine.arguments[2]) as CFURL, nil)!
precondition(CGImageSourceCopyAuxiliaryDataInfoAtIndex(generated, 0, kCGImageAuxiliaryDataTypeISOGainMap) != nil)
print("Apple ISO HEIC synthetic fixture generated")
