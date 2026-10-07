import Foundation
import CoreImage
import CoreGraphics
import ImageIO
let width = 1024, height = 32
let linear = CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)!
let display = CGColorSpace(name: CGColorSpace.displayP3)!
var values = [Float](repeating: 1, count: width * height * 4)
for y in 0..<height { for x in 0..<width {
    let gamma = Float(x) / Float(width - 1)
    let light = gamma <= 0.04045 ? gamma / 12.92 : pow((gamma + 0.055) / 1.055, 2.4)
    for c in 0..<3 { values[(y * width + x) * 4 + c] = light }
} }
let base = values.withUnsafeBytes { CIImage(bitmapData: Data($0), bytesPerRow: width * 16, size: CGSize(width: width, height: height), format: .RGBAf, colorSpace: linear) }
let hdr = base.applyingFilter("CIColorMatrix", parameters: ["inputRVector": CIVector(x: 8, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: 8, z: 0, w: 0), "inputBVector": CIVector(x: 0, y: 0, z: 8, w: 0)])
let context = CIContext(options: [.workingColorSpace: linear])
let url = URL(fileURLWithPath: CommandLine.arguments[1])
try context.writeHEIF10Representation(of: base, to: url, colorSpace: display, options: [.hdrImage: hdr, .hdrGainMapAsRGB: true, kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 1.0])
let source = CGImageSourceCreateWithURL(url as CFURL, nil)!
precondition(CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeISOGainMap) != nil)
