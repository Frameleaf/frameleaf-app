Golden fixtures copied unchanged from the Frameleaf Cloud contracts package, so the server's parsers are
tested against what the cloud publishes (FL-177).

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
  `origin/main` at `517cbd3da9e20b9248c4b975bf3a400a2bce37d1` (Frameleaf/frameleaf-cloud#54, which reads the app's
  real `frameleaf-v<semver>-<sequence>` tags; first copied from #43 at `86adf20`). The contract is
  `packages/contracts/src/releases/latest.ts`; `server/src/utils/frameleaf-release.ts` reads them (FL-192).
- FL-164 managed backup (BAK-001 FC-33, BAK-002 FC-38): `backup/grant-response.json`,
  `backup/grant-rotate-response.json`, `backup/grant-metadata.json`, `backup/usage.json`, `backup/escrow-blob.json`,
  `backup/escrow-record.json`, `backup/run-report.json` and `backup/settings.json`, and the backup refusals
  `errors/grant-revoked.json`, `errors/clone-suspected.json`, `errors/escrow-not-allowed.json`,
  `errors/rate-limited.json` and `errors/region-unavailable.json`, are byte-identical to `origin/main` at
  `39488a50b176ea0778ee138d202bc8eda8376a70` (merge of Frameleaf/frameleaf-cloud#51). The contracts are
  `packages/contracts/src/backup/{grant,usage,escrow,runs}.ts`; `server/src/utils/frameleaf-cloud-backup.ts` reads
  them, and `errors/entitlement-missing.json` was checked byte-identical at that commit. Not copied, because nothing
  here parses them yet: `backup/purge.json`, `backup/run-list.json` and `errors/purge-not-cancellable.json` (a
  purge is started from the Frameleaf account).
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
