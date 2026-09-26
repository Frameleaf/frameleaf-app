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

**Unlink…** on the Account & link page stops every cloud feature on this server: remote access, cloud processing and scheduled cloud backups. Sign in with Frameleaf stops too: those sessions end and the links between accounts here and Frameleaf accounts are removed. Local photos, albums, accounts and password sign-in keep working exactly as before. If Frameleaf Cloud ends the link from its side, the page says so and why; the same features stop and nothing local is removed. You can link again at any time.

Administrators receive a notification when the server is linked or unlinked, when check-ins keep failing, and when Frameleaf Cloud sees this server's identity start from two places (for example after copying a server with its identity folder). Each of these is recorded in the administrator's activity.

## Sign in with Frameleaf

Once the server is linked, people can sign in with their Frameleaf account. It works alongside passwords and your own OpenID provider, whose settings it never reads or changes. Settings → Access & security → **Sign in with Frameleaf** shows whether it is available, this server's client ID and how many accounts are linked.

- **Through remote access** the sign-in page offers only Sign in with Frameleaf, and a visitor who turns out to be on the same network is offered this server's local address (`FRAMELEAF_LOCAL_URL`). The server refuses passwords and other sessions that arrive through remote access; see [Remote access security](#remote-access-security).
- **At home** people keep signing in as they do now. Turn on **Show "Sign in with Frameleaf" at home** to add the button to the local sign-in page too; you can change its text on the same page.
- Each person links their own Frameleaf account under Your preferences → **Frameleaf account**, and can unlink it there, which ends their other Frameleaf sessions.
- A person Frameleaf Cloud authorizes for this server gets an account here on first sign-in, as an administrator or a member as Frameleaf Cloud says. A Frameleaf account is linked to an existing account here only by a verified email address; the same rule now applies to your own OpenID provider.
- When Frameleaf Cloud signs someone out, or the server is unlinked, their Frameleaf sessions on this server end.

The server proves who it is to Frameleaf Cloud with its own key. A client secret is only needed if Frameleaf Cloud registered the server with one; it is write-only, like the other credentials.

## Remote access security

Remote access itself (the switch, the connection, the server's certificate, your own domain and the connection test) is described in [Workers and endpoints](/administration/workers-and-endpoints#the-edge-worker-remote-access). Turning it on needs a linked server and a plan that includes remote access; unlinking turns it off, removes the server's remote-access certificates and stops using a custom domain.

These protections are in place before any remote path opens. The sign-in and download rules apply only to requests that arrive through remote access, so people on your home network sign in and download as before; the rate limits apply to every request. Both settings below are under Settings → Frameleaf Cloud → **Remote access**, and go back to off when the server is unlinked.

**How the server knows a request is remote.** The edge worker, which carries remote-access traffic, marks each request with how it arrived (home network, a direct connection from outside, or the Frameleaf relay) and proves the mark with a secret the server generates again on every start (`FRAMELEAF_EDGE_SECRET`; a value you set is used instead). A request that carries a mark (`X-Frameleaf-Via` or `X-Frameleaf-Via-Auth`) without the right secret is refused with `403` (`frameleaf_via_unverified`); it is never treated as coming from home. Every other `X-Frameleaf-*` header a browser or app sends is dropped, except `X-Frameleaf-Worker-Session`, the session credential this server gives its render workers. The edge worker must also send `X-Forwarded-For` with the visitor's address; without it every remote visitor shares one rate-limit counter.

If you run the edge worker in a different container from the API (a split deployment), each container would generate its own secret and every remote request would be refused. Set `FRAMELEAF_EDGE_SECRET` explicitly, to a random value of at least 16 characters, and give both containers the same value.

**Who can connect from outside.** A remote request must come from a Sign in with Frameleaf session; any session can still sign out. Public shared links still open without signing in. An API key works only when its owner's account here is linked to a Frameleaf account. Anything else is refused with `frameleaf_sign_in_required`. Password sign-in is refused away from home unless you turn on **Allow password sign-in over the relay**; the sessions it creates then work remotely too.

**What the relay carries.** Original downloads, archive downloads, preservation packages, database backups, video version masters, Studio bundles and exports, memory export archives and integrity report files are refused through the relay unless you turn on **Allow original downloads over the relay**. Thumbnails, previews and video playback always work; a full-size view shows the preview through the relay instead of the original, and so does a restored photo chosen for viewing. Develop and restoration files are refused like originals. Direct connections are not affected. The render workers' API, including the originals they read, is refused over remote access whatever the setting: render workers belong on your home network.

**Shared-link passwords** are stored as bcrypt hashes. Passwords saved before this version are hashed when the server upgrades, and every link keeps its password. The password is never shown again after it is set. After a password is entered, the browser keeps an unlock token that is keyed with a secret stored in the identity folder (`server-hmac.key`, next to the server's identity key), not in the database, so a database dump alone cannot unlock a link. The identity folder is on the same volume as the database backups, so protect a copy of that volume like the server itself. If the key file is damaged, the server replaces it and says so in its log; viewers then enter link passwords again. Viewers enter a link's password once more after this upgrade. The official upstream server cannot check these hashes: see [the upstream handoff guide](./upstream-handoff.md) before handing the library to it.

**Live updates** (the websocket) accept a browser page only from this server's own address, its external domain or the addresses Frameleaf Cloud published for it.

### Rate limits

Each limit counts requests in a fixed window, per client address (an IPv6 address by its /64) and, where the request names one, per account or link. For password sign-in and shared-link passwords, the per-email and per-link limits count wrong passwords from each address separately, so a stranger trying passwords from elsewhere never locks you out of your own address, and a correct password never uses up your attempts. Every attempt is counted as it starts, so attempts sent in parallel cannot get past the limit either. There is deliberately no limit on one account across all addresses, because such a limit would let anyone lock a person out; someone guessing from many addresses is slowed by the per-address limits and by bcrypt, which makes every guess take tens of milliseconds of server time. Use a strong password, or Sign in with Frameleaf, for accounts that can be reached from outside. Emails, links and credentials are counted as keyed hashes, never in clear. Going over answers `429` with `Retry-After` in seconds. The counters live in Redis; if Redis cannot be reached, remote requests are refused (`503` with `Retry-After`) and requests on your home network are let through.

The client address is the one the server sees. Behind a reverse proxy, the proxy's address is used unless the proxy is trusted: private addresses and loopback need nothing, but a proxy on another address, for example a VPS reached over Tailscale (`100.64.0.0/10`), must be listed in `IMMICH_TRUSTED_PROXIES`, or every visitor shares the proxy's counter. `IMMICH_ENV=testing` turns the sign-in limits off for the automated test suites; never set it on a server people use (the server warns when it starts with it).

| Requests                                                                                                      | Per address | Per account or link            | Window     |
| ------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------ | ---------- |
| Password sign-in (`POST /api/auth/login`)                                                                     | 30          | 10 wrong per email and address | 10 minutes |
| Your OpenID provider's callbacks (`/api/oauth/callback`, `/api/oauth/link`)                                   | 30          | 30 per session                 | 10 minutes |
| Sign in with Frameleaf (`/api/oauth/frameleaf/*`)                                                             | 60          | 60 per session                 | 10 minutes |
| Shared-link password (`POST /api/shared-links/login`)                                                         | 30          | 60 wrong per link and address  | 10 minutes |
| Licence activation (`/api/admin/license/activate`, `/api/admin/license/certificate`, `/api/users/me/license`) | 10          | 10 per session                 | 1 hour     |
| Starting a link (`POST /api/admin/cloud/link`)                                                                | 10          | 10 per session                 | 1 hour     |
| Every request through remote access, except thumbnails and previews                                           | 1,200       | —                              | 1 minute   |
| Thumbnails and previews through remote access, shared links included                                          | 6,000       | —                              | 1 minute   |

## Plan and licence

**Plan** and **Licence** are separate pages. Neither is needed to self-host, and neither ever locks a photo or a local feature.

- A **Frameleaf Cloud plan** ($9.99 a month or $99.90 a year) adds remote access and includes 1 TB of cloud backup. Checkout happens in the Frameleaf store; the linked server picks the plan up by itself. More backup storage is sold in 1 TB blocks at $9.99 a month each. A licensed server pays less for plans: 20% by default ($7.99 a month or $79.92 a year). Frameleaf Cloud can publish a different discount, up to 50%, which the server picks up on its next check-in, applies from the time Frameleaf Cloud sets and keeps across restarts. AI credit and extra backup storage are never discounted. **Remove from this server** takes the plan off this server only; the subscription is managed in your Frameleaf account.
- A **licence** is a one-time supporter key: `FL-SXXX-XXXX-XXXX` for a server ($100) or `FL-IXXX-XXXX-XXXX` for one person ($25). It adds a supporter badge, and a licensed server pays less for Frameleaf Cloud plans (see above). AI credit is priced the same for everyone. Removing the key ends the badge and the discount; a plan is not affected.

Every price is in US dollars. When the server was deployed without a Frameleaf Cloud address, the cards say purchasing isn't available yet.

The server checks a key's format, including its check symbol, before sending it anywhere, and refuses keys of the previous product-key scheme. Keys travel only in request bodies: a key handed over by the Frameleaf store arrives in the address fragment of `/link`, is kept in the browser's session storage for **Support Frameleaf**, and is cleared from the address straight away.

### Licence certificates

Activating a key, or installing a licence file, gives this server a signed licence certificate. The server trusts only certificates signed by the Frameleaf keys built into it, bound to this server's instance ID. The instance ID is the binding; a certificate may also name this server's identity key, which is then checked too, but it does not have to, so a licence survives a key rotation and a licence file can be made before the server is linked. It refreshes them once a day while linked. If a refresh keeps failing, cloud features keep working through a grace period (the certificate says how long), then pause; nothing local changes. Administrators are told once when a plan enters grace and once when it ends.

### Servers without internet access

On **Licence**, copy this server's instance ID, download the licence file for it from your Frameleaf account on another device, and choose **Choose licence file…**. The file can carry a licence and a Frameleaf Cloud plan.

### Personal supporter keys

Anyone can activate their own `FL-I…` key under **Your preferences → Supporter** or on **Support Frameleaf**, and hide the supporter badge there. A person's key is tied to this server and to their account.

## Cloud backup

**Settings › Frameleaf Cloud › Cloud backup** backs up this server's originals and database to a bucket that only this server uses. Setup needs a linked server with cloud backup in its plan. Choose **Frameleaf-managed storage** (see [Frameleaf-managed storage](#frameleaf-managed-storage)) or your own bucket on any S3-compatible provider that supports customer-provided encryption keys (SSE-C), such as Wasabi. The storage address must use HTTPS. Frameleaf addresses the bucket by path (`<storage address>/<bucket>`), so on Amazon S3 use the bucket's regional endpoint, for example `https://s3.eu-central-1.amazonaws.com`; a bucket in another region is refused with a message saying so. Amazon S3 turns SSE-C off by default on new buckets: allow it in the bucket's default encryption settings (remove SSE-C from the blocked encryption types) before you check the bucket. A server clock that is off is refused by the provider too; keep the server's time synchronised.

Setup has four steps:

1. **Destination.** Frameleaf-managed storage needs nothing more: Frameleaf Cloud makes the bucket when the server claims it. For your own bucket, enter the storage address, an empty bucket, and an access key for it. **Check bucket** lists the bucket and writes, reads back and deletes a test file encrypted with a throwaway key, so a provider that does not apply SSE-C is refused before anything is claimed. The secret access key is stored on this server as a write-only setting and is never shown again.
2. **Encryption key.** Every file is encrypted by the provider with a key for this bucket; the provider keeps only a check value, never the key.
   - **Generate a key for me:** this server creates the key and keeps it next to its identity, in a file only the server can read (`cloud-backup-<fingerprint>.key` in the identity folder).
   - **I'll maintain my own key:** the key is created in your browser. Download the key file and confirm it is saved somewhere other than this server before you continue. With **Keep a copy on this server** on, the server keeps a copy in the same kind of file and backups run unattended. With it off, the key is never saved: after every restart backups wait until someone loads the key again (**Unlock**), and you type "I understand" first, because a lost key makes every backup in the bucket permanently unreadable.
3. **Recovery kit** (generated keys only). The kit holds the key as a recovery code and is shown once. Download or print it and keep it offline; the server never shows the key again. You can also keep an encrypted copy with Frameleaf here: see [Key escrow](#key-escrow).
4. **Claim bucket.** The server writes `frameleaf-backup.json` holding its instance ID, encrypted like everything else. A bucket that holds another server's claim, a claim made with a different key, or any other files is refused. Setting up again with the same bucket and key keeps its backups.

The key is never part of the settings, a database dump, a log or an answer from the server, and it is never sent to Frameleaf Cloud.

### What a run backs up

**Back up now** starts a run, which shows in Activity. A run backs up, in this order:

- a fresh database dump, as `db/<file>`; the clean-up keeps the seven most recent dumps and the dump of every backup retention keeps;
- every original, sidecar and profile image, each unique file once as `o/<sha256>`. Locked and trashed photos are included; files in external libraries are not. Thumbnails, previews and transcoded videos are left out unless you include them in the settings;
- a manifest of the run, `m/<time>.json.gz`, naming every photo's files by checksum.

Only new or changed files upload: a photo you have twice is stored once, a second run with nothing changed uploads no files, and a file that changed is uploaded under its new checksum. A checksum on record is trusted only while the file is unchanged at the path it was verified at; anything else is hashed again. A file is read once while it uploads and must match the checksum it is stored under, or it is left for the next run. The manifest is written as the run's last step, streamed from what the run recorded, and never written twice. Each run checks the bucket's claim first: a bucket that was emptied, recreated or claimed by another server is refused until cloud backup is set up again, and setting up an emptied or recreated bucket again starts from its new listing. Nothing on this server is changed or removed by a run, except its own temporary database dump once it is in the bucket.

A run records where it is every 25 photos. The administrator who started it can pause, resume or cancel it, and a run interrupted by a restart carries on with the same manifest. A run that fails is retried once; if it fails again, administrators are told once a day. The status card shows the last run, the last complete backup, the last check and the storage used.

Every backup run, check, clean-up and restore shows in **Activity** under **Background work** for administrators while it is queued, starting, running or paused, with the files and bytes done so far. Those rows are read-only: pausing, resuming and cancelling live on the Cloud backup page and in **Settings › Background work**. Finished ones stay in the list like any other job.

Only one backup operation uses the bucket at a time: a run, a check, a clean-up or a restore waits for the one in progress, and a scheduled run is never queued beside one that is still unfinished. A scheduled run that finds a check, a clean-up or a restore in progress starts as soon as it has ended, and no check starts in the hour before a scheduled run. A backup this server has no record of (a bucket claimed again, or a database restored from before later runs) is picked up by the next run from the bucket's own manifests.

### Schedule and retention

**Schedule & retention** is saved with the other settings. **Run** starts a backup every night at 03:00 (the default), every 6 hours, or on Sundays at 03:00, in the server's time zone (`frameleafCloud.cloudBackup.schedule.cronExpression` in a configuration file takes any cron expression). One server runs the schedule; the others follow it. Scheduled runs belong to the first administrator and show in their Activity.

After each scheduled run, runs past retention are cleaned up. Retention keeps the newest run, then the newest run of each of the last **Keep daily runs** days (7), **Keep weekly runs** weeks (4) and **Keep monthly runs** months (12), in UTC. The clean-up reads every kept run's manifest from the bucket first and removes only the files and database dumps that no kept run names; if any kept manifest cannot be read, nothing is removed. Each removed file is forgotten by the server before it is deleted, so an interrupted clean-up can at worst upload a file again. The API offers a clean-up by hand (`POST /api/admin/cloud/backup/prune`), which must be a dry run first: it reports how many runs, files and bytes would go, and the clean-up itself is accepted within a day of that dry run while no backup has run since.

### Checking the backups

The server checks the bucket on its own while cloud backup is on (`frameleafCloud.cloudBackup.verifyWeekly`, on by default):

- **Weekly**, it fetches the week's share of the backed-up files (1/52 of them, so every file once a year) and checks each against its checksum. **Verify** on the Cloud backup page runs this check now.
- **Monthly**, it checks that every file and database dump a kept run names is still in the bucket, with the size it was backed up at.

A check that fails is tried again the next day. A file that is missing or damaged is uploaded again by the next run when this server still has it, and every run that names it is marked incomplete. Administrators are told what was found, and the Cloud backup page shows the last check.

### Frameleaf-managed storage

With a Frameleaf Cloud plan, Frameleaf Cloud keeps a bucket for this server (`fl-<region>-<instance ID>`, in your account's data region) with versioning on, so an overwritten or deleted file can be recovered for 30 days, and an access policy that lets this server neither delete old versions nor remove the bucket. The server asks for a new bucket-scoped access key at the start of every backup, check, clean-up and restore; the key is kept in memory for that operation only and never stored. Frameleaf Cloud can list file names and sizes to measure storage, never read contents: files are encrypted with your bucket key, which Frameleaf Cloud never receives.

The plan includes 1 TB. Storage never stops for size: each further 1 TB block is added automatically and billed with the plan (see [Plan and licence](#plan-and-licence)); the Cloud backup page shows the storage used against the current allowance. Frameleaf Cloud makes the bucket read-only while a deletion of it is on hold or after the plan has lapsed: uploads and clean-ups stop, nothing on this server changes, and restores and checks keep working. When the server is unlinked or suspended, or Frameleaf Cloud suspects a copy of this server (see [Unlinking](#unlinking)), managed backups stop with the reason on the Cloud backup page; a busy Frameleaf Cloud or a region without storage is waited out and tried again.

### Key escrow

With a key this server generated, you can keep an encrypted copy of it with Frameleaf, in the setup's recovery kit step. The server wraps the key under a passphrase of at least 12 characters (scrypt with N = 2^17, then AES-256-GCM) and sends only the wrapped copy; the passphrase is never stored or sent, and Frameleaf Cloud cannot unwrap the copy. It helps if you lose this server and the recovery kit but still remember the passphrase: download the copy from your Frameleaf account and restore with it (see [Disaster recovery](#disaster-recovery)). Escrow is never offered for your own key, and removing it (`DELETE /api/admin/cloud/backup/escrow`) deletes the copy from Frameleaf Cloud.

### Restoring

The **Restore** section on the Cloud backup page restores from any kept backup. It shows the newest backup, the database backup it pairs with, and how far back deleted items can come from.

- **Items.** Search the chosen backup by file name and see whether each item is still in the library, in the trash, or gone. A Locked item is listed as a Locked item, never by name, and a search by name does not find it. **Restore…** on an item still in the library opens the restore dialog: choose the backup to restore from, and the item's files go back where the library expects them. A file already there that is not the backed-up one is moved to `<media>/frameleaf/restore/replaced/<restore>` and never deleted; a file already there with the backed-up content is left alone. **Restore** on a deleted item brings its files back into `<media>/frameleaf/restore/<restore>`, where Library Care's search for missing originals finds them. Thumbnails and previews of items restored in place are made again.
- **Whole library.** Type RESTORE to start. Every file goes back in place as above, and the paired database backup is written to `<media>/backups` as `cloud-restore-<file>`. Restore it from **Maintenance** (the existing database restore), which signs everyone out until it finishes; the library then goes back to that backup's time.

Every file is fetched with the bucket key and checked against its checksum before it is written; a missing or mismatched file stops the restore and names the file, and everything restored before it stays in place. A restore runs on the server as a job (`cloud_restore`) with its progress in Activity; it can be paused, resumed and cancelled like a backup run, and a restore interrupted by a restart carries on from the next file. In own-memory key mode, load the key first. With Frameleaf-managed storage, the items in a backup can be browsed only while no backup operation is running, because reading them uses a fresh key.

### Disaster recovery

`immich-admin cloud-backup restore` restores a server from its bucket without the web app, for example on new hardware after a loss. Run it in the server container with the media folder mounted:

```bash
export FRAMELEAF_BACKUP_SECRET_ACCESS_KEY='…'
immich-admin cloud-backup restore \
  --bucket family-backup \
  --endpoint https://s3.eu-central-2.wasabisys.com \
  --access-key-id AKIA… \
  --key-file /path/to/frameleaf-backup-key-XXXX-XXXX.json \
  --restore-database
```

- `--key-file` takes the key file or a text file holding the recovery code. Instead, `--escrow-file` takes an escrow copy downloaded from your Frameleaf account, with its passphrase in `FRAMELEAF_BACKUP_ESCROW_PASSPHRASE`. Secrets are read from the environment only, never from the command line.
- `--region` names the region when the storage address does not; `--manifest m/<time>.json.gz` restores an older backup than the newest.
- `--scope library` (the default) restores every file in place and the database dump; `files` restores into `<media>/frameleaf/restore/command-<time>`; `database` restores the dump only.
- `--restore-database` also restores the database from the dump, as the maintenance restore does, replacing the database the server has now. Without it, the command says where the dump is.

The command takes none of the server's locks: stop the server first, or at least make sure no backup operation is running. Files whose backed-up place is outside the media folder are restored into `<media>/frameleaf/restore/command-<time>` instead. The key must open the bucket's claim, or nothing is restored. Every file is checked against its checksum as it is written. Afterwards, start the server and set cloud backup up again with the same bucket and key: the bucket's claim and backups are kept. A Frameleaf-managed bucket's access keys are issued to the linked server only, so recover a managed bucket by restoring the database first (from a local backup, or with a key you were given for it) and then restoring from the Cloud backup page once the server is linked again.

**Turn off backup…** stops backing up. The bucket, its backups and the key are kept, so the backups stay readable with the key file or recovery kit.
