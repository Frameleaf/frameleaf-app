---
title: FL-86 Studio artifact attribution and resource rights
---

# Acceptance boundary

[FL-86 / STU-103](https://heroit.atlassian.net/browse/FL-86) remains **In Progress and unqualified**. This candidate packages notice files with the isolated engine and records explicit resource decisions. It does not authorize redistribution, enable downloads, prove offline operation, or qualify the full Studio release. Mobile/native work is deferred by the user.

Work starts from reviewed dependency `4ccad254cf6665e2ebce99e7cac8c376c0cf7d4c`, stacked over default `0116d4778d7ce34e9bc41a7d1fed46a4cd88a466`. Neither the reviewed dependency nor these local checks proves FL-84 landed or passed current hosted gates. Root lifecycle ownership remains separate from this implementation.

# Implemented artifact boundary

`studio/tools/engine.mjs attest` now creates `studio/engine/dist/attribution/` before computing the output inventory. It contains the exact notice bytes and an `index.json` identifying their source, hashes, installed runtime packages, resource decisions and unresolved embedded components. The build receipt records the attribution index digest and missing-package-notice list. The original build provenance, lockfile declarations and three embedded receipt notices remain preserved.

`studio/tools/engine.mjs audit-attribution` independently recomputes the expected output from the maintained manifest, retained evidence and installed locked packages. It reads the actual output files, rejecting missing/modified/additional notice files, changed inventory, substituted package versions and symlinked notice paths. It does not repair output during audit. Packaging validates inputs before replacing its own generated attribution directory. No vendor bytes or application behavior changed.

Root-level license/copying/notice/copyright files from every installed non-development lockfile package are copied byte-for-byte. Optional packages absent on the build platform are recorded separately. A declaration without a file remains `missing-notice`; collecting files does not establish that source-offer, modification, linking, patent or embedded-code obligations are satisfied.

# Preserved notices and remaining package obligations

Maintained `studio/notices/` contains Freecut MIT, SoundTouch LGPL plus its JS copyright declaration, Anime4K/WebSR attribution and complete MIT texts, Mediabunny/TurboRes MPL, FFmpeg LGPL text, LAME maintainer guidance, and the preserved MOSS ORT header/tokenizer embedded notices. Each file is bound to SHA-256 in `studio/dependency-attribution.json`. Primary references and captures are identified there; MPL text matches installed Mediabunny and all four wrapper packages at 1.50.8.

- [MPL 2.0](https://www.mozilla.org/en-US/MPL/2.0/) sections 3.1–3.4 require the applicable source availability and notices. The final source-delivery mechanism and modified-source audit remain open.
- Pinned Freecut `src/infrastructure/audio/time-stretch.ts:3-21` explicitly declares SoundTouch JS 0.2.3 LGPL-2.1-or-later. Preserve the four named copyright holders as well as the [LGPL text](https://www.surina.net/soundtouch/license.html); combined-work/source obligations remain open.
- Installed Mediabunny AAC/AC3 READMEs identify embedded FFmpeg WASM; MP3 identifies LAME 3.100; ProRes identifies TurboRes. Their wrapper MPL labels do not replace the underlying component review. Exact embedded revisions, build configuration and corresponding source must be established. The generic [FFmpeg LGPL text](https://github.com/FFmpeg/FFmpeg/blob/master/COPYING.LGPLv2.1) is retained with its capture hash, not presented as proof of the embedded binary's configuration.
- [Anime4K](https://github.com/bloc97/Anime4K/blob/master/LICENSE) and [WebSR](https://github.com/sb2702/websr/blob/main/LICENSE) MIT texts and three pinned ONNX hashes are retained; historical training-weight source commit mapping remains unqualified.
- MOSS ORT includes its pinned copyright/license header. The attempted complete ORT license fetch failed certificate verification; no TLS bypass was used. Full embedded third-party/source mapping remains blocked.

# Resource decisions

The existing attribution manifest now identifies **210 resources**: 16 models, 64 voices, 121 font families, 3 bundled weight files, 2 runtime-code sources, 2 dynamic asset classes and 2 Dolby tool/licensing classes. This count is independent of the 210-row FL-85 feature inventory. Resource IDs are exact model/family/voice identities or explicitly marked dynamic classes; arbitrary project/font/Lottie instances still require individual review.

Every resource separately records **blocked** redistribution, local-runtime and hosted-use decisions. Basis fields explain the evidence and missing conditions. An unknown/unqualified resource is never silently removed from release scope. The packager rejects approval flags: changing a JSON label cannot establish rights or runtime qualification.

Pinned primary model cards and full LFM/Supertonic license captures live in `studio/rights-evidence/`, referenced by exact URL/revision and text hash in the manifest. Model-card hashes identify evidence text, not weight bytes. Missing weight checksums remain null or missing file inventories rather than invented digests.

| Resource            | Evidence and explicit blocker                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MusicGen            | Exact Xenova conversion card declares CC-BY-NC-4.0. No separate commercial/hosted commercial permission. Noncommercial use also needs exact files and obligations reviewed.                                                                                                                                                                                                                               |
| Kokoro              | Model card declares Apache-2.0; voices remain a separate decision. Locked `kokoro-js` 1.2.1 itself ships 54 voice binaries (28 in the editor menu); their already-installed bytes are hashed separately from mutable browser download URLs. The normal locked npm install acquired these dependency payloads; no additional model/voice download endpoint was invoked.                                    |
| MOSS TTS/tokenizer  | Two publisher conversion cards declare Apache-2.0. Required 16 files are enumerated with unresolved payload hashes and source/notice mapping.                                                                                                                                                                                                                                                             |
| Supertonic          | Space assets and model repository differ. OpenRAIL-M sections 4–5 require applicable downstream use conditions; Space/model/ten-voice mapping and implementation remain open.                                                                                                                                                                                                                             |
| Gemma               | Repository is named E4B but captured conversion card names E2B as base. Resolve identity before approving use despite the referenced official Apache-2.0 authority.                                                                                                                                                                                                                                       |
| LFM                 | Captured LFM v1.0 terms condition commercial use on entity/revenue criteria. No user eligibility, revenue or separate license is assumed.                                                                                                                                                                                                                                                                 |
| Parakeet            | Captured card declares CC-BY-4.0, but smoothquant source redirects to optimized-onnx. Exact variant/files and attribution chain remain unresolved.                                                                                                                                                                                                                                                        |
| CLIP, CLAP, Whisper | Conversion cards do not declare licenses; base-model and conversion terms remain to be traced. MiniLM's Apache and RIFE's MIT declarations likewise need exact payload/source mapping.                                                                                                                                                                                                                    |
| Fonts               | 120 catalog families plus the extra page-load family produce 121 distinct rows. IBM Plex overlaps the catalog. Google API availability and family names do not license an identified binary.                                                                                                                                                                                                              |
| Lottie              | [Simple License FL 9.13.21](https://lottiefiles.com/page/license) permits specified public-file uses subject to conditions; [service terms](https://lottiefiles.com/page/terms-and-conditions) separately govern API/platform/plan use and extraction. Neither a blanket commercial approval nor a blanket prohibition is inferred. Each animation and GIF preview needs acquisition and rights evidence. |
| Dolby               | Administrator-installed CM Analyze/Metafier/Mezzinator only until applicable automation, redistribution and hosted-use rights are established. Artistic trims require a separate decision. No purchase or tool availability is invented.                                                                                                                                                                  |

# Executed evidence and limits

Local environment: Node 24.21.0, npm 11.8.0, macOS arm64. A first dependency install used npm 11.19.0 and was superseded by a clean `npm ci` and build with pinned npm 11.8.0 before attestation. Source recovery verified all 2,646 upstream files and adapted source digest `673f7dc4b985aeb1c13b478ed6bb9ca00ba543c765e8820074ea29618d5003b2`.

- `node --test studio/tools/engine.test.mjs`: four tests pass, including actual output notice modification/removal, invented output resource identity, substituted package version and symlink rejection. The new artifact test was first observed failing before implementation.
- Pinned isolated `npm ci --ignore-scripts --no-audit --no-fund` and `npm run build` pass. Upstream build reports its existing Tailwind sourcemap warning; this is not a claim that warning was resolved.
- `node studio/tools/engine.mjs attest` and `audit-attribution` pass against the produced output: **179 notice files**, 215 non-development lockfile package records; 166 have root notice files, 23 are absent optional platform packages, and **26 installed packages lack root notice files**. These missing entries remain in the receipt and block distribution qualification.
- Artifact inventory: 1020 files; SHA-256 `454767f8599a2a9f87de3a11edae2192381c8e360b85f5060d61de3ec34cf5e5`. Attribution index SHA-256 `e4dda5ea0f117b0824f61605818a59abd6ec803d11d9eb0447c16b1911d513c6`. These identify local evidence, not hosted CI or deployment.

The actual build receipt and output are generated/ignored; reproduce them with the documented pinned commands. Hosted exact-head evidence and independent candidate review remain required. The build output still contains external-loading code and is not approved for deployment.

# Next bounded runtime packet

Do not enable downloads through this manifest. No runtime admission guard was added because the existing shared ONNX cache does not cover all paths:

1. Direct ONNX cache: `src/shared/utils/onnx-model-cache.ts:129-157,190-209`; validate approved immutable bytes on both cache hits and misses.
2. SDK workers: pipeline/from_pretrained initializers for models, plus the independent MOSS `public/moss-tts/browser_model_store.js` and Kokoro library voice loader.
3. Runtime code: shared ORT CDN and Whisper worker's dynamically imported Transformers 3.8.1/WASM (different from installed 4.1.0).
4. Fonts: `index.html:14-16`, `font-loader.ts:118-123,169-177`, text composition, picker previews and `src/headless/main.ts:191,1114`.
5. Lottie: GraphQL browse, GIF previews, imports, metadata reads and runtime sources. Project-import resources and embedded references require ownership/resource admission as well as rights decisions.

Implement outside the immutable vendor snapshot using the existing patch/adaptor boundary. Then intercept real browser, worker, module, script, stylesheet/font and SDK requests with empty and warm caches, all model/backend fallbacks, page/text/headless rendering and Lottie browse/preview/import. Assert no implicit external request, rejected unknown/tampered identities and usable explicitly approved local assets. A global fetch mock or manifest-only test is insufficient. **Offline/no-implicit-download acceptance remains unqualified.**
