# FL-41 server and JavaScript contract validation

Issue: [FL-41](https://heroit.atlassian.net/browse/FL-41). Accepted source baseline: `5acd172436a0c8b68d93e51527c5461812511310` on `Frameleaf/frameleaf-app` branch `fork/main`. This receipt covers the server and JavaScript SDK slice; it is not full issue, native, release or deployment acceptance.

## Change

The asset-edit DTO previously parsed parameters through an untagged union before checking the action. An earlier all-optional parameter schema could strip unrelated keys: valid speed edits failed validation, audio volume/mute settings became an empty object, and action defaults were skipped. Request validation now selects the existing discriminated action schema before parsing the parameters. Invalid ranges, unsupported actions and duplicate actions remain rejected. The Nest validation pipe uses the runtime DTO import.

The published request contract retains its original parameter `anyOf` alternatives and action enum. Runtime parsing first preserves the raw parameter object, then validates it against the selected action. Source metadata derives the documented alternatives from the existing parameter schemas; it does not relax runtime validation. After source regeneration, the entire OpenAPI specification and JavaScript client are byte-for-byte identical to the accepted baseline, including all 313 operations, response schemas and required fields.

The first candidate replaced request `anyOf` with an object. Hosted Check OpenAPI run `35585248253`, job `106286958932`, rejected that schema change. The corrected candidate restores the exact existing wire contract without suppressing the check or adding a compatibility-exception label. Both Dart generator patches are also restored byte-for-byte to baseline; there are no mobile changes. Mobile implementation, native compilation, unknown-action support and device qualification remain deferred by the user's September 21 instruction.

## Reproducible checks

- `pnpm --dir server exec vitest --config test/vitest.config.mjs run src/dtos/editing.dto.spec.ts src/services/asset.service.spec.ts`: 87 tests passed, including every supported edit action, action defaults, invalid/unknown input, duplicate rules and the Nest request pipe.
- `pnpm --filter immich check`: full server typecheck passed after explicitly typing the service-test edit fixtures against `AssetEditActionItem`; hosted jobs `106289630751` and `106288637280` had identified enum widening in three fixture uses. Runtime validation was not weakened.
- `pnpm --filter immich build`, then `pnpm --filter immich exec node dist/bin/sync-open-api.js`: passed using Node 24.21.0 and pnpm 11.24.0.
- `oazapfts --optimistic --argumentStyle=object --useEnumType --allSchemas open-api/immich-openapi-specs.json packages/sdk/src/fetch-client.ts` and `pnpm --filter @immich/sdk build`: passed.
- `pnpm --filter @immich/sdk test`: three checks passed for all operation exports, real generated JSON serialization/deserialization of future action names with nested arrays/expressions/nulls, and byte-preserving multipart asset upload. The JSON fixture also verifies unknown sibling fields and explicit nulls on response/edit objects, and preserves omitted optional speed `startMs`/`endMs` parameters through read and write. The transport uses injected responses; it does not claim that the server executes unsupported actions. The upload check inspects the generated FormData bytes and filename, not a live HTTP upload or raw binary importer body.
- `pnpm --dir server exec eslint src/dtos/editing.dto.ts src/dtos/editing.dto.spec.ts --max-warnings 0`: passed.
- `cd open-api && bash bin/generate-dart-sdk.sh`: unchanged source generator patches apply successfully; this does not qualify a native application.

The host's mise 2026.5.16 cannot run the repository's newer monorepo task syntax. The declared generation/build commands were executed explicitly through `mise exec`; repository toolchain settings were not changed. Current-candidate hosted gates remain CI responsibilities. The branch incorporates default commit `a3b0cae7e785e31339353ad9b0a55cfb10d03f56`, which removes mobile CI under the user's instruction; it does not restore those gates. The existing fork integration workflow now executes the SDK transport checks after regeneration and build.

## Server E2E diagnostic capture

An API-test connection failure does not establish why a server exited or became unreachable. The server E2E workflow now captures timestamped Compose logs and only Docker container Name, State and RestartCount immediately after API/CLI tests, before maintenance tests can change container state. The separate `docker-diagnostics-after-api-tests.txt` artifact complements the existing later Compose logs. Collection is best-effort and runs after failed tests; it does not weaken the test result. No full container configuration, environment or host/kernel inventory is collected. This is diagnosis instrumentation, not a runtime fix or a claim that OOM caused the failure. A narrow workflow contract verifies ordering, selected fields and artifact retention.

## Remaining acceptance

The initial candidate and wire-contract correction received independent review with no P0/P1/P2 findings; the reviewed runtime candidate is `5bbab9b44aaf9434ff77d24bcfa813d76f20666b`. The later fixture typing and approved mobile CI baseline integration do not change runtime behavior. New current-head GitHub Actions remain required before this slice is ready for merge. There is no merge, publication or deployment authorization in this work. Jira remains In Progress.

Studio/project graph and binary importer APIs are absent from this accepted baseline. The nested edit-parameter transport fixture is not a substitute for testing those production APIs when their owning implementation is accepted. Do not invent new endpoints or mark their wider acceptance complete. Dart and other mobile work remain deferred by the user.
