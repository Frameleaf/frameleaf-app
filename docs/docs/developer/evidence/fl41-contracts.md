# FL-41 server and JavaScript contract validation

Issue: [FL-41](https://heroit.atlassian.net/browse/FL-41). Accepted source baseline: `5acd172436a0c8b68d93e51527c5461812511310` on `Frameleaf/frameleaf-app` branch `fork/main`. This receipt covers the server and JavaScript SDK slice; it is not full issue, native, release or deployment acceptance.

## Change

The asset-edit DTO previously parsed parameters through an untagged union before checking the action. An earlier all-optional parameter schema could strip unrelated keys: valid speed edits failed validation, audio volume/mute settings became an empty object, and action defaults were skipped. Request validation now selects the existing discriminated action schema before parsing the parameters. Invalid ranges, unsupported actions and duplicate actions remain rejected. The Nest validation pipe uses the runtime DTO import.

The generated request contract keeps the existing action enum and accepts an opaque parameter object, which the server validates against that action. Every response schema, schema name, required-key list and all 313 operations remain unchanged against the exact baseline. The OpenAPI specification and JavaScript client were regenerated from the DTO; generated sources were not hand-edited.

Two existing Dart generator patches were adjusted only to match the new generated request-map and response-parameter type names. They preserve the previous dynamic-map behavior and keep the existing generation gate reproducible. This is maintenance required by the server contract change, not mobile implementation. Mobile features, native compilation, unknown-action support and device qualification are deferred by the user's September 21 instruction.

## Reproducible checks

- `pnpm --dir server exec vitest --config test/vitest.config.mjs run src/dtos/editing.dto.spec.ts src/services/asset.service.spec.ts`: 87 tests passed, including every supported edit action, action defaults, invalid/unknown input, duplicate rules and the Nest request pipe.
- `pnpm --filter immich build`, then `pnpm --filter immich exec node dist/bin/sync-open-api.js`: passed using Node 24.21.0 and pnpm 11.24.0.
- `oazapfts --optimistic --argumentStyle=object --useEnumType --allSchemas open-api/immich-openapi-specs.json packages/sdk/src/fetch-client.ts` and `pnpm --filter @immich/sdk build`: passed.
- `pnpm --filter @immich/sdk test`: three checks passed for all operation exports, real generated JSON serialization/deserialization of future action names with nested arrays/expressions/nulls, and byte-preserving multipart asset upload. The transport uses injected responses; it does not claim that the server executes unsupported actions.
- `pnpm --dir server exec eslint src/dtos/editing.dto.ts src/dtos/editing.dto.spec.ts --max-warnings 0`: passed.
- `cd open-api && bash bin/generate-dart-sdk.sh`: source generator patches apply successfully; this does not qualify a native application.

The host's mise 2026.5.16 cannot run the repository's newer monorepo task syntax. The declared generation/build commands were executed explicitly through `mise exec`; repository toolchain settings were not changed. The full `mise run //:open-api` aggregate and current-candidate hosted gates remain CI responsibilities. The existing fork integration workflow now executes the SDK transport checks after regeneration and build.

## Remaining acceptance

Independent review and current-head GitHub Actions remain required before this slice is ready for merge. There is no merge, publication or deployment authorization in this work. Jira remains In Progress.

Studio/project graph and binary importer APIs are absent from this accepted baseline. The nested edit-parameter transport fixture is not a substitute for testing those production APIs when their owning implementation is accepted. Do not invent new endpoints or mark their wider acceptance complete. Dart and other mobile work remain deferred by the user.
