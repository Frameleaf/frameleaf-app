# Push envelope v1 (`frameleaf-push-v1`)

This page specifies how a Frameleaf server encrypts a push notification for one device, and how the device decrypts it. The Frameleaf apps for iOS and Android implement the device side from this page alone. The server side is FL-228 (push device registry and delivery). The push gateway (`push.frameleaf.cloud`, FC-92) carries the encrypted blob without being able to read it.

Every value below is exact: byte lengths, string spellings and field names are part of the protocol.

## Overview

1. **Device key.** When the app registers for push (`PUT /api/push/devices/current`), it creates an X25519 key pair and sends the server only the raw 32-byte public key.
2. **Sealing.** For every push, the server builds a JSON payload and seals it to that key. Sealing uses:
   - a fresh ephemeral X25519 key pair for each push;
   - HKDF-SHA256 to derive the key;
   - AES-256-GCM to encrypt.
3. **Delivery.** The sealed bytes, base64url-encoded, are the **envelope**. The gateway puts the envelope in the platform message as the field `e`.
4. **Opening.** The device's Notification Service Extension (iOS) or messaging service (Android) opens the envelope with its private key and shows the notification from the plaintext.

The gateway, APNs and FCM see only the opaque envelope.

## The device key

- **Algorithm:** X25519 (Curve25519 Diffie-Hellman, RFC 7748).
- **What is registered:** the raw 32-byte public key, encoded as base64url without padding, in the `publicKey` field of the push device registration. On iOS this is CryptoKit `Curve25519.KeyAgreement.PublicKey.rawRepresentation`; on Android it is the Tink or Keystore raw X25519 public key.
  - The server also accepts standard base64, with or without padding. It stores the key normalised to unpadded base64url.
  - Any value that does not decode to exactly 32 bytes is refused.
- **Private key:** never leaves the device. Store it where the Notification Service Extension or messaging service can read it (on iOS, a shared keychain access group).
- **Rotation:** send the new public key with `PATCH /api/push/devices/current`. Envelopes already in flight were sealed to the old key, so keep the old private key until in-flight pushes have arrived.
- **Fingerprint:** the device list shows `publicKeyFingerprint`, the first 16 hex characters of SHA-256 over the raw 32 public-key bytes. It is for display only.

## Envelope byte layout

The envelope is the base64url encoding (RFC 4648 §5, **no padding**) of these bytes:

| Offset | Length | Field                | Value                                                                  |
| ------ | ------ | -------------------- | ---------------------------------------------------------------------- |
| 0      | 1      | version              | `0x01`                                                                 |
| 1      | 32     | ephemeral public key | The raw X25519 public key the server made for this push                |
| 33     | 12     | nonce                | Random 96-bit AES-GCM nonce                                            |
| 45     | n      | ciphertext           | AES-256-GCM ciphertext of the plaintext (same length as the plaintext) |
| 45 + n | 16     | tag                  | AES-GCM authentication tag (128 bits)                                  |

The total length is 61 + n bytes, where n is the plaintext length in bytes. The shortest valid envelope is 61 bytes, for an empty plaintext. Refuse anything shorter, and anything whose first byte is not `0x01`.

## Key agreement and key derivation

| Step                   | Inputs                                                                                                                                                                                                                       | Output          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| Shared secret          | X25519(device private key, ephemeral public key from bytes 1–32). The server computes the same value as X25519(ephemeral private key, device public key).                                                                    | 32 bytes        |
| Low-order check        | If the shared secret is all zero bytes, the key is unusable. The server never seals to such a key.                                                                                                                           | Refuse          |
| HKDF-SHA256 (RFC 5869) | IKM = the shared secret.<br/>Salt = ephemeral public key (32 raw bytes) ‖ device public key (32 raw bytes), 64 bytes in that order.<br/>Info = the ASCII bytes of `frameleaf-push-v1` (17 bytes, no terminator).<br/>L = 32. | 32-byte AES key |

`‖` means byte concatenation. The device public key in the salt is the device's own raw public key: the same 32 bytes it registered.

## Encryption

| Parameter                     | Value                                                                       |
| ----------------------------- | --------------------------------------------------------------------------- |
| Algorithm                     | AES-256-GCM                                                                 |
| Key                           | The 32-byte HKDF output                                                     |
| Nonce                         | The 12 bytes at offset 33                                                   |
| Additional authenticated data | The first 33 bytes of the envelope: version (`0x01`) ‖ ephemeral public key |
| Tag                           | 16 bytes, appended after the ciphertext                                     |

To open an envelope:

1. Decode the base64url.
2. Check the version byte and the length.
3. Compute the shared secret and the key as above.
4. Decrypt with the AAD and tag.

Any failure means the envelope was not sealed to this key or was changed. Discard it, and show the placeholder text or nothing.

## Versioning

- **Version byte.** The first envelope byte and the HKDF info string together name the version: `0x01` and `frameleaf-push-v1`. A future incompatible change gets a new version byte and a new info string. A device that meets an unknown version byte discards the push.
- **Plaintext version.** The plaintext carries its own version, `v: 1`. Within plaintext version 1:
  - new fields and new values may be added;
  - unknown fields are ignored;
  - an unknown `type` is shown with its `title` and `body` and no special handling.

## Plaintext

The plaintext is one JSON object, UTF-8 encoded, at most **2048 bytes**. The server shortens `body`, then `title`, until the object fits.

| Field        | Type             | Meaning                                                                                                                                                                        |
| ------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `v`          | number           | Always `1`                                                                                                                                                                     |
| `id`         | string (UUID)    | This message's id, the same one the gateway uses for deduplication. A device can drop a repeated `id`.                                                                         |
| `type`       | string           | The event type (see below)                                                                                                                                                     |
| `sentAt`     | string           | ISO 8601 UTC time the server built the message, e.g. `2026-10-01T12:00:00.000Z`                                                                                                |
| `title`      | string           | English fallback title, at most 120 characters. The app may localise from `type` and `data` instead.                                                                           |
| `body`       | string           | English fallback text, at most 400 characters                                                                                                                                  |
| `data`       | object           | Event details: plain values only (strings, numbers, booleans, null); never file paths or credentials                                                                           |
| `assetIds`   | string[]         | Up to 5 asset ids the notice is about. Locked, sensitive or hidden items are never included, and any `data` value naming one is dropped too. Always empty for a Live Activity. |
| `preview`    | object or null   | `{ "assetId": … }`, the first of `assetIds` (the app may fetch its thumbnail), or null                                                                                         |
| `activation` | object, optional | The Cloud Backup activation progress, only for `cloud-backup-activation` (see below)                                                                                           |

### Event types and their `data`

| `type`                    | When                                                                          | `data` fields                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `backup-needs-attention`  | Phone backup reconciliation found missing items                               | `deviceId`, `itemsMissing` (number), `reason: "reconciliation-missing"`                                                                                               |
|                           | Cloud backup needs the owner (administrators)                                 | `reason`: the server's notice key                                                                                                                                     |
|                           | The backup plan outgrew its tier (FL-301; the server owner only)              | `reason: "tier-overflow"`, `screen: "plan"`, `caseId`, `status` (`asked`, `accepted`, `declined`), `currentTier`, `suggestedTier` (or null), `backupPaused` (boolean) |
|                           | Backups are paused because the plan is full (FL-301; administrators)          | `reason: "plan-full"`, `screen: "plan"`, `action` (`upgrade` or `ask-organiser`)                                                                                      |
| `backup-stale`            | A silent wake-up for a device whose phone backup has not succeeded for 2 days | `backupDeviceKey`, `pendingCount` (number), `lastSuccessfulBackupAt` (ISO time)                                                                                       |
| `cloud-backup-activation` | A step of the Cloud Backup activation chain                                   | `step`, `total` (numbers), `stage`, `state`                                                                                                                           |
| `shared-activity`         | New items in a shared album                                                   | `albumId`, `action: "items-added"`                                                                                                                                    |
|                           | Invited to a shared album                                                     | `albumId`, `action: "invited"`                                                                                                                                        |
|                           | Items shared with you                                                         | `ownerId`, `count`, `action: "items-shared"`                                                                                                                          |
|                           | Mentioned in a shared space                                                   | `albumId`, `activityId`, `action: "mentioned"`, optional `assetId`                                                                                                    |
|                           | A reply to your comment                                                       | `albumId`, `activityId`, `action: "replied"`, optional `assetId`                                                                                                      |
| `memories`                | New memories are ready                                                        | `count`                                                                                                                                                               |
| `render-finished`         | A Studio render finished or failed                                            | `versionId`, `projectId`, `status` (`published` or failed), and the render's `job` fields (see below)                                                                 |
| `render-progress`         | A Studio render started, or made progress (background push)                   | `kind: "render"`, `state` (`started` or `running`), `progress` (0–1), `versionId`, `projectId`, and the render's `job` fields (`pause,cancel`)                        |
| `access-changed`          | Your role in an album changed                                                 | `albumId`, `change: "role"`, `role`                                                                                                                                   |
|                           | A partner shared or stopped sharing their library                             | `partnerId`, `change` (`partner-added` or `partner-removed`)                                                                                                          |

`data` values that name an item withheld for privacy are removed. A device must not assume an optional field is present.

### Server jobs: `job`, `jobType`, `jobActions`

A notice about a server job names it, so the app can offer Retry or Pause:

| Field        | Meaning                                                                                                                                                                                                                                   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `job`        | The job's id                                                                                                                                                                                                                              |
| `jobType`    | `media-operation`: `POST /media-operations/{job}/retry`, `/pause`, `/resume`, `/cancel`. `cloud-backup-run` (administrators): `POST /admin/cloud/backup/runs/{job}/pause`, `/resume`, `/cancel`; Retry is `POST /admin/cloud/backup/runs` |
| `jobActions` | Comma-separated actions on offer when the push was built (`retry`, `pause`, `resume`, `cancel`); may be empty                                                                                                                             |

They are sent with `render-progress` (the running Studio render; `pause,cancel`), with `render-finished` (the Studio render; no generic Retry action: reopen `projectId`/`versionId` in Studio to create a new export) and with the cloud backup notices of `backup-needs-attention`: a failed backup run (`retry`), a run waiting for its key (`pause,cancel`), and a failed verification, clean-up or restore (no action; started again from settings). The job's state may have moved on by the time the device shows the notice: the endpoints answer with the current state.

### `activation`

| Field           | Values                                                                |
| --------------- | --------------------------------------------------------------------- |
| `step`, `total` | Numbers, e.g. 3 and 4                                                 |
| `stage`         | `plan-active`, `server-notified`, `preparing-storage`, `first-backup` |
| `state`         | `active`, `complete`, `failed`                                        |
| `firstRun`      | `not-started`, `queued`, `running`, `done`, `failed`                  |
| `nextRunAt`     | ISO time or null                                                      |

## Delivery: where the envelope is, and what `t` means

The gateway wraps the envelope in the platform message. Nothing else from the plaintext reaches Apple or Google.

| Push                | APNs body                                                                                                                                                                                                                                        | FCM message                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Alert               | `{"aps":{"alert":{"title":"Frameleaf","body":"You have a new notification."},"mutable-content":1,"sound":"default"},"e":"<envelope>"}`. The Notification Service Extension replaces the placeholder alert with the decrypted `title` and `body`. | `data: {"e":"<envelope>","t":"alert"}`      |
| Background (silent) | `{"aps":{"content-available":1},"e":"<envelope>"}`                                                                                                                                                                                               | `data: {"e":"<envelope>","t":"background"}` |
| Live Activity (iOS) | `aps.content-state` is a small fixed, non-personal state. It is not an envelope, because ActivityKit renders the state itself and no extension can decrypt it (see Live Activity content state below).                                           | —                                           |

- **`e`** is always the envelope string exactly as sealed.
- **`t`** appears only in FCM data messages. It is the gateway's push type, `alert` or `background`. FCM data messages have no `aps` to say how they should be shown, so `t` tells the Android app whether to post a visible notification (`alert`) or work silently (`background`).
- **`t` is not authenticated.** It is outside the envelope, so it only says how to handle the push, never what it is about. The event type is the plaintext's `type`, which is authenticated.

### Live Activity content state

Live Activity pushes (iOS only) carry no envelope and no text. `aps.content-state` is exactly this JSON object, and nothing else from the server reaches ActivityKit:

| Field      | Type                | Meaning                                                    |
| ---------- | ------------------- | ---------------------------------------------------------- |
| `step`     | string              | One of the steps below                                     |
| `progress` | number 0–1, omitted | How far through the activation chain (the step's position) |
| `done`     | integer, optional   | Reserved for counts; the server does not send it today     |
| `total`    | integer, optional   | Reserved for counts; the server does not send it today     |

The steps the gateway allows are `plan-active`, `server-notified`, `storage-ready`, `first-backup`, `backup-running`, `backup-done`, `render-running`, `render-done` and `needs-attention`. The Cloud Backup activation chain (`activation` in the plaintext) maps onto them like this:

| Activation stage              | `step`            | `progress`   |
| ----------------------------- | ----------------- | ------------ |
| `plan-active`                 | `plan-active`     | step ÷ total |
| `server-notified`             | `server-notified` | step ÷ total |
| `preparing-storage`           | `storage-ready`   | step ÷ total |
| `first-backup`, still running | `first-backup`    | step ÷ total |
| `first-backup`, complete      | `backup-done`     | 1            |
| any stage, failed             | `needs-attention` | omitted      |

A Studio render (`render-progress`, then `render-finished`) maps onto them like this:

| Render                   | `step`            | `progress` |
| ------------------------ | ----------------- | ---------- |
| started or running       | `render-running`  | 0–1        |
| finished (`published`)   | `render-done`     | 1          |
| failed (its retry spent) | `needs-attention` | omitted    |

The activity's lifecycle is driven by the push type:

- `live-activity-start` is sent to the push-to-start token, with attributes type `ActivationAttributes` (activation) or `RenderAttributes` (render). A render activity is started only by the render's `started` push, and only when that job has no bound `studio-render` activity token registered.
- `live-activity-update` is sent while the chain runs. Each update has a stale date one hour after it is sent.
- `live-activity-end` is sent when the chain completes or fails. An ordinary alert carrying the full plaintext follows it.
- Activity tokens are registered per kind (`PUT /push/devices/current/activities/{activityId}` with `kind` `cloud-backup-activation` or `studio-render`); the app removes one when its activity ends (`DELETE` on the same path). A `studio-render` registration must include `operationId`, the owned Studio render job that activity follows. The binding cannot change to another job: use a new activity id. Updates and terminal messages target only that job; unbound legacy render tokens fail closed. Cloud Backup activation registration is unchanged.

An update that could not be delivered is not sent again, because the next update replaces it.

### APNs environment

A development build gets APNs sandbox tokens, and only APNs sandbox delivers to them. Register such a build with `apnsEnvironment: "sandbox"` (`PUT /api/push/devices/current`, or later with `PATCH`; iOS only). The server then routes its pushes through the gateway as `apns-sandbox`. Production builds leave the field out.

## Test vectors

The server's own sealing code (`sealPushEnvelope`) produced these, with the ephemeral key and nonce fixed instead of random. Its opening code (`openPushEnvelope`) round-trips each one, and the shared secret and key were recomputed independently.

- **Keys** are X25519 scalars as raw bytes. X25519 clamps them as RFC 7748 specifies.
- **Plaintexts** are the exact bytes encrypted. The JSON key order matters only because these are the exact bytes; a device never needs to re-serialise.
- **Vector 3** has a non-ASCII character (`·`), so its byte length is greater than its character count.

### Vector 1

| Input                                        | Value                                                              |
| -------------------------------------------- | ------------------------------------------------------------------ |
| Device private key (hex)                     | `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` |
| Device public key (raw, hex)                 | `14ca9e4d387bccf35746e0407daaacc6b28a4f8445ef5a5158894db983e24070` |
| Device public key, as registered (base64url) | `FMqeTTh7zPNXRuBAfaqsxrKKT4RF71pRWIlNuYPiQHA`                      |
| Ephemeral private key (hex)                  | `0101010101010101010101010101010101010101010101010101010101010101` |
| Ephemeral public key (raw, hex)              | `a4e09292b651c278b9772c569f5fa9bb13d906b46ab68c9df9dc2b4409f8a209` |
| Nonce (hex)                                  | `000102030405060708090a0b`                                         |
| Shared secret X25519 (hex)                   | `1417b6af6bfeaedaf293e9d6f906eb3255b30c1645520763eb908953bb47e866` |
| HKDF output key (hex)                        | `8ee2697d1496ae14591e3ed74092c6443ebc0bf6b81d408fa7588251f59b1806` |

Plaintext (UTF-8, 206 bytes, exactly these bytes):

```json
{
  "v": 1,
  "id": "0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e10",
  "type": "memories",
  "sentAt": "2026-10-01T12:00:00.000Z",
  "title": "Memories",
  "body": "3 new memories are ready",
  "data": { "count": 3 },
  "assetIds": [],
  "preview": null
}
```

Ciphertext (hex): `2fd82ceb773c64a5c050d55ee5ba917d626269434fa2fb709bd119527ccae0a76e7addea1e818e519799e7c0fe6ae041f40076349ea47910616368e5c4d922303fc3189e8348ad4554d4479503b72cac387f43e54f608ae31043804223a83e699089e2652ee88b86f66486d5040beca7b6fbbfa8314d228c5d3a8217e162df59118f8736be67ed2c0ef878a4c60310b64b94c18afb209edbd03c6ab93ee849d549d1e89e544cb671c6e5a0086b28aed94ff4d36529881146849ba040f6fd2030312822bcf1036205873603deb743`

Tag (hex): `940c6669ad1fc904e3f51fc50fafd88f`

Envelope (base64url, the value of `e`):

```text
AaTgkpK2UcJ4uXcsVp9fqbsT2Qa0araMnfncK0QJ-KIJAAECAwQFBgcICQoLL9gs63c8ZKXAUNVe5bqRfWJiaUNPovtwm9EZUnzK4Kduet3qHoGOUZeZ58D-auBB9AB2NJ6keRBhY2jlxNkiMD_DGJ6DSK1FVNRHlQO3LKw4f0PlT2CK4xBDgEIjqD5pkIniZS7oi4b2ZIbVBAvsp7b7v6gxTSKMXTqCF-Fi31kRj4c2vmftLA74eKTGAxC2S5TBivsgntvQPGq5PuhJ1UnR6J5UTLZxxuWgCGsortlP9NNlKYgRRoSboED2_SAwMSgivPEDYgWHNgPet0OUDGZprR_JBOP1H8UPr9iP
```

### Vector 2

| Input                                        | Value                                                              |
| -------------------------------------------- | ------------------------------------------------------------------ |
| Device private key (hex)                     | `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` |
| Device public key (raw, hex)                 | `6b0b616d718e53691236d3be3ce6d44f9d28836426d81305d131f488206f8d2b` |
| Device public key, as registered (base64url) | `awthbXGOU2kSNtO-PObUT50og2Qm2BMF0TH0iCBvjSs`                      |
| Ephemeral private key (hex)                  | `0202020202020202020202020202020202020202020202020202020202020202` |
| Ephemeral public key (raw, hex)              | `ce8d3ad1ccb633ec7b70c17814a5c76ecd029685050d344745ba05870e587d59` |
| Nonce (hex)                                  | `f0f1f2f3f4f5f6f7f8f9fafb`                                         |
| Shared secret X25519 (hex)                   | `7906ba4ce5995076c9d43deb31b7044967971a6b2537d31224c4e2ac87e54d74` |
| HKDF output key (hex)                        | `0b41919e13211784ec92164c222fdb5648ecd60f4273f538316ea3f2053bf1f5` |

Plaintext (UTF-8, 373 bytes, exactly these bytes):

```json
{
  "v": 1,
  "id": "0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e11",
  "type": "shared-activity",
  "sentAt": "2026-10-01T12:05:00.000Z",
  "title": "Family trip",
  "body": "New items were added to Family trip",
  "data": { "albumId": "8f6a3c1e-2b4d-4e5f-9a0b-1c2d3e4f5a6b", "action": "items-added" },
  "assetIds": ["5b2c7d8e-9f01-4a23-8b45-6c7d8e9f0a1b"],
  "preview": { "assetId": "5b2c7d8e-9f01-4a23-8b45-6c7d8e9f0a1b" }
}
```

Ciphertext (hex): `1ad52fddda5e6df6fd4dd70ca4c01392e635d33d799a13957cfdfbd6333b7c549a2c4731a5ac80ee97a4b9000fb8fe07de794622fdfba445fa7134cdf60426a7dc015a5b6f9837b0bcd86cf3c5e64117a8a26707722f11f89c7ee1a00abeef223ceba28b7b56b0a27b1db2f42df0329e849e22312a903756ed767932c1c5da1a5fd6c9edb16209b5afd767cc03d2e16c178427e395855e5e375fd6323f2a8bd8b58d89eee769207e68edb21ab9e0e3a99575dc2945ca602c6216ea6ae9a0aaa9527a706be4369a11c23dc593d80e9b6b3ae137cef2b69e3606f3a6737687f36e4ff79824a63a4537fe75726a656a8a2a9407605a3029cd542e21772872b442d3ae933b1789f268c1bdf999bfabaa01ef3c9e8bac97057bd9c096e7a810e38b94a525f56ab881fda2c96eacb0238a6a8ad69d09f358c0068110f29b71d3fe3c4d9b96f925b5b161e84682bdba6b2252806006637be62ff934ad758859f28905aa5d17f81c0dabc3dbb6c6623828dea4816efe3f3634`

Tag (hex): `6321966dc1e4e245253397d7a8e4fe6f`

Envelope (base64url, the value of `e`):

```text
Ac6NOtHMtjPse3DBeBSlx27NApaFBQ00R0W6BYcOWH1Z8PHy8_T19vf4-fr7GtUv3dpebfb9TdcMpMATkuY10z15mhOVfP371jM7fFSaLEcxpayA7pekuQAPuP4H3nlGIv37pEX6cTTN9gQmp9wBWltvmDewvNhs88XmQReoomcHci8R-Jx-4aAKvu8iPOuii3tWsKJ7HbL0LfAynoSeIjEqkDdW7XZ5MsHF2hpf1sntsWIJta_XZ8wD0uFsF4Qn45WFXl43X9YyPyqL2LWNie7naSB-aO2yGrng46mVddwpRcpgLGIW6mrpoKqpUnpwa-Q2mhHCPcWT2A6bazrhN87ytp42BvOmc3aH825P95gkpjpFN_51cmplaooqlAdgWjApzVQuIXcocrRC066TOxeJ8mjBvfmZv6uqAe88nouslwV72cCW56gQ44uUpSX1ariB_aLJbqywI4pqitadCfNYwAaBEPKbcdP-PE2blvkltbFh6EaCvbprIlKAYAZje-Yv-TStdYhZ8okFql0X-BwNq8PbtsZiOCjepIFu_j82NGMhlm3B5OJFJTOX16jk_m8
```

### Vector 3

| Input                                        | Value                                                              |
| -------------------------------------------- | ------------------------------------------------------------------ |
| Device private key (hex)                     | `cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc` |
| Device public key (raw, hex)                 | `e8980c4ea5ebf8fb6c281098b75cdd32862922a638778251979b6d322ed7e02e` |
| Device public key, as registered (base64url) | `6JgMTqXr-PtsKBCYt1zdMoYpIqY4d4JRl5ttMi7X4C4`                      |
| Ephemeral private key (hex)                  | `0303030303030303030303030303030303030303030303030303030303030303` |
| Ephemeral public key (raw, hex)              | `5dfedd3b6bd47f6fa28ee15d969d5bb0ea53774d488bdaf9df1c6e0124b3ef22` |
| Nonce (hex)                                  | `111111111111111111111111`                                         |
| Shared secret X25519 (hex)                   | `3133209d6186d8168cebd5439d8610862c8a0e1fa799d6ee44e1abc6b8aa7d37` |
| HKDF output key (hex)                        | `dfab8ba1cdd8f0cb3d33dfae296852e69eb04bb7fb83e57e2d327c302a78ec88` |

Plaintext (UTF-8, 409 bytes, exactly these bytes):

```json
{
  "v": 1,
  "id": "0192f1b0-1a2b-7c3d-8e4f-5a6b7c8d9e12",
  "type": "cloud-backup-activation",
  "sentAt": "2026-10-01T12:10:00.000Z",
  "title": "Cloud Backup setup",
  "body": "3 of 4 · Preparing storage",
  "data": { "step": 3, "total": 4, "stage": "preparing-storage", "state": "active" },
  "assetIds": [],
  "preview": null,
  "activation": {
    "step": 3,
    "total": 4,
    "stage": "preparing-storage",
    "state": "active",
    "firstRun": "not-started",
    "nextRunAt": null
  }
}
```

Ciphertext (hex): `5df0936c6de02cc111a7f79d17b7f58c4bc52212d733144467ebc33f364537d71a5d08695486817d99d64df4f4795aa769bc473ae1647e62b53d5995a80960b7d851dafed8e4f9b0a720234c1776109de8770ab67c72ce6085ba21236cca724a10ba005bbed5aa4fd219d0db87dd5852bdf96b22df9d4575a74561de6eaf25acd532fd1bec4fb7f9d4f815c48e874f4c541a8e884cece8e08a9fbb418ecfb76e0714dadd0684950975a145e276b12d7c023e8445fcfb3973427693c9ab9e9c4cbf0cedefc8876b817d78178fbe2ff290389f186b7c98cb98c637cfcd366e3f16584516ae478c99dfb616dfad643e0d7334ce86a9275a36f0deeae5c9483ea3213279b2db6bb58f12dd34b7dc6e17dc45b9d844031572d9b91798c1b8b23fb4def34313d3c88b4c98a00851a09963d3e3a8f1b9d1081d9c62f4524e923c0425e9c4623d0fd1088421327a3c9c6e87fbddfd0e4d4d9150d67f932514fe2def150fb4a3f77fcde1977a441e672829d35a3f20b6079179e728ba2058c9f80796ac16d165e54a6a54efd7ed3080752980921798d22b223dbbe25465`

Tag (hex): `06844b6e0cec0ec77737c5af645fb882`

Envelope (base64url, the value of `e`):

```text
AV3-3Ttr1H9voo7hXZadW7DqU3dNSIva-d8cbgEks-8iERERERERERERERERXfCTbG3gLMERp_edF7f1jEvFIhLXMxREZ-vDPzZFN9caXQhpVIaBfZnWTfT0eVqnabxHOuFkfmK1PVmVqAlgt9hR2v7Y5PmwpyAjTBd2EJ3odwq2fHLOYIW6ISNsynJKELoAW77Vqk_SGdDbh91YUr35ayLfnUV1p0Vh3m6vJazVMv0b7E-3-dT4FcSOh09MVBqOiEzs6OCKn7tBjs-3bgcU2t0GhJUJdaFF4naxLXwCPoRF_Ps5c0J2k8mrnpxMvwzt78iHa4F9eBePvi_ykDifGGt8mMuYxjfPzTZuPxZYRRauR4yZ37YW361kPg1zNM6GqSdaNvDe6uXJSD6jITJ5sttrtY8S3TS33G4X3EW52EQDFXLZuReYwbiyP7Te80MT08iLTJigCFGgmWPT46jxudEIHZxi9FJOkjwEJenEYj0P0QiEITJ6PJxuh_vd_Q5NTZFQ1n-TJRT-Le8VD7Sj93_N4Zd6RB5nKCnTWj8gtgeReecouiBYyfgHlqwW0WXlSmpU79ftMIB1KYCSF5jSKyI9u-JUZQaES24M7A7HdzfFr2RfuII
```

A cancelled render sends a silent terminal `render-progress` payload with `state`/`status` `cancelled` and no actions. Cancellation delivery is idempotent. A render terminal activity message still ends the matching activity when `renderFinished` alerts are disabled; the ordinary finish alert stays suppressed. `/push/status` event names are open-ended; ignore unfamiliar names.
