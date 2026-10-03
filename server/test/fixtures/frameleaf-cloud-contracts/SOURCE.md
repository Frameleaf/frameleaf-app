Golden fixtures from the Frameleaf Cloud contracts package, so the server's parsers are tested against
what the cloud publishes (FL-177). Provenance and any pending candidate verification are recorded below.

- Repository: `Frameleaf/frameleaf-cloud`
- Path: `packages/contracts/fixtures/` (`errors/`, `instance/`, `ml/`, `ml/rejected/` and `licence/`, every file
  this server parses)
- Branch and commit: `codex/FC-19-heartbeat` at `383f815ad474e369d16d4f62eb5eef077e9dc135` (Frameleaf/frameleaf-cloud#9, final);
  against `89654126c3f54ee89444c8f2b0c0efb3c03b4e66` only `instance/discovery.json` and
  `instance/discovery-instance.json` changed (they gained `store`)
- The FC-18 files (`errors/insufficient-credits.json`, `errors/use-dpop-nonce.json`,
  `instance/register-request.json`, `instance/register-response.json`) are byte-identical to `codex/FC-18-instances`
  at `3c7a87ee75b76bbada72c031d36738f301db6cfa`.
- `licence/check-symbol/` (every file) is byte-identical to `packages/contracts/fixtures/licence/check-symbol/` at
  `8bf5b83ed2a5a4ce22b64f553a6f48ec78768504` (`feat: FC-22 Luhn mod 32 check symbol for licence keys`); see that
  folder's own `SOURCE.md` for what it exercises (FL-182).
- FL-184: refreshed `errors/` and `instance/` against `origin/main` at `4658c6a72e274512a935fff73cee142163ff9635`
  (merges FC-19 `2042045`, FC-66 `57c7170` and FC-22 `4658c6a`, all final). The FC-19/FC-18 files above and
  `licence/check-symbol/` were verified byte-identical to this commit; nothing in them changed. New at this
  commit: `exchanges/` (every file: `token-dpop`, `token-use-dpop-nonce`, `token-invalid-dpop-proof`,
  `token-clone-suspected`, `api-use-dpop-nonce`, `api-invalid-dpop-proof`, `api-bearer-refused`),
  `instance/dpop-proof-token.json`, `instance/dpop-proof-api.json`, `instance/token-response-dpop.json`
  (FL-178), the new `errors/` files (`invalid-dpop-proof`, `estimate-mismatch`, `request-invalid`,
  `license-not-found`, `activation-limit`, `activation-rate-limited`), and all of `licence/` except
  `licence/check-symbol/` (already copied for FL-182 and byte-identical): the keys document, certificate claims
  and verdict cases (`certificates/`), activation request/response including `activation-jose.json` and its
  `-kid-mismatch`/`-jkt-mismatch`/`-missing-jwk` variants, the offline activation request, refresh, deactivate
  and entitlements (FL-177).
- FL-183: `ml/` and `ml/rejected/` (every file) are byte-identical to `origin/main`. Against the FL-181 copy
  (`codex/FC-66-api-protection` at `44311b822d94c8cd9a2cc95cd4bcde79e54902b4`), `ml/catalog-restoration.json` is
  replaced by the cloud's own fixture, and new are `capabilities.json`, `capabilities-not-ready.json`,
  `hardware.json`, `wallet.json`, `consent-current.json`, `consent-record-request.json`, `consent-recorded.json`,
  `job-admitted.json`, `catalog-descriptions.json` and
  `rejected/catalog-entry-{mode-on-descriptions,non-commercial-licence,restoration-without-mode}.json`,
  `rejected/consent-record-{email,ocr-addon}.json` and `rejected/catalog-two-defaults.json`; every other `ml/`
  file is unchanged. The server's production schemas in `server/src/utils/frameleaf-cloud.ts` parse every answer
  fixture field for field, check every request fixture before it would be sent, and refuse every `ml/rejected/`
  fixture (FL-183).
- `errors/` (FL-183): `capacity.json`, `consent-missing.json`, `consent-version-outdated.json`, `daily-cap.json`,
  `entitlement-missing.json`, `estimate-used.json`, `ml-rate-limited.json` and `region-mismatch.json` are
  byte-identical to `origin/main`. The wallet top-up envelopes (`balance-cap.json`, `top-up-minimum.json`)
  belong to the account API and are not copied.
- FL-185: `licence/refresh-request.json` is byte-identical to `origin/main`, which no longer carries a null
  entry in `certificates` (Frameleaf/frameleaf-cloud#27).
- FL-183/FL-185 re-sync (2026-09-26): `origin/main` at `5e51087d92b1fc37ee7617835587c0935ce263de`, which carries
  Frameleaf/frameleaf-cloud#27 (merge `3559f29941`) and #29 (merge `0bb493f9e3`). Every file under `errors/`,
  `instance/`, `licence/` (except `check-symbol/`, tracked separately above) and `ml/` that this app copies is
  byte-identical to that commit (git blob hashes compared) except the two updated above
  (`ml/catalog-restoration.json`, `licence/refresh-request.json`); `ml/catalog-descriptions.json` and
  `ml/rejected/catalog-two-defaults.json` are newly copied from it. Not copied, because nothing in
  `server/src/utils/frameleaf-cloud.ts` parses them yet: `billing/` (in-app billing, FC-52), `wallet/` (account
  wallet endpoints — this server only reads the ML gateway's own `ml/wallet.json`),
  `identity/instance-claims.json`, the instance sharing/connections fixtures
  (`instance/accept-invitation-response.json`, `instance/connections.json`, `instance/instance-access.json`,
  `instance/instances-list.json`, `instance/invitation-preview.json`) and their matching `errors/`
  (`already-shared.json`, `invitation-email-mismatch.json`, `invitation-gone.json`, `invitation-pending.json`,
  `velocity-limit.json`), plus `errors/balance-cap.json` and `errors/top-up-minimum.json` (account API, noted
  above).
- FC-70 release feed: `releases/latest-stable.json` and `releases/latest-beta.json` are byte-identical to
  `origin/main` at `cb8355d` (merge of Frameleaf/frameleaf-cloud#83, commit
  `a2b668fae4b3b2752b92070bf2145e2f459dc934`, "FC-70 staged rollout and withdrawn releases in the release check"):
  they gained `rolloutPercent` and `fallback` (FL-142). Earlier copies: #54 at `517cbd3da9`, which reads the app's
  real `frameleaf-v<semver>-<sequence>` tags, and #43 at `86adf20`. The contract is
  `packages/contracts/src/releases/latest.ts`; `server/src/utils/frameleaf-release.ts` reads them (FL-192).
- FL-164 managed backup (BAK-001 FC-33, BAK-002 FC-38): `backup/usage.json`, `backup/escrow-blob.json`,
  `backup/escrow-record.json`, `backup/run-report.json` and `backup/settings.json`, and the backup refusals
  `errors/grant-revoked.json`, `errors/clone-suspected.json`, `errors/escrow-not-allowed.json`,
  `errors/rate-limited.json` and `errors/region-unavailable.json`, are byte-identical to `origin/main` at
  `39488a50b176ea0778ee138d202bc8eda8376a70` (merge of Frameleaf/frameleaf-cloud#51). The contracts are
  `packages/contracts/src/backup/{grant,usage,escrow,runs}.ts`; `server/src/utils/frameleaf-cloud-backup.ts` reads
  them, and `errors/entitlement-missing.json` was checked byte-identical at that commit. Not copied, because nothing
  here parses them yet: `backup/purge.json`, `backup/run-list.json` and `errors/purge-not-cancellable.json` (a
  purge is started from the Frameleaf account).
  The original v1 grant trio from this source commit is superseded by the FL-325 / FC-101 refresh below.
- FL-325 / FC-101 managed backup v2 (2026-10-03): `backup/grant-response.json`,
  `backup/grant-rotate-response.json` and `backup/grant-metadata.json` are byte-identical to Cloud's
  new `packages/contracts/fixtures/backup/v2/` trio with the same filenames at source commit
  `c65ede160b91c02ca2947e516dd59dde1919b26d` on `Frameleaf/frameleaf-cloud`
  `aj/FC-101-city-backup-domains` (reviewed candidate; merge and hosted qualification tracked separately).
  The SHA-256 hashes were compared after copying the authoritative files. These fixtures carry
  `version: 2`, `provider: frameleaf`, storage ID
  `0194b445-9c8a-7001-8000-000000000002` and location `loc-07` / `amsterdam` / Amsterdam / Netherlands / NL,
  with explicit `eu-central-1` region and `https://s3.eu-central-1.backup.frameleaf.cloud` endpoint. The
  existing bucket, credentials, encryption and policy fields are preserved.
- FL-165 remote access: `remote/enroll-response.json`, `remote/dns-txt-put-request.json`,
  `remote/dns-txt-put-response.json`, `remote/certs-request.json`, `remote/caa-put-request.json`,
  `remote/hostname-put-request.json`, `remote/hostnames-list.json` and `remote/label-vectors.json` are
  byte-identical to `origin/main` at `39488a50b176ea0778ee138d202bc8eda8376a70`. The contracts are
  `packages/contracts/src/remote/{enroll,dns-txt,certs,caa,hostnames}.ts`; `server/src/utils/frameleaf-remote-access.ts`
  reads and builds them. The server takes the domain from the enrolment answer (or discovery's
  `remote.directDomain`) and falls back to `frameleaf.net`; `frameleaf-direct.net` is retired (cloud FC-29). The relay fixtures (`remote/relay-*.json`, `remote/wan-probe-*.json`,
  `remote/remote-usage.json`) belong to CLD-103/CLD-104 and are not copied yet.
- FL-165: `instance/discovery.json` and `instance/discovery-instance.json` are byte-identical to
  `daa22f68296bc5a897b40b3af34b750fd6586e2f` (the `frameleaf.net` rename): both gained the optional
  `remote: { directDomain }` (contract `packages/contracts/src/instance/discovery.ts`), which
  `server/src/utils/frameleaf-cloud.ts` reads and remote access uses as the direct domain before enrolment.
- Apex and domain layout (Frameleaf/frameleaf-cloud#57, merge `e318c18314b30a9c0fad7472a34be3c706837b52`, which also
  carries the `frameleaf.net` rename from #56): `instance/discovery.json`, `instance/discovery-instance.json`,
  `ml/wallet.json`, `remote/certs-request.json`, `remote/dns-txt-put-response.json`, `remote/enroll-response.json` and
  `remote/hostnames-list.json` are byte-identical to that commit. The store and wallet links now point at the
  `https://frameleaf.cloud` apex and the direct names at `frameleaf.net`; every other copied `remote/` and `backup/`
  fixture was checked byte-identical there.
- FL-162 (cloud restoration and Smooth motion jobs): byte-identical to `origin/main` at
  `39488a50b176ea0778ee138d202bc8eda8376a70` (FC-39 broker, FC-42 job storage and FC-43 `JobView.cost`, all
  merged): `ml/job-{queued,running,completed,failed,settled-budget}.json`,
  `ml/rejected/job-view-{cost-above-hold,cost-lines-mismatch,cost-not-charged-total,cost-provider-details,provider-details,unknown-status}.json`,
  every file of `ml/storage/` and `ml/storage/rejected/`, and `errors/{inputs-missing,job-active,job-ended,upload-closed}.json`.
  Every other `ml/` and `errors/` file this app already copied was compared with that commit and is unchanged, and
  every `ml/` and `errors/` fixture is unchanged again at `423d04d` (the storage contract's publication). The
  contracts are `packages/contracts/src/ml/{jobs,storage,gateway}.ts`; `server/src/utils/frameleaf-cloud.ts`
  (`jobViewSchema`, `jobCostSchema`, `uploadTargetSchema`, `jobResultSchema`, and `jobAdmittedSchema.uploads`) reads
  them.

- FL-163 (cloud description batches): every file of `ml/descriptions/` and `ml/descriptions/rejected/` is
  byte-identical to `origin/main` at `62637ca6b77cccf0b68bac2b19c50b14242a6830` (FC-44 descriptions request options
  and result contract, `d17af58`). The contract is `packages/contracts/src/ml/descriptions.ts` (with
  `DescriptionsRequest` in `ml/workloads.ts`); `server/src/utils/frameleaf-cloud.ts` (`CLOUD_WORKLOAD_REQUESTS.descriptions`,
  `descriptionsResultSchema`) sends and reads them. Every other copied `ml/` and `errors/` file was compared with that
  commit (git blob hashes) and is unchanged.

Do not edit these files by hand. When the cloud changes a fixture, copy the new version and update the commit
above.
- FL-166: `remote/relay-token-response.json`, `remote/relay-token-claims.json`, `remote/relay-token-header.json`,
  `remote/relay-candidates.json`, `remote/relay-select-request.json`, `remote/relay-select-response.json`,
  `remote/wan-probe-request.json`, `remote/wan-probe-response.json` and `remote/remote-usage.json` are byte-identical
  to `origin/main` at `62637ca6b77cccf0b68bac2b19c50b14242a6830` (FC-28 relay control plane). The tunnel protocol
  constants in `server/src/utils/frameleaf-relay.ts` mirror `packages/contracts/src/tunnel.ts` on `codex/FC-30-relay`
  at `b223ee8`; `server/test/fixtures/relay.ts` is a Node stand-in for the Go relay (`apps/relay`), and
  `server/test/fixtures/frameleaf-relay/` holds test-only certificates and keys used nowhere else.
- FL-159 / FC-61 (heartbeat settings snapshot and `entitlements.refresh`): `instance/heartbeat-request.json` is
  byte-identical to `origin/main` at `b3f1391b636b041d7baf140c6ec0f12b6832be57` (FC-61 `8d02d5b`, frameleaf-cloud PR #73; it gained
  `entitlements.refresh` in `capabilities` and the `remoteAccessSettings`, `cloudMl`, `cloudBackup` and `licenseState`
  blocks). Every other copied `instance/` file was compared with that commit and is unchanged. The contract is
  `packages/contracts/src/instance/heartbeat.ts` (`RemoteAccessSettings`, `CloudMlSettings`, `CloudBackupSettings`,
  `LicenseState`); `server/src/utils/frameleaf-cloud-settings.ts` builds and checks the blocks.
- CLD-004 / FC-37 (licence link codes): `licence/redeem-link-code-request.json`,
  `licence/redeem-link-code-request-personal.json`, `licence/redeem-link-code-response.json`,
  `errors/link-code-{not-found,expired,used,wrong-account,kind-mismatch,activation-limit,instance-id-taken,rate-limited}.json`,
  `instance/discovery.json` and `instance/discovery-instance.json` (which gained `features.licenseLinkCode` and
  `endpoints.licenseLinkCode`) are byte-identical to `origin/main` at `7a71b2f3eed26d8fd4e59c777bd36c6089c3ad5b`
  (frameleaf-cloud PR #82). `errors/request-invalid.json` was compared with that commit and is unchanged; the cloud
  publishes no fixture for the 403 `forbidden` (licence on hold) answer, so the spec writes that envelope inline. The
  contract is `packages/contracts/src/licence/link-code.ts` and "Licence link codes" in `docs/instance-contract.md`;
  `server/src/services/frameleaf-license.service.ts` (`redeemLinkCode`) sends and reads them.
- FL-159 / FL-162 / FL-163 (CLD-201/202/203), the ML owner decisions of 2026-09-27: `errors/idempotency-in-flight.json`,
  `errors/idempotency-key-missing.json`, `errors/idempotency-key-reused.json` (FC-43, IETF Idempotency-Key draft),
  `ml/catalog-studio.json` (FC-48: English Kokoro voices, RIFE only), and `ml/upscale/` (FC-46: `estimate-request.json`,
  `estimate-response.json` with `upscale {scale, items, lowered}`, `job-request.json`, `job-request-minimal.json`,
  `result.json` and `result-failed-items.json` with per-item `scale`, and every `rejected/result-*.json`) are
  byte-identical to `origin/main` at `bcb5098` (merge of frameleaf-cloud PR #96; git blob hashes compared). Every other
  copied `errors/` and `ml/` file was compared with that commit and is unchanged. The contracts are
  `packages/contracts/src/errors.ts`, `src/ml/{gateway,jobs,upscale,workloads,refusal-table}.ts`;
  `server/src/utils/frameleaf-cloud.ts` reads them and `server/src/utils/frameleaf-cloud-ml-decisions.spec.ts` parses
  every one. The `ml/upscale/rejected/request-*.json` fixtures are not copied: this server declares only the
  `scale`/`items`/`faceRestore`/`output` keys it sends.
- FL-230 / FC-86 (IDN-005, token exchange): `identity/exchange/{jwks,valid,wrong-audience,expired,replayed,plain-id-token,logout-token}.json`
  are byte-identical to `codex/FC-85-86-87-93-native-identity` at `d192f7cfd5676d390092064f7cec2d957c681286`
  (generated by `packages/contracts/scripts/exchange-fixtures.mjs` with a throwaway key; only the public JWKS is kept).
  `server/src/services/frameleaf-auth.service.spec.ts` verifies each at its fixture `now` through
  `POST oauth/frameleaf/exchange` and the back-channel logout verifier. The cloud's `unlinked-server.json` and
  `revoked-access.json` are token-endpoint refusals the app receives; no token reaches this server, so they are not copied.
- FL-301 / FC-91 (NAPI-013, backup plan signal): `instance/heartbeat-response-backup-plan.json`,
  `instance/heartbeat-response-backup-plan-family.json` and `backup/usage-plan-full.json` are byte-identical to
  frameleaf-cloud `916f12a1d787c8b9ef47a3937c6af44028a45d48`. The contract is `BackupPlanSignal` in
  `packages/contracts/src/billing/stores.ts` and `INSTANCE_CAPABILITY_BACKUP_PLAN` in `src/instance/heartbeat.ts`;
  `server/src/utils/frameleaf-cloud-link.ts` reads it and `server/src/services/frameleaf-cloud.service.spec.ts` checks the
  pushes, `server/src/utils/frameleaf-cloud-backup.spec.ts` the `plan_full` reason.

## Published registry receipt: Cloud contracts 0.0.3

The selective 0.0.3 import is pinned by `registry-0.0.3.json`, copied from the verified registry receipt
with per-file SHA256 values from the genuine package. Package `@frameleaf/cloud-contracts` version
0.0.3, registry version ID 1329556226, is Apache-2.0 and restricted on GitHub Packages; this import
adds no runtime dependency or registry credentials. The annotated `contracts-v0.0.3` tag resolves to
`b7e9b37b53392694383ecc69fe4d7f18496d4ac2`. Tarball SHA256:
`23aeee533b7b969473e1a6ab53f1d0299369ea015eb37f85c4cc847cfd194eba`; its registry SHA512 integrity
and SHA1 are retained in the receipt.

Only `instance/discovery.json` and `instance/discovery-instance.json` are refreshed (the published
`endpoints.push` address), plus eleven new `push/` fixtures. Every imported file is byte-identical to
`fixtures/` in that tarball. Other copied files remain unchanged. In particular both heartbeat
backup-plan fixtures and `backup/usage-plan-full.json` were compared byte-for-byte with 0.0.3 and
remain unchanged; their hashes and actual parser assertions are in `frameleaf-cloud-contracts.spec.ts`.

The discovery and push parsers remain Library-owned. Conformance covers actual DPoP request bodies,
API token audience, push proof address, response/error envelopes and local rejection of the published
invalid request. It does not qualify APNs delivery, relay, linked servers, top-ups or provider behavior.

### Earlier package parser compatibility (source-derived)

The genuine registry 0.0.2 tarball has SHA256
`a63d807ea2ad81c046acb223fdc7cf87bf6c8520256edb48b5c226d9b7c8f540`; its registry receipt verifies
SHA1 `44d575f4b6f318d52f97fc7790bcc784acf3a8f7` and SHA512 integrity. Inspection of that package's
compiled `instance/discovery.js` shows `DiscoveryEndpoints = z.strictObject(...)` without a `push`
property. Therefore the unmodified 0.0.2 package parser rejects the new additive `endpoints.push`
field. This is a source-derived compatibility finding, not an executed runtime result. The 0.0.3
package declares `push` optional, preserving discovery documents that omit it.

The Library owns its parser and copied corpus; it does not import either package as a runtime
dependency. Its current conformance covers FC-98's optional discovery push address, explicit
`FRAMELEAF_PUSH_URL` precedence, and all eleven published push fixtures. This packet introduces no
additional FL-293 product question or delivery qualification claim.


## Published identity receipt: Cloud contracts 0.0.3

`identity-0.0.3.json` is a separate selective import receipt for the SAME verified package above:
SHA256 `23aeee533b7b969473e1a6ab53f1d0299369ea015eb37f85c4cc847cfd194eba`, source
`b7e9b37b53392694383ecc69fe4d7f18496d4ac2`, registry version ID 1329556226. It retains the genuine
registry SHA512 integrity, SHA1 and byte count and records each of eight byte-exact fixture hashes.
The existing `registry-0.0.3.json` and its 13-file selection/assertions remain unchanged. No runtime
package dependency or registry credential is introduced. This paragraph supersedes only the earlier
statement that `identity/instance-claims.json` was not copied; historical provenance above is retained.

The eight files are `identity/device-authorization-{request,response}.json`,
`identity/device-token-{request,pending}.json`, `identity/token-request-client-credentials.json`,
`identity/token-response-{instance,link}.json`, and `identity/instance-claims.json`. Actual Library
consumer tests exercise the device authorization/poll/link registration path, signed live instance
client assertions and DPoP, and the cryptographically signed OIDC callback. Illustrative client JWT
bytes are NOT used as a signer: issuer/subject/audience, TTL, fresh JTI and signature are checked using
the real instance key and dynamic configured resource. OIDC issuer/audience and iat/exp are minted by
the existing actual test issuer; the fixture's subject, role, access, email/name and session sid are
consumed by the real callback/account/session path. Existing tests keep the default `fl-sub` unless
claims explicitly supply a string subject. No picture-field enforcement or full-envelope claim.

The exact published `token-response-instance.json` has no `cnf.jkt`. The actual `accessToken` consumer
must reject it and must not cache it; this is NEGATIVE conformance, not positive instance token
qualification. Existing positive bound-token/DPoP controls remain unchanged. The link response is a
temporary registration credential; device/link tokens are tested not to escape public state or remain
in metadata after successful registration.

`identity/oidc-client-metadata.json` is deliberately NOT copied: there is no complete Library builder
or consumer for that registration metadata. Callback/client-assertion tests do not qualify an invented
registration parser, endpoint, or application registration flow. This remains a Cloud-owned integration
gap, as does Cloud's quarterly key publication fix. No production auth weakening or generated API
changes. These are authored source tests pending hosted execution, not deployed identity/provider,
quarterly rotation, native/store or complete product acceptance.
