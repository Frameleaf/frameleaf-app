# Library ML Lifecycle Candidate

This dedicated suite drives `FrameleafCloudMlRepository` and `FrameleafCloudRepository` over loopback HTTP with real input and output files. It mounts the additive Cloud testing export's `createRecordedMlLifecycleServer.request/transfer` and delegates lifecycle verdicts to `runMlLifecycleCases`. It does not use the package's recorded client. The default unit config selects only `src/**/*.spec.ts`, so it does not require this testing export.

From `server`, qualify the immutable registry package supplied by the integration owner:

```sh
FRAMELEAF_CLOUD_LIFECYCLE_TGZ="$CONTRACTS_REGISTRY_ARCHIVE" \
FRAMELEAF_CLOUD_LIFECYCLE_NODE_MODULES="$CONTRACTS_DEPENDENCIES" \
node test/lifecycle/run-installed-package.mjs
```

CI must provision the archive and its compatible installed dependencies before this command. `contracts-package-receipt.json` pins the exact registry bytes with SHA-256, SHA-512 integrity, length, package identity and source provenance. The launcher verifies the archive buffer, sends that same buffer to tar over stdin, checks the supplied Zod version against the package dependency, runs the dedicated suite and removes the extraction. Tar never reopens the source archive path. The launcher performs no network access or dependency installation. No archive or machine-specific path is tracked. Source provenance is the integration owner's receipt; it is not inferred from the package version.

For preparation against a compiled source package, use:

```sh
FRAMELEAF_CLOUD_LIFECYCLE_TEST_MODULE="$COMPILED_CONTRACTS_TESTING_ENTRYPOINT" \
./node_modules/.bin/vitest run --config test/vitest.config.lifecycle.mjs test/lifecycle/frameleaf-cloud-lifecycle.spec.ts
```

The entrypoint must be the compiled `dist/testing/index.js` with its package fixtures and dependencies available. Missing or incompatible paths fail explicitly, without skipping tests. This path alone qualifies source behavior, not registry bytes; only the receipt-verifying launcher qualifies the immutable supplied archive.

Eight positive lifecycle cases and five negative controls exercise actual client requests. Multipart resume first sends part 1 from the file and attempts an incomplete completion, then refreshes and resumes with the saved ETag. Part 1 uses `0x07` bytes and part 2 uses `[0x11,0x22,0x33,0x44,0x55]`, so an offset-zero read changes the reconstructed digest. A negative control replaces the second range in the actual resumed file with the first range's prefix and requires the shared runner's digest failure.

For `corrupt-output`, the recorded store stays healthy. The HTTP bridge flips one byte in its successful output response without changing the declared or delivered length. It captures the resulting response bytes in its own wire-transfer recorder before sending them to the actual download client. The adapter reads the Cloud snapshot unchanged for HTTP, journal, hold and object observations and supplies the bridge's already-recorded storage observations to the shared runner. Neither snapshots nor shared verdicts are modified after recording. The client must refuse the same-length response with `sha256-mismatch`, and its destination must be absent before observations return.

The HTTP storage bridge decodes XML `&quot;` entities before passing ETag text to the recorded transport, which expects parsed text. Observations stay in memory; failures contain only fixed messages. Archive mutation controls run the real tar after replacing only a temporary archive copy at the verification/extraction boundary, and independently require rejection of same-length byte tampering and wrong SHA-512 integrity. Running these extraction controls requires the supplied immutable archive; the source-preparation command above selects only the client lifecycle file.

Acceptance limits:

- Retry-After tests check real repository header parsing and server receipt timestamps on the fixture clock. Manual clock advancement does not qualify production scheduling. The dedicated suite also checks `cloudMlJobBackoffMs`, but does not exercise `CloudMlJobService.wait` or durable `mediaOperationRepository.requeue` scheduling.
- Worker completion, hold/journal rows and object inventories are recorded fixture controls. They do not qualify a deployed worker, ledger or object store.
- Repeated terminal reads exercise the actual client. The recorded fixture rejects a second `finish()` after terminal status, so worker settlement replay itself remains unsupported. Duplicate-capture fixture injection is rejected by the shared runner.
- This is a bounded candidate against the current worktree. Integration against a newer head and its service scheduler regressions belongs to the integration owner.

## FC98 Push and Discovery

`frameleaf-cloud-push.spec.ts` loads the supplied package's actual `fixture` export through the same `loadLifecycleTestingApi()` compiled-path loader as the ML lifecycle suite. It uses both unmodified published discovery documents to check the push address, then relocates only fixture addresses to loopback for actual `FrameleafCloudRepository.discovery` and `FrameleafCloudPushRepository.target/send` calls. Discovery fallback uses the named `/push` base on the Cloud listener because discovery validation requires matching ports on loopback. Environment overrides use a distinct listener that shares the fixture token store with the identity listener. Actual instance signing and the existing fake gateway's signature, token binding, method, address and nonce checks remain active.

The suite checks `FRAMELEAF_PUSH_URL` parsing and override precedence, discovery fallback, override without discovery push, and absent push without token issuance or an API-host send. All ten valid-request published exchanges cover sent, invalid-token, throttled, retry, Live Activity and error handling; their bodies, status and headers are served directly from the supplied package. Negative controls refuse the published invalid request before push HTTP, malformed success/retry/error responses, and require a fresh signed proof after a nonce challenge.

Run the receipt-verifying installed-package launcher above for immutable archive qualification. To select only this spec against an already extracted compiled package, use the source-preparation command above with `test/lifecycle/frameleaf-cloud-push.spec.ts` as the file argument. This requires the compiled testing entrypoint and compatible package dependencies; an alias is not required. The suite qualifies the consumer over local HTTP, not a deployed Cloud push provider, delivery scheduling, device invalidation or mobile receipt. Existing vendored fixtures are preserved.

A separate local compatibility probe found the existing 0.0.2 archive and matched its SHA-256 (`a63d807ea2ad81c046acb223fdc7cf87bf6c8520256edb48b5c226d9b7c8f540`) and SHA-512 to its local receipt before buffer extraction. With Zod 4.6.5, that archive's actual `ServicesDocument` and `InstanceDiscovery` parsers each reject the corresponding unmodified 0.0.5 discovery fixture solely for `endpoints.push` (`unrecognized_keys`). Backward strict-parser compatibility therefore fails; this is separate from the 0.0.3 InstanceSummary issue. The dedicated suite does not provision or bind the older artifact, so a repeatable hosted compatibility control remains outside this consumer spec.

## Hosted Qualification

The existing `test.yml` manual dispatch accepts `candidate_sha` for this qualification only. Dispatch on `master/frameleaf-implementation` with its full reviewed commit SHA. A checkout-free job with empty permissions fails invalid requests; ordinary PR/push tests and blank-input dispatches retain their normal behavior. The reusable `frameleaf-cloud-consumers.yml` retrieves registry version 0.0.5 with only `packages: read`, verifies the pinned length and digests without checking out App source, and transfers only the archive. A separate `contents: read` job checks out that exact commit, builds the required SDKs, installs Zod 4.6.5 from `dependencies/package-lock.json` with scripts disabled, re-verifies the archive, and runs the combined ML/archive and FC98 suite plus existing consumer regressions. Both jobs clean temporary package files; the launcher removes its extraction in `finally`.

The only registry credential is the retrieval job's built-in `GITHUB_TOKEN`. The `Frameleaf/cloud-contracts` package must grant the `Frameleaf/frameleaf-app` repository Actions read access. A denied registry request is an access blocker, not permission to inject a PAT into consumer execution. No Cloud publisher action, package republish, deployment or main merge is part of this workflow.
