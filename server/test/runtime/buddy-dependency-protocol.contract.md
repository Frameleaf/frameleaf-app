# Buddy dependency binding v2: protocol RED fixture

This is the concrete protocol contract and its admission-only implementation packet, not a service qualification result. The original v1-only production dispatch produced the intended hosted RED on run `37217759102`, proof head `60dabb503e619072bdaf8f99d80dcedc6d6ea2a0`: server build passed and the sole test failure was the final protocol-admission assertion. The test invokes existing compiled `dist/main.js`; it imports no proposed adapter or registry API. V1 application-only bindings and their dependency/security refusal controls remain unchanged.

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

Only `Reviewed v2 dependency protocol must be admitted before application cache` was the first intended RED. The hosted v1-only compiled main explicitly emitted its sanitized validation-refusal category, exited 1, and never reached the observer. Missing files, unavailable exports or fixture failures do not qualify. The current source packet preserves that assertion and adds strict v2 validation; its GREEN remains unqualified until root-hosted build and tests.

Admission validates strict closed shapes, replacement-local Ed25519 signatures over original JSON member order, exact selected-key/source coverage, request nonce and digest, recovery/snapshot/vault/identity/artifact/prepared/publication bindings, resource revision, challenge and shared publication-fence epoch. It does not independently observe a current local registration/source revision or live service. Those signed values are protocol declarations, not operational readiness. Only existing application keys can change the boot environment; all dependency values and `_FILE` sources remain replacement-local. V2 with an active maintenance marker or request state refuses before the application graph. V2 finalization always refuses before promotion until real readiness adapters qualify, preserving the marker and existing publication fence. V1 maintenance/finalization semantics are unchanged.

The extended test checks inert dependency inputs, signed tampering, foreign endpoints, stale/mismatched revisions/challenges/digests/identities, unsupported/missing source coverage, partial adapter/publication journals, duplicate grants, active marker and finalization refusal. The final admission assertion and pre-bootstrap cache observation remain unchanged. No authored record is promoted to operational proof.

Review corrections additionally bind `publicationDigest` to the exact private journal bytes parsed and validated as complete, with no unvalidated second read. The final identity/marker check refuses v2 if maintenance appears after the initial check, retaining v1's matching-marker return. Hosted Linux regressions interpose only the real FileHandle IO boundary: original read bytes are returned unchanged; actual atomic journal replacement or private marker creation occurs only after the genuine handle close completes, after the held-file postread identity/stat checks. A private close-barrier observation must exist before the race assertion counts. This prevents an early ctime integrity refusal from satisfying the negative. The journal negative signs replacement noncomplete bytes and must refuse at digest consistency; the late-marker v2 negative must refuse without cache initialization, while the same controlled v1 race preserves replacement-local port. No loader, authentication, config or client result is substituted.

After strict v2 admission and negative authority controls qualify, a separate admitted-v2 consumer RED must use the same first ConfigRepository cache and actual production PostgreSQL/Valkey clients against genuine hosted disposable services. Independent setup connectivity is not that RED. Until then, consumer connectivity is **UNMEASURED**. Ordinary full bootstrap, distribution/source loss, restart, platform persistence and two-network recovery remain required.

## Root-owned hosted verification

Using the existing pinned server/plugin-core build setup, run the production server build followed by:

```sh
node --test server/test/runtime/buddy-boot-binding.test.mjs server/test/runtime/buddy-dependency-protocol.test.mjs
```

The admission implementation now expects both files to pass, including the unchanged former RED assertion and new negative controls. This is an expectation, not observed GREEN. Existing v1 runtime controls must remain green. No command was executed locally; no service, secret store, provider or infrastructure operation is part of this source packet.
