# Studio third-party notices

The complete list of everything Frameleaf credits (engines, models, voices, fonts and assets, with
authors, licences and links) is `licenses/acknowledgements.json`, published as
`licenses/THIRD-PARTY-NOTICES.md` (every licence text, verbatim), the docs Acknowledgements page and
Support and feedback → Third-party notices in the app. This folder holds the notices that ship with
the Studio engine build; server images carry them under `/licenses/studio`.

## Freecut

Frameleaf Studio's video editor is **Freecut**, © its authors, used under the MIT licence.

- Project: https://github.com/walterlow/freecut
- Pinned revision: `4d62e8082c5eb387a96275bcbd323d28f6e41a62`
- Archive: `https://codeload.github.com/walterlow/freecut/tar.gz/4d62e8082c5eb387a96275bcbd323d28f6e41a62`,
  SHA-256 `b4224e5c219a6302586cbe2242e9e6d299dfd1878f1fcd0f2d77ea3db12a5d32`
- Licence: `freecut.txt` in this folder is an unmodified copy of the upstream `LICENSE` (MIT).

Frameleaf does not fork Freecut's source. `studio/tools/engine.mjs` recovers the pinned archive,
verifies every file against `studio/freecut-provenance.json` and applies the versioned patches in
`studio/patches/`; the Frameleaf adapter in `studio/adapters/web` wraps the result and is not part
of Freecut. The owner unparked the engine for Studio on 2026-09-25.

## Other notices shipped with the Studio engine

Each file below is an unmodified licence or notice text. `studio/dependency-attribution.json`
(`artifactNotices`) pins its SHA-256 and names the component it covers, and the engine build
copies them into its `attribution/` artifact directory.

| File                                 | Covers                                             |
| ------------------------------------ | -------------------------------------------------- |
| `freecut.txt`                        | Freecut (MIT)                                      |
| `soundtouch.txt`                     | SoundTouch JS 0.2.3 (LGPL-2.1)                     |
| `soundtouch-copyright.txt`           | SoundTouch JS copyright and licence declaration    |
| `anime4k-websr.txt`                  | Anime4K / WebSR weights                            |
| `anime4k-license.txt`                | Anime4K                                            |
| `websr-license.txt`                  | WebSR                                              |
| `ffmpeg-lgpl.txt`                    | FFmpeg (LGPL-2.1)                                  |
| `lame-license.txt`                   | LAME                                               |
| `turbores-license.txt`               | TurboRes                                           |
| `mediabunny-mpl.txt`                 | Mediabunny and its codec wrappers 1.50.8 (MPL-2.0) |
| `moss-tokenizer.txt`                 | MOSS bundled tokenizer dependencies                |
| `moss-ort.txt`                       | MOSS ONNX Runtime Web bundled JS/WASM              |
| `radix-primitives-license.txt`       | Radix UI primitives                                |
| `react-hotkeys-hook-license.txt`     | react-hotkeys-hook                                 |
| `react-resizable-panels-license.txt` | react-resizable-panels                             |
| `onnx-common-*-license.txt`          | onnxruntime-common package sources                 |

Package notices recovered from the engine lockfile are recorded under
`studio/package-notice-evidence/`. None of these records is a completed redistribution approval;
FL-86 keeps that gate.
