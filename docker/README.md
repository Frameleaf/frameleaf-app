# Frameleaf containers

Install from a [published Frameleaf release](https://github.com/Frameleaf/frameleaf-app/releases), using its Compose files and environment example together. Files from a development checkout can differ from a published release.

| Component        | Container image                                |
| ---------------- | ---------------------------------------------- |
| Server and web   | `ghcr.io/frameleaf/frameleaf-server`           |
| Machine learning | `ghcr.io/frameleaf/frameleaf-machine-learning` |

Release bundles pin `IMMICH_VERSION` to their version. The `release` and `latest` tags follow stable releases; `edge` follows development builds. Hardware variants append `-cuda`, `-openvino`, `-armnn`, `-rknn` or `-rocm` to the selected ML tag. For example, the stable CUDA image is `ghcr.io/frameleaf/frameleaf-machine-learning:release-cuda`. Select the matching hardware configuration and platform; a tag does not prove a particular GPU or model is supported.

The release includes `docker-compose.yml`, `docker-compose.rootless.yml`, `example.env`, `hwaccel.ml.yml` and `hwaccel.transcoding.yml`. Use the regular **or** rootless Compose file. Copy `example.env` to `.env` only for a new installation. Read the [installation steps](../docs/docs/install/docker-compose.mdx) and review the release notes before starting or upgrading.

## Existing installations

Changing application images does not require moving media or recreating a database. Preserve the existing Compose project name, `.env`, upload/database paths, volume names, external-library mounts and database settings. Keep the existing stack directory: relative host paths are resolved from the Compose files. Do not start a second stack against the same PostgreSQL directory, and do not use `docker compose down --volumes` during this migration.

Service keys (`immich-server`, `immich-machine-learning`, `database`, `redis`), the project name `immich`, `IMMICH_*` environment keys and the ML address `http://immich-machine-learning:3003` are retained for compatibility. Existing project overrides remain valid. Displayed container names become `frameleaf_server`, `frameleaf_machine_learning`, `frameleaf_postgres` and `frameleaf_redis`; update external scripts that address a container by its old name. Prefer service-based commands, which work across both names:

```sh
docker compose config --images
docker compose pull
docker compose up -d
docker compose logs immich-server
docker compose exec database pg_isready
```

Back up the database and originals before changing releases. Preserve pinned PostgreSQL/base images and the exact official image required by the [handoff procedure](../docs/docs/administration/upstream-handoff.md); the Frameleaf image rename does not change database compatibility certification.

Cloud processing is Frameleaf Cloud, added and consented to by an administrator in the app; no image setting or Compose change enables it.

## Local builds

`docker-compose.prod.yml` and `docker-compose.dev.yml` build local `frameleaf-*:local` images. They retain their existing project names, development volumes and storage paths and are not interchangeable with the release installation file. ML builds explicitly use the `prod` stage. Neither a local image name nor successful compilation establishes release, hardware or model qualification.

## Restoration worker

`docker-compose.restoration.yml` adds a separate restoration container (`frameleaf-restoration`, port 3004 on the Compose network) built from `machine-learning/Dockerfile.video-restoration`. Library analysis stays in `immich-machine-learning`; the two never share a worker. Use it from a source checkout with `docker compose -f docker-compose.yml -f docker-compose.restoration.yml up -d`, then add the worker under Administration > Processing destinations. No restoration image is published and the worker is not qualified; see [Workers and endpoints](../docs/docs/administration/workers-and-endpoints.md) and `machine-learning/video-restoration/README.md`.
