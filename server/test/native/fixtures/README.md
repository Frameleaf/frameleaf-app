# Synthetic transfer fixtures

These files contain no user media. Generated with libheif 1.23.6 / libaom lossless
10-bit AVIF from 64 × 32 RGB16 PNG bars, explicit BT.2020 primaries, identity
matrix, full range and the indicated transfer. They verify implementation math
and primary-image container geometry. They do not qualify camera codecs or HDR
displays.

| File            | Signal                                                                     | SHA-256                                                          |
| --------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| pq-rotated.avif | ST 2084 bars at 0, 100, 203, 6500 cd/m²; clockwise 90° container transform | 9f5a16c1e25c627fdd9175808f3a07f90aa7311f208d4c7298a5697577fe7d98 |
| hlg.avif        | HLG signal bars at 0, 0.5, 0.75, 1                                         | ce1389c157c65c217ff42579411e4a91bba2bef4263d3bb41280d5647bf66480 |

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

Legacy Apple reconstruction is experimental and restricted to version 65536,
8-bit monochrome quarter-resolution maps, straight alpha and supported RGB
profiles. Other versions, metadata overrides and unsupported profiles fail
explicitly. Processing is disabled by default; the server capability remains
unqualified until pinned Linux builds, real camera fixtures and HDR hardware
acceptance pass.

The first inverse Rec.709 candidate differed from current ImageIO midtones.
The versioned policy `apple-legacy-imageio-2.2-reference-203-v1` instead matches
ImageIO's observed 2.2 power curve, applied after resizing encoded map values.
All 256 codes were checked at three authored headrooms. This is a platform
parity policy for the admitted legacy subset, not an interpretation of ISO gain
maps. The historical description is in
[Apple HDR reconstruction guidance](https://developer.apple.com/documentation/appkit/applying-apple-hdr-effect-to-your-photos).

| Fixture                    | SHA-256                                                          | Independent reference tolerance         |
| -------------------------- | ---------------------------------------------------------------- | --------------------------------------- |
| apple-gain-map-ramp.heic   | f333140335975b0f8ff84c204c4f5a157d6e2e1b5e7b3399776ab16294488abb | maximum RGB error < 0.015, RMS < 0.0075 |
| apple-gain-map-colors.heic | 24a4cc541bc41034056a981f1c2814482cc09c1b2c43b61c51bcf65082fe877b | maximum RGB error < 0.05, RMS < 0.025   |

Both ramp fixtures are 1024 × 32 with all 256 map codes. The color fixture has
Display P3 red, green, blue and gray rows. Errors are in linear BT.2020 units
relative to SDR reference white. Four rows are sampled, including gamut corners
and the entire gain-map range. The bounds include independent HEVC decoding and
ICC conversion differences and are pinned per fixture.

Reproduce input generation with the existing generator's `--ramp` and
`--ramp --colors` flags. Reproduce references with
`swift server/test/native/fixtures/generate-apple-reference.swift /path/to/fixture.heic /path/to/reference.json`.
The JSON references record OS, independent Core Image decoding, source checksum
and linear RGB values. No Frameleaf codec is used to generate them. Reference
updates require independent qualification; they must not be generated from the
implementation under test. These synthetic cases do not establish camera or
physical-display acceptance.
