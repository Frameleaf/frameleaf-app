---
title: Native app API changes
---

# Native app API changes

The native Frameleaf apps (iOS and Android, in their own repositories) generate their clients from
`open-api/immich-openapi-specs.json`. When a live end-to-end test finds an API that is missing or insufficient, the server
is extended rather than worked around in the app (owner instruction, 2026-10-03). This page records each gap, the decision
and the operationIds involved.

Decisions are one of:

- **Existing endpoint**: the API already supports the journey; the app was pointed at it.
- **Extended**: an existing endpoint or DTO gained a backwards-compatible field or parameter.
- **New**: no existing endpoint fitted, so one was added.

## Gaps

Server changes land on branch `aj/native-api-gaps` through [Frameleaf/frameleaf-app#176](https://github.com/Frameleaf/frameleaf-app/pull/176); cloud changes through [Frameleaf/frameleaf-cloud#291](https://github.com/Frameleaf/frameleaf-cloud/pull/291).

| Reported by                          | Journey                                                                                                                                                                                                        | Decision                           | operationIds                                                                  | Change                                                                                                                                                                                                                                              |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ios-live (FL-218)                    | Settings > Preferences: changing any preference (for example Memories) forced every session of the account to drop its mirror and re-sync the whole library                                                    | Existing endpoint, behaviour fixed | `updateMyPreferences` (and `updateMyPreferencesV3`), unchanged                | The server now requests a sync reset only when the Locked rules (`privacy.suppression`: people, pets, tags, scope) actually change. Other preferences reach devices as an ordinary `UserMetadataV1` upsert. Reordering the same ids is not a change |
| ios-live (FL-218)                    | Backup > Back Up Now: every resumable upload was refused with 400 `Invalid Asset-Metadata` because `isFavorite` was a JSON boolean                                                                             | Extended (backwards compatible)    | `createAssetUploadResource` (`POST /assets/uploads`), header description only | `Asset-Metadata` JSON now accepts `isFavorite` as a JSON boolean, matching its OpenAPI `boolean` type. The legacy strings `"true"`/`"false"` are still accepted; other values are still refused. `duration` is integer milliseconds                 |
| android-live via live-stack (FL-218) | Sign-in: the plain-HTTP `local` candidate (`GET /server/connections`) and the DNS-SD advertisement named the container's bind port, which a port-mapped server (host 2290 to container 2283) doesn't answer on | Existing endpoint, behaviour fixed | `getServerConnections` (unchanged shape)                                      | When `FRAMELEAF_LOCAL_URL` names the LAN address, the fallback candidate and the `_frameleaf._tcp` advertisement use its scheme and port                                                                                                            |

## Server issues found by the live tests

### FL-330: default smart-search model missing from the model mirror

- **Found by:** live-stack, 2026-10-03. Every SmartSearch job failed with HTTP 500 on a fresh server.
- **Root cause:** the server has defaulted `machineLearning.clip.modelName` to `ViT-B-16-SigLIP-384__webli` since
  2026-05-18. The Frameleaf model mirror (`https://models.frameleaf.cloud`) was set up later and only carried
  `ViT-B-32__openai`, so the ML service could not download the default model.
- **Decision:** keep the default and publish the model on the mirror. The owner approved Apache-2.0 redistribution on
  2026-10-03. The catalogue change is in frameleaf-cloud (`infra/models/models.json`, Frameleaf/frameleaf-cloud#291); publishing is an operator action
  (`models-mirror` workflow).
- **Guard:** `server/test/model-mirror/default-models.spec.ts` (`pnpm test:model-mirror` in `server/`, workflow
  `model-mirror-defaults.yml`) checks that every default CLIP, facial-recognition and OCR model answers 200 on the mirror.
  It runs on pull requests that touch the ML defaults or model source, and weekly.
- **API impact:** none. No operationIds changed.
