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

Do not edit these files by hand. When the cloud changes a fixture, copy the new version and update the commit
above.
