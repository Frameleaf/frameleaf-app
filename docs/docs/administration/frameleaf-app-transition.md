# Moving to the Frameleaf app

Frameleaf runs its own application and PostgreSQL 19 database. Moving an existing library into Frameleaf is a one-time offline import into a fresh database. Follow the [offline import runbook](./import-immich.md), verify the imported library, and activate Frameleaf before signing in with the Frameleaf app.

The source database and media remain the recovery copy. Frameleaf does not synchronize changes with that source or provide a switch-back compatibility contract. Use the Frameleaf app with the Frameleaf server; ongoing upstream client compatibility is not supported.

## What the library import preserves

The importer maps supported users and password hashes, ownership, albums, sharing permissions, relationships, metadata and media references into Frameleaf's canonical schema. Its validation checks permissions, relationships and explicit media-root mappings before activation. Compatible embeddings are imported as values; missing or incompatible derived results become resumable processing work.

## What to set up on the phone

The Frameleaf app starts as a new client. Source sessions and temporary credentials are excluded from the database import, and on-phone state is separate:

- **Sign-in.** Sign in to the new Frameleaf server. The app creates a new Frameleaf session.
- **Phone permissions.** Grant photo library, notification and background access to the Frameleaf app.
- **App settings and caches.** Choose backup albums and Wi-Fi and battery rules again. Thumbnails and other on-phone caches are not imported.
- **Locked content.** Unlock with the account's Frameleaf PIN when requested. Unlocking another app does not unlock Frameleaf.

Keep the source application stopped during the offline import. When setting up phone backup afterward, select the intended Frameleaf server and review the backup albums before enabling it.

## OAuth sign-in

Configure the Frameleaf callback with your identity provider: `frameleaf-auth:///oauth-callback`, or `https://<server>/api/oauth/frameleaf-mobile-redirect` when using the mobile redirect override. Administration → Settings → Authentication shows the exact addresses for this server. See [OAuth Authentication](./oauth.md#frameleaf-mobile-app) for configuration details.
