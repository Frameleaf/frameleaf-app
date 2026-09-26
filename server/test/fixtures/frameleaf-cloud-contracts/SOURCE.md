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
- `ml/` and `ml/rejected/` (every file, FL-181): `codex/FC-66-api-protection` at
  `44311b822d94c8cd9a2cc95cd4bcde79e54902b4` (Frameleaf/frameleaf-cloud#19). These fixtures use the FC-66
  `packages/contracts/src/ml/gateway.ts` shape (`sku`, `computeSku`, `rev`, `rate`, `eta`, …), which is not
  yet what `server/src/utils/frameleaf-cloud.ts`'s `catalogSchema`/`usageSchema` parse field-for-field; FL-181
  only reads each fixture's `workload` (and, where present, `mode`) string to test the workload ID mapping,
  not the full catalogue/estimate/job schema. A later story should reconcile the rest of the shape.

Do not edit these files by hand. When the cloud changes a fixture, copy the new version and update the commit
above.
