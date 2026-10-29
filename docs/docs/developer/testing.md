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

## Container images and mirrors

Building Frameleaf's Postgres image (`docker/postgres`) pulls the PostgreSQL base image from Docker Hub and downloads the pgvector source from `codeload.github.com` (checked against a pinned SHA-256). Docker Hub rate-limits anonymous pulls, so a busy machine or network can hit `toomanyrequests` errors. CI avoids this with Google's Docker Hub mirror, and you can do the same locally:

| What                                          | Setting                                                                                                                                                          |
| :-------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres base image (medium tests, e2e stack) | `export FRAMELEAF_CI_POSTGRES_IMAGE=mirror.gcr.io/library/postgres@sha256:4c618d9a30e0b88078b9371a0499d7055da9ab7f5afe386a460758eac9857f06`                      |
| Postgres base image (manual build)            | `docker build --build-arg POSTGRES_IMAGE=mirror.gcr.io/library/postgres@sha256:4c618d9a30e0b88078b9371a0499d7055da9ab7f5afe386a460758eac9857f06 docker/postgres` |
| testcontainers reaper (Ryuk)                  | `export RYUK_CONTAINER_IMAGE=mirror.gcr.io/testcontainers/ryuk@sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0`                          |
| Any other Docker Hub image                    | Add `"registry-mirrors": ["https://mirror.gcr.io"]` to the Docker daemon settings (Docker Desktop: Settings → Docker Engine)                                     |

The digests match the ones pinned in `docker/postgres/Dockerfile` and `.github/workflows/test.yml`; use the values from those files if they have changed since this page was written.

To skip the pgvector download entirely, use the published image instead of building one. `docker/postgres/image-lock.json` names the current image and digest (for example `ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7`); pull it and tag it with the name the stack expects, such as `docker tag ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7 frameleaf-postgres:local` for `docker/docker-compose.dev.yml`. Compose and testcontainers still rebuild when the source changes, so only do this when your branch does not change `docker/postgres`.

## Memory for server checks

A full server type check (`pnpm --dir server check`), `nest build` (`pnpm --dir server build`) and the type-aware lint (`pnpm --dir server lint`) each need more than the Node.js default heap. The package scripts raise the limit to 12 GB with `--max-old-space-size`, which fits a machine with 15 GB of memory when only one of them runs at a time. To use a different limit, set it yourself, for example `NODE_OPTIONS=--max-old-space-size=10240 pnpm --dir server check`; your value wins over the script default.
