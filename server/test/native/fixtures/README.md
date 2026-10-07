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

## Independent Develop/export round trips

`develop-hdr.jpg` and `develop-hdr.heic` come from the admitted server worker:
`apple-gain-map-colors.heic` → Develop exposure +1 EV → HDR JPEG master → still
exports. The original fixture's checksum is checked after generation. These are
synthetic, capture-metadata-stripped files; they contain no user media.

The generator uses the pinned libUltraHDR 2.0.2 revision and the same
`UHDR_WRITE_XMP=ON`, `UHDR_WRITE_ISO=ON`, `UHDR_ENABLE_GLES=OFF`,
`UHDR_ENABLE_HEIF=OFF` build inputs as Linux. No upstream source patches are
applied. Fixture generation used the addon at `08b683a38d` and libheif 1.23.6;
Linux tests independently decode the committed outputs with pinned libheif 1.23.3.
The JPEG includes both Ultra HDR XMP and ISO metadata; its SDR baseline
and reconstructed HDR are Display P3. The HEIC is ten-bit PQ, Display P3.

| Fixture          | SHA-256                                                          | Independent reconstruction bounds     |
| ---------------- | ---------------------------------------------------------------- | ------------------------------------- |
| develop-hdr.jpg  | d9b8bec5099f6b6d20a76f6f57d481159388b76be17ba9654d3c9a14176e26f3 | maximum RGB error < 0.2, RMS < 0.02   |
| develop-hdr.heic | 668110ac7f49e1512ec1116e1320120e1ec6b4a5e04f5d11d8cdcf4acef8de69 | maximum RGB error < 0.08, RMS < 0.015 |

References are linear Display P3 relative to reference white, sampled over all
256 gain-map positions and four color rows. Bounds account for independent
JPEG/HEVC decoding, gain-map quantization, and half-float output; they do not
establish display correctness. macOS 26.5.2 observed maximum/RMS error:
JPEG 0.189683/0.013982; HEIC 0.052709/0.008369.

After building the server, generate exports with
`FRAMELEAF_HDR_BINDING=/path/to/pinned/image-hdr.node node server/test/native/fixtures/generate-hdr-export-fixtures.mjs /path/to/output`.
Select the pinned codec shared libraries as well as the addon; a version string
alone does not prove identical codec build options. Regenerate references on
macOS with:

```sh
swift server/test/native/fixtures/generate-jpeg-reference.swift /path/to/develop-hdr.jpg /path/to/reference.json --display-p3
swift server/test/native/fixtures/generate-apple-reference.swift /path/to/develop-hdr.heic /path/to/reference.json --display-p3
```

For JPEG, Core Image URL/data loading adjusts the adaptive SDR baseline even
when `expandToHDR` is false. A direct expanded URL decode therefore cannot be
compared to the server's unnormalized linear working pixels. The independent
reference retains the untouched primary JPEG pixels and ICC profile, omits only
adaptive routing/capture metadata from that temporary in-memory baseline, and
applies the original gain map with Apple's Core Image API at full content
headroom. It never re-encodes the baseline or uses Frameleaf to reconstruct the
reference. Normal platform display adaptation remains separate from this
reconstruction check.

## ISO HEIC authored SDR regression (experimental)

`apple-iso-gain-map.heic` is an authored synthetic Display P3 SDR base with an ISO RGB gain map, written by Core Image on macOS 26.5.2 (25F84). SHA-256: `391cb5eced34d9cc12114a255bd203d2cbcbf3f94cc49627749c42d5b5ab35c8`. It has no camera or user content. It does not establish real-camera or HDR-display acceptance.

Generate with `swift generate-iso-gain-map.swift develop-hdr.jpg /path/to/apple-iso-gain-map.heic`. Compressed output can vary with OS codec builds. The worker test reserves a maximum 8 code-value error and RMS 2 for lossy JPEG re-encoding; the original failure was maximum 47 and RMS 10.57 from a second tone map.

Run `FRAMELEAF_HDR_ISO_TEST=1 FRAMELEAF_HDR_BINDING=/path/to/experimental/image-hdr.node node --test server/test/native/image-hdr-renditions.test.mjs`. The default skips ISO-only checks for legacy local codec builds. The pinned Linux image enables these checks while building its installed decoder port. Existing JPEG, Apple, PQ, HLG, resource and immutable-source checks still run.

The build carries checksum-pinned decoder-only patches in
`server/base-image/sources/libheif-hdr.patch` and `libultrahdr-hdr.patch`.
The libheif port adapts Google's `cmake/patches/libheif_pr1503.patch` at
LibUltraHDR commit `e5f5a022fe96fc4dc2ee35c19f733a50df807abe` to libheif
`78c9746aea226b22885e8d35241353ce669c4ea5`, preserving its per-context limits and
current C API. Adaptive HEIF encoding returns unsupported. The Ultra HDR patch
validates ICC transfer/primaries, preserves alpha and aligned geometry, imposes
per-decoder resource limits, and reuses scalar wide-gamut RGB-to-YCbCr conversion
where the ARM coefficient tables diverge. Source licenses remain unchanged.
These changes identify renderer 2 and require recipe v4 for new edits.

`image-hdr.test.mjs` checks colored linear sRGB, P3 and BT.2020 round trips in the
actual output gamut against D65 RGB/XYZ references. The 48MP resource test uses P3
throughout: comparing raw RGB numbers across different gamuts is invalid. Neither
synthetic numerical agreement nor successful codec builds establishes physical
HDR-display or real-camera acceptance; `qualified` remains false.
