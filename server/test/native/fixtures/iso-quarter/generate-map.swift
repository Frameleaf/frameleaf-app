import Foundation
import CoreImage
import CoreGraphics
import ImageIO
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let source = CGImageSourceCreateWithURL(input as CFURL, nil)!
let base = CIImage(cgImage: CGImageSourceCreateImageAtIndex(source, 0, nil)!)
let auxiliary = CIImage(contentsOf: input, options: [.auxiliaryHDRGainMap: true])!
let reduced = auxiliary.transformed(by: CGAffineTransform(scaleX: 0.25, y: 0.25)).settingProperties(auxiliary.properties)
let space = CGColorSpace(name: CGColorSpace.displayP3)!
let context = CIContext(options: [.workingColorSpace: CGColorSpace(name: CGColorSpace.extendedLinearDisplayP3)!])
try context.writeHEIFRepresentation(of: base, to: output, format: .RGBA8, colorSpace: space, options: [.hdrGainMapImage: reduced, .hdrGainMapAsRGB: true])
let generated = CGImageSourceCreateWithURL(output as CFURL, nil)!
print("properties", auxiliary.properties)
print("ISO", CGImageSourceCopyAuxiliaryDataInfoAtIndex(generated, 0, kCGImageAuxiliaryDataTypeISOGainMap) != nil, "Apple", CGImageSourceCopyAuxiliaryDataInfoAtIndex(generated, 0, kCGImageAuxiliaryDataTypeHDRGainMap) != nil)
print("gain-map extent", reduced.extent)
