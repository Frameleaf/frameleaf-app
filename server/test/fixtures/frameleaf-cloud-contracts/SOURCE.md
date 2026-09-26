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
- `licence/check-symbol/` (every file) is byte-identical to `packages/contracts/fixtures/licence/check-symbol/` at
  `8bf5b83ed2a5a4ce22b64f553a6f48ec78768504` (`feat: FC-22 Luhn mod 32 check symbol for licence keys`); see that
  folder's own `SOURCE.md` for what it exercises (FL-182).

Do not edit these files by hand. When the cloud changes a fixture, copy the new version and update the commit
above.
