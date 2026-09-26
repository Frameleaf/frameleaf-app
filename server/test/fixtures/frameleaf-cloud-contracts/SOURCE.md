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

Do not edit these files by hand. When the cloud changes a fixture, copy the new version and update the commit
above.
