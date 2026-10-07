// Synthetic fixture only; contains no captured media. Run on macOS with ImageIO.
import Foundation
import CoreGraphics
import ImageIO
import CoreVideo
let out = URL(fileURLWithPath: CommandLine.arguments[1])
let ramp = CommandLine.arguments.contains("--ramp")
let width = ramp ? 1024 : 64, height = 32
let space = CGColorSpace(name: CGColorSpace.displayP3)!
var bytes = [UInt8](repeating: 100, count: width * height * 3)
if CommandLine.arguments.contains("--colors") {
    let colors: [[UInt8]] = [[240, 25, 12], [5, 240, 25], [10, 20, 240], [100, 100, 100]]
    for y in 0..<height { for x in 0..<width { for c in 0..<3 {
        bytes[(y * width + x) * 3 + c] = colors[y / (height / 4)][c]
    } } }
}
let provider = CGDataProvider(data: Data(bytes) as CFData)!
let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 24,
                    bytesPerRow: width * 3, space: space, bitmapInfo: CGBitmapInfo(rawValue: 0),
                    provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
let dst = CGImageDestinationCreateWithURL(out as CFURL, "public.heic" as CFString, 1, nil)!
let properties: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 1.0,
    kCGImagePropertyMakerAppleDictionary: ["33": NSNumber(value: Float(1)), "48": NSNumber(value: Float(0))]]
CGImageDestinationAddImage(dst, image, properties as CFDictionary)
let metadata = CGImageMetadataCreateMutable()
let namespace = "http://ns.apple.com/HDRGainMap/1.0/" as CFString
precondition(CGImageMetadataRegisterNamespaceForPrefix(metadata, namespace, "HDRGainMap" as CFString, nil))
precondition(CGImageMetadataSetValueWithPath(metadata, nil, "HDRGainMap:HDRGainMapVersion" as CFString, "65536" as CFString))
let mapWidth = width / 4, mapHeight = height / 4
var map = [UInt8](repeating: 0, count: mapWidth * mapHeight)
for y in 0..<mapHeight { for x in 0..<mapWidth { map[y * mapWidth + x] = ramp ? UInt8(x) : (x < 4 ? 0 : x < 8 ? 64 : x < 12 ? 128 : 255) } }
let aux: [CFString: Any] = [kCGImageAuxiliaryDataInfoData: Data(map),
    kCGImageAuxiliaryDataInfoDataDescription: [kCGImagePropertyWidth: mapWidth, kCGImagePropertyHeight: mapHeight,
        kCGImagePropertyBytesPerRow: mapWidth, kCGImagePropertyPixelFormat: kCVPixelFormatType_OneComponent8],
    kCGImageAuxiliaryDataInfoMetadata: metadata]
CGImageDestinationAddAuxiliaryDataInfo(dst, kCGImageAuxiliaryDataTypeHDRGainMap, aux as CFDictionary)
precondition(CGImageDestinationFinalize(dst))
let source = CGImageSourceCreateWithURL(out as CFURL, nil)!
let info = CGImageSourceCopyAuxiliaryDataInfoAtIndex(source, 0, kCGImageAuxiliaryDataTypeHDRGainMap)! as NSDictionary
print("aux keys", info.allKeys)
print("description", info[kCGImageAuxiliaryDataInfoDataDescription]!)
print("primary MakerApple", (CGImageSourceCopyPropertiesAtIndex(source, 0, nil)! as NSDictionary)[kCGImagePropertyMakerAppleDictionary] as Any)
let loadedMetadata = info[kCGImageAuxiliaryDataInfoMetadata] as! CGImageMetadata
print(String(data: CGImageMetadataCreateXMPData(loadedMetadata, nil)! as Data, encoding: .utf8)!)
