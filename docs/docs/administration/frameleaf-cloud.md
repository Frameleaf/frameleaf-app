# Frameleaf Cloud

Frameleaf Cloud adds optional extras to a self-hosted server: the Frameleaf mobile apps from anywhere, remote access, cloud processing and cloud backup. Your server works fully without it. Local photos and features never depend on a link, a plan or a licence.

Everything on this page is in **Settings → Frameleaf Cloud**.

## Setting the address

The deployment names Frameleaf Cloud with `FRAMELEAF_CLOUD_URL` (see [Environment Variables](/install/environment-variables#frameleaf-cloud)). Without it, **Account & link** says Frameleaf Cloud is not set up, and the server never contacts anything. The address is never a setting and no default host is built in.

## This server's identity

The first time the server links, it creates its own identity: an instance ID and an Ed25519 key. The key is written once to `FRAMELEAF_IDENTITY_DIR` (by default `<media>/frameleaf/identity`), readable by the server only, and never leaves it. Frameleaf Cloud only ever sees the public key and short-lived signed requests; no Frameleaf password or long-lived token is stored.

Keep the identity folder on persistent storage and in your backups. If it is lost, the server gets a new identity, and the link and any licence tied to the old one stop working until you link and activate again.

## Linking the server

1. Open **Settings → Frameleaf Cloud → Account & link** and choose **Link to Frameleaf**.
2. The page shows a short code (`XXXX-XXXX`), a QR code and a ten-minute countdown. Open the address on your phone or computer, sign in, and check that the server name, version and key fingerprint match before you approve.
3. The page picks up the approval by itself. If the code expires or is declined, choose **Get a new code**.

Nothing from your library is uploaded by linking.

### Linking without a browser

Create a link token in your Frameleaf account under **Servers → Add server**, then start the server with `FRAMELEAF_LINK_TOKEN=fll_…`. The token works once and expires within an hour. The server links when it starts and never sends the same token again; remove it from the environment afterwards.

## Check-ins

While linked, the server checks in every few minutes. **What this server sends** on the Account & link page lists every field of a check-in: the Frameleaf version, a start marker, uptime, health, the addresses used for remote access, the remote-access state, the permission choices and the licence's signing key. Photos, videos, thumbnails, metadata, names, accounts and usage are never sent.

## What Frameleaf Cloud may ask

**Allow Frameleaf Cloud to…** decides which requests from your Frameleaf account this server honours:

| Choice                          | What it allows                                                               | Default |
| :------------------------------ | :--------------------------------------------------------------------------- | :-----: |
| Turn remote access on or off    | Turning remote access on or off from your Frameleaf account                  |   Off   |
| Start a cloud backup            | Starting a backup run; never reading, changing or deleting backups           |   On    |
| Refresh your plan automatically | Picking up renewals and plan changes, and renewing this server's credentials |   On    |

The server checks every request against these choices and records it. A request to link again only asks an administrator to do so; no request ever deletes anything on the server.

## Unlinking

**Unlink…** on the Account & link page stops every cloud feature on this server: remote access, cloud processing and scheduled cloud backups. Local photos, albums, accounts and sign-in keep working exactly as before. If Frameleaf Cloud ends the link from its side, the page says so and why; the same features stop and nothing local is removed. You can link again at any time.

Administrators receive a notification when the server is linked or unlinked, when check-ins keep failing, and when Frameleaf Cloud sees this server's identity start from two places (for example after copying a server with its identity folder). Each of these is recorded in the administrator's activity.
