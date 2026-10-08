# Moving to the Frameleaf app

Frameleaf runs its own application and PostgreSQL 19 database. Moving an existing library into Frameleaf is a one-time offline import into a fresh database. Follow the [offline import runbook](./import-library.md), verify the imported library, and activate Frameleaf before signing in with the Frameleaf app.

Keep independent source database and media recovery copies before import. Frameleaf does not synchronize changes with that source or provide a switch-back compatibility contract. Use the Frameleaf app with the Frameleaf server; other applications' client compatibility is not supported.

## What the library import preserves

The importer maps supported users and password hashes, ownership, albums, sharing permissions, relationships, metadata and media references into Frameleaf's canonical schema. Its validation checks permissions, relationships and explicit media-root mappings before activation. Compatible embeddings are imported as values; missing or incompatible derived results become resumable processing work.

## Connect a phone

Use an available [official Frameleaf app](/features/mobile-app) with the new server address. Source sessions are not imported, so sign in again and grant the permissions required by the installed app. Review its backup selection before enabling uploads. Manager's address is separate from the photo application's address.

Keep the source application stopped during import and verification. The phone's caches and settings are separate from the imported server library.

## OAuth sign-in

Configure the Frameleaf callback with your identity provider: `frameleaf-auth:///oauth-callback`, or `https://<server>/api/oauth/frameleaf-mobile-redirect` when using the mobile redirect override. Administration → Settings → Authentication shows the exact addresses for this server. See [OAuth Authentication](./oauth.md#frameleaf-mobile-app) for configuration details.
