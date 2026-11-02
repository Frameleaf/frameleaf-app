# Threat model

## What this project does and where untrusted input enters
Frameleaf is a self-hosted photo and video library: a NestJS server (`server/`), a SvelteKit web app (`web/`),
a Python machine-learning service (`machine-learning/`), a CLI (`packages/cli/`) and plugin SDKs
(`packages/plugin-sdk/`, `packages/plugin-core/`). One server hosts several user accounts, each with its own
library; users share with each other through partners, albums, shared links and shared spaces.

Untrusted input:
- **HTTP API and WebSocket** (`server/src/controllers/`, `server/src/middleware/websocket.adapter.ts`), from
  anonymous visitors, shared-link holders, and signed-in users of any role.
- **Uploaded media and sidecars** (`asset-media`, `asset-upload-resource`, `takeout`, iCloud and Immich import).
  Files are parsed by exiftool, ffmpeg, libvips/sharp, libheif, libraw and darktable. Treat every uploaded
  file and every metadata field as hostile.
- **Studio project imports and bundles** (`studio-*.controller.ts`), which carry project JSON and media references.
- **Remote peers**: Buddy Backup peers, Frameleaf Cloud link and relay traffic (`frameleaf-remote-access*`,
  `buddy-backup*`, `cloud-*`). A peer server is less trusted than the local admin.
- **External libraries and import folders** on disk: file names and paths are attacker-influenced.

Trusted: the server operator (environment variables, `docker-compose`, the host filesystem), the admin user's
system settings, and the database. The machine-learning service is reached only from the server on a private
network and is not authenticated; report it only where server-supplied input reaches a flaw.

## Components that matter most / least
Most:
- Authentication and authorization: `server/src/middleware/auth.guard.ts`, `server/src/services/auth.service.ts`,
  `server/src/services/frameleaf-auth.service.ts`, API keys, sessions, OAuth.
- Access checks: `server/src/utils/access.ts` and the `*access*` repository queries. Any path where one user reads,
  changes or deletes another user's assets, albums, faces, people, metadata or location.
- Locked and hidden items: these must reach partners only and never appear through albums, shared links,
  shared spaces, search, timeline, sync or Studio.
- Shared links: a link holder must see only what the link grants (and no EXIF/location when the link hides it).
- Path handling: `server/src/utils/library-paths.ts`, `studio-managed-paths.ts`, storage templates, external
  libraries, downloads and archives. Path traversal, symlink escapes, arbitrary file read or write.
- Media processing: command or argument injection into ffmpeg/exiftool/darktable, and parser bugs reachable by upload.
- SSRF from any server-side fetch whose URL a user controls (webhooks, workflows, plugins, imports, Cloud/relay).
- Crypto and secrets: `cloud-backup-crypto.ts`, `buddy-backup-crypto.ts`, `push-crypto.ts`, licence and
  device-link token handling, JWT/session secrets.
- Stored XSS in the web app (`web/src/`): asset names, descriptions, album titles, comments, people names,
  markdown and SVG rendering.

Least:
- `e2e/`, `docs/`, `design/`, `misc/`, `scripts/`, `.github/`, build tooling and test fixtures.
- `studio/` vendored engine snapshot sources other than Frameleaf's adapter.
- Generated code: `open-api/`, `packages/sdk/` output, `server/src/queries/*.sql`.

## How to exercise it
The image has the checkout at `/src`, with all Node and Python dependencies installed and no network access.
- Server unit tests (repositories mocked): `cd /src/server && pnpm exec vitest run --config test/vitest.config.mjs`,
  or a single file, e.g. `pnpm exec vitest run --config test/vitest.config.mjs src/utils/access.spec.ts`.
  Most service and controller files have a sibling `*.spec.ts` that is the quickest place to write a reproducer.
- Web unit tests: `cd /src/web && pnpm exec vitest run <path>`.
- Machine-learning tests: `cd /src/machine-learning && uv run --offline pytest -q <file>`.
- The built server is at `/src/server/dist`. Running it end to end needs PostgreSQL 19 with pgvector (`docker/postgres`),
  which the image does not include; medium tests (`test:medium`) need Docker. Prefer unit-level reproducers and
  reason from source for flows that need a live database.
- The production image builds libvips, libheif, libraw, ImageMagick and darktable from source (`server/Dockerfile`);
  this image uses Debian's ffmpeg and exiftool only. State the library version assumption in media-parsing reports.
- The build log contains a baseline test run; check it for existing failures before attributing one to a change.

## How you rate severity
- **Critical**: unauthenticated remote code execution; authentication bypass; unauthenticated access to any
  user's private media; leaking server secrets that let an attacker forge sessions, licences or device links.
- **High**: an authenticated non-admin user reads, changes or deletes another user's private assets, metadata,
  locked/hidden items or location; privilege escalation to admin; a shared-link holder reaching beyond the link;
  arbitrary file read/write or path traversal from any user role; RCE or code execution needing a normal user
  account (e.g. via a crafted upload); SSRF to internal services from a normal user; stored XSS that runs in
  another user's or the admin's session.
- **Medium**: information disclosure of limited metadata (counts, names, existence of an asset); CSRF on
  state-changing actions; authenticated denial of service that needs a restart; SSRF needing admin settings;
  a remote peer (Buddy Backup or relay) exceeding what it was granted.
- **Low**: self-XSS; issues needing the admin to configure something unsafe; rate-limit gaps; user enumeration;
  DoS from a single oversized request that recovers on its own.
- Memory-safety bugs in bundled native libraries count only with a demonstrated path from an upload or API call;
  report them against the library and say how Frameleaf reaches it.

## Anything to leave alone
- Admin capabilities working as designed (managing users, setting paths, enabling external libraries, running jobs).
- Partners seeing each other's GPS location and locked items they were shared: this is intended.
- The unauthenticated machine-learning HTTP API on its own; it is an internal service.
- Findings that only affect developer tooling, tests, CI workflows or `e2e/`.
- Version-check or telemetry calls, and missing security headers without a concrete exploit.
