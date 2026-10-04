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
