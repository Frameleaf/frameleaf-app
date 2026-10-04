# Buddy dependency binding v2: protocol RED fixture

This is the concrete **proposed test contract**, not an implemented schema or a service qualification result. The production `buddy-boot-binding.ts` schema accepts only v1. The test invokes existing compiled `dist/main.js`; it imports no proposed adapter or registry API. V1 application-only bindings and their dependency/security refusal controls remain unchanged.

The intended missing behavior is strict v2 protocol admission before the first application cache. The final assertion requires admission of a correctly bound local protocol fixture. The observation stops at the existing signal-registration boundary before bootstrap; it cannot establish dependency authentication, consumer connectivity, worker startup, or full recovery acceptance.

## Proposed closed wire shape

V2 retains the v1 common fields: `version` (now 2), `state`, `recoveryId`, `snapshotId`, `vaultId`, `replacementIdentity`, `scope`, `mode`, `environmentKeys`, `recoveryDirectory`, `artifactDigest`, and `preparedDigest`. Its only additional top-level field is `dependencyGrants`. Unknown fields, duplicate keys/grants, unsupported profiles/modes/sources, unselected keys, foreign identity and stale revisions must be refused. V1 never accepts this extension.

Each grant is exactly `{ request, receipt, signature }`. The fixture covers PostgreSQL and Valkey, `verify-existing` profile version 1, parts mode, and environment sources. File/systemd sources, URL/options/socket modes and managed provisioning remain separate packets. No captured endpoint can grant local service authority by itself.

| Object | Exact fields and binding |
| --- | --- |
| `request` | `version: 1`, `grantId`, `dependency: postgres or valkey`, `profile: verify-existing`, `profileVersion: 1`, `connectionMode: parts`, `environmentKeys`, `sourceBindings`, `requestNonce`, `priorConfigurationRevision`, `registration`, `recoveryId`, `snapshotId`, `vaultId`, `replacementIdentity`, `artifactDigest`, `preparedDigest` |
| `sourceBindings[]` | Exactly `{ key, source: environment }`; names only, unique and equal to the grant's selected keys. Values remain in the authenticated private typed artifact. |
| `registration` | `version: 1`, matching `dependency`, `kind: standalone`, `registrationId`, `revision`, `replacementIdentity`, `transport: tcp`, `hostname`, `port`, `tls`. This models a separately selected replacement-local resource; it is not recovered endpoint authority. |
| `receipt` | `version: 1`, `state: eligible`, `grantId`, `requestDigest`, `requestNonce`, `registrationId`, `serviceRevision`, `replacementIdentity`, `recoveryId`, `snapshotId`, `vaultId`, `artifactDigest`, `preparedDigest`, `publicationDigest`, `sourceRevision`, `publicationFence`, `challenge`, `journal` |
| `publicationFence` | Exactly `{ recoveryId, epoch, replacementIdentity }`; binds the modeled held publication fence, not a historical process or advisory-lock identifier. |
| `challenge` | Exactly `{ replacementIdentity, requestNonce, serviceRevision }`; must agree with the current registration and request. This fixture authors the challenge; no live service has answered it. |
| `journal` | Exact ordered phases `requested`, `validated`, `service-prepared`, `files-prepared`, `verified`, `eligible`. An adapter journal never substitutes for the existing complete publication journal. |
| `signature` | Base64url Ed25519 signature over the UTF-8 `JSON.stringify(receipt)` bytes. `requestDigest` is SHA-256 over the UTF-8 `JSON.stringify(request)` bytes. Verify against the replacement-local identity key, never the historical snapshot signer. These byte conventions are proposed here; no existing production receipt API is claimed. |

PostgreSQL selects `DB_HOSTNAME`, `DB_PORT`, `DB_DATABASE_NAME`, `DB_USERNAME`, and `DB_PASSWORD`. Valkey selects `REDIS_HOSTNAME`, `REDIS_PORT`, `REDIS_DBINDEX`, `REDIS_USERNAME`, and `REDIS_PASSWORD`. Top-level selected keys are the union of those grants plus the application control `FRAMELEAF_PORT`; security/identity/link/entitlement inputs remain excluded from activation. This is a narrow initial profile, not all dependency coverage.

## Evidence boundary and test ordering

The test performs actual compiled typed capture, encryption, signed vault commit, export, original source/vault removal, authenticated offline recovery, private artifact staging, file publication/verification, complete journal, and existing v1 fenced binding finalization. The source snapshot signer and replacement identity are distinct. The fence callback is a local fixture, not an observed live PostgreSQL maintenance lock. File publication is real; database publication is outside this settings-scope protocol packet.

The local registration, nonce, challenge, phase journal and `eligible` receipt are **authored protocol fixtures**. Their local signatures are real, but neither signatures nor serialized eligibility establish live service identity, readiness, TLS, permissions, or connectivity. Port 1 is intentionally not a disposable service. These records must never be used as hosted operational proof or as authority for historical automatic credential activation. A production actor must earn such records with actual matching-service verification under a held fence; production admission must validate their local issuer, request/revision/source/identity/digest bindings and reject stale or forged receipts.

Before the final RED assertion, the test checks compiled-file/import prerequisites, real recovery/publication, private modes, baseline startup, actual v1 application-selected typed port, and v1 DB/Redis/security refusal before cache. The legacy raw environment port differs from the selected typed port. Any failure there is a setup or compatibility failure, not the intended RED.

Only `Reviewed v2 dependency protocol must be admitted before application cache` is the first intended RED. Current compiled main explicitly emits its sanitized validation-refusal category, exits 1, and never reaches the observer because the binding schema has `version: literal(1)`. Missing files, unavailable exports or fixture failures do not qualify. Root must observe that exact hosted assertion before authorizing any production admission change.

After strict v2 admission and negative authority controls qualify, a separate admitted-v2 consumer RED must use the same first ConfigRepository cache and actual production PostgreSQL/Valkey clients against genuine hosted disposable services. Independent setup connectivity is not that RED. Until then, consumer connectivity is **UNMEASURED**. Ordinary full bootstrap, distribution/source loss, restart, platform persistence and two-network recovery remain required.

## Root-owned hosted verification

Using the existing pinned server/plugin-core build setup, run the production server build followed by:

```sh
node --test server/test/runtime/buddy-boot-binding.test.mjs server/test/runtime/buddy-dependency-protocol.test.mjs
```

The new file is expected to fail only at the final protocol-admission assertion. Existing v1 runtime controls must remain green. No command was executed locally; no service, secret store, provider or infrastructure operation is part of this source packet.
