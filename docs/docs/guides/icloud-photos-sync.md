# iCloud Photos Sync

**Utilities → iCloud Photos Sync** manages one-way imports from iCloud Photos into your Immich account. Transfers run on the server; your browser does not relay photos and can close while a run continues. The connector never writes to or deletes from iCloud, and source deletions do not mirror-delete Immich assets.

This feature requires the fork server, its database migrations, and the separate HTTPS iCloud bridge. It is not a global Rclone installation, mounted cloud filesystem, Mac agent, or `rclone sync` mirror.

## Deploy the bridge

Use the [Compose overlay](../../../deployment/icloud-sync.compose.yml) with the Compose file for your installed fork release. The bridge imports Rclone **v1.75.1**, commit `687d264b689b8c49a67e2e52a8a5e0caa01c04ce`; its Go modules and container base images are pinned. The original Rclone MIT copyright and permission notice is included at `icloud-bridge/licenses/rclone/COPYING` in the checkout and `/usr/share/licenses/icloud-bridge/rclone/COPYING` in the runtime image. The [protocol reference](../../../icloud-bridge/api.md) records the transport contract and limitations.

Prepare absolute paths in your deployment environment:

```dotenv
IMMICH_SOURCE_ROOT=/opt/immich
IMMICH_FORK_IMAGE=your-registry/immich-server:your-tested-fork-release
IMMICH_UID=1000
IMMICH_GID=1000
ICLOUD_SECRETS_DIR=/srv/immich-icloud/secrets
ICLOUD_STAGING_DIR=/srv/immich-icloud/staging
```

Set the UID/GID to the non-root identity that owns this installation's Immich media files. Both services use that identity. Existing media directories must already be writable by it; this overlay does not recursively change their ownership. Do not set either ID to zero.

Staging must be a private directory disjoint from Immich's upload, library, thumbnail, profile, backup, and every external-library root. Do not place it inside a monitored media tree or expose it through a web server or file share. It holds partial downloads and verified recovery copies. Check available disk space as well as the configured staging byte limit.

Generate secrets on the deployment host without printing their values:

```sh
umask 077
mkdir -p "$ICLOUD_SECRETS_DIR" "$ICLOUD_STAGING_DIR"
openssl rand -hex 32 > "$ICLOUD_SECRETS_DIR/bridge-token"
openssl rand -base64 32 > "$ICLOUD_SECRETS_DIR/encryption-key"
openssl req -x509 -newkey rsa:3072 -nodes -days 3650 \
  -subj '/CN=Immich iCloud private CA' \
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

The bridge has no published port or media mount. Its private Docker network permits outbound Apple HTTPS traffic. Do not add host networking or a public reverse-proxy route. The Immich web application itself must be served over HTTPS for account authentication.

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

## Connect an Apple account

1. Open **Utilities → iCloud Photos Sync**, add a descriptive connection name, and sign in with your Apple account email and password.
2. Enter the six-digit trusted-device verification code when requested. SMS verification is not supported by this bridge.
3. Enable **Access iCloud Data on the Web** on a trusted Apple device. With Advanced Data Protection, approve the device prompt and select **Check device approval**. One click makes one approval request; access may expire and require approval again.
4. Select **Load libraries and albums**. Unsupported source scopes remain explicitly marked. An incomplete inventory is not proof that an album or photo disappeared.
5. Choose libraries/albums or leave a scope unselected to include all supported items in it. Filter albums by name to browse large inventories; selection retains stable source IDs even when names change.
6. Set the interval, download concurrency, staging budget, and media policies. **Save**, then **Run now**.

Passwords and codes clear after submission and are not stored in browser storage. Opaque Apple sessions are encrypted in the server database. **Check saved session** validates existing access without transferring media.

**Pause**, **Resume**, **Cancel current run**, **Retry failures**, and **Reconcile and rescan** operate on saved server state. Closing the browser does not cancel a run. **Refresh** reads persisted counts; logical photos/videos and file resources are separate because a Live Photo or RAW pair contains multiple files. An exact duplicate may require an initial download to establish content identity.

## Recovery and privacy

A matching database checksum alone does not prove the destination file is healthy. A validated iCloud original can recover an existing managed asset with missing, corrupt, unreadable, or offline media while preserving that asset's ID and relationships. Applicable active health findings clear only after the recovered bytes pass verification. A failed, truncated, wrong-variant, or unverified download cannot count as a repair.

External-library recovery is **off by default**. Opting into **Allow damaged external-library matches to become managed assets** authorizes the server to recover a proven match into managed storage while keeping its identity. It does not authorize overwriting external files. Without this policy, a damaged external match requires review and its staged recovery copy remains available; the connector does not silently convert it to managed storage.

Hidden-source import is also opt-in and requires an elevated unlocked session when saving. Destination privacy and metadata locks remain authoritative. Progress/errors must not disclose hidden asset IDs, names, paths, or matches. Intentionally trashed assets are not automatically restored.

## Source metadata

The verified source fields are favorites, hidden status, and capture date. They are applied after metadata extraction, with source/applied baselines saved for later reconciliation. Native metadata locks and local changes remain authoritative. Apple Hidden maps to Immich **Locked**; Immich's internal **Hidden** visibility is reserved for motion companions. A source unhide never automatically removes a destination privacy choice.

On first adoption, an existing favorite is preserved when the source is not a favorite. A destination's default false can adopt source true; the native schema cannot distinguish that default from an untracked historical manual false. Later favorite changes use the saved applied baseline. Capture dates respect the native date lock and retain the existing timezone interpretation. Conflicting source metadata for distinct logical photos sharing one destination asset requires review.

Source captions, locations, and timezone fields are **not supported** by the verified raw-field adapter. Existing extracted or local values are preserved; absent source fields never erase destination metadata. The connector does not rewrite original EXIF or fabricate unavailable Apple fields.

## Health counts and orphan reports

The health scanner includes native hidden Live Photo motion assets. Server photo/video statistics exclude those hidden assets, and per-user statistics apply Timeline/Archive and privacy filters. These totals describe different populations; compare the same scope before treating a difference as missing media. Orphan reports also include physical derivative and sidecar files, rather than only logical photos.

Locate accepts verified content hashes even when filenames, paths, or saved sizes changed. A path-derived `sha1Path` is not content identity. This connector can recover matching original, rendition, or Live Photo component bytes, but an original's hash cannot identify a differently encoded transcode or XMP sidecar. It does not delete orphaned files or establish that a reported orphan is safe to remove. The reported production orphan inventory still needs a separate scoped reconciliation.

## Originals, edits, albums, and limits

Source identities are library/zone, asset/master, resource, and album IDs—not filenames or album names. Multiple logical source photos may share original bytes while retaining different source renditions and memberships. Apple-edited files are independent Immich assets grouped with their originals using native **Stacks**, with the source-edited asset preferred when that does not overwrite manual stack choices or local work. This uses normal Immich serving and downloads. It does not fabricate an Immich edit operation: original bytes, Apple-rendered assets, and local Immich edit instructions remain separate. Live Photo still/movie resources are linked through Immich's native Live Photo relationship using source identities; the existing Relink Live Photos utility remains available.

The pinned bridge exposes original, original motion, RAW/alternate original, available full-size JPEG, and full-size video resource descriptors. Actual availability depends on Apple's response. It preserves raw adjustment fields when exposed; it does not reconstruct Apple adjustment recipes or promise portable edits. Edited Live Photo pairing and all special slow-motion/HDR edit semantics are not supported. Do not substitute a preview JPEG for an original HEIC/RAW.

Primary and enumerated shared sync zones are distinct from Shared Albums. `CMM-*` Shared Albums are unsupported. Apple sharing permissions and Smart Album semantics are not reproduced. Nested albums use source parent IDs when available. Source membership removals require a complete authoritative inventory and only affect memberships owned by that connection; independent/manual memberships and local albums remain separate. Source album deletion is non-destructive.

The library/album selector supports at most **100 libraries and 10,000 albums per connection**. Exceeding either limit fails explicitly with `icloud_inventory_limit_exceeded`; it does not return a silently truncated selection or a completed scan. Source album IDs remain distinct even when names match.

Relationship reconciliation inspects at most 100 **current** resources in a shared-original family. A larger family requires review (`resource_family_too_large`). Historical Apple edit admission is separately limited to **20 distinct retained edit fingerprints per logical source photo**, across image/video renditions. Existing mapped assets, reservations, and staged or precommit versions count, including superseded versions. At the ceiling a new descriptor remains recorded but becomes `needs-review` with `retained_edit_limit`; it is not downloaded. Already retained fingerprints can be reused, and original/motion recovery is not subject to this edit limit.

Superseded renditions remain immutable Immich assets and can remain in their Stack. The connector does not prune them or delete the only recoverable version. Pre-existing histories above the ceiling are retained. Moving an old asset to Trash does not release its slot: only confirmed removal of the mapped asset, followed by **Retry failures**, can restore admission capacity; retained staging/precommit copies still count until safely finalized. Review source relationships and recoverability before any manual asset removal. Native account quota and staging limits continue to apply to bytes.

Downloads restart from the beginning after interruption; the bridge does not support Range resume. Inventory pages are bounded, but an initial scan is not a transactionally isolated Apple snapshot. Changes must reconcile after the initial scan. Authentication failure or a partial page must never be presented as a completed scan.

Retained staging for source versions that are no longer current stays reserved. If it prevents another reservation, the affected connection stops with `staging_retained_capacity`; reservations and recovery files are not discarded. An operator can reselect the affected source and retry to verify, promote, and finalize its retained copy, or an administrator can add capacity. There is no unchecked disposal action or staging-directory purge workflow. An already reserved resource may continue within its existing reservation even after budgets are reduced, and committed cleanup can release space without new capacity admission.

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

**Disconnect account** removes its saved Apple session and stops new work. Existing imported Immich assets remain. It does not delete the Apple account's photos or turn the connector into a mirror. Do not manually empty staging while a run is active or while it contains the only verified recovery copy.

Back up the Immich database, managed media, retained source resources, private staging state, and encryption key as one consistent checkpoint. Restrict backup access as tightly as production secrets. Stop/pause workers before taking an application-consistent snapshot. Keep the bearer token and TLS material separately recoverable; restore permissions before starting services. Restoring a database without its matching encryption key requires Apple reauthentication. Never attach session values, tokens, signed URLs, passwords, or keys to support reports.

All connector tables live in `immich_fork`. During a certified official-Immich handoff they remain dormant. On return, missing public asset/album mappings are archived and cleared, source records remain, and deleted owners' connections are disabled. Follow the existing [fork/official switching procedure](../features/switching-between-fork-and-official.md); deploying an arbitrary official image is not a compatibility check.

## Troubleshooting and acceptance

| State or symptom                   | Next action                                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| Connector disabled                 | Check server environment paths, readable secret files, and the HTTPS bridge URL.                  |
| Awaiting two-factor authentication | Enter the current trusted-device code; SMS is unsupported.                                        |
| Awaiting device approval           | Enable web access, approve on a trusted device, then check approval once.                         |
| Reauthentication required          | Sign in again. Do not repeatedly retry downloads with an expired session.                         |
| Rate limited                       | Preserve the retry state and allow its delay; do not create parallel connections to bypass it.    |
| Partial inventory                  | Resume/reload the inventory. Do not interpret absent rows as source deletions.                    |
| Staging/disk or quota limit        | Free authorized space or adjust the configured limit; preserve verified recovery copies.          |
| Unsupported or requires review     | Inspect the safe reason and source-format capability. These resources are not successful imports. |
| External repair outstanding        | Decide whether to authorize managed recovery; external files are not silently overwritten.        |

Release acceptance requires real integration checks plus an operator-authorized Apple account run. Verify a small selected album, repeat import, an authentication challenge, a restart, and recovery of a deliberately broken synthetic managed asset. Confirm that the same asset ID serves healthy bytes and its applicable active findings disappear. A second run should reuse that healthy resource. Fixture and local database tests do not establish live iCloud compatibility, universal edit fidelity, or production readiness.
