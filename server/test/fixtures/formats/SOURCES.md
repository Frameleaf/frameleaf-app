# Format fixtures: where they come from

`manifest.json` lists every fixture `verify-formats.mjs` runs. Its `root` says where the file lives.

| Root          | Location                                         | Origin                                                      |
| ------------- | ------------------------------------------------ | ----------------------------------------------------------- |
| `generated`   | this folder (`jpeg/ still/ design/ video/`)       | Made by `generate.sh` from test patterns. No third-party rights. |
| `test-assets` | `e2e/test-assets` (`Frameleaf/frameleaf-test-assets`, pinned in `scripts/checkout-test-assets.sh`) | Third-party samples, each with its own licence. |
| `resources`   | `server/resources`                               | Files the server already ships (the bundled OFL Studio fonts). |

## Still to add to `Frameleaf/frameleaf-test-assets`

Nothing below is in the fixture repository yet. Adding them needs an owner push there, then a bump of
`fixture_commit` in `scripts/checkout-test-assets.sh` and of the tarball name in
`.github/workflows/test-fixtures.yml`, then manifest entries here. Directory listings were checked on
2026-11-10; licences are as the source states them and must be confirmed per file before the push.

### RAW (raw.pixls.us)

Most of the archive is CC0, but not every file: the licence shown on each file's page decides.
Base URL `https://raw.pixls.us/data/`.

| Why | File | Suggested path |
| --- | --- | --- |
| 45 MP, over the 256 MiB render cap | `Canon/EOS R5/Canon_EOS_R5_RAW_ISO_100_nocrop_nodual.CR3` | `formats/raw/Canon/` |
| CR3 lossy (CRAW) | `Canon/EOS R5/Canon_EOS_R5_CRAW_ISO_100_nocrop_nodual.CR3` | `formats/raw/Canon/` |
| Compressed NEF, 45 MP | `Nikon/Z 9/Nikon_-_NIKON_Z_9_-_14bit_compressed_(Lossless).NEF` | `formats/raw/Nikon/` |
| High Efficiency NEF (no open sensor decoder: preview rung) | `Nikon/Z 9/Nikon_-_NIKON_Z_9_-_14bit_compressed_(Lossy_High_Efficiency).NEF` and `..._Star).NEF` | `formats/raw/Nikon/` |
| ARW lossless compressed, 50 MP | `Sony/ILCE-1/A1_full_lossless_compressed.ARW` | `formats/raw/Sony/` |
| ARW lossy compressed | `Sony/ILCE-1/A1_full_compressed.ARW` | `formats/raw/Sony/` |
| RAF compressed, 102 MP | `Fujifilm/GFX100S/Fujifilm-GFX100S-14bits-compress-4_3.RAF` | `formats/raw/Fujifilm/` |
| RAF lossless, X-Trans | `Fujifilm/X-T5/DSCF0021.RAF` | `formats/raw/Fujifilm/` |
| Foveon X3F | `Sigma/sd Quattro H/SDIM0061.X3F` | `formats/raw/Sigma/` |
| GoPro GPR | `GoPro/HERO9 Black/GOPR0017.GPR` | `formats/raw/GoPro/` |
| Panasonic high-resolution RW2 | `Panasonic/DC-S5M2/P1126473_96MP.RW2` | `formats/raw/Panasonic/` |
| Samsung SRW | `Samsung/NX1/2016-07-23-142101_sam_9364.srw` | `formats/raw/Samsung/` |
| Olympus ORF | `Olympus/E-M1MarkIII/_3160529.ORF` | `formats/raw/Olympus/` |
| OM System 14-bit | one file from `OM System/OM-1 Mark II/` | `formats/raw/OM/` |

Not on raw.pixls.us (newest iPhone there is the 12 Pro): a JPEG XL ProRAW DNG from an iPhone 16 or
17 Pro. The owner needs to shoot one.

### Stills

| Why | Source | Licence |
| --- | --- | --- |
| Reference arithmetic and 12-bit JPEGs (`testimgari.jpg`, `testorig12.jpg`) | `https://github.com/libjpeg-turbo/libjpeg-turbo/tree/main/testimages` | IJG / BSD-3-Clause |
| Every BMP header and compression variant, including the questionable ones | `https://entropymine.com/jason/bmpsuite/` | Public domain (author's statement) |
| PNG edge cases, bad CRC included | `http://www.schaik.com/pngsuite/` | Free to use and distribute (author's statement) |
| EXR compression and channel variants | `https://github.com/AcademySoftwareFoundation/openexr-images` | BSD-3-Clause |
| JPEG 2000 conformance (`.j2k .jp2 .jpx`) | `https://github.com/uclouvain/openjpeg-data` | Mixed: check per folder |
| JPEG XR (`.jxr .wdp`) | none found under a clear licence; make one with `JxrEncApp` from jxrlib (BSD-2-Clause) | own work |

### Video (FFmpeg FATE suite)

Base URL `https://fate-suite.ffmpeg.org/`. The suite carries no blanket licence: these are samples
gathered for decoder testing, so the owner decides whether redistribution in our repository is
acceptable or whether CI should fetch them at run time instead.

| Why (no encoder to make our own) | File |
| --- | --- |
| VVC / H.266 | `vvc-conformance/10b422_L_5.bit` |
| APV | `apv/profile_422-10.apv` |
| VC-1 (and WMV3 in ASF) | `vc1/SA00040.vc1`, `wmv8/wmv8_x8intra.wmv` |
| DV / DVCPRO HD | `dv/dvcprohd_720p50.mov` |
| Camera MXF (XDCAM, Avid) | `mxf/Sony-00001.mxf`, `mxf/Avid-00005.mxf`, `mxf/C0023S01.mxf` |
| ProRes in MXF, HDR10 | `mxf/Meridian-Apple_ProResProxy-HDR10.mxf` |
| ProRes 4444 with alpha | `prores/prores4444_with_transparency.mov` |
| JPEG 2000 digital cinema | `jpeg2000/chiens_dcinema2K.mxf` |
| RED R3D (kept safe, no playback: placeholder) | one file from `r3d/` |

Still wanted, source not found: ProRes RAW, Blackmagic RAW, Canon Cinema RAW Light, Nikon N-RAW, and
Dolby Vision profile 5 and 7 clips. Owner-supplied camera files are the likely route.

### Design files

`generate-design.py` writes the design fixtures in `design/` byte by byte from one test pattern (FL-1358):
layered PSD with and without its flat picture ("Maximize Compatibility" on and off), 16-bit, 32-bit and
CMYK PSD, a PSB wider than a PSD may be, a PSD that only its embedded thumbnail can show, a two-page PDF,
a PDF-compatible Illustrator file, EPS with and without a preview, GIMP XCF, a PNG with Fireworks' private
chunks, and one ZIP-based document per container format with its preview at the documented path. They
prove Frameleaf's side: which loader opens a format and where a container's preview is read from. They
do not prove that every file a real application writes opens, so these are still wanted:

| Why | Source |
| --- | --- |
| PSD and PSB as Photoshop writes them: both "Maximize Compatibility" settings, smart objects, adjustment layers, 16/32-bit with layers (`Lr16`/`Lr32`), a multi-gigabyte PSB | Owner: save from Photoshop (own work) |
| Fireworks PNG with pages, states and layers | Owner: one of the reported files, or save from Fireworks |
| AI saved with and without "Create PDF Compatible File"; EPS from Illustrator | Owner: save from Illustrator (own work) |
| Sketch, XD, Figma (.fig), Procreate, Krita, OpenRaster and CorelDRAW documents from the applications | Owner or beta users: own work |
| Affinity (.afdesign .afphoto .afpub) and InDesign (.indd) | Owner or beta users: own work. Not accepted yet: no fixture, so no extension |

The FATE suite's `psd/` samples use the Lena photograph, which has no usable licence: do not add them.

### Fonts (SIL Open Font License 1.1)

| Why | Source |
| --- | --- |
| Static TTF | already shipped: `server/resources/studio-fonts/` (root `resources`) |
| Variable font, many axes | `https://github.com/rsms/inter/releases` (`InterVariable.ttf`) |
| Static OTF (CFF outlines) and WOFF, WOFF2 | `https://github.com/adobe-fonts/source-serif/releases` |
| Colour font (COLRv1) | `https://github.com/googlefonts/noto-emoji` (`fonts/Noto-COLRv1.ttf`) |
| CJK and a TrueType collection | `https://github.com/notofonts/noto-cjk` (`Sans/OTC/NotoSansCJK-Regular.ttc`, about 20 MB: consider one weight only) |
| Type 1 (`.pfb`) | none found under OFL; convert an OFL font with FontForge |
