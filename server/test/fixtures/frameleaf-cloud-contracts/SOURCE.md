Golden fixtures copied unchanged from the Frameleaf Cloud contracts package, so the server's parsers are
tested against what the cloud publishes (FL-177).

- Repository: `Frameleaf/frameleaf-cloud`
- Path: `packages/contracts/fixtures/` (`errors/` and `instance/`, every file)
- Branch and commit: `codex/FC-19-heartbeat` at `383f815ad474e369d16d4f62eb5eef077e9dc135` (Frameleaf/frameleaf-cloud#9, final);
  against `89654126c3f54ee89444c8f2b0c0efb3c03b4e66` only `instance/discovery.json` and
  `instance/discovery-instance.json` changed (they gained `store`)
- The FC-18 files (`errors/insufficient-credits.json`, `errors/use-dpop-nonce.json`,
  `instance/register-request.json`, `instance/register-response.json`) are byte-identical to `codex/FC-18-instances`
  at `3c7a87ee75b76bbada72c031d36738f301db6cfa`.
- `ml/` and `ml/rejected/` (every file): FL-183 copied them from the FC-34 pull request branch, **not
  `main`**: `codex/FC-34-ml-gateway` at `89fb079f2a2dd7f82bd01c15b7609e2068cd09d6`
  (Frameleaf/frameleaf-cloud#29, open and unmerged when copied on 2026-09-26). Every file is byte-identical to
  that commit (git blob hashes compared). Against the FL-181 copy (`codex/FC-66-api-protection` at
  `44311b822d94c8cd9a2cc95cd4bcde79e54902b4`), `ml/catalog-restoration.json` is replaced by the cloud's own
  fixture, and new are `capabilities.json`, `capabilities-not-ready.json`, `hardware.json`, `wallet.json`,
  `consent-current.json`, `consent-record-request.json`, `consent-recorded.json`, `job-admitted.json` and
  `rejected/catalog-entry-{mode-on-descriptions,non-commercial-licence,restoration-without-mode}.json` and
  `rejected/consent-record-{email,ocr-addon}.json`; every other `ml/` file is unchanged. The server's
  production schemas in `server/src/utils/frameleaf-cloud.ts` parse every answer fixture field for field,
  check every request fixture before it would be sent, and refuse every `ml/rejected/` fixture (FL-183).
- `errors/` (FL-183): `capacity.json`, `consent-missing.json`, `consent-version-outdated.json`, `daily-cap.json`,
  `entitlement-missing.json`, `estimate-used.json`, `ml-rate-limited.json` and `region-mismatch.json` are
  byte-identical to the same FC-34 commit `89fb079f2a2dd7f82bd01c15b7609e2068cd09d6`. The wallet top-up
  envelopes (`balance-cap.json`, `top-up-minimum.json`) belong to the account API and are not copied.
- FL-183 review round (2026-09-26): `origin/codex/FC-34-ml-gateway` at `568ea686b77cb4cec24d0f96f2e64ee00f99ed64`
  changes no `ml/` or ML `errors/` fixture against `89fb079f2a`, and does not yet carry the default-model fixtures
  (`ml/catalog-descriptions.json`, `ml/rejected/catalog-two-defaults.json`, the updated `ml/catalog-restoration.json`).
  The default-model specs build their catalogues inline from the published entries until those land; copy them
  byte-identically then and record the commit here.
- Re-check when FC-34 merges: if Frameleaf/frameleaf-cloud#29 lands on `main` with any of these files changed,
  copy the `main` version and record that commit here.
- `licence/check-symbol/` (every file) is byte-identical to `packages/contracts/fixtures/licence/check-symbol/` at
  `8bf5b83ed2a5a4ce22b64f553a6f48ec78768504` (`feat: FC-22 Luhn mod 32 check symbol for licence keys`); see that
  folder's own `SOURCE.md` for what it exercises (FL-182).
- FL-184: refreshed `errors/` and `instance/` against `origin/main` at `4658c6a72e274512a935fff73cee142163ff9635`
  (merges FC-19 `2042045`, FC-66 `57c7170` and FC-22 `4658c6a`, all final). The FC-19/FC-18 files above and
  `ml/`, `ml/rejected/` and `licence/check-symbol/` were verified byte-identical to this commit; nothing in
  them changed. New at this commit: `exchanges/` (every file: `token-dpop`, `token-use-dpop-nonce`,
  `token-invalid-dpop-proof`, `token-clone-suspected`, `api-use-dpop-nonce`, `api-invalid-dpop-proof`,
  `api-bearer-refused`), `instance/dpop-proof-token.json`, `instance/dpop-proof-api.json`,
  `instance/token-response-dpop.json` (FL-178), the new `errors/` files (`invalid-dpop-proof`,
  `estimate-mismatch`, `request-invalid`, `license-not-found`, `activation-limit`, `activation-rate-limited`),
  and all of `licence/` except `licence/check-symbol/` (already copied for FL-182 and byte-identical): the
  keys document, certificate claims and verdict cases (`certificates/`), activation request/response
  including `activation-jose.json` and its `-kid-mismatch`/`-jkt-mismatch`/`-missing-jwk` variants, the
  offline activation request, refresh, deactivate and entitlements (FL-177).

Do not edit these files by hand. When the cloud changes a fixture, copy the new version and update the commit
above.
