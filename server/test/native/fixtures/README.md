# Synthetic transfer fixtures

These files contain no user media. Generated with libheif 1.23.6 / libaom lossless
10-bit AVIF from 64 × 32 RGB16 PNG bars, explicit BT.2020 primaries, identity
matrix, full range and the indicated transfer. They verify implementation math
and primary-image container geometry. They do not qualify camera codecs or HDR
displays.

| File | Signal | SHA-256 |
| --- | --- | --- |
| pq-rotated.avif | ST 2084 bars at 0, 100, 203, 6500 cd/m²; clockwise 90° container transform | 9f5a16c1e25c627fdd9175808f3a07f90aa7311f208d4c7298a5697577fe7d98 |
| hlg.avif | HLG signal bars at 0, 0.5, 0.75, 1 | ce1389c157c65c217ff42579411e4a91bba2bef4263d3bb41280d5647bf66480 |

HLG interpretation uses the same explicit nominal 1000 cd/m² display / gamma
1.2 policy as Studio, with working pixels relative to 203 cd/m² reference white.
PQ remains absolute luminance divided by that reference white. The gain-map JPEG
round-trip and EXIF fixtures are generated in memory by the test.

Run `FRAMELEAF_HDR_BINDING=/path/to/image-hdr.node node --test server/test/native/image-hdr.test.mjs`.
The Docker codec stage runs these same tests on Linux amd64 and arm64. Real
Apple legacy gain maps, ISO adaptive HEIF, Ultra HDR camera JPEG, portrait/depth,
PQ/HLG camera fixtures and independent reconstruction/display checks remain
required before the codec capability is qualified.

## Apple auxiliary metadata fixture

`apple-gain-map-p3.heic` is synthetic: 64 × 32 Display P3 neutral RGB at code
100, with a quarter-resolution monochrome gain map containing codes 0, 64,
128 and 255. ImageIO on macOS 26.5.2 (25F84) authored the file using
`generate-apple-gain-map.swift`; MakerNote 33 = 1, MakerNote 48 = 0,
HDRGainMapVersion = 65536. SHA-256:
`1185bc3e539ffe55dce9cc9b8224e6d82727c73258e6f6123bdefd73be3e8d42`.

Regenerate with `swift server/test/native/fixtures/generate-apple-gain-map.swift /path/to/output.heic`.
ImageIO codec output may differ across OS versions; tests use the committed file.
This verifies primary-owned Exif, auxiliary-owned XMP, bounded parsing,
headroom classification and refusal to flatten unsupported HDR during export.
It is not a camera or display qualification fixture.

Legacy Apple reconstruction remains unavailable. The documented inverse
Rec.709 reconstruction was compared with ImageIO DecodeToHDR and direct Core
Image expandToHDR in linear BT.2020. Headroom and SDR appearance agree, but
midtones differ (maximum absolute RGB error 0.0904 in reference-white units on
this fixture). Do not substitute a fitted gamma or enable this decoder until
real fixtures and independent decodes resolve the interpretation. Source:
[Apple HDR reconstruction guidance](https://developer.apple.com/documentation/appkit/applying-apple-hdr-effect-to-your-photos).
