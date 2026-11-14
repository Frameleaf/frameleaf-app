# Frameleaf Connect for Zapier

Private beta. Triggers, searches, actions and files are implemented; hosted qualification and Zapier review are still required. Do not publish this package.

The connection requests library:read, library:download, albums:write, tags:write, photos:upload, boards:upload and events:read. In Frameleaf consent, choose the exact owned albums to read and the albums or workspaces to write. Whole-library reading is an explicit choice. People, sharing, removal and deletion are never requested.

Zapier must reach a public HTTPS Library address. Customer-provided HTTPS needs no Frameleaf Cloud plan; Frameleaf relay needs an eligible plan. Zapier subscriptions and usage limits are separate. LAN-only access is unsupported.

In Zapier, obtain the exact callback for this private application. A Frameleaf administrator registers that exact callback in Connect setup and supplies the non-secret client ID. Enter the canonical server origin and client ID, then complete browser consent. Never paste tokens into a Zap field.

Event triggers check the newest 1000 matching events on each poll. More than 1000 events between two polls omits the oldest ones; this is not a lossless sync.

Actions that create something require a Source ID that stays the same for the same item, such as the ID from the previous step. Replays, retries and simultaneous runs then create one album or file, not duplicates.

Files are fetched only when a later step uses them, with the connection's current access. Revoking access in Frameleaf Connected Apps stops further files; it cannot remove copies already sent elsewhere. Removing the Zapier connection does not revoke the Frameleaf grant.

Before publication, qualify the hosted app: browser OAuth with the real callback, simultaneous Zaps sharing one expiring connection producing one safe rotation, a lost refresh response, revocation, and every trigger, search, action and file against a test Library.
