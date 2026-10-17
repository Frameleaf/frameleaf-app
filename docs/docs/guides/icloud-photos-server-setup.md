# iCloud Photos Sync: server setup

This guide is for the administrator who installs and maintains iCloud Photos Sync. After setup, each user connects their own Apple account through the [iCloud Photos Sync user guide](icloud-photos-sync.md).

The feature requires a Frameleaf release that contains iCloud sync and its database migrations, plus the separate HTTPS bridge. It is disabled until configured. Older published images may not contain it; use a tested Frameleaf release that includes it.

## Deploy the bridge

Use the [Compose overlay](https://github.com/Frameleaf/frameleaf-app/blob/main/deployment/icloud-sync.compose.yml) with the Compose file for your installed Frameleaf release. The bridge imports Rclone **v1.75.2**, commit `be8d6044eacb843b74d335db0c5fbe09222031fe`; its Go modules and container base images are pinned. The original Rclone MIT copyright and permission notice is included at `icloud-bridge/licenses/rclone/COPYING` in the checkout and `/usr/share/licenses/icloud-bridge/rclone/COPYING` in the runtime image. The [protocol reference](https://github.com/Frameleaf/frameleaf-app/blob/main/icloud-bridge/api.md) records the transport contract and limitations.

Prepare absolute paths in your deployment environment:

```dotenv
FRAMELEAF_SOURCE_ROOT=/opt/frameleaf-app
FRAMELEAF_IMAGE=ghcr.io/frameleaf/frameleaf-server:your-tested-release
FRAMELEAF_UID=1000
FRAMELEAF_GID=1000
ICLOUD_SECRETS_DIR=/srv/frameleaf-icloud/secrets
ICLOUD_STAGING_DIR=/srv/frameleaf-icloud/staging
```

Set the UID/GID to the non-root identity that owns this installation's Frameleaf media files. Both services use that identity. Existing media directories must already be writable by it; this overlay does not recursively change their ownership. Do not set either ID to zero.

Staging must be a private directory disjoint from Frameleaf's upload, library, thumbnail, profile, backup, and every external-library root. Do not place it inside a monitored media tree or expose it through a web server or file share. It holds partial downloads, verified recovery copies and private scheduled validation inputs. Check available disk space as well as the configured staging byte limit.

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
sudo chown -R "$FRAMELEAF_UID:$FRAMELEAF_GID" "$ICLOUD_SECRETS_DIR" "$ICLOUD_STAGING_DIR"
chmod 700 "$ICLOUD_SECRETS_DIR" "$ICLOUD_STAGING_DIR"
chmod 600 "$ICLOUD_SECRETS_DIR"/*
```

Run these once for a new installation. Do not regenerate the encryption key when updating containers: stored sessions need the original key. The server reads a **base64-encoded 32-byte key**, not a password or arbitrary text. Keep the CA signing key offline after issuing the bridge certificate. Renew the certificate before expiration.

Compose file-backed secrets are bind mounts on many installations; host ownership and modes are authoritative. Apple passwords and verification codes belong only in the HTTPS web form, never `.env`, Compose, shell arguments, or support logs. The bridge receives only its bearer token and TLS files. The server receives the bearer token, CA certificate, and session encryption key.

Validate and start from the checkout, using your release's base Compose path:

```sh
docker compose --env-file /absolute/path/to/frameleaf.env \
  -f /absolute/path/to/docker-compose.yml \
  -f "$FRAMELEAF_SOURCE_ROOT/deployment/icloud-sync.compose.yml" config --quiet
docker compose --env-file /absolute/path/to/frameleaf.env \
  -f /absolute/path/to/docker-compose.yml \
  -f "$FRAMELEAF_SOURCE_ROOT/deployment/icloud-sync.compose.yml" up -d --build
```

The bridge has no published port or media mount. Its private Docker network permits outbound Apple HTTPS traffic. Do not add host networking or a public reverse-proxy route. The Frameleaf web application itself must be served over HTTPS for account authentication.

The server configuration paths are `FRAMELEAF_ICLOUD_BRIDGE_URL`, `FRAMELEAF_ICLOUD_BRIDGE_TOKEN_FILE`, `FRAMELEAF_ICLOUD_KEY_FILE`, `FRAMELEAF_ICLOUD_CA_FILE`, and `FRAMELEAF_ICLOUD_STAGING_PATH`. They are set by the overlay. For split API/worker deployments, give each process the same transport/key configuration and consistent access to the private staging directory.

The first start after upgrading to iCloud source identities builds an index over the sync's inventory. On a very large iCloud library that start takes longer.

`FRAMELEAF_ICLOUD_IDENTITY_MATCHING=false` switches off iCloud source identity matching between the sync and the Frameleaf app. Then only photos with the same SHA-256 are treated as the same. See [iCloud Photos Sync and the Frameleaf app](icloud-photos-sync.md#with-the-app).

Identity adoption before a cloud download and scheduled weekly audits are separately disabled by default. Keep `FRAMELEAF_ICLOUD_IDENTITY_ADOPTION` and `FRAMELEAF_ICLOUD_WEEKLY_AUDIT_EXECUTION` off until the live Apple-account identity/fingerprint spike and the mandatory weekly audit worker/provider/schedule are qualified. The source includes owner-scoped weekly grants, a frozen 1% sample cohort, production through the existing sync scheduler, and a scheduled worker. Grants bind the connection configuration and privacy settings; protected audits additionally require explicit protected-media authority and the current PIN binding. Adoption rechecks weekly grant authority and also requires matching to remain enabled. Configuration or consent alone establishes no qualification. The bounded adoption path accepts only unprotected original, Live Photo motion and RAW-alternative resources with current exact source evidence and freshly verified managed bytes. It records the actual decision but does not mark those skipped cloud bytes audit-verified. Edited resources and unsupported evidence retain the ordinary download/hash path; retired authority or unsettled validation retries without publishing a decision. Before any separately authorized activation, verify old-worker drain and qualify the combined validation-input lifecycle and release guards. Unknown restart-work recovery and complete decoder-transient peak accounting remain separate requirements; this source does not authorize activation.

### Check readiness and the pinned version

From the server container, verify the bridge's HTTPS certificate and health response using Node's built-in client. Prefix `exec` with the same Compose files and environment used above:

```sh
docker compose exec frameleaf-server node --input-type=module -e '
import https from "node:https";
import fs from "node:fs";
https.get(new URL("/health", process.env.FRAMELEAF_ICLOUD_BRIDGE_URL), {
  ca: fs.readFileSync(process.env.FRAMELEAF_ICLOUD_CA_FILE)
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

| Environment variable                 | Default                  | Purpose                                                    |
| ------------------------------------ | ------------------------ | ---------------------------------------------------------- |
| `FRAMELEAF_ICLOUD_MAX_CONCURRENCY`   | `4`                      | Maximum active resource leases across connections          |
| `FRAMELEAF_ICLOUD_MAX_STAGING_BYTES` | `107374182400` (100 GiB) | Total reserved staging budget                              |
| `FRAMELEAF_ICLOUD_FREE_SPACE_BYTES`  | `1073741824` (1 GiB)     | Free disk space to retain in addition to the next download |

Set these on the workers that run sync. Increasing a reservation limit does not create disk space. Retained copies outside a user's current selection still consume their reservation; `staging_retained_capacity` requires reselection/recovery or additional capacity. Do not clear database reservations or empty staging to bypass it. Committed cleanup remains eligible when the budget is full.

### Scheduled validation inputs and upgrades

Scheduled weekly validation reserves a full expected-size input in addition to its staged source
and any recovery copy, before creating or copying the input or starting the decoder. For a
10-byte resource, source plus input reserves 20 bytes; source plus recovery plus destination input
reserves 30 bytes. Input disposal refunds only its own 10 bytes. The existing connection/global
limits and free-space watermark still apply; this adds no setting.

A timeout, cancellation, disconnect or restart does not free that input's reservation. Actual
decoder and readonly work, including handle closes, must settle before authenticated disposal.
Normal success must dispose the input before publication. Unknown, pending, malformed or
unsupported ownership evidence remains private and fully charged. Housekeeping can discover
source-only inputs without a recovery copy or live Apple credentials; it cannot infer that unknown
work has stopped. Do not delete retained files, clear database charges or edit receipt JSON to
recover capacity. Preserve the matching staging and database checkpoint for reviewed recovery.

History retains one current input and one previous disposed receipt with a persistent exact
generation mark. This does not impose a lifetime attempt limit or change scheduled pause, resume
or deferral behavior. Existing manual/non-scheduled behavior remains unchanged when no input
ledger exists; unknown scheduled legacy work still requires settlement evidence.

Before enabling scheduled execution after an upgrade, drain every old worker that can create or
clean private copies and verify its in-flight decoder/readonly work has actually settled. A pause,
timeout, restart or disabled admission flag alone does not prove drain. Preserve unknown legacy
work rather than treating a missing new receipt as permission to remove it. Keep adoption and
weekly execution disabled until this drain and final-candidate service/restart/release qualification,
required review/checks and the existing live Apple/provider gates are satisfied. See the
[private-copy disposition contract](../developer/icloud-private-disposition.md#qualification-and-upgrade-gates).

The full input charge does not cover every RAW render, image buffer or native decoder scratch
allocation. Those transients can exceed the reservation; complete peak resource accounting and
native/device acceptance remain separate qualification work.

### Media validation timeout

The server environment variable `FRAMELEAF_MEDIA_VALIDATION_TIMEOUT_MS` controls the integrity validator's timeout, including full video decoding. Its default is **120000 ms (two minutes)**; finite values are clamped to **10000–86400000 ms** and invalid values use the default. Set it on each server/worker that performs validation, for example in an additional Compose override:

```yaml
services:
  frameleaf-server:
    environment:
      FRAMELEAF_MEDIA_VALIDATION_TIMEOUT_MS: '600000'
```

A timeout is unresolved validation, not proof of corruption or successful repair. Raising the timeout can permit long videos to finish; it does not add decoder support. Native operations keep their concurrency slot until they actually finish after a timeout, preventing timed-out work from creating unbounded parallel decoding.

## Disconnect, backup, and restore

**Disconnect account** removes its saved Apple session and stops new work. Existing imported Frameleaf assets remain. It does not delete the Apple account's photos or turn the connector into a mirror. Do not manually empty staging while a run is active or while it contains the only verified recovery copy.

Back up the Frameleaf database, managed media, retained source resources, private staging state, and encryption key as one consistent checkpoint. Restrict backup access as tightly as production secrets. Stop/pause workers before taking an application-consistent snapshot. Keep the bearer token and TLS material separately recoverable; restore permissions before starting services. Restoring a database without its matching encryption key requires Apple reauthentication. Never attach session values, tokens, signed URLs, passwords, or keys to support reports.

All connector state is in the canonical `public` schema. Back up the database together with the original connector encryption key and matching media files. A one-time offline Immich import uses a separate read-only source and never shares this database with another server implementation. See [Backup and restore](../administration/backup-and-restore.md).
