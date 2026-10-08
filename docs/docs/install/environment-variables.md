---
sidebar_position: 90
---

# Environment Variables

:::caution

To change environment variables, you must recreate the Frameleaf containers.
Just restarting the containers does not replace the environment within the container!

In order to recreate the container using docker compose, run `docker compose up -d`.
In most cases docker will recognize that the `.env` file has changed and recreate the affected containers.
If this does not work, try running `docker compose up -d --force-recreate`.

:::

## Docker Compose

| Variable                          | Description                     |  Default  | Containers               |
| :-------------------------------- | :------------------------------ | :-------: | :----------------------- |
| `FRAMELEAF_VERSION`<sup>\*1</sup> | Image tags                      | `release` | server, machine learning |
| `UPLOAD_LOCATION`                 | Host path for uploads           |           | server                   |
| `DB_DATA_LOCATION`                | Host path for Postgres database |           | database                 |

:::tip
These environment variables are used by the `docker-compose.yml` file and do **NOT** affect the containers directly.
:::

\*1: Set `FRAMELEAF_VERSION=latest` for a new installation using the current application images; an explicit compatible version is optional.

## General

| Variable                              | Description                                                                                                                                                          |           Default            | Containers               | Workers            |
| :------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------: | :----------------------- | :----------------- |
| `TZ`                                  | Timezone                                                                                                                                                             |        <sup>\*1</sup>        | server                   | microservices      |
| `FRAMELEAF_ENV`                       | Environment (production, development)                                                                                                                                |         `production`         | server, machine learning | api, microservices |
| `FRAMELEAF_LOG_LEVEL`                 | Log level (verbose, debug, log, warn, error)                                                                                                                         |            `log`             | server, machine learning | api, microservices |
| `FRAMELEAF_LOG_FORMAT`                | Log output format (`console`, `json`)                                                                                                                                |          `console`           | server                   | api, microservices |
| `FRAMELEAF_MEDIA_LOCATION`            | Media location inside the container ⚠️**You probably shouldn't set this**<sup>\*2</sup>⚠️                                                                            |           `/data`            | server                   | api, microservices |
| `FRAMELEAF_CONFIG_FILE`               | Path to config file                                                                                                                                                  |                              | server                   | api, microservices |
| `FRAMELEAF_HELMET_FILE`               | Path to a json file with [helmet](https://www.npmjs.com/package/helmet) options. Set to `false` to disable. Set to `true` to use `server/helmet.json`<sup>\*3</sup>. |           `false`            | server                   | api                |
| `NO_COLOR`                            | Set to `true` to disable color-coded log output                                                                                                                      |           `false`            | server, machine learning |                    |
| `CPU_CORES`                           | Number of cores available to the Frameleaf server                                                                                                                    | auto-detected CPU core count | server                   |                    |
| `FRAMELEAF_PROCESS_INVALID_IMAGES`    | When `true`, generate thumbnails for invalid images                                                                                                                  |                              | server                   | microservices      |
| `FRAMELEAF_TRUSTED_PROXIES`           | List of comma-separated IPs set as trusted proxies                                                                                                                   |                              | server                   | api                |
| `FRAMELEAF_IGNORE_MOUNT_CHECK_ERRORS` | See [System Integrity](/administration/system-integrity)                                                                                                             |                              | server                   | api, microservices |
| `FRAMELEAF_IMPORT_ROOTS`              | Comma-separated absolute paths administrators may select Google Photos Takeout folders from                                                                          |                              | server                   | api, microservices |
| `FRAMELEAF_ALLOW_SETUP`               | When `false` disables the `/auth/admin-sign-up` and `/admin/database-backups/start-restore` endpoints                                                                |            `true`            | server                   | api                |

\*1: `TZ` should be set to a `TZ identifier` from [this list][tz-list]. For example, `TZ="Etc/UTC"`.
`TZ` is used by `exiftool` as a fallback in case the timezone cannot be determined from the image metadata. It is also used for logfile timestamps and cron job execution.

\*2: This path is where the Frameleaf code looks for the files, which is internal to the docker container. Setting it to a path on your host will certainly break things, you should use the `UPLOAD_LOCATION` variable instead.

\*3: The [default configuration](https://helmetjs.github.io/#content-security-policy) sets `upgrade-insecure-requests`, which tells the browser to upgrade all requests to HTTPS. This breaks on HTTP-only deployments. If you cannot use HTTPS, you should use a custom helmet config file with `"upgrade-insecure-requests": null`.

## Machine-learning connection

| Variable                             | Purpose                                                                                             | Default                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `FRAMELEAF_MACHINE_LEARNING_ENABLED` | Initial local machine-learning enabled state                                                        | `true`                              |
| `FRAMELEAF_MACHINE_LEARNING_URL`     | Initial machine-learning endpoint URL for the server                                                | Release service URL                 |
| `FRAMELEAF_ML_AUTH_TOKEN`            | Bearer token required by the machine-learning worker; save the same token on its server destination | Unset; inference is unauthenticated |

Use [Workers and endpoints](/administration/workers-and-endpoints) to choose destinations for each task. A token on the worker alone does not configure the server's credential.

## Library Care

| Variable                   | Description                                                                                                              | Default | Containers | Workers            |
| :------------------------- | :----------------------------------------------------------------------------------------------------------------------- | :-----: | :--------- | :----------------- |
| `FRAMELEAF_RECOVERY_ROOTS` | Recovery locations Library Care may search for exact copies, as `Label=/path;Label=/path`. Only ever read.<sup>\*1</sup> |         | server     | api, microservices |

\*1: Each entry is an absolute path inside the container, optionally labelled. A copy found there is copied into library storage before an item is relinked to it; see [Library Care](/features/library-care).

## App releases

| Variable                           | Description                                                                                                                  | Default | Containers | Workers |
| :--------------------------------- | :--------------------------------------------------------------------------------------------------------------------------- | :-----: | :--------- | :------ |
| `FRAMELEAF_ANDROID_RELEASE_URL`    | https folder holding this installation's signed Android APKs; `{version}` is replaced with the server version.<sup>\*1</sup> |         | server     | api     |
| `FRAMELEAF_ANDROID_APP_ID`         | Android package id the APKs are signed as.                                                                                   |         | server     | api     |
| `FRAMELEAF_ANDROID_SIGNING_SHA256` | SHA-256 fingerprint of the APK signing certificate, shown to people before they install.                                     |         | server     | api     |
| `FRAMELEAF_IOS_APP_URL`            | https App Store or TestFlight page of the iOS app.                                                                           |         | server     | api     |
| `FRAMELEAF_ANDROID_STORE_URL`      | https store listing of the Android app (Google Play, F-Droid or another store), offered next to the APKs.                    |         | server     | api     |

\*1: The folder must contain `app-arm64-v8a-release.apk`, `app-armeabi-v7a-release.apk`, `app-x86_64-release.apk` and `app-release.apk` (universal). Android downloads and Obtainium setup are offered only when all three Android variables are set; a value that is set but invalid stops the server at startup. Without them the Mobile applications and Obtainium setup pages say that no signed release is available. Include `{version}` in the folder so Obtainium recognises each new release.

## Optional account and remote-access connection

| Variable                       | Description                                                                                                                                                                                                                                                                             |           Default            | Containers | Workers                  |
| :----------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------: | :--------- | :----------------------- |
| `FRAMELEAF_CLOUD_URL`          | Frameleaf Cloud address: set `https://api.frameleaf.cloud`. Unset means Frameleaf Cloud is not set up and nothing is ever contacted.<sup>\*1</sup>                                                                                                                                      |                              | server     | api, microservices, edge |
| `FRAMELEAF_PUSH_URL`           | Frameleaf push gateway address for notifications to the Frameleaf apps: set `https://push.frameleaf.cloud`. Unset means no push notifications are sent.                                                                                                                                 |                              | server     | api, microservices, edge |
| `FRAMELEAF_IDENTITY_DIR`       | Folder holding this server's identity key. Must be persistent storage.<sup>\*2</sup>                                                                                                                                                                                                    | `<media>/frameleaf/identity` | server     | api, microservices, edge |
| `FRAMELEAF_LINK_TOKEN`         | Single-use link token (`fll_…`) that links the server to a Frameleaf account when it starts, without a browser.<sup>\*3</sup>                                                                                                                                                           |                              | server     | microservices            |
| `FRAMELEAF_SETUP_CODE`         | Pins the setup code a new server asks for (8 characters of `ABCDEFGHJKMNPQRSTUVWXYZ23456789`), for automated installs and tests. Unset, a new code is shown on the console at every start. See [Setting up a new server](/administration/system-settings#setting-up-a-new-server).      |                              | server     | api                      |
| `FRAMELEAF_EDGE_PORT`          | Port of the direct remote-access listener.                                                                                                                                                                                                                                              |            `2443`            | server     | edge                     |
| `FRAMELEAF_EDGE_BIND`          | Address the direct remote-access listener binds to.                                                                                                                                                                                                                                     |          `0.0.0.0`           | server     | edge                     |
| `FRAMELEAF_ACME_DIRECTORY_URL` | ACME directory the edge worker obtains its certificates from. Only for Let's Encrypt staging or a test certificate authority.                                                                                                                                                           |        Let's Encrypt         | server     | edge                     |
| `FRAMELEAF_TRUSTED_LAN_CIDRS`  | Extra networks, as comma-separated CIDRs, that count as home besides private IPv4 ranges and IPv6 unique local addresses.                                                                                                                                                               |                              | server     | edge                     |
| `FRAMELEAF_EDGE_SECRET`        | Per-boot secret the edge worker sends with each request, so the server can tell how a visitor arrived. The server generates a new one on every start; set it only when the edge worker runs in another container, to the same value in both. Without it the edge worker serves nothing. |                              | server     | api, edge                |
| `FRAMELEAF_LOCAL_URL`          | This server's address on the home network, offered to a remote-access visitor who is on the same network. The edge worker publishes the LAN name for its address when it is an IPv4 address; in a container, that is the only LAN name.                                                 |                              | server     | api, edge                |

\*1: The address is deployment configuration, never a setting, and no default host is ever used.

\*2: The key is created once, readable by the server only. Losing it gives the server a new identity: every link and licence tied to the old one stops working until you link and activate again.

\*3: Create the token in your Frameleaf account under Servers → Add server. It works once and expires within an hour; the server never sends a token it already used. Remove it after the server shows as linked. A malformed token, port or network stops the server at startup.

## Help links

| Variable                    | Description                                                       | Default | Containers | Workers |
| :-------------------------- | :---------------------------------------------------------------- | :-----: | :--------- | :------ |
| `FRAMELEAF_DOCS_URL`        | https address of this installation's documentation.<sup>\*1</sup> |         | server     | api     |
| `FRAMELEAF_SUPPORT_URL`     | https address where people get help with this installation.       |         | server     | api     |
| `FRAMELEAF_BUG_FEATURE_URL` | https address for reporting problems and requesting features.     |         | server     | api     |
| `FRAMELEAF_SOURCE_URL`      | https address of the source code this installation runs.          |         | server     | api     |

\*1: Help, settings and sign-in pages link to these addresses only when they are set; nothing falls back to another project's sites. A value that is not an https address, or that carries a user name or password, stops the server at startup. Legacy help-link aliases remain accepted when their current name is unset; only HTTPS values are used.

## Workers

| Variable                    | Description                                                                                             | Default | Containers |
| :-------------------------- | :------------------------------------------------------------------------------------------------------ | :-----: | :--------- |
| `FRAMELEAF_WORKERS_INCLUDE` | Only run these workers.                                                                                 |         | server     |
| `FRAMELEAF_WORKERS_EXCLUDE` | Do not run these workers. Matches against default workers, or `FRAMELEAF_WORKERS_INCLUDE` if specified. |         | server     |

:::info
Information on the current workers can be found [here](/administration/jobs-workers).
:::

## Stopping

| Variable                              | Description                                                                                                                   | Default | Containers |
| :------------------------------------ | :---------------------------------------------------------------------------------------------------------------------------- | :-----: | :--------- |
| `FRAMELEAF_SHUTDOWN_GRACE_SECONDS`    | How long running jobs and in-flight requests get to finish when the server stops. Jobs still running then go back to waiting. |   `5`   | server     |
| `FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS` | When the server has exited after a stop, whatever is still running. Must be greater than `FRAMELEAF_SHUTDOWN_GRACE_SECONDS`.  |   `9`   | server     |

Both must be positive numbers, and the grace period must end before the deadline; otherwise the server refuses to start. Docker kills the container when its stop timeout ends, so the server's `stop_grace_period` must be longer than the deadline. The provided Compose files and NAS packages use 10 seconds, which fits the defaults; raise it with the deadline. See [Stopping the server](/administration/jobs-workers#stopping-the-server).

## Ports

| Variable         | Description    |                  Default                   | Containers               |
| :--------------- | :------------- | :----------------------------------------: | :----------------------- |
| `FRAMELEAF_HOST` | Listening host |                 `0.0.0.0`                  | server, machine learning |
| `FRAMELEAF_PORT` | Listening port | `2283` (server), `3003` (machine learning) | server, machine learning |

## Database

All Frameleaf workers share one canonical PostgreSQL 19 database with pgvector 0.8.7 and HNSW. The owned image mounts the parent directory at `/var/lib/postgresql`; old major-version clusters must not be reused. Queues, rate limits, upload leases and Socket.IO coordination use this database.

| Variable             | Description                                                              |   Default   | Containers                     |
| :------------------- | :----------------------------------------------------------------------- | :---------: | :----------------------------- |
| `DB_URL`             | Database URL                                                             |             | server                         |
| `DB_HOSTNAME`        | Database host                                                            | `database`  | server                         |
| `DB_PORT`            | Database port                                                            |   `5432`    | server                         |
| `DB_USERNAME`        | Database user                                                            | `postgres`  | server, database<sup>\*1</sup> |
| `DB_PASSWORD`        | Database password                                                        | `postgres`  | server, database<sup>\*1</sup> |
| `DB_DATABASE_NAME`   | Database name                                                            | `frameleaf` | server, database<sup>\*1</sup> |
| `DB_SSL_MODE`        | Database SSL mode                                                        |             | server                         |
| `DB_SKIP_MIGRATIONS` | Whether to skip running migrations on startup (one of [`true`, `false`]) |   `false`   | server                         |

\*1: The values of `DB_USERNAME`, `DB_PASSWORD`, and `DB_DATABASE_NAME` are passed to the Postgres container as the variables `POSTGRES_USER`, `POSTGRES_PASSWORD`, and `POSTGRES_DB` in `docker-compose.yml`.

:::info

All `DB_` variables must be provided to all Frameleaf workers, including `api` and `microservices`.

`DB_URL` must be in the format `postgresql://dbusername:dbpassword@postgreshost:postgresport/databasename`.
You can require SSL by adding `?sslmode=require` to the end of the `DB_URL` string, or require SSL and skip certificate verification by adding `?sslmode=require&uselibpqcompat=true`. This allows both Frameleaf and `pg_dump` (the PostgreSQL 19 client used for database backups) to [properly connect](https://github.com/brianc/node-postgres/tree/master/packages/pg-connection-string#tcp-connections) to your database.

When `DB_URL` is defined, the `DB_HOSTNAME`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD` and `DB_DATABASE_NAME` database variables are ignored.

:::

## Machine Learning

| Variable                                                    | Description                                                                                                                                                  |             Default              | Containers       |
| :---------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------: | :--------------- |
| `MACHINE_LEARNING_MODEL_TTL`                                | Inactivity time (s) before a model is unloaded (disabled if \<= 0)                                                                                           |              `300`               | machine learning |
| `MACHINE_LEARNING_MODEL_TTL_POLL_S`                         | Interval (s) between checks for the model TTL (disabled if \<= 0)                                                                                            |               `10`               | machine learning |
| `MACHINE_LEARNING_CACHE_FOLDER`                             | Directory where models are downloaded                                                                                                                        |             `/cache`             | machine learning |
| `MACHINE_LEARNING_MODEL_SOURCE_URL`<sup>\*5</sup>           | Hub-compatible host that serves the `frameleaf/<model>` repositories for smart search, face recognition and OCR                                              | `https://models.frameleaf.cloud` | machine learning |
| `MACHINE_LEARNING_MODEL_SOURCE_TOKEN`<sup>\*5</sup>         | Token sent to a custom model source that needs authentication; never logged                                                                                  |                                  | machine learning |
| `MACHINE_LEARNING_REQUEST_THREADS`<sup>\*1</sup>            | Thread count of the request thread pool (disabled if \<= 0)                                                                                                  |       number of CPU cores        | machine learning |
| `MACHINE_LEARNING_MODEL_INTER_OP_THREADS`                   | Number of parallel model operations                                                                                                                          |               `1`                | machine learning |
| `MACHINE_LEARNING_MODEL_INTRA_OP_THREADS`                   | Number of threads for each model operation                                                                                                                   |               `2`                | machine learning |
| `MACHINE_LEARNING_WORKERS`<sup>\*2</sup>                    | Number of worker processes to spawn                                                                                                                          |               `1`                | machine learning |
| `MACHINE_LEARNING_HTTP_KEEPALIVE_TIMEOUT_S`<sup>\*3</sup>   | HTTP Keep-alive time in seconds                                                                                                                              |               `2`                | machine learning |
| `MACHINE_LEARNING_WORKER_TIMEOUT`                           | Maximum time (s) of unresponsiveness before a worker is killed                                                                                               |   `300` (`900` if using ROCm)    | machine learning |
| `MACHINE_LEARNING_PRELOAD__CLIP__TEXTUAL`                   | Comma-separated list of (textual) CLIP model(s) to preload and cache                                                                                         |                                  | machine learning |
| `MACHINE_LEARNING_PRELOAD__CLIP__VISUAL`                    | Comma-separated list of (visual) CLIP model(s) to preload and cache                                                                                          |                                  | machine learning |
| `MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__RECOGNITION` | Comma-separated list of (recognition) facial recognition model(s) to preload and cache                                                                       |                                  | machine learning |
| `MACHINE_LEARNING_PRELOAD__FACIAL_RECOGNITION__DETECTION`   | Comma-separated list of (detection) facial recognition model(s) to preload and cache                                                                         |                                  | machine learning |
| `MACHINE_LEARNING_PRELOAD__OCR__RECOGNITION`                | Comma-separated list of (recognition) OCR model(s) to preload and cache                                                                                      |                                  | machine learning |
| `MACHINE_LEARNING_PRELOAD__OCR__DETECTION`                  | Comma-separated list of (detection) OCR model(s) to preload and cache                                                                                        |                                  | machine learning |
| `MACHINE_LEARNING_ANN`                                      | Enable ARM-NN hardware acceleration if supported                                                                                                             |              `True`              | machine learning |
| `MACHINE_LEARNING_ANN_FP16_TURBO`                           | Execute operations in FP16 precision: increasing speed, reducing precision (applies only to ARM-NN)                                                          |             `False`              | machine learning |
| `MACHINE_LEARNING_ANN_TUNING_LEVEL`                         | ARM-NN GPU tuning level (1: rapid, 2: normal, 3: exhaustive)                                                                                                 |               `2`                | machine learning |
| `MACHINE_LEARNING_DEVICE_IDS`<sup>\*4</sup>                 | Device IDs to use in multi-GPU environments                                                                                                                  |               `0`                | machine learning |
| `MACHINE_LEARNING_MAX_BATCH_SIZE__FACIAL_RECOGNITION`       | Set the maximum number of faces that will be processed at once by the facial recognition model                                                               |   None (`1` if using OpenVINO)   | machine learning |
| `MACHINE_LEARNING_MAX_BATCH_SIZE__OCR`                      | Set the maximum number of boxes that will be processed at once by the OCR model                                                                              |               `6`                | machine learning |
| `MACHINE_LEARNING_RKNN`                                     | Enable RKNN hardware acceleration if supported                                                                                                               |              `True`              | machine learning |
| `MACHINE_LEARNING_RKNN_THREADS`                             | How many threads of RKNN runtime should be spun up while inferencing.                                                                                        |               `1`                | machine learning |
| `MACHINE_LEARNING_MODEL_ARENA`                              | Pre-allocates CPU memory to avoid memory fragmentation                                                                                                       |               true               | machine learning |
| `MACHINE_LEARNING_OPENVINO_PRECISION`                       | If set to FP16, uses half-precision floating-point operations for faster inference with reduced accuracy (one of [`FP16`, `FP32`], applies only to OpenVINO) |              `FP32`              | machine learning |

\*1: It is recommended to begin with this parameter when changing the concurrency levels of the machine learning service and then tune the other ones.

\*2: Since each process duplicates models in memory, changing this is not recommended unless you have abundant memory to go around.

\*3: For scenarios like HPA in K8S.

\*4: Using multiple GPUs requires `MACHINE_LEARNING_WORKERS` to be set greater than 1. A single device is assigned to each worker in round-robin priority.

\*5: Smart search, face recognition and text recognition (OCR) models are downloaded from the model source: `MACHINE_LEARNING_MODEL_SOURCE_URL` if set, otherwise `HF_ENDPOINT` if set (an existing Hub mirror keeps working), otherwise the Frameleaf model mirror at `https://models.frameleaf.cloud`. The machine learning service logs which source it uses at startup. The source keeps the Hugging Face layout (`/{org}/{repo}/resolve/{revision}/{path}` and `/api/models/{org}/{repo}/revision/{revision}`), so you can point it at your own mirror or an offline copy. A Hugging Face token (`HF_TOKEN`) is only sent when the source is `huggingface.co`; any other source gets no token unless you set `MACHINE_LEARNING_MODEL_SOURCE_TOKEN`. No usage statistics are sent to any host. OCR models use `frameleaf/PP-OCRv5_mobile` and `frameleaf/PP-OCRv5_server` (each holding `detection/model.onnx` and `recognition/model.onnx`) plus one `frameleaf/<LANG>__PP-OCRv5_mobile` repository per language pack (`EL`, `EN`, `ESLAV`, `KOREAN`, `LATIN`, `TH`, holding `recognition/model.onnx`); each file must match the pinned PP-OCRv5 checksum. If the source does not serve a model you choose, loading it fails with an error naming the model and the source; the service never falls back to another host. Image descriptions (on by default) and NSFW detection (off by default) do not use this source: their models come from `huggingface.co`, or from `HF_ENDPOINT` if set. To keep them off `huggingface.co`, set `HF_ENDPOINT` to your own mirror, or fill the model cache yourself and set `HF_HUB_OFFLINE=1`.

:::info

While the `textual` model is the only one required for smart search, some users may experience slow first searches
due to backups triggering loading of the other models into memory, which blocks other requests until completed.
To avoid this, you can preload the other models (`visual`, `recognition`, and `detection`) if you have enough RAM to do so.

Additional machine learning parameters can be tuned from the admin UI.

:::

## Prometheus

Telemetry and metrics export are disabled in Frameleaf. Legacy telemetry, metrics-port and `OTEL_*` variables cannot activate a listener or exporter. Use [logs and health checks](/features/monitoring) for local operation.

## Deprecated names

Use the `FRAMELEAF_*` names documented here for new configuration. Older variable names remain compatibility aliases during the current major version. Startup logs name any deprecated variables in use and their replacements. Conflicting values for an old and current name stop startup; remove the old name after migrating the value.

A database from another application is not compatible with a fresh Frameleaf deployment. Use [library import](/administration/import-library).

## iCloud connector

The connector is optional and requires a separate authenticated HTTPS bridge. Use the [server setup guide](/guides/icloud-photos-server-setup) for its complete mounts, file-backed secrets and staging requirements.

| Variable                             | Purpose                                                           |
| ------------------------------------ | ----------------------------------------------------------------- |
| `FRAMELEAF_ICLOUD_BRIDGE_URL`        | HTTPS address of the private bridge                               |
| `FRAMELEAF_ICLOUD_BRIDGE_TOKEN_FILE` | File containing the bridge bearer token                           |
| `FRAMELEAF_ICLOUD_KEY_FILE`          | File containing the base64-encoded 32-byte session-encryption key |
| `FRAMELEAF_ICLOUD_CA_FILE`           | CA certificate used to verify the bridge                          |
| `FRAMELEAF_ICLOUD_STAGING_PATH`      | Private container directory for staged imports                    |
| `FRAMELEAF_ICLOUD_FREE_SPACE_BYTES`  | Minimum free-space reserve for staging                            |
| `FRAMELEAF_ICLOUD_MAX_CONCURRENCY`   | Maximum concurrent connector transfers                            |
| `FRAMELEAF_ICLOUD_MAX_STAGING_BYTES` | Staging byte limit                                                |

Keep the original encryption key with your backups. Replacing it makes stored connector sessions unreadable.

## Secrets

The following variables support reading from files, either via [Systemd Credentials][systemd-creds] or [Docker secrets][docker-secrets] for additional security.

To use any of these, either set `CREDENTIALS_DIRECTORY` to a directory that contains files whose name is the “regular variable” name, and whose content is the secret. If using Docker Secrets, setting `CREDENTIALS_DIRECTORY=/run/secrets` will cause all secrets present to be used. Alternatively, replace the regular variable with the equivalent `_FILE` environment variable as below. The value of the `_FILE` variable should be set to the path of a file containing the variable value.

| Regular Variable   | Equivalent Docker Secrets '\_FILE' Variable |
| :----------------- | :------------------------------------------ |
| `DB_HOSTNAME`      | `DB_HOSTNAME_FILE`<sup>\*1</sup>            |
| `DB_DATABASE_NAME` | `DB_DATABASE_NAME_FILE`<sup>\*1</sup>       |
| `DB_USERNAME`      | `DB_USERNAME_FILE`<sup>\*1</sup>            |
| `DB_PASSWORD`      | `DB_PASSWORD_FILE`<sup>\*1</sup>            |
| `DB_URL`           | `DB_URL_FILE`<sup>\*1</sup>                 |

\*1: See the [official documentation][docker-secrets-docs] for
details on how to use Docker Secrets in the Postgres image.

[tz-list]: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones#List
[docker-secrets-docs]: https://github.com/docker-library/docs/tree/master/postgres#docker-secrets
[docker-secrets]: https://docs.docker.com/engine/swarm/secrets/
[systemd-creds]: https://systemd.io/CREDENTIALS/
