# Licensed Android Ultra HDR camera sample

`cityscape.jpg` is an unchanged copy of `ultrahdr_cityscape.jpg` from the official
[Android platform samples](https://github.com/android/platform-samples/tree/13db9886bc189a03c0bd3bea312344e8ff6194c0/samples/graphics/ultrahdr/src/main/assets/ultrahdr).
Upstream commit: `13db9886bc189a03c0bd3bea312344e8ff6194c0`.
Upstream Git blob: `e719e02724b5be6a5bc77bb1208c4bb9dd5a4b0c`.
The upstream Apache 2.0 license is retained in `LICENSE`; copyright Google LLC.
No upstream NOTICE file accompanies this asset. EXIF labels the camera Google Pixel 7 Pro
and HDR+ software; this is provenance supplied by the sample, not authenticated capture evidence.

Source SHA-256: `ec4647b82153b65a6cc3bce4900626e77464595f6af321d9e21146b31ad0acc1`.
Dimensions: 3072 x 4080, Display P3, Ultra HDR gain map, content headroom 2.45999.
The immutable camera bytes are included solely as a decoder regression fixture.

`cityscape-reference.json` was generated independently on macOS 26.5.2 (25F84):

```sh
swift ../generate-jpeg-reference.swift cityscape.jpg cityscape-reference.json --display-p3
```

The generator uses untouched primary JPEG pixels and ICC, omits adaptive routing metadata
from its temporary SDR base, then applies the original auxiliary gain map through Core Image
at full authored headroom. It samples 9216 linear Display P3 channels over four rows.
Reference SHA-256: `ba81cf240561f8c3916ed35e3e2b6b595f1de430e71f912803d74462a5537b16`.
Pinned maximum/RMS error ceilings are 0.12/0.012, accounting for independent JPEG/chroma
reconstruction and half-float decoding. Initial measured maximum/RMS: 0.101678/0.008550.
These fixture-specific bounds do not relax the existing synthetic checks.

This adds natural camera-labelled JPEG coverage. It does not qualify Apple HEIC,
Live Photo pairs, every camera firmware, or physical HDR display behavior.
