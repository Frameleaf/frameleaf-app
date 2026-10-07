# FL-136 web and worker distribution evidence register

Source/data checkpoint reviewed 2026-10-06. Source commit:
`d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9`. Scope: the Frameleaf web bundle,
Studio browser assets, server/LAN workers and machine-learning containers.
Mobile applications, stores and their dependencies are excluded.

Supersedes the source-input checkpoint at `6394cdd4e7ad92b72240fe5c654544d4e355872e`.
The web manifest and workspace lock changed: the UI, SDK and layout WASM now
resolve to local workspace packages. The input hashes identify the source
checkpoint above, not a delivered artifact or a new rights approval.

This register records source identities and missing evidence. It does not grant
rights, clear an existing gate, change resource admission, certify a delivered
SBOM, or qualify an installed worker. No product dependency, model or licensed
Dolby tool was downloaded, installed or executed for this checkpoint. References to captured license
texts and prior approvals describe repository evidence, not fresh legal review.

## Authorities and exact inputs

These SHA-256 values identify the bytes inspected at the source commit above.
After a dependency/resource change, review the new inputs and delivered artifact;
do not treat this checkpoint as approval of the changed version.

| Source authority                                              | SHA-256                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `pnpm-lock.yaml`                                              | `edb4c4139cb20c5bd9d2116b1e6f9042a3dcc7944130693b304367a82c281bd2` |
| `web/package.json`                                            | `987d7c0b6989de57cd1e90b2788b837b95ebcae9cda1013eed9a1fd3efcf5322` |
| `machine-learning/uv.lock`                                    | `45acd08c52ed855387b434b7ce8fc087f26892362c5864799e3e95e81422b8bf` |
| `machine-learning/pyproject.toml`                             | `e34ed0a752d3dcbc746c27cd72948289af25676e1ad51c182d267bc37905cb92` |
| `studio/engine-build.json`                                    | `7ff83e01618d5f1798d618add888289b07f7fd3bffb7830e723ae55409fe9ca1` |
| `studio/engine-package-lock.json`                             | `5efddf7c35a2600f0228f0b973991838af8996fba8d5591dd7460dc3690a36dc` |
| `studio/dependency-attribution.json`                          | `562547d25ba230ceed3350999d97280fe858ce774102a27f6d0bc45e5cdffda7` |
| `studio/rights-approval.json`                                 | `9a6b7a08b1b29fb9787a1d62924552ef4b1813538ff0828c3bb4b5f1aad3186b` |
| `studio/distribution-gates.json`                              | `517decef8ca1cea63fe28781b4419d32ad835c11caf8330beb2c0fb4b1ca35f0` |
| `licenses/acknowledgements.json`                              | `1987600c3ec93f0d3ac211110f43e6246b55ea8d941fe7c747dff5b8cdb1e5de` |
| `machine-learning/immich_ml/models/semantic-mask-models.json` | `7683ad4fd11d70b17dd02bb738bd95fce1f84aa54dcc28947f1669833d2adca8` |
| `studio/freecut-provenance.json` | `615f4e3c758ff6ff092281d1b41275f650e45d93b86e77f0bd3b0a7151310487` |
| `packages/sdk/package.json` | `b8035fd0eb3f8f40891029b30202ad156d933863a4c79d5e6144fd2f49bcc3ea` |
| `packages/ui/package.json` | `0e40ac3e192eca8fabf91e774e84d17c0ad45668f9f53c9f2a09fadf7d8e1d66` |
| `packages/ui/LICENSE` | `39121dfe51a7919c78393a9a905f2ab64e02ba5c8e3be277631db4520fcb789f` |
| `packages/justified-layout-wasm/package.json` | `f6a2fce0344d166240431f38d69fa9ea7ad61a272dcbdbe5a05a024c5116132b` |
| `packages/justified-layout-wasm/LICENSE` | `ce3fb82d9ee80a1cb0e548f9b0560ead52378ee2b4e826fd9459b4acf7075d89` |

The existing [rights foundation](frameleaf-studio-foundation.md) explains the
attribution inventory, digest-bound owner approvals, generated runtime admission,
public credits and distribution gates. Keep those authorities separate. In
particular, raw `resources[].decisions` are not the effective owner-approved
runtime decision by themselves. Reproduction commands below verify the generated
rights and notices without changing approvals.

## Exact package versions and delivery gaps

`pnpm-lock.yaml`'s `web` importer is the complete direct dependency resolution
authority, including peer contexts and workspace links. The following compact
inventory records its external version numbers;
it is not a license or transitive/delivered-file inventory.

| Web package(s)                                                                                                               | Locked version(s)                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `@formatjs/icu-messageformat-parser`, `intl-messageformat`                                                                   | 3.5.17; 11.2.14                                                                     |
| `@frameleaf/justified-layout-wasm`, `@frameleaf/ui` | Workspace links `../packages/justified-layout-wasm` (0.4.3; AGPL-3 declaration) and `../packages/ui` (0.86.0; MIT declaration); bind Git source and emitted bytes |
| `@mdi/js`, `@noble/hashes`                                                                                                   | 7.4.47; 2.3.0                                                                       |
| `@photo-sphere-viewer/core`, equirectangular-video-adapter, markers-plugin, resolution-plugin, settings-plugin, video-plugin | 5.15.1 each                                                                         |
| `@types/geojson`, `@zoom-image/core`, `@zoom-image/svelte`                                                                   | 7946.0.16; 0.42.0; 0.3.9                                                            |
| `dom-to-image`, `fabric`, `geo-coordinates-parser`, `geojson`                                                                | 2.6.0; 7.4.0; 1.7.4; 0.5.0                                                          |
| `handlebars`, `happy-dom`, `hash-wasm`                                                                                       | 4.7.9; 20.11.8; 4.12.0                                                              |
| `hls-video-element`, `hls.js`, `justified-layout`, `lodash-es`, `luxon`                                                      | 1.5.11; 1.7.1; 4.1.0; 4.18.1; 3.7.2                                                 |
| `maplibre-gl`, `media-chrome`, `qrcode`, `simple-icons`, `socket.io-client`                                                  | 6.9.0; 4.19.2; 1.5.4; 16.28.0; 4.8.3                                                |
| `svelte-gestures`, `svelte-i18n`, `svelte-jsoneditor`, `svelte-maplibre`, `svelte-persisted-store`                           | 5.2.2; 4.0.1; 3.13.0; 2.0.0; 0.12.0                                                 |
| `tabbable`, `tailwind-merge`, `tailwind-variants`, `thumbhash`, `transformation-matrix`, `uplot`                             | 6.5.0; 3.6.0; 3.3.1; 0.1.1; 3.1.0; 1.6.32                                           |
| `@frameleaf/sdk`                                                                                                             | Workspace link `../packages/sdk`; bind its Git source and emitted bytes at delivery |

`web/package.json` declares AGPL version 3 for the application. That declaration
does not license every dependency, model or fetched asset. Required next evidence:
the exact web artifact's dependency/file SBOM, corresponding packaged license and
NOTICE texts, modified-source obligations, fonts/icons/assets and accessible
credits. Build-tool or direct-dependency presence alone does not prove inclusion.

| Worker/Studio component                              | Source version / declared license evidence                                                      | Required artifact evidence                                                                                                                                                                                                         |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Freecut                                              | Commit `4d62e8082c5eb387a96275bcbd323d28f6e41a62`; pinned MIT LICENSE                           | Match source/patch chain and shipped Freecut notice. This integration checkpoint records adapted digest `aaf508828b8881a3314e5b364da5326c6706dffe191fa6a63abe2dff67e4468c`; it is not the separately owned newer Studio candidate. |
| SoundTouch JS                                        | 0.2.3; LGPL-2.1-or-later; attribution has license and copyright notice hashes                   | Match modified DSP source, actual bundled bytes, notices and applicable corresponding-source/build obligations; no DSP acceptance claim.                                                                                           |
| Mediabunny plus AAC/AC3/MP3/ProRes wrappers          | 1.50.8 each; wrapper MPL-2.0 declarations                                                       | Exact embedded FFmpeg/LAME/TurboRes source/configuration/build mapping and license obligations. Wrapper terms do not clear embedded binaries.                                                                                      |
| Embedded LAME                                        | Attribution identifies 3.100; LGPL declaration                                                  | Exact compiled features, source/build materials and distribution obligation review; existing gate stays blocked.                                                                                                                   |
| Embedded FFmpeg / TurboRes                           | Exact embedded revisions unknown in attribution                                                 | Obtain actual WASM provenance/configuration and corresponding-source evidence; do not infer revision from wrapper version.                                                                                                         |
| Studio transformers / Kokoro / ORT Web               | 4.1.0 / 1.2.1 / 1.26.0-dev.20260410-5e55544225; Apache-2.0 / Apache-2.0 / MIT lock declarations | Use all 51 `runtimePackages` rows and package-notice evidence in attribution; bind nested runtimes/WASM, exact source and delivered notices.                                                                                       |
| React / React DOM / dotLottie                        | 19.2.5 / 19.2.5 / 0.76.0; MIT lock declarations                                                 | Delivered dependency closure and notices; Lottie asset rights remain per-asset.                                                                                                                                                    |
| ML Torch / Torchvision                               | 2.5.1 and 2.5.1+cpu / 0.20.1 and 0.20.1+cpu in `uv.lock`                                        | Per-platform wheel hashes, bundled native libraries, actual image SBOM and notices; these lock rows are alternatives, not proof every image installs both.                                                                         |
| ML transformers / NumPy / Pillow / OpenCV / RapidOCR | 5.16.1 / 2.4.6 / 12.3.0 / 4.13.0.92 / 3.8.1                                                     | Package/native dependency licenses and exact delivered wheel identity remain unverified by this register.                                                                                                                          |
| ML ONNX runtimes                                     | CPU 1.30.0; GPU 1.26.0; MIGraphX 1.27.1; OpenVINO 1.24.1; OpenVINO GenAI 2026.3.1.0             | Full `uv.lock` closure, selected device image, provider/native redistribution terms, SBOM and corresponding notices. No container was inspected.                                                                                   |
| Dolby portal / artistic trim tools                   | Not bundled; candidate-chain versions not supplied here                                         | Existing administrator-installed-tool gate, qualified worker address, exact versions and VID-204 edited-output QC. Detection is not qualification.                                                                                 |

## Models, weights, fonts and MusicGen

The 210-row attribution resource inventory and digest-bound approvals remain the
authorities for resources, voices, fonts, LUTs and bundled media. The following
model revisions are source declarations, not newly verified downloaded weights.
Missing file hashes or model cards cannot be filled by assuming a repository
license covers the weights, tokenizer, voices or intended service use.

| Studio model locator                              | Pinned revision                            | Declared license in attribution                                |
| ------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------- |
| Xenova/musicgen-small                             | `6a8096dabfff72909ef5eae41461408e29ae20fd` | CC-BY-NC-4.0                                                   |
| onnx-community/Kokoro-82M-v1.0-ONNX               | `1939ad2a8e416c0acfeecc08a694d14ef25f2231` | Apache-2.0                                                     |
| OpenMOSS-Team/MOSS-TTS-Nano-100M-ONNX             | `f52645cb467506d8e18e746ddd59482685b74e58` | Apache-2.0                                                     |
| OpenMOSS-Team/MOSS-Audio-Tokenizer-Nano-ONNX      | `ceff0d0749bfb3fa2d61149794ec6feef0d1e1ae` | Apache-2.0                                                     |
| onnx-community/gemma-4-E4B-it-ONNX                | `843f250f23bc91754def1e0f0db390dacd1e6b05` | Apache-2.0 declaration; verify applicable original-model terms |
| LiquidAI/LFM2.5-VL-450M-ONNX                      | `95c283d4497a56477a83177079fa6b7121abb1b1` | Other; intended-use review needed                              |
| Xenova/clip-vit-base-patch32                      | `d15189d7028b43f1d3e65039190477f6af591c2a` | Unspecified                                                    |
| Xenova/all-MiniLM-L6-v2                           | `751bff37182d3f1213fa05d7196b954e230abad9` | Apache-2.0                                                     |
| Xenova/clap-htsat-unfused                         | `c28f2883575e590e04d3146ff0713c2448d691ba` | Unspecified                                                    |
| walterlow/RIFE_fp32_timestep                      | `ee09066f9822f8b28b8477a1b4cc30f19d607590` | MIT                                                            |
| Olicorne/parakeet-tdt-0.6b-v3-smoothquant-onnx    | `8a9229fe6a84898bcd05abd31d541722560b80f8` | CC-BY-4.0                                                      |
| onnx-community/whisper-tiny_timestamped           | `517244293732ee2d58139af5814231b7e6830a0d` | Unspecified                                                    |
| onnx-community/whisper-base_timestamped           | `608c49e61301901684bc36cac8f74b95ff6b5a8e` | Unspecified                                                    |
| onnx-community/whisper-small_timestamped          | `65caa70f294b46e1c33ff820aae6b16d048ab818` | Unspecified                                                    |
| onnx-community/whisper-large-v3-turbo_timestamped | `b3f77bf9a8c4d5ea3415827033d1ffea7955fd9a` | Unspecified                                                    |
| supertonic-3                                      | `4402acca094e2ff2b3dff446e0bf915f3fccc462` | OpenRAIL-M                                                     |

MusicGen's existing owner-approved row digest is
`ad5eb23fa07eb3ad7a7f41034c9250e041b3d5bdcd0d33fa609ce96451d2f650`.
Its `excludedUses.hostedUse` retains the explicit Frameleaf Cloud exclusion and
existing local/server/LAN-worker approval. This packet preserves that
approval and its hosted exclusion; it supplies no legal opinion. The attribution row
still has no per-file weights inventory. Resolve exact downloaded files, notice
delivery and consent evidence for the actual approved distribution; never clear
the hosted exclusion to resolve an engineering test.

Photo-library model credits in `licenses/acknowledgements.json` cover InsightFace,
OpenAI CLIP/OpenCLIP, Apple DFN, SigLIP, NLLB-CLIP, M-CLIP, PP-OCRv5, Qwen2.5-VL,
Florence/Phi and NSFW detection. These component credit entries do not themselves
pin model artifact revisions. The register records the repository's commercial
buffalo_l license assertion, not independent license evidence. Obtain exact model
files/revisions, applicable terms, license evidence and actual selected model
image/download receipt. Preserve NLLB/MusicGen hosted exclusions and model-source
selection/consent controls; provider access is outside this packet.

## Reproduce the source checkpoint and reconcile a delivered artifact

From the repository root, verify the hashes above against the current checkout.
The check fails on drift; a changed hash requires a new review, not a refreshed
approval. It reads only the listed source files and downloads nothing.

```sh
python3 - <<'PY'
import hashlib
import re
from pathlib import Path

register = Path('docs/docs/developer/fl136-web-worker-evidence-register.md').read_text()
inputs = re.findall(r'\|\s*`([^`]+)`\s*\|\s*`([0-9a-f]{64})`\s*\|', register)
assert len(inputs) == 17, 'Source-input table is incomplete'
changed = [file for file, expected in inputs
           if hashlib.sha256(Path(file).read_bytes()).hexdigest() != expected]
assert not changed, f'Source inputs changed: {changed}'
print(f'Verified {len(inputs)} source inputs; delivered artifact and rights qualification remain separate')
PY
node scripts/frameleaf-studio-rights.mjs
node scripts/frameleaf-acknowledgements.mjs
node scripts/frameleaf-distribution-gates.mjs
node --test scripts/frameleaf-distribution-gates.test.mjs
```

The acknowledgements generator validates and reproduces the committed public
credits and notice texts in memory. The rights generator verifies its committed
server mirror. Neither operation supplies a license opinion or artifact SBOM.

For the actual Studio candidate built with the pinned source and toolchain, reuse
`node studio/tools/engine.mjs attest` and
`node studio/tools/engine.mjs audit-attribution`. They bind the adapted source,
lockfile, delivered files and notices; the audit recomputes attribution from
trusted inputs and rejects changed, missing or extra notice artifacts. A fresh
worktree without `studio/vendor/freecut`, the installed engine and its `dist`
cannot run that artifact check. This packet does not build or attest an artifact.

For each delivered web/worker/container target, attach its immutable artifact
digest, platform, source SHA, generated package/file SBOM and build provenance.
Compare exact package versions and workspace source to the locks and manifests
above; compare Studio resources and embedded binaries to attribution and its
digest-bound approvals. Record unresolved versions, missing file identities,
unmatched SBOM components, notices and corresponding-source materials as release
blockers. A package found in a lock or a scanner's license field supplies no
redistribution or service-use approval. Model downloads require their own file
digests and consent receipts. No delivered SBOM was supplied for this review.

## Acceptance mapping at the reviewed source

| FL-136 requirement | Committed behavior / evidence | Remaining acceptance |
| --- | --- | --- |
| Qualified worker and administrator-installed Dolby chain | `distribution-gates.json` tracks `dolby-tool-admission`; preflight remains fail-closed | Worker address, tool paths/versions and actual edited-output VID-204 QC from FL-109 |
| Web/worker/cloud component, model, font and media register | Attribution, digest-bound approvals, public notices and this 17-input source checkpoint; MusicGen hosted exclusion preserved | Actual delivered package/file SBOM, embedded-source obligations and legal/distribution review |
| Credentials, billing, privacy and download consent gates | Ten recorded gates; four remain blocked on owner input; secrets stay outside Git | Named responsible owner/evidence for each unresolved gate; current Cloud billing and feature disclosures require their own owner reconciliation |
| Manifest/provenance and license reconciliation | Rights/credits generators and gate validator reproduce source records; existing engine attestation/audit handles a built candidate | Actual candidate artifacts and source/toolchain required to execute artifact reconciliation |
| Signed native inspection | Native acceptance moved to FL-210/211 by the owner on 2026-09-30 | Excluded from this repository and this packet |
| Owner/legal/distribution evidence | Prior digest-bound approvals retained for their exact rows | No new approval supplied; source availability does not establish rights |

## Next evidence packets and limitations

| Remaining gate                       | Concrete evidence packet                                                                                                                   | Dependency / ownership                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Delivered web/worker inventory       | Exact candidate artifact digest, target/platform, package/file closure, notices and modified-source bundle mapped to the authorities above | Root-owned hosted build/release evidence; FL-24/FL-136 independent review. No local generator or install substitutes for it.  |
| Embedded codec/runtime obligations   | Exact WASM/native source revision, configuration, reproducible build materials and shipped corresponding-source/notices review             | Existing `embedded-codec-corresponding-source` gate; engineering/legal evidence, not inferred permission.                     |
| Model and fetched-asset identity     | Exact revisions and per-file hashes, model/voice/font/asset terms, notice delivery and download-consent behavior for actual artifacts      | Existing Studio resource owner and model/distribution owner; do not change admission or duplicate DSP work.                   |
| Cloud processing disclosures/billing | Versioned actual feature disclosure/acceptance, processing locations, retention/subprocessors and named billing evidence                   | Preserve existing gate status; coordinate with its owner. No account, secret, provider or disclosure approval operation here. |
| Dolby edited-output admission        | Qualified installed worker/tool chain plus actual edited-output profile QC                                                                 | FL-109/VID-204 owner; source or tool detection is insufficient.                                                               |
| Architecture/package reconciliation  | Repeat artifact mapping against final PG19 package and durable-job graph; classify frozen legacy import assets explicitly                  | FL-333 owner supplies canonical interfaces. No Redis/Valkey engineering or switchback certification is introduced.            |

No gate was cleared. Prior source receipts, credits or owner-decision records
remain provenance for their named versions. Exact installed artifacts, runtime
notice presence, offline/download consent, privacy behavior and legal/distribution
review are unqualified by this static packet. FL-136 remains open.
