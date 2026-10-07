# Synthetic reduced-resolution ISO gain map

The primary is 1024 × 32 Display P3, with a 256 × 8 monochrome gain map. These are synthetic fixtures, not camera or hardware acceptance evidence.

On macOS, generate a reduced map from the existing synthetic Apple ISO fixture:

```sh
swift generate-map.swift ../apple-iso-gain-map.heic /tmp/frameleaf-quarter-legacy.heic
python3 convert-to-iso.py ../apple-iso-gain-map.heic /tmp/frameleaf-quarter-legacy.heic source.heic
python3 generate-geometry.py
swift ../generate-apple-reference.swift source.heic reference.json
```

Core Image's explicit gain-map writer emits a legacy HEIF auxiliary item. The bounded converter retains its encoded HEVC samples and adds an ISO tone-map item using the original synthetic fixture's ISO metadata, target color profile and alternate-image group. It removes the legacy auxiliary association. The converter validates its template checksum and container structure; generation is platform-dependent, so regenerate and requalify the checksums and reference together.

The independent macOS Core Image reference reconstructs the untransformed source into floating-point extended-linear BT.2020. Maximum RGB error is bounded at 0.1 and RMS at 0.02. This detects the former corner-coordinate/Shepard interpolation discrepancy without relaxing the existing full-resolution-map bounds.

Nine derived files add primary container crops, rotations and mirrors while retaining identical encoded sample payloads. The crop starts at primary pixel (257, 9), giving fractional gain-map coordinates (64.25, 2.25). All reconstructed HDR pixels and authored SDR bytes must equal the corresponding integer transform of the full source. Both the raw primary budget and the retained HDR buffer during paired decoding are checked.

Core Image does not reconstruct HDR from these synthetic cropped containers. Their geometry checks therefore prove Frameleaf's sampling and transform invariants, not independent acceptance of cropped-container interchange. Real authored media and physical displays remain separate release gates.
