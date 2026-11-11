# Testing

## Server

### Unit tests

Unit tests are run with `mise //server:test`.
You need to run `mise //server:install` before _once_.

### End to end tests

The e2e tests can be run by first starting up a test production environment via:

```bash
mise e2e
```

Before you can run the tests, you need to run the following commands _once_:

- `mise //e2e:ci-setup` (installs e2e, SDK, and CLI dependencies)
- `mise //:open-api`

Once the test environment is running, the e2e tests can be run via:

```bash
mise //e2e:test
```

The tests check various things including:

- Authentication and authorization
- Query param, body, and url validation
- Response codes
- Thumbnail generation
- Metadata extraction
- Library scanning

### Medium tests

Medium tests (`server/test/medium`) run against a real PostgreSQL container started by [testcontainers](https://testcontainers.com). Run them with `pnpm --dir server test:medium`. The global setup builds `frameleaf-postgres:medium` from `docker/postgres`, runs the migrations once and stops and removes the container when the run finishes, so no Postgres containers are left behind.

### Format matrix

`server/test/fixtures/formats/manifest.json` lists a fixture for every file format and says what the server should make of it: whether it decodes, on which decoder rung, at what size, and what the integrity check answers. `verify-formats.mjs` runs each one through the server's own decode entry points, and `verify-decoders.mjs` checks that the image still has every decoder the list relies on. Both run inside a built server image. This builds the one CI uses (a full `frameleaf-server` image works too):

```bash
bash scripts/checkout-test-assets.sh
sh server/test/fixtures/formats/fetch-fate.sh /tmp/fate # FFmpeg samples with no stated licence, checked against pinned hashes
docker build --target native-raw-validation -f server/Dockerfile -t frameleaf-native-raw:formats .
run() { docker run --rm --network none --entrypoint node \
  -v "$PWD/server/base-image:/harness:ro" -v "$PWD/server/test/fixtures/formats:/fixtures/generated:ro" \
  -v "$PWD/e2e/test-assets:/fixtures/test-assets:ro" -v "$PWD/server/resources:/fixtures/resources:ro" -v /tmp/fate:/fixtures/fate:ro \
  frameleaf-native-raw:formats "$@"; }
run /harness/verify-decoders.mjs
run /harness/verify-formats.mjs /fixtures/generated/manifest.json \
  generated=/fixtures/generated test-assets=/fixtures/test-assets resources=/fixtures/resources fate=/fixtures/fate
```

Fixtures whose root is left off the command line are not run, and the summary names the roots it skipped. Add `--actual` to print what the image does with each fixture today. A fixture that lands before its fix carries `expectedFailure` with the reason and `failsOn` with the keys that differ today; update or remove them as the fix lands, because a marked fixture that passes, or fails on other keys, fails the run. In CI the same two commands run from the manual `Frameleaf quality` dispatch with `raw_engine=formats`. `SOURCES.md` beside the manifest says where each fixture comes from.

### Known-bad file corpus

`server/test/fixtures/known-bad-corpus.json` lists awkward and broken files (HEIC variants, HDR stills and video, `hvc1` and `hev1` HEVC, a truncated MP4, odd EXIF, a 72 MP panorama, RAW edge cases) with what each processing step should do with them. The medium suite `server/test/medium/specs/corpus/known-bad-corpus.spec.ts` runs every file through metadata extraction, thumbnail generation and, for videos, the playback encode, retries a failing step the way the queue does, and compares the result with the manifest: `ok`, `skipped`, `library-care`, `set-aside` (with the stored cause) or `failed`, plus any dates, time zone, sizes and codecs the entry pins. A difference fails the run with one line per changed fact.

The `Known-bad file corpus` workflow runs it on every pull request that changes the media pipeline (metadata, thumbnails, video encoding, file types, the server image or the corpus itself; the list is the workflow's `paths`), and from the Actions tab for any branch. Its `known-bad-corpus-report` artifact holds `known-bad-corpus-diff.md` and `known-bad-corpus-actual.json`, what every step did for every file. `mise run //server:corpus` runs it locally; the decoders are the medium runner image's, so for results that match CI build that image (`docker build --target medium-test -f server/Dockerfile .`) and run it with `FRAMELEAF_MEDIUM_SUITE=corpus` and the mounts the workflow uses.

To add a file: the fixture repositories are public, so use only a file with a clear licence (CC0, public domain, a permissive licence) or one generated from a test pattern (`server/test/fixtures/known-bad/generate.sh`). Add an entry with `file`, `root` (`test-assets` or `fixtures`), `type`, `note`, `source`, `licence`, `reproduces` and an `outcome` for each step, run the suite, check what `known-bad-corpus-actual.json` says for the new file, and copy the facts worth pinning into its `expect`.

## Container images and mirrors

Building Frameleaf's Postgres image (`docker/postgres`) pulls the PostgreSQL base image from Docker Hub and downloads the pgvector source from `codeload.github.com` (checked against a pinned SHA-256). Docker Hub rate-limits anonymous pulls, so a busy machine or network can hit `toomanyrequests` errors. CI avoids this with Google's Docker Hub mirror, and you can do the same locally:

| What                                          | Setting                                                                                                                                                          |
| :-------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres base image (medium tests, e2e stack) | `export FRAMELEAF_CI_POSTGRES_IMAGE=mirror.gcr.io/library/postgres@sha256:e698169ffdd3c23af2a1675d30f48eeab6883fb277bf5be6911ceac5cfaf760f`                      |
| Postgres base image (manual build)            | `docker build --build-arg POSTGRES_IMAGE=mirror.gcr.io/library/postgres@sha256:e698169ffdd3c23af2a1675d30f48eeab6883fb277bf5be6911ceac5cfaf760f docker/postgres` |
| testcontainers reaper (Ryuk)                  | `export RYUK_CONTAINER_IMAGE=mirror.gcr.io/testcontainers/ryuk@sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0`                          |
| Any other Docker Hub image                    | Add `"registry-mirrors": ["https://mirror.gcr.io"]` to the Docker daemon settings (Docker Desktop: Settings → Docker Engine)                                     |

The digests match the ones pinned in `docker/postgres/Dockerfile` and `.github/workflows/test.yml`; use the values from those files if they have changed since this page was written.

For the Compose stacks you can skip the pgvector download entirely by using the published image instead of building one. `docker/postgres/image-lock.json` names the current image and digest (for example `ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7`). Pull it and tag it with the name the stack expects: `frameleaf-postgres:local` for `docker/docker-compose.dev.yml`, or `frameleaf-postgres:e2e` for `e2e/docker-compose.yml`. Compose then uses the tagged image and builds only when you pass `--build`, so do this only when your branch does not change `docker/postgres`. Medium tests always build `frameleaf-postgres:medium` from `docker/postgres` (Docker's layer cache makes later runs fast), so for them only the base-image mirror (`FRAMELEAF_CI_POSTGRES_IMAGE` above) applies; the first build still downloads pgvector.

## Memory for server checks

A full server type check (`pnpm --dir server check`), `nest build` (`pnpm --dir server build`) and the type-aware lint (`pnpm --dir server lint`) each need more than the Node.js default heap. The package scripts raise the limit to 12 GB with `--max-old-space-size`, which fits a machine with 15 GB of memory when only one of them runs at a time. To use a different limit, set it yourself, for example `NODE_OPTIONS=--max-old-space-size=10240 pnpm --dir server check`; your value wins over the script default.
