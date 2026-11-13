# Frameleaf DAKboard protocol simulator

This is Frameleaf's partner test client. It is not a DAKboard source or an installable DAKboard app. The native integration, account-plan eligibility and release require DAKboard's participation.

Run with Node.js22 or later:

```sh
node --test integrations/dakboard/test/*.test.mjs
node integrations/dakboard/simulator.mjs https://photos.example.com
```

Open the authorization URL printed by the simulator. It requests only `library:read`; select the albums to authorize. The command lists the number of readable albums, revokes its grant and exits. Tokens exist only in process memory and are never printed or written to disk. Do not paste tokens into command arguments.

The simulator registers a temporary loopback callback when the Library permits dynamic registration. If registration is disabled, ask the administrator to register a loopback callback for this simulator and pass its non-secret client ID as the final argument. The Library's loopback callback rule permits a random port. DAKboard's production source must instead register its exact HTTPS callback.

`ConnectDisplay` exposes album browsing, paginated image metadata, and bounded prefetching of the current and next image. It serializes rotating refresh tokens within its one process. A production DAKboard implementation must coordinate refresh across every worker sharing the same connection and atomically persist the entire token set. A failed renewal requires reconnection; it must never fall back to API keys.

Only authenticated JPEG renditions are accepted. The `display` variant creates a bounded, metadata-free JPEG from the authorized processed preview, including when normal previews use WebP. It never requests originals.

Customer-managed public HTTPS does not require a Frameleaf Cloud plan. Frameleaf relay follows the existing plan requirements. Loopback HTTP is supported only for isolated protocol tests, and does not establish DAKboard LAN support. The tests use synthetic local HTTP servers; they are not proof of an actual DAKboard OAuth round trip, renderer compatibility or public availability.

Partner qualification must cover actual HTTPS callbacks, concurrent refresh and restart, two users with separate albums, narrowed access, removed photos, revoked grants, offline Libraries, rate limiting, bounded cache behaviour, direct HTTPS and relay. Do not send private media, credentials or transfer URLs in telemetry. Revocation prevents future fetches; it cannot erase an already downloaded copy.

Existing self-hosted-source guidance is at [DAKboard Support](https://dakboard.freshdesk.com/support/solutions/articles/35000308011). Its commercial rules describe that existing source and do not establish the requirements of a future native Frameleaf source.
