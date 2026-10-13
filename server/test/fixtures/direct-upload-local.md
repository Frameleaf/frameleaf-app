# Isolated direct-upload fixture

Use a fresh local PostgreSQL 19 Frameleaf test database and an owned temporary
media directory. Never use application/customer data or production credentials.
The existing medium test global setup builds `docker/postgres`, creates a fresh
database and runs current source migrations.

From the repository root:

```sh
pnpm install --filter frameleaf... --frozen-lockfile
pnpm --filter @frameleaf/sdk build
pnpm --filter @frameleaf/plugin-sdk build
pnpm --dir server build
pnpm --dir server test:medium run test/medium/specs/repositories/direct-upload-admission.spec.ts test/medium/specs/services/asset-upload-direct.spec.ts
```

The medium peer test uses actual AuthService, a real synthetic session, native
upload resources, immutable files and PostgreSQL publication. It drops a commit
ACK, reads HEAD, uploads only the suffix and checks one asset plus final bytes and
SHA-256. STUN is disabled only in this loopback fixture's real peers.

For simulator/emulator API interoperability, the parent integration owner starts
the built server from `server/` with the fixture-only `DB_URL`,
`FRAMELEAF_MEDIA_LOCATION` and `FRAMELEAF_PORT` environment values:

```sh
node dist/main.js
```

When the parent owns a binding-only local Cloud STUN listener on UDP 3479, its
fixture process can set `NODE_OPTIONS=--import=/absolute/path/to/server/test/fixtures/direct-upload-runtime-preload.mjs`.
This overrides only the test process's real peer factory, including inherited
API workers, to use `stun:127.0.0.1:3479`. Production source keeps the approved
Frameleaf hosts. Never use this preload in a deployed server.

Provide the same static geodata/runtime assets that the existing local server
fixture expects. Bootstrap a synthetic administrator through
`POST /api/auth/admin-sign-up`, log in with `POST /api/auth/login`, and create an
upload/read API key with `POST /api/api-keys`. Direct transport always uses WAN
authorization, so link this synthetic local account with an isolated
`public.frameleaf_account_link` fixture row, or tag its synthetic session through
`FrameleafAccountRepository.tagSession`. Do not disable the production WAN guard.
Store fixture credentials only in a local mode-0600 file excluded from Git.

Create an empty incomplete resource with native interop version 9, complete-file
SHA-256 `Repr-Digest`, expected length and canonical base64url `Asset-Metadata`.
Send the complete offer to its direct endpoint; send binary bytes only on the
resource-scoped data channel. Terminate/delete incomplete synthetic resources
after failed attempts so the existing four-resource native admission cap remains
meaningful. The direct peer cap is independently sixteen global/two per owner.

The parent owns shared fixture startup/restarts and final simulator qualification.
Do not run a second server on the same fixture port or restart another owner's
process while a native client is transferring.
