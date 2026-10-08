# Synthetic ISO HDR-base qualification

These are generated ramps, not camera media or physical-display acceptance. Core Image
writes an independent 10-bit PQ/HLG HEIF primary; `convert-to-iso.py` copies its compressed
primary tiles and color profile into the existing ISO fixture without recompression.
The SDR alternate uses constant logarithmic gain and distinct offsets. The P3 alternate
case applies per-channel gains 8/16/32 in BT.2020; authored content headroom stays 8.

Reproduce the checked container bytes from retained independently authored primaries:

```sh
python3 convert-to-iso.py
python3 convert-to-iso.py --colors
python3 convert-to-iso.py --colors --alternate
python3 convert-to-iso.py --hlg
cp pq-alternate.heic geometry/source.heic
python3 ../iso-quarter/generate-geometry.py geometry
```

To author fresh primaries on macOS (codec bytes may differ by OS):

```sh
swift generate-primary.swift pq-base-authored.heic
swift generate-primary.swift pq-p3-colors.heic --p3 --colors
swift generate-primary.swift hlg-base-authored.heic --hlg
```

HDR references use `../generate-apple-reference.swift` with `--display-p3` for the
P3 cases. SDR references use `generate-sdr-reference.swift` in linear BT.2020,
adding `--alternate` for per-channel gains. References and export references record
source SHA-256 and OS identity. No Frameleaf decoder creates reference pixels.
The codec test checks both retained exports and newly generated exports against
independent Core Image reconstructions. Geometry checks transform decoded full-source
pixels as an internal invariant; they do not prove independent cropped interoperability.

Pinned native tolerances (reference-white units) are: PQ maximum .004 / RMS .0015;
colored P3 .08 / .015; HLG .002 / .0007; SDR maximum 1 encoded byte; independently
reconstructed JPEG exports maximum .08 / RMS .015. These bounds include half-float,
color-conversion and compression error. Every regeneration requires reference review.
Invalid channel gamma and aggregate resource limits must fail explicitly.
