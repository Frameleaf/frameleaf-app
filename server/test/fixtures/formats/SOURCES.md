# Format fixtures: where they come from

`manifest.json` lists every fixture `verify-formats.mjs` runs. Its `root` says where the file lives.

| Root          | Location                                         | Origin                                                      |
| ------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| `generated`   | this folder (`jpeg/ still/ design/ video/`)       | Made by `generate.sh` and `generate-more-stills.sh` from test patterns. No third-party rights. |
| `test-assets` | `e2e/test-assets` (`Frameleaf/frameleaf-test-assets`, pinned in `scripts/checkout-test-assets.sh`) | Third-party samples, each with its own licence. |
| `resources`   | `server/resources`                               | Files the server already ships (the bundled OFL Studio fonts). |
| `fate`        | downloaded by `fetch-fate.sh`, never committed   | FFmpeg FATE samples, pinned by SHA-256 in `fate.sha256`. |

## Third-party fixtures in `Frameleaf/frameleaf-test-assets`

Added on 2026-11-10 (fixture commit `63a12e4f97e7`). That repository is public, so only files with a
clear licence go there. `FRAMELEAF-FORMAT-FIXTURES.md` at its root lists each file with its source
URL, licence and SHA-256; the licence texts sit beside the files.

| Files | Source | Licence |
| --- | --- | --- |
| `formats/raw/`: Canon EOS R5 RAW and CRAW (45 MP), Nikon Z 9 lossless and High Efficiency\* (45 MP), Sony A1 lossless compressed (50 MP), Fujifilm GFX100S compressed (102 MP) and X-T5 compressed, Sigma sd Quattro H (X3F), GoPro HERO9 (GPR), Panasonic S5 II, Samsung NX1 | `https://raw.pixls.us/data/` | CC0 1.0, checked per file against the site's index |
| `formats/jpeg/libjpeg-turbo/testimgari.jpg` | `https://github.com/libjpeg-turbo/libjpeg-turbo/tree/main/testimages` | IJG licence |
| `formats/exr/openexr-images/` | `https://github.com/AcademySoftwareFoundation/openexr-images` | BSD-3-Clause |
| `formats/fonts/Inter/InterVariable.ttf` (variable) | `https://github.com/rsms/inter` | SIL OFL 1.1 |
| `formats/fonts/SourceSerif/` (OTF with CFF outlines, WOFF, WOFF2) | `https://github.com/adobe-fonts/source-serif` | SIL OFL 1.1 |
| `formats/fonts/NotoColorEmoji/Noto-COLRv1-noflags.ttf` (colour) | `https://github.com/googlefonts/noto-emoji` | SIL OFL 1.1 |
| `formats/fonts/NotoSansCJK/NotoSansCJK-Regular.ttc` (CJK, collection) | `https://github.com/notofonts/noto-cjk` | SIL OFL 1.1 |

To add more: push to the `frameleaf-frozen` branch there, then change `fixture_commit` in
`scripts/checkout-test-assets.sh` and the same hash in `.github/workflows/test-fixtures.yml`,
`scripts/frameleaf-workflows.test.mjs` and `docker/README.md`. Every CI job that uses fixtures
clones that repository, so keep additions small.

## FFmpeg FATE samples (fetched, not committed)

The FATE suite (`https://fate-suite.ffmpeg.org/`) states no licence, so its samples are never
copied into a Frameleaf repository. `fetch-fate.sh <dir>` downloads the files listed in
`fate.sha256` and fails unless every hash matches. They cover codecs we cannot encode ourselves:
VVC, APV, VC-1, WMV, DVCPRO HD, camera MXF (XDCAM, Avid, MPEG-4), ProRes 4444 with alpha, and
JPEG 2000 digital cinema. To add one, append its `sha256sum` line to `fate.sha256`.

## Still wanted, no usable source

The owner decided on 2026-11-10 to ship without these and have beta users test them live.

- JPEG XL ProRAW from an iPhone 16 or 17 Pro (raw.pixls.us stops at the iPhone 12 Pro).
- Design files as their applications write them (FL-1358). `generate-design.py` writes the fixtures in
  `design/` byte by byte from one test pattern: they prove which loader opens a format and where a
  container's preview is read from, not that every real file opens. Wanted, as the owner's or beta
  users' own work: PSD and PSB from Photoshop (both "Maximize Compatibility" settings, smart objects,
  16/32-bit with layers, a multi-gigabyte PSB); a real Fireworks PNG with pages, states and layers; AI
  saved with and without "Create PDF Compatible File" and an EPS from Illustrator; Sketch, XD, Figma
  (.fig), Procreate, Krita, OpenRaster and CorelDRAW documents. The FATE `psd/` samples use the Lena
  photograph, which has no usable licence.
- Affinity (.afdesign .afphoto .afpub) and InDesign (.indd): not accepted yet, because an extension
  needs a fixture.
- The reported files themselves: an old JPEG shown as damaged, a RAW that failed to import.
- ProRes RAW, Blackmagic RAW, RED R3D, Canon Cinema RAW Light, Nikon N-RAW, Dolby Vision profile 5
  and 7 clips.
- JPEG XR, a 12-bit JPEG with a clear licence (the generated one covers the decoder), bmpsuite and
  PngSuite edge cases, JPEG 2000 conformance files (mixed licences), a Type 1 font.
