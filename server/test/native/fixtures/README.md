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
