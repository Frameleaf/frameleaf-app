# Synthetic 12-bit numerical regression

`source.heic` contains a neutral Display P3 SDR primary with 12-bit lossless HEVC
RGB tiles and the ISO gain-map payload from `iso-gain-map-10bit.heic`. It is
synthetic and contains no camera or user media. SHA-256:
`72b85ffd553d16fab0fff47f6ed8faf8f9afb9daf232bd16fe690151218c56f9`.

`generate.py` verifies the template checksum, creates two 512×512 RGB tiles,
encodes them with FFmpeg 7.1.3-6 / libx265 4.1+54-fa2770934 (12-bit NEON), and
rewrites the primary HEVC configuration, pixel depth and absolute item extents.
The visible primary is 1024×32. Values vary in the low two bits across adjacent
rows. Unchanged auxiliary compressed samples and ISO metadata remain paired.

The reference independently decodes both primary and gain-map HEVC streams with
FFmpeg, checks decoded 12-bit codes against the authored input, applies analytic
sRGB inversion and the ISO gain-map equation, and samples seven rows, including
all four low-bit variations. No Frameleaf decoder generates the reference.
Neutral RGB has the same value in Display P3 and BT.2020, so no matrix conversion
is needed. ISO reconstruction follows the base/alternate offset and gain-map
math documented in [libavif's gain-map contract](https://github.com/AOMediaCodec/libavif/blob/main/include/avif/avif.h).

Reproduce with the specified encoder build:

```sh
python3 server/test/native/fixtures/iso-12bit/generate.py /path/to/ffmpeg /path/to/output
```

Source and reference regeneration are byte-identical with that build. Other
encoder versions may produce different compressed bytes and require independent
review before updating the checksum-bound reference.

The native test bounds maximum linear error below 0.007 and RMS below 0.002;
observed full-ramp maximum/RMS are 0.006308/0.001543. The current decoder stores
encoded RGB and linear output as half floats, so adjacent 12-bit codes can merge
near SDR white. The test checks distinct low bits where half-float precision can
represent them, and checks the full reference separately. It does not assert
lossless 12-bit working pixels or color-corner accuracy.

Core Image on macOS 26.5.2 loads this synthetic container but returns near-black
expanded pixels. This is therefore a numerical decoder regression, **not Apple
container interoperability qualification**. It cannot replace consented camera
fixtures or physical HDR display acceptance. HDR remains gated and unqualified.
