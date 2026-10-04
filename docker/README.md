# Frameleaf containers

Install from a [published Frameleaf release](https://github.com/Frameleaf/frameleaf-app/releases), using its Compose files and environment example together. Files from a development checkout can differ from a published release.

| Component        | Container image                                |
| ---------------- | ---------------------------------------------- |
| Server and web   | `ghcr.io/frameleaf/frameleaf-server`           |
| Machine learning | `ghcr.io/frameleaf/frameleaf-machine-learning` |
| Database         | `ghcr.io/frameleaf/frameleaf-postgres`         |

Release bundles pin `FRAMELEAF_VERSION` to their version. The `release` and `latest` tags follow stable releases; `edge` follows development builds. Hardware variants append `-cuda`, `-openvino`, `-armnn`, `-rknn` or `-rocm` to the selected ML tag. For example, the stable CUDA image is `ghcr.io/frameleaf/frameleaf-machine-learning:release-cuda`. Select the matching hardware configuration and platform; a tag does not prove a particular GPU or model is supported.

The release includes `docker-compose.yml`, `docker-compose.rootless.yml`, `example.env`, `hwaccel.ml.yml` and `hwaccel.transcoding.yml`. Use the regular **or** rootless Compose file. Copy `example.env` to `.env` only for a new installation. Read the [installation steps](../docs/docs/install/docker-compose.mdx) and review the release notes before starting or upgrading.

## Existing installations

For an existing canonical Frameleaf installation, changing application images does not require moving media or recreating the database. An Immich database requires a separate offline import into a fresh destination. Preserve the existing Compose project name, `.env`, upload/database paths, volume names, external-library mounts and database settings. Keep the existing stack directory: relative host paths are resolved from the Compose files. Do not start a second stack against the same PostgreSQL directory, and do not use `docker compose down --volumes` during this migration.

Service keys (`immich-server`, `immich-machine-learning`, `database`), the project name `immich` and the ML address `http://immich-machine-learning:3003` are retained for compatibility. Frameleaf's environment variables are named `FRAMELEAF_*` (for example `FRAMELEAF_VERSION` and `FRAMELEAF_LOG_LEVEL`); the `IMMICH_*` names in an existing `.env` keep working as deprecated aliases, and the server logs one warning listing them with their new names. Setting an old and a new name to different values stops the server, which names the pair. The `immich-admin` and `immich-healthcheck` commands remain as aliases of `frameleaf-admin` and `frameleaf-healthcheck`. Existing project overrides remain valid. Displayed container names become `frameleaf_server`, `frameleaf_machine_learning`, `frameleaf_postgres`; update external scripts that address a container by its old name. Prefer service-based commands, which work across both names:

```sh
docker compose config --images
docker compose pull
docker compose up -d
docker compose logs immich-server
docker compose exec immich-server frameleaf-admin list-users
docker compose exec database pg_isready
```

Back up the database and originals before changing releases. Frameleaf uses PostgreSQL 19 beta 4 with pgvector 0.8.7 and HNSW. Release bundles pin the owned database image by digest. These installation files create a fresh canonical database. Mount its parent directory at `/var/lib/postgresql` and retain the versioned PostgreSQL directory within it. An offline read-only Immich 3.x export through stable 3.2.4 is supported separately as a one-time import; old database directories must not be attached as the Frameleaf database.

Cloud processing is Frameleaf Cloud, added and consented to by an administrator in the app; no image setting or Compose change enables it.

## Local builds

`docker-compose.prod.yml` and `docker-compose.dev.yml` build local `frameleaf-*:local` images, including the database from `docker/postgres`. They retain their existing project names, development volumes and storage paths and are not interchangeable with the release installation file. The server image builds its own media libraries from the sources in `server/base-image`, so a first build takes longer. ML builds explicitly use the `prod` stage. Neither a local image name nor successful compilation establishes release, hardware or model qualification.

## Restoration worker

`docker-compose.restoration.yml` adds a separate restoration container (`frameleaf-restoration`, port 3004 on the Compose network) built from `machine-learning/Dockerfile.video-restoration`. Library analysis stays in `immich-machine-learning`; the two never share a worker. Use it from a source checkout with `docker compose -f docker-compose.yml -f docker-compose.restoration.yml up -d`, then add the worker under Administration > Processing destinations. No restoration image is published and the worker is not qualified; see [Workers and endpoints](../docs/docs/administration/workers-and-endpoints.md) and `machine-learning/video-restoration/README.md`.

Test fixtures are frozen at commit `6742055402de1aa48f93d12ded7d18f4057f9d1f`. Hosted jobs use `bash scripts/checkout-test-assets.sh`; the manual Frameleaf frozen media fixtures workflow creates an attributed, checksummed archive for later authorized publication. No fixture tracking branch or submodule updates are followed.
