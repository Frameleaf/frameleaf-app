# iCloud Photos Sync: server setup

This guide is for the administrator who installs and maintains iCloud Photos Sync. After setup, each user connects their own Apple account through the [iCloud Photos Sync user guide](icloud-photos-sync.md).

The feature requires a fork build containing iCloud sync, its database migrations, and the separate HTTPS bridge. It is disabled until configured. Availability in this checkout does not mean an older published image contains the feature. Use a tested fork image that includes it.

## Deploy the bridge

Use the [Compose overlay](https://github.com/adamtaylor152/immich/blob/fork/main/deployment/icloud-sync.compose.yml) with the Compose file for your installed fork release. The bridge imports Rclone **v1.75.1**, commit `687d264b689b8c49a67e2e52a8a5e0caa01c04ce`; its Go modules and container base images are pinned. The original Rclone MIT copyright and permission notice is included at `icloud-bridge/licenses/rclone/COPYING` in the checkout and `/usr/share/licenses/icloud-bridge/rclone/COPYING` in the runtime image. The [protocol reference](https://github.com/adamtaylor152/immich/blob/fork/main/icloud-bridge/api.md) records the transport contract and limitations.

Prepare absolute paths in your deployment environment:

```dotenv
IMMICH_SOURCE_ROOT=/opt/immich
IMMICH_FORK_IMAGE=your-registry/immich-server:your-tested-fork-release
IMMICH_UID=1000
IMMICH_GID=1000
ICLOUD_SECRETS_DIR=/srv/immich-icloud/secrets
ICLOUD_STAGING_DIR=/srv/immich-icloud/staging
```

Set the UID/GID to the non-root identity that owns this installation's Frameleaf media files. Both services use that identity. Existing media directories must already be writable by it; this overlay does not recursively change their ownership. Do not set either ID to zero.

Staging must be a private directory disjoint from Frameleaf's upload, library, thumbnail, profile, backup, and every external-library root. Do not place it inside a monitored media tree or expose it through a web server or file share. It holds partial downloads and verified recovery copies. Check available disk space as well as the configured staging byte limit.

Generate secrets on the deployment host without printing their values:

```sh
umask 077
mkdir -p "$ICLOUD_SECRETS_DIR" "$ICLOUD_STAGING_DIR"
openssl rand -hex 32 > "$ICLOUD_SECRETS_DIR/bridge-token"
openssl rand -base64 32 > "$ICLOUD_SECRETS_DIR/encryption-key"
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -subj '/CN=Frameleaf iCloud private CA' \
  -keyout "$ICLOUD_SECRETS_DIR/ca.key" -out "$ICLOUD_SECRETS_DIR/ca.crt"
openssl req -newkey rsa:3072 -nodes -subj '/CN=icloud-bridge' \
  -keyout "$ICLOUD_SECRETS_DIR/bridge.key" -out "$ICLOUD_SECRETS_DIR/bridge.csr"
printf 'subjectAltName=DNS:icloud-bridge\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n' > "$ICLOUD_SECRETS_DIR/bridge.ext"
openssl x509 -req -days 365 -in "$ICLOUD_SECRETS_DIR/bridge.csr" \
  -CA "$ICLOUD_SECRETS_DIR/ca.crt" -CAkey "$ICLOUD_SECRETS_DIR/ca.key" -CAcreateserial \
  -extfile "$ICLOUD_SECRETS_DIR/bridge.ext" -out "$ICLOUD_SECRETS_DIR/bridge.crt"
sudo chown -R "$IMMICH_UID:$IMMICH_GID" "$ICLOUD_SECRETS_DIR" "$ICLOUD_STAGING_DIR"
chmod 700 "$ICLOUD_SECRETS_DIR" "$ICLOUD_STAGING_DIR"
chmod 600 "$ICLOUD_SECRETS_DIR"/*
```

Run these once for a new installation. Do not regenerate the encryption key when updating containers: stored sessions need the original key. The server reads a **base64-encoded 32-byte key**, not a password or arbitrary text. Keep the CA signing key offline after issuing the bridge certificate. Renew the certificate before expiration.

Compose file-backed secrets are bind mounts on many installations; host ownership and modes are authoritative. Apple passwords and verification codes belong only in the HTTPS web form, never `.env`, Compose, shell arguments, or support logs. The bridge receives only its bearer token and TLS files. The server receives the bearer token, CA certificate, and session encryption key.

Validate and start from the checkout, using your release's base Compose path:

```sh
docker compose --env-file /absolute/path/to/immich.env \
  -f /absolute/path/to/docker-compose.yml \
  -f "$IMMICH_SOURCE_ROOT/deployment/icloud-sync.compose.yml" config --quiet
docker compose --env-file /absolute/path/to/immich.env \
  -f /absolute/path/to/docker-compose.yml \
  -f "$IMMICH_SOURCE_ROOT/deployment/icloud-sync.compose.yml" up -d --build
```

The bridge has no published port or media mount. Its private Docker network permits outbound Apple HTTPS traffic. Do not add host networking or a public reverse-proxy route. The Frameleaf web application itself must be served over HTTPS for account authentication.

The server configuration paths are `IMMICH_ICLOUD_BRIDGE_URL`, `IMMICH_ICLOUD_BRIDGE_TOKEN_FILE`, `IMMICH_ICLOUD_KEY_FILE`, `IMMICH_ICLOUD_CA_FILE`, and `IMMICH_ICLOUD_STAGING_PATH`. They are set by the overlay. For split API/worker deployments, give each process the same transport/key configuration and consistent access to the private staging directory.

### Check readiness and the pinned version

From the server container, verify the bridge's HTTPS certificate and health response using Node's built-in client. Prefix `exec` with the same Compose files and environment used above:

```sh
docker compose exec immich-server node --input-type=module -e '
import https from "node:https";
import fs from "node:fs";
https.get(new URL("/health", process.env.IMMICH_ICLOUD_BRIDGE_URL), {
  ca: fs.readFileSync(process.env.IMMICH_ICLOUD_CA_FILE)
}, response => {
  if (response.statusCode !== 200) process.exitCode = 1;
  response.pipe(process.stdout);
}).on("error", () => { console.error("Bridge TLS/readiness check failed"); process.exitCode = 1; });
'
```

The response identifies protocol version 1 and its pinned Rclone source. This proves local readiness, not Apple authentication or a successful import. No live Apple-account verification is implied by a container build, synthetic fixture, or health response.

## Capacity and long-video validation

The staging directory must be owned by the server user and have mode `0700`. It must remain outside every managed or external media directory. Existing directories with broader permissions are rejected; correct the directory permissions before starting a run.

Per-connection controls are limited to 1–4 concurrent downloads. The worker also applies server-wide limits:

| Environment variable              | Default                  | Purpose                                                    |
| --------------------------------- | ------------------------ | ---------------------------------------------------------- |
| `IMMICH_ICLOUD_MAX_CONCURRENCY`   | `4`                      | Maximum active resource leases across connections          |
| `IMMICH_ICLOUD_MAX_STAGING_BYTES` | `107374182400` (100 GiB) | Total reserved staging budget                              |
| `IMMICH_ICLOUD_FREE_SPACE_BYTES`  | `1073741824` (1 GiB)     | Free disk space to retain in addition to the next download |

Set these on the workers that run sync. Increasing a reservation limit does not create disk space. Retained copies outside a user's current selection still consume their reservation; `staging_retained_capacity` requires reselection/recovery or additional capacity. Do not clear database reservations or empty staging to bypass it. Committed cleanup remains eligible when the budget is full.

### Media validation timeout

The server environment variable `IMMICH_MEDIA_VALIDATION_TIMEOUT_MS` controls the integrity validator's timeout, including full video decoding. Its default is **120000 ms (two minutes)**; finite values are clamped to **10000–86400000 ms** and invalid values use the default. Set it on each server/worker that performs validation, for example in an additional Compose override:

```yaml
services:
  immich-server:
    environment:
      IMMICH_MEDIA_VALIDATION_TIMEOUT_MS: '600000'
```

A timeout is unresolved validation, not proof of corruption or successful repair. Raising the timeout can permit long videos to finish; it does not add decoder support. Native operations keep their concurrency slot until they actually finish after a timeout, preventing timed-out work from creating unbounded parallel decoding.

## Disconnect, backup, and restore

**Disconnect account** removes its saved Apple session and stops new work. Existing imported Frameleaf assets remain. It does not delete the Apple account's photos or turn the connector into a mirror. Do not manually empty staging while a run is active or while it contains the only verified recovery copy.

Back up the Frameleaf database, managed media, retained source resources, private staging state, and encryption key as one consistent checkpoint. Restrict backup access as tightly as production secrets. Stop/pause workers before taking an application-consistent snapshot. Keep the bearer token and TLS material separately recoverable; restore permissions before starting services. Restoring a database without its matching encryption key requires Apple reauthentication. Never attach session values, tokens, signed URLs, passwords, or keys to support reports.

All connector tables live in `immich_fork`. During a certified handoff to the official upstream server they remain dormant. On return, missing public asset/album mappings are archived and cleared, source records remain, and deleted owners' connections are disabled. Follow the existing [switching procedure](../features/switching-between-fork-and-official.md); deploying an arbitrary official image is not a compatibility check.

## Verify before a large import

Use a small selected album first. Check sign-in and device approval, a photo and Live Photo, an available Apple edit, a repeated run, and a pause/resume. Confirm that originals remain accessible and edited versions appear in their Stack. Test recovery using disposable synthetic media, not a valuable original.

Local fixtures and database tests cover recovery and restart boundaries, but live Apple-account compatibility has not yet been verified for this implementation. The [user guide](icloud-photos-sync.md#supported-media-and-limits) lists the supported scope. An HTTPS health response alone does not prove an Apple sync succeeded.

For missing files, count differences, and orphan reports, see [Recover missing or corrupt media](media-recovery.md).
