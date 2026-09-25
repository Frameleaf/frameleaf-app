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

## Plan and licence

**Plan** and **Licence** are separate pages. Neither is needed to self-host, and neither ever locks a photo or a local feature.

- A **Frameleaf Cloud plan** ($6 a month or $60 a year) adds remote access. Checkout happens in the Frameleaf store; the linked server picks the plan up by itself. Cloud backup is priced separately by what you store, from $7.99 a month per TB with a 1 TB minimum. **Remove from this server** takes the plan off this server only; the subscription is managed in your Frameleaf account.
- A **licence** is a one-time supporter key: `FL-SXXX-XXXX-XXXX` for a server ($100) or `FL-IXXX-XXXX-XXXX` for one person ($25). It adds a supporter badge, and a licensed server pays 20% less for Frameleaf Cloud plans. AI credit is priced the same for everyone. Removing the key ends the badge and the discount; a plan is not affected.

Every price is in US dollars. When the server was deployed without a Frameleaf Cloud address, the cards say purchasing isn't available yet.

The server checks a key's format, including its check symbol, before sending it anywhere, and refuses keys of the previous product-key scheme. Keys travel only in request bodies: a key handed over by the Frameleaf store arrives in the address fragment of `/link`, is kept in the browser's session storage for **Support Frameleaf**, and is cleared from the address straight away.

### Licence certificates

Activating a key, or installing a licence file, gives this server a signed licence certificate. The server trusts only certificates signed by the Frameleaf keys built into it, bound to this server's instance ID. It refreshes them once a day while linked. If a refresh keeps failing, cloud features keep working through a grace period (the certificate says how long), then pause; nothing local changes. Administrators are told once when a plan enters grace and once when it ends.

### Servers without internet access

On **Licence**, copy this server's instance ID, download the licence file for it from your Frameleaf account on another device, and choose **Choose licence file…**. The file can carry a licence and a Frameleaf Cloud plan.

### Personal supporter keys

Anyone can activate their own `FL-I…` key under **Your preferences → Supporter** or on **Support Frameleaf**, and hide the supporter badge there. A person's key is tied to this server and to their account.
