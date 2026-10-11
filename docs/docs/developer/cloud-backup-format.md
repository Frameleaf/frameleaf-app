# Client backup format 1

`frameleaf-client-backup` version 1 encrypts backup payloads on the Frameleaf server before S3 requests. It reuses the Buddy HKDF, keyed identities and authenticated blocks in a separate Cloud Backup domain. The implementation is in `server/src/utils/cloud-backup-crypto.ts`; signed recovery metadata and passphrase wrapping are in `cloud-backup-recovery.ts`.

New writes require `FRAMELEAF_BACKUP_CLIENT_ENCRYPTION=1` and an explicitly prepared independent client keyring. The default remains legacy SSE-C until compatibility, provider policy and replacement-server restore qualification are complete. Managed writes additionally require a grant advertising `{format:"frameleaf-client-backup",version:1}` in `objectFormats.write`; unsupported grants stop the run.

Legacy SSE-C manifest versions 1 and 2 remain readable. A client keyring supplements the existing key file:

```json
{
  "client": {
    "vaultId": "f0000000-0000-4000-8000-000000000001",
    "current": 2,
    "keys": { "1": "base64-32-byte-root", "2": "base64-32-byte-root" }
  }
}
```

The real roots are independent random 32-byte values. Never derive a client root from the legacy SSE-C key: storage has already received that key. Keep the top-level legacy `key` for old history. Rotation adds a new root and retains every older version. Stored key modes update the owner-only key file atomically under the bucket lock; own-memory roots stay in process memory and authenticated worker sharing. A run pins its write version in its manifest name so a restart cannot change its format or key version.

## Object names and identities

- Media, thumbnails, profile images and sidecars: `o/v1/<vaultId>/<keyVersion>/<id>`.
- Database dumps: `db/v1/<vaultId>/<keyVersion>/<id>/<original-dump-basename>.sql.gz`.
- Manifests: `m/v1/<vaultId>/<keyVersion>/<YYYYMMDDTHHMMSSZ>.json.gz`.

UUIDs and hexadecimal values are lowercase. Key versions are positive decimal integers up to 999999999, without leading zeroes. Unknown client versions are refused. The database basename is retained so the existing maintenance restore recognizes the downloaded dump.

Define `cloud(root,vault,purpose)` as HKDF-SHA256 with input key `root`, salt UTF-8 `vault`, info UTF-8 `frameleaf-client-backup/1/` followed by `purpose`, and output length 32. The stored media/database ID is lowercase hex HMAC-SHA256 of the binary plaintext SHA-256, keyed by `cloud(root,vault,"identity/<keyVersion>/<kind>")`. Kind is `object` or `database`. Plaintext hashes stay inside local indexes and encrypted manifests.

## Payload bytes

All new payloads use `application/octet-stream`, without SSE-C customer-key headers. SigV4 SHA-256 and Content-MD5 cover ciphertext. The clear header is exactly 48 bytes:

| Offset | Length | Value                                      |
| ------ | ------ | ------------------------------------------ |
| 0      | 8      | ASCII `FLCBAE01`                           |
| 8      | 32     | Fresh cryptographically random upload salt |
| 40     | 8      | Unsigned big-endian plaintext byte length  |

Split plaintext into 8388608-byte blocks, except the last block. Index data blocks from zero. After the data, seal one terminal block containing the 32-byte plaintext SHA-256 at the next index. For every block:

1. Derive a block root with `cloud(root,vault,JSON.stringify([bucket,exactObjectKey,kind,keyVersion,base64url(header),index]))`. Base64url has no padding; `kind` is `object`, `database`, or `manifest`.
2. Compute the Buddy block ID: HMAC-SHA256 over SHA-256 of the block, using HKDF-SHA256 of the block root with salt UTF-8 vault and info `frameleaf-buddy/1/object-id` (32-byte output).
3. Derive the AES-256-GCM key from the block root using the same HKDF salt, info `frameleaf-buddy/1/block/<keyVersion>/<lowercase-hex-block-id>`, and output length 32.
4. Generate a random 12-byte nonce. Associated data is UTF-8 `JSON.stringify(["frameleaf-buddy-block",1,vault,lowercaseHexBlockId,keyVersion])`.
5. Store binary block ID (32 bytes), nonce (12), ciphertext (same length as the block), and GCM tag (16).

The terminal sealed block is 92 bytes. Exact stored size is `140 + plaintextLength + 60 * ceil(plaintextLength / 8388608)`. Empty plaintext has a header and terminal block. Reject invalid lengths, missing/trailing bytes, authentication failures, terminal digest mismatches and a whole-payload keyed ID mismatch. Each chunk authenticates before entering a private restore staging file; the destination is published only after the complete payload passes validation. Previews and manifests are returned only after complete validation.

The derived key binds the vault, bucket, exact name, type, format, key version, length, upload salt and chunk index. Reordering or transplanting blocks between those contexts fails authentication. Object sizes, timestamps, counts and traffic remain visible to storage.

## Durable uploads

Before the first request, encrypt the complete payload into owner-only durable local staging. Persist its ciphertext SHA-256, plaintext identity/size, upload ID and sequential accepted part numbers/ETags. Flush files and directory entries before sending. Multipart parts are slices of staged ciphertext; their boundaries do not have to match encryption blocks.

Retries and worker restarts reuse identical staged bytes. A lost part response can repeat the same part number and bytes. An expired multipart session starts another session for those same bytes. A lost completion is accepted only when the exact stored version's ciphertext digest matches staging. New encryption attempts use a fresh upload salt and fresh block nonces; they never reuse a saved upload's cryptographic context with different bytes.

Manifests use conditional creation. Their transport receipts remain staged until the signed history and local manifest index are committed. Database receipts remain staged until the worker's database checkpoint is committed. A retry after completion reuses that receipt without another transfer. Storage errors preserve interrupted client upload state; they do not abort or restart the whole backup. Legacy upload behavior is unchanged.

The worker checkpoints its manifest name/write version and database dump identity before upload. A resumed database phase keeps that dump and addresses the same staged ciphertext after a root rotation or flag change. A fresh run removes abandoned temporary dumps.

Client deduplication authenticates and hashes the exact stored object before skipping it; a same-size HEAD cannot clear a detected storage fault. This requires a read of each reused client object. The legacy presence index contains only legacy addresses, and switching back to legacy writes checks those addresses when client roots are loaded.

## Manifest schema 3

The encrypted payload is the existing gzip JSON manifest with `version:3`, including asset records, related metadata, albums, people, profiles and database references. Each file additionally carries its exact `objectKey`. Database `key` already names its exact stored object. References must belong to the manifest's vault and supported client namespace. Legacy manifests omit `objectKey` and use `o/<plaintext-sha256>`.

Retention reads every kept manifest before deleting data and preserves every exact referenced object, including copies under different key versions. A missing anchored current head stops cleanup. Verification marks missing or unauthenticated references degraded. Legacy and client histories coexist without rewriting older objects.

The manifest describes included files, rather than selection rules. `manifestReferences()` supplies retention with plaintext checksum/size pairs and every exact stored object key for each checksum; database references remain exact keys. These references are local to the application and encrypted payload. The existing managed run report sends numeric bytes uploaded, objects uploaded/skipped, status and times; it does not establish total included-original coverage or distinguish intentional exclusions from missing/damaged originals. A future numeric coverage extension must define those counts separately and preserve this manifest/reference seam. Album, person, tag and folder names/IDs, selectors and selection rules must stay out of Cloud telemetry and opaque snapshot descriptors.

## Signed snapshot authority

Encryption establishes authenticity of contents, not freshness. Recovery pins an Ed25519 signing identity and a latest sequence/digest outside mutable provider heads. After manifest completion, sign this descriptor with the existing instance identity:

```json
{
  "version": 2,
  "instanceId": "UUID",
  "vaultId": "UUID",
  "snapshotId": "UUID",
  "sequence": 1,
  "previousDigest": null,
  "createdAt": "UTC ISO timestamp",
  "manifest": {
    "format": "frameleaf-client-backup",
    "formatVersion": 1,
    "keyVersion": 1,
    "objectKey": "m/v1/<vaultId>/1/<time>.json.gz",
    "versionId": "non-null provider version ID",
    "ciphertextSha256": "64 lowercase hex characters"
  },
  "signerKid": "Ed25519 public JWK thumbprint"
}
```

Canonical signing bytes are UTF-8 `frameleaf-backup-snapshot-v2\n` followed by compact JSON with fields in exactly the displayed order, including nested manifest fields. The digest is lowercase hex SHA-256 of those bytes; the signature is raw Ed25519 encoded as unpadded base64url. The public JWK's `kid` is its RFC 7638 thumbprint.

Local recovery history is `{pinnedKeys,snapshots,anchor}`. A snapshot record is `{descriptor,signature,digest,signerJwk,receivedAt}`. The anchor is `{instanceId,vaultId,sequence,digest}`. Keys, records and anchors are validated; conflicting imports, duplicate identities, missing anchors and broken historical chains are refused. Cloud receives only `{descriptor,signature}` at `/v2/backup/snapshots`, authenticated with the instance's existing DPoP token. Cloud history never advances a local anchor by itself.

Stored-key setup durably retains accepted imported authority, including an existing-file upgrade. CLI restore/export reconciles an imported kit with established local history, using the claimed stable storage reference for managed storage. An offline export selects its recorded restore point by default while retaining the full latest anchor for historical verification.

Read the manifest by its trusted exact provider `versionId`, then verify ciphertext SHA-256 and authenticated payload. A current delete marker or substituted head cannot select an older snapshot automatically. Missing trusted versions fail. Historical selection is explicit, and newer unanchored history is reported. Operation capabilities used for these reads must permit exact-version access; authorization failure preserves staging and stops the operation.

## Recovery package 2

Only server-key mode may escrow. Wrap the complete key-file JSON, including independent/historical roots, the legacy key and pinned history, locally. Use the existing normalized-passphrase scrypt parameters N=131072, r=8, p=1, 32-byte output, random 16-byte salt and AES-256-GCM with a random 12-byte nonce. Associated data is UTF-8 `frameleaf-backup-recovery/2/<vaultId>/<currentKeyVersion>`. Ciphertext includes the final 16-byte tag and uses standard padded base64.

Outer fields are the existing escrow shape plus `version:2`, `vaultId` and `keyVersion`; no roots, passphrase or descriptive metadata is outside the ciphertext. `/v2/backup/escrow` preserves separate key versions. The current schema permits 4096 decoded ciphertext bytes, so complete kit JSON is limited to 4080 bytes. Oversized kits require local export and are never truncated. Legacy v1 escrow remains readable. An existing escrow or export anchor records the latest snapshot when that kit was created; refresh the kit to advance it.

Local synthetic tests exercise framing, adversarial payloads, separate roots/rotation, multipart restart, lost completions, exact-version selection, legacy compatibility and offline filesystem recovery. They do not establish live provider policy, native Object Lock, NAS filesystem durability or a complete PostgreSQL replacement-server restore.
