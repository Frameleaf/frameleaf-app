# FL-285 server acceptance

Audited integration base: `d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9`.

| Requirement                                   | Committed behavior / check                                                                                                                                                                                                                                        | Qualification boundary                                                                                                                                |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Incomplete upload survives restart            | PostgreSQL stores resource offset and immutable part paths. The existing relay/stripping-proxy transport tests recreate only the owned API after a seven-byte prefix, then HEAD/PATCH verify exact resume, digest, stored original, quota and single publication. | The transport lane must pass on the integrated head. Same-image recreation proves restart; a different-image upgrade needs a separately recorded run. |
| Upload-Limit follows the writable volume      | OPTIONS probes the existing disk-usage helper. Creation persists a ceiling of at most half the available bytes, allowing for immutable parts plus assembly. 104/POST/HEAD use that resource ceiling.                                                              | This is a capacity snapshot, not a reservation across concurrent writers. Later exhaustion is retryable.                                              |
| Low-space append preserves acknowledged bytes | Declared appends require space for remaining parts plus full assembly. ENOSPC/EDQUOT return 507 without advancing the failed attempt's offset. Unit checks recreate the service and verify retry/single publication.                                              | Service recreation uses a repository harness; it does not qualify a server process or database restart.                                               |
| Real volume exhaustion                        | The opt-in test below fills a disposable bounded filesystem, checks 507 and an unchanged prefix/manifest, then appends successfully after failed scratch cleanup.                                                                                                 | Record the filesystem, platform and test output. Local HFS evidence does not qualify Linux NAS filesystems.                                           |
| Real native producer/device evidence          | Excluded from this server packet; remains in FL-260/FL-261 and FL-285's device residue.                                                                                                                                                                           | No device, relay/device digest or device Live Photo qualification is claimed.                                                                         |

## Focused server checks

From `server/`, with normal workspace dependencies installed:

```sh
pnpm exec vitest run --maxWorkers 1 --config test/vitest.config.mjs \
  src/services/asset-upload-storage.spec.ts \
  src/services/asset-upload-resource.service.spec.ts \
  src/controllers/asset-upload-resource.controller.spec.ts \
  src/repositories/asset-upload-resource.repository.spec.ts \
  src/utils/asset-upload-resource.spec.ts
```

For the real exhaustion check, set `FL285_VOLUME_FOLDER` to an **owned, empty,
disposable filesystem** with more than 1 MiB and at most 32 MiB available.
The check writes up to 64 MiB within a unique temporary subdirectory and removes
only that subdirectory. Never point it at a production share.

The existing Linux server unit lane mounts an owned 32 MiB tmpfs and sets this
variable for `ci-unit`, then unmounts it on exit. Its integrated-head result is
the Linux filesystem gate; the local HFS run alone does not satisfy it.

## Restart recording

The existing upload transport CI step sets `FL285_RESTART_OWNED_FIXTURE=true`
and retains its existing Docker diagnostics. The fixed restart command recreates
only `immich-server` in `e2e/docker-compose.yml` plus its upload transport overlay,
with `--no-deps`, without renewing anonymous media volumes. PostgreSQL is retained.
The tests verify recovery through both relay and stripping-proxy listeners.

For an upgrade, first create an incomplete resource using the old image, record
its image digest/offset/Upload-Limit, recreate only that owned API using the new
image while retaining media and PostgreSQL, then record HEAD/PATCH, original
SHA-256, quota and replay assertions. A same-image restart or a service harness
must not be reported as a different-image upgrade.

Do not close the remaining qualification gates from a source review or unit pass.
