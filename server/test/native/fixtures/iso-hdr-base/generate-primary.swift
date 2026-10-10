import Foundation
import CoreImage
import CoreGraphics
let width = 1024, height = 32
let p3 = CommandLine.arguments.contains("--p3")
let linear = CGColorSpace(name: p3 ? CGColorSpace.extendedLinearDisplayP3 : CGColorSpace.extendedLinearITUR_2020)!
let hlg = CommandLine.arguments.contains("--hlg")
let pq = CGColorSpace(name: hlg ? CGColorSpace.itur_2100_HLG : p3 ? CGColorSpace.displayP3_PQ : CGColorSpace.itur_2100_PQ)!
var values = [Float](repeating: 1, count: width * height * 4)
for y in 0..<height { for x in 0..<width {
    let q = Float(x) / Float(width - 1)
    let light = (q <= 0.04045 ? q / 12.92 : pow((q + 0.055) / 1.055, 2.4)) * (hlg ? 4 : 8)
    for c in 0..<3 { values[(y * width + x) * 4 + c] = !CommandLine.arguments.contains("--colors") || y >= 24 || c == y / 8 ? light : 0 }
} }
let base = values.withUnsafeBytes { CIImage(bitmapData: Data($0), bytesPerRow: width * 16, size: CGSize(width: width, height: height), format: .RGBAf, colorSpace: linear) }
let context = CIContext(options: [.workingColorSpace: linear])
try context.writeHEIF10Representation(of: base, to: URL(fileURLWithPath: CommandLine.arguments[1]), colorSpace: pq, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 1.0])
