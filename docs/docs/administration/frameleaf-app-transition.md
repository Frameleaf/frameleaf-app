# Moving to the Frameleaf app

The Frameleaf mobile app and the Immich mobile app are separate apps. Both can be installed on the same phone and both can connect to the same server at the same time. This page explains what changes, and what does not, when someone starts using the Frameleaf app.

## What carries over

Everything that lives on the server is shared, because both apps sign in to the same account:

- photos and videos, albums, people, memories, favourites and the trash;
- sharing, partners and shared links;
- the account's settings that are stored on the server, such as Locked content rules.

## What does not carry over

The Frameleaf app starts as a new client. It does not inherit anything from the Immich app on the phone:

- **Sign-in.** Sign in again in the Frameleaf app. Its session is a new session, listed separately under Signed-in devices in the account settings, and signing out of one app never signs out of the other.
- **Access tokens and API keys.** Nothing is copied from the Immich app. Revoking the Immich app's session does not affect the Frameleaf app, and the other way round.
- **Phone permissions.** The phone asks again for photo library, notification and background access. Grant them to the Frameleaf app.
- **App settings and caches.** Backup album choices, Wi-Fi and battery rules, thumbnails and other on-phone caches are per app. Choose the backup albums again in the Frameleaf app.
- **Locked content PIN entry.** The PIN is the account's PIN on the server, but unlocking in one app does not unlock the other.

## Running both apps for a while

Old clients keep working. The server still accepts the Immich app, its `app.immich:///oauth-callback` sign-in callback and its API, so nobody has to switch on a set date.

If both apps back up the same phone, turn backup off in one of them. The server recognises a file it already has for the same account and does not store it twice, but running two backups still uses battery and data for nothing.

## OAuth sign-in

Each app gets its own OAuth callback, so neither app is opened for the other's sign-in:

| App       | Without the mobile redirect override | With the override                                      |
| :-------- | :----------------------------------- | :----------------------------------------------------- |
| Frameleaf | `frameleaf-auth:///oauth-callback`   | `https://<server>/api/oauth/frameleaf-mobile-redirect` |
| Immich    | `app.immich:///oauth-callback`       | `https://<server>/api/oauth/mobile-redirect`           |

Allow both with your identity provider. Administration → Settings → Authentication shows the exact addresses for this server under **Mobile app callbacks**, and says when the configured override cannot be used by the Frameleaf app. See [OAuth Authentication](./oauth.md#frameleaf-mobile-app) for details.
