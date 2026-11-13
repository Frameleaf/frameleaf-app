# Independent native darktable reference fixtures

The photographic RAW inputs come from Frameleaf/frameleaf-test-assets at commit `63a12e4f97e7a1ce54bb72ebd9fa5c2c812480bf`:

- Canon: `formats/raw/Canon/EOS_70D.CR2`
- Nikon: `formats/raw/Nikon/D80/glarus.nef`

Source: https://github.com/Frameleaf/frameleaf-test-assets/tree/63a12e4f97e7a1ce54bb72ebd9fa5c2c812480bf
The source README states that all assets are public domain. The source repository also carries an AGPL-3.0 license for repository code; this record does not relicense that code or its dependencies.

The input copies used here had GPS, artist/owner/copyright, camera serials and comments removed before rendering. These two reference JPEGs were produced independently by the actual darktable 5.6.2 CLI (upstream source `20891f6c6fa7be995e5bf9dff9d1ee5062051773`), using the camera's native scene-referred sigmoid history exported by darktable's `dt_exif_xmp_write`. Frameleaf's importer, recipe renderer and rendered output did not supply reference pixels. They are native darktable references, not Lightroom references.

CLI export settings: sRGB ICC, relative-colorimetric intent, high quality, maximum1536×1536 without upscaling, JPEGquality100, OpenCL disabled, no custom presets, scene-referred sigmoid workflow. Each reference used a fresh disposable native library/config/cache and the corresponding explicit XMP argument.

The committed copies preserve the original JPEG compressed image stream and complete embedded ICC profile byte for byte. Non-ICC application metadata and comments were removed without re-encoding. Decoded RGB pixels and ICC bytes were checked identical against the immutable independently rendered originals; metadata audit found only JPEG dimensions/encoding and standard ICC data, with no EXIF/XMP/IPTC/private paths or identifying fields.

| Reference | SHA-256 | Size |
| --- | --- | --- |
| canon-native-reference.jpg | 2928f74fac36110319d2fc4f6849ff6181f6c401ff162dc8a8dea782d4cc3fcf |1536×1025 |
| nikon-native-reference.jpg | fe9f0880136d438b881ee5f44b88d84402091c24b12431160298c0353c311f4b |1536×1028 |

Authoritative acceptance compares full frames at384×256 with embedded ICC→sRGB, Pillow Lanczos, linear sRGB→XYZ D65→Lab D65 and CIE76 mean strictly below6. The durable native test uses the separately labelled Sharp/Lanczos3 resampler and the same D65/CIE76 calculation and threshold. Neither protocol registers images, substitutes pixels or relaxes the threshold.

The two `darktable-native-*.xmp` files come from those actual native exports. Only non-rendering timestamps/EXIF/identifiers were removed; native parameter and blend bytes are unchanged. Canon XMP SHA-256: `1bde29fa42238b7e85a085ea68b2fc59d88256ae8f4d1dd4fa9723f15b95d959`; Nikon XMP SHA-256: `e9bbff6aed12765e9ecd8b28ac8fcb45e1333b1a059179380231686c6f3fc47c`. The XMP files contain no customer media or machine-specific paths.
