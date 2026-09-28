# Frameleaf Cloud

Frameleaf Cloud adds optional extras to a self-hosted server: the Frameleaf mobile apps from anywhere, remote access, cloud processing and cloud backup. Your server works fully without it. Local photos and features never depend on a link, a plan or a licence.

Everything on this page is in **Settings → Frameleaf Cloud**: **Account & link**, **Plan**, **Licence**, **Remote access**, **Cloud processing** and **Cloud backup**, each also found by searching the settings. Each person links their own Frameleaf account under Your preferences → **Frameleaf account**. The Command Center **Overview** has a **Frameleaf Cloud** tile that reads, for example, "Linked · Remote on · Plan active": whether the server is linked, whether remote access is on, and the plan (or "Not set up" when the deployment has no Frameleaf Cloud address). It turns amber while a plan is in its grace period or has expired, and opens these pages. First-run setup features linking: when the deployment names Frameleaf Cloud, **Frameleaf account** is the recommended choice, so setup creates the administrator and then shows the link code to approve in your Frameleaf account (a server already linked with a link token signs the administrator in with Frameleaf instead). **Local account only**, or **Continue with local account** at the link, keeps a local-only server, fully supported; you can link later from Settings. Nothing is sent to Frameleaf Cloud until you start linking.

## Setting the address

The deployment names Frameleaf Cloud with `FRAMELEAF_CLOUD_URL` (see [Environment Variables](/install/environment-variables#frameleaf-cloud)). Without it, **Account & link** says Frameleaf Cloud is not set up, and the server never contacts anything. The address is never a setting and no default host is built in.

## Environment variables and secrets

Frameleaf Cloud is set up by the deployment, not in the settings. Every variable is described in [Environment Variables](/install/environment-variables#frameleaf-cloud):

| Variable                       | What it does                                                                                                                                                                                        |
| :----------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FRAMELEAF_CLOUD_URL`          | Frameleaf Cloud's address. Unset means Frameleaf Cloud is not set up and nothing is ever contacted.                                                                                                 |
| `FRAMELEAF_IDENTITY_DIR`       | The folder holding this server's identity key, its backup key and the edge worker's certificates. Keep it on persistent storage and in your own backups.                                            |
| `FRAMELEAF_LINK_TOKEN`         | A single-use token that links the server when it starts, without a browser (see [Linking without a browser](#linking-without-a-browser)).                                                           |
| `FRAMELEAF_EDGE_PORT`          | The port the edge worker listens on for direct connections (default `2443`).                                                                                                                        |
| `FRAMELEAF_EDGE_BIND`          | The address it listens on (default `0.0.0.0`).                                                                                                                                                      |
| `FRAMELEAF_TRUSTED_LAN_CIDRS`  | Extra networks that count as home for remote access.                                                                                                                                                |
| `FRAMELEAF_LOCAL_URL`          | This server's address on the home network, offered to remote visitors who turn out to be at home.                                                                                                   |
| `FRAMELEAF_ACME_DIRECTORY_URL` | Only for testing certificates against Let's Encrypt staging or a test certificate authority.                                                                                                        |
| `FRAMELEAF_EDGE_SECRET`        | Set by the server itself: it generates a new secret on every start and hands it to the edge worker. Set it yourself only when the edge worker runs in another container, to the same value in both. |

Secrets are write-only: the server keeps them, but never shows them again, never puts them in an export, a log or the settings history, and never sends them to Frameleaf Cloud.

| Secret                                                                | Where it lives                                                                                                                                                                                                                                                                                                                                                                          |
| :-------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Your bucket's secret access key (`cloud-backup-s3-secret-key`)        | Entered during cloud backup setup for your own bucket. Replace or clear it under **Server credentials** in the settings, or with `PUT` and `DELETE /api/admin/config/credentials/cloud-backup-s3-secret-key` (see [System settings](/administration/system-settings#server-credentials)). Frameleaf-managed storage has no stored key: the server gets a fresh one for every operation. |
| The backup encryption key (`cloud-backup-bucket-key`)                 | Never a setting. A generated key is kept in a file only the server can read in the identity folder; your own key is kept there only if you choose **Keep a copy on this server**, otherwise it is loaded with **Unlock** after each restart. It is replaced only by setting up backup again, and it is shown once, in the recovery kit (see [Cloud backup](#cloud-backup)).             |
| Sign in with Frameleaf client secret (`frameleaf-oidc-client-secret`) | No longer stored: the server signs in to Frameleaf Cloud with its own key.                                                                                                                                                                                                                                                                                                              |

## This server's identity

The first time the server links, it creates its own identity: an instance ID and an Ed25519 key. The key is written once to `FRAMELEAF_IDENTITY_DIR` (by default `<media>/frameleaf/identity`), readable by the server only, and never leaves it. Frameleaf Cloud only ever sees the public key and short-lived signed requests; no Frameleaf password or long-lived token is stored.

Keep the identity folder on persistent storage and in your backups. If it is lost, the server gets a new identity, and the link and any licence tied to the old one stop working until you link and activate again.

Every access token Frameleaf Cloud gives this server is bound to that key (DPoP). Each request that uses one, whether a check-in, a relay, backup or remote-access request, a licence refresh or a cloud processing call, carries a new proof signed by the key for that one request, so a copied token is useless anywhere else. The server tells Frameleaf Cloud this when it links and in every check-in, and from then on Frameleaf Cloud refuses any token for it that isn't bound to its key. A server linked with an earlier version switches to the stricter check at its first check-in after the upgrade, without linking again; the switch is permanent until the server is linked again. The only requests without a proof are the ones that present no token: reading Frameleaf Cloud's public service list, the processing service's availability check, the linking code exchange, and licence activation on a server that isn't linked. Tokens, proofs and keys are never written to the logs.

## Linking the server

1. Open **Settings → Frameleaf Cloud → Account & link** and choose **Link to Frameleaf**.
2. The page shows a short code (`XXXX-XXXX`), a QR code and a ten-minute countdown. Open the address on your phone or computer, sign in, and check that the server name, version and key fingerprint match before you approve.
3. The page picks up the approval by itself. If the code expires or is declined, choose **Get a new code**.

Nothing from your library is uploaded by linking.

### The tour of what linking unlocks

When you link a server that is already set up, a short tour opens over Settings once the approval lands. Its six steps cover remote access, your server's own address, Sign in with Frameleaf, cloud AI and the AI Wallet (in US dollars), encrypted cloud backup, and your plan, licence and the Frameleaf Cloud area. Each step shows where that part stands **On this server** (for example **Needs a plan**, **Ready to turn on** or **On**) and has an **Open …** link to its settings page. Nothing is turned on by the tour, and it sends nothing to Frameleaf Cloud: the status comes from what your server already knows.

Use **Next** and **Back**, the arrow keys, the page dots or a swipe to move between steps. **Done**, **Skip tour**, Escape or an **Open …** link each end the tour, and a link opens its page. The tour is shown once to each administrator: every other administrator sees it on their next visit to Settings, and people who are not administrators never do. Whether you have seen it is kept with your account on the server, so another browser does not show it again. A server linked during first-run setup does not show it, because setup already summarises what the link unlocks. To see it again, choose **Take the tour** on the **Linked to Frameleaf** card in **Account & link**, or search the settings for "tour". With Reduce Motion on, the steps fade instead of sliding; on a phone the tour is a sheet at the bottom of the screen.

### Linking without a browser

Create a link token in your Frameleaf account under **Servers → Add server**, then start the server with `FRAMELEAF_LINK_TOKEN=fll_…`. The token works once and expires within an hour. The server links when it starts and never sends the same token again; remove it from the environment afterwards.

## Check-ins

While linked, the server checks in every few minutes: as often as Frameleaf Cloud's last answer asks, else as its service list says, else every five minutes, and never more often than once a minute or less often than every 15 minutes. **What this server sends** on the Account & link page lists every field of a check-in: the Frameleaf version, a start marker, uptime, health, the addresses used for remote access, the remote-access state, the permission choices, the licence's signing key and the capabilities this version supports (such as signing every request with its key), and a summary of the choices on these pages: the remote access mode, direct port and relay options and whether the Frameleaf or your own address is used (never the address itself); whether cloud processing is on, where each kind of work runs, automatic descriptions and their daily budget and the terms version accepted; whether cloud backup is on and whether it goes to Frameleaf-managed storage or your own bucket (never the bucket's name, address or keys), its key type, schedule and retention, whether the key is kept with Frameleaf, and how the last run ended (never file names or error text); and the licence's state. Frameleaf Cloud shows this summary to its support staff so they can help without asking. Photos, videos, thumbnails, metadata, names, accounts and usage are never sent.

### Messages from Frameleaf Cloud

A check-in can bring messages from Frameleaf Cloud, such as planned maintenance or new processing terms. Each one reaches every administrator once, as a notification titled **Message from Frameleaf Cloud**, however often later check-ins repeat it and even after the notification is dismissed. A message that can't be dismissed comes back once a day while it lasts. After this update, a message an earlier version already showed can appear once more.

### When Frameleaf Cloud pauses new work

Frameleaf Cloud can pause new work of one kind for a while, such as linking servers, relay connections or processing in a region, new backup storage, or AI credit top-ups in your Frameleaf account. Starting such work on this server then fails with Frameleaf Cloud's own explanation, shown as it is: linking ends with it (a link token set in `FRAMELEAF_LINK_TOKEN` is kept and tried again at the next start), setting up Frameleaf-managed backup storage shows it, the relay's last problem on the Remote access page shows it, and an estimate shows it in place of a price. Work already running is never interrupted: open relay connections, backups and cloud jobs carry on. A cloud job or description batch that Frameleaf Cloud has not accepted yet waits and tries again when Frameleaf Cloud says to, and so does the relay connection, and Activity shows the explanation while it waits; a cloud job that still can't start after several tries fails with it.

## What Frameleaf Cloud may ask

**Allow Frameleaf Cloud to…** decides which requests from your Frameleaf account this server honours:

| Choice                          | What it allows                                                               | Default |
| :------------------------------ | :--------------------------------------------------------------------------- | :-----: |
| Turn remote access on or off    | Turning remote access on or off from your Frameleaf account                  |   Off   |
| Start a cloud backup            | Starting a backup run; never reading, changing or deleting backups           |   On    |
| Refresh your plan automatically | Picking up renewals and plan changes, and renewing this server's credentials |   On    |

**Refresh your plan automatically** also lets Frameleaf Cloud ask the server to fetch its plan and licence again straight away. The server checks every request against these choices and records it. A request to link again only asks an administrator to do so; no request ever deletes anything on the server.

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

The server proves who it is to Frameleaf Cloud with its own key, so no client secret is stored for Sign in with Frameleaf. Entries in the settings change history from before this still read "Sign in with Frameleaf client secret" (`frameleaf-oidc-client-secret`).

## Remote access security

Remote access itself (the switch, the connection, the server's certificate, your own domain and the connection test) is described in [Workers and endpoints](/administration/workers-and-endpoints#the-edge-worker-remote-access). The **Public server URL** is set on the same page: it is the address this server puts in shared links, emails and sign-in callbacks, saved with your other settings changes. **Use the Frameleaf address** fills in `https://r.<label>.frameleaf.net`; **Use my domain** fills in your own verified hostname (see [Your own domain](/administration/workers-and-endpoints#your-own-domain)). Either one also becomes the address the server publishes to the apps. Turning it on needs a linked server and a plan that includes remote access; unlinking turns it off, removes the server's remote-access certificates and stops using a custom domain.

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

| Requests                                                                                                                                | Per address | Per account or link            | Window     |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------ | ---------- |
| Password sign-in (`POST /api/auth/login`)                                                                                               | 30          | 10 wrong per email and address | 10 minutes |
| Your OpenID provider's callbacks (`/api/oauth/callback`, `/api/oauth/link`)                                                             | 30          | 30 per session                 | 10 minutes |
| Sign in with Frameleaf (`/api/oauth/frameleaf/*`)                                                                                       | 60          | 60 per session                 | 10 minutes |
| Shared-link password (`POST /api/shared-links/login`)                                                                                   | 30          | 60 wrong per link and address  | 10 minutes |
| Licence activation (`/api/admin/license/activate`, `/api/admin/license/certificate`, `/api/users/me/license`, `/api/license/link-code`) | 10          | 10 per session                 | 1 hour     |
| Starting a link (`POST /api/admin/cloud/link`)                                                                                          | 10          | 10 per session                 | 1 hour     |
| Every request through remote access, except thumbnails and previews                                                                     | 1,200       | —                              | 1 minute   |
| Thumbnails and previews through remote access, shared links included                                                                    | 6,000       | —                              | 1 minute   |

## Plan and licence

**Plan** and **Licence** are separate pages. Neither is needed to self-host, and neither ever locks a photo or a local feature.

- A **Frameleaf Cloud plan** ($9.99 a month or $99.90 a year) adds remote access and includes 1 TB of cloud backup. Checkout happens in the Frameleaf store; the linked server picks the plan up by itself. More backup storage is sold in 1 TB blocks at $9.99 a month each. A licensed server pays less for plans: 20% by default ($7.99 a month or $79.92 a year). Frameleaf Cloud can publish a different discount, up to 50%, which the server picks up on its next check-in, applies from the time Frameleaf Cloud sets and keeps across restarts. AI credit and extra backup storage are never discounted. **Remove from this server** takes the plan off this server only; the subscription is managed in your Frameleaf account.
- A **licence** is a one-time supporter key: `FL-SXXX-XXXX-XXXX` for a server ($100) or `FL-IXXX-XXXX-XXXX` for one person ($25). It adds a supporter badge, and a licensed server pays less for Frameleaf Cloud plans (see above). AI credit is priced the same for everyone. Removing the key ends the badge and the discount; a plan is not affected.

Every price is in US dollars. When the server was deployed without a Frameleaf Cloud address, the cards say purchasing isn't available yet.

The server checks a key's format, including its check symbol, before sending it anywhere, and refuses keys of the previous product-key scheme. A key never travels in an address, not even after the `#`: you type or paste it into **Already have a key?** on **Support Frameleaf** (or the **Licence** page), and it is sent only in the request body.

**Use on your server** in your Frameleaf account hands a licence over without the key. It opens this server's `/link` page with a one-time link code (`flc_…`, single use, valid for 10 minutes). The page takes the code out of the address before anything else happens, so it stays in neither the address bar nor the browser history, and **Support Frameleaf** hands it to this server in a request body. The server redeems it with Frameleaf Cloud over its signed link, and Frameleaf Cloud activates the licence for this server directly. Neither the server nor the browser ever sees the key. A server key goes to an administrator's server; anyone else can only receive a personal key. The server must be linked to the same Frameleaf account that holds the licence. On a server that isn't linked, or while Frameleaf Cloud doesn't offer link codes yet, the page asks you to link the server first or to paste the key. A link that still carries a key in its address (from before link codes) is never used: the key is removed from the address at once and you're asked to paste it. The server never records the address of `/link` or of a licence request in its logs, and `/link` is served so that no request sends its address on as a referrer.

### Licence certificates

Activating a key, or installing a licence file, gives this server a signed licence certificate. The server trusts only certificates signed by the Frameleaf keys built into it, bound to this server's instance ID. The instance ID is the binding; a certificate may also name this server's identity key, which is then checked too, but it does not have to, so a licence survives a key rotation and a licence file can be made before the server is linked. It refreshes them while linked, as often as Frameleaf Cloud's service list says (at least every hour and at most every day; once a day unless it says otherwise), and picks up a change within the hour. If a refresh keeps failing, cloud features keep working through a grace period (the certificate says how long), then pause; nothing local changes. Administrators are told once when a plan enters grace and once when it ends.

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

Every backup run, check, clean-up and restore shows in **Activity** for administrators while it is queued, starting, running or paused, as the **Background work** group at the end of **In progress**, with its stage and the files and bytes done so far. Those rows are read-only: pausing, resuming and cancelling live on the Cloud backup page and in **Settings › Background work**. Finished ones are listed under **Recent** like any other job.

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

**Turn off backup…** stops scheduled runs; a run, check, clean-up or restore in progress has to be cancelled first. The bucket, its backups and the key are kept, so the backups stay readable with the key file or recovery kit. Delete a Frameleaf-managed bucket in your Frameleaf account, or your own bucket at your storage provider, when you no longer need it.

## Restoration and Smooth motion on Frameleaf Cloud

Restoration and Smooth motion can run on Frameleaf Cloud when the server is linked, cloud processing is turned on and its terms are accepted. Nothing is sent without a confirmation for that job: choosing Frameleaf Cloud in the editor's restoration panel, or asking for Smooth motion on a video, opens an estimate first. A job that Frameleaf Cloud cannot run or finish stops and says why; it never moves to this server or another computer by itself, and a job for this server never moves to Frameleaf Cloud.

The terms have a version. The terms dialog shows the version Frameleaf Cloud asks this server to accept for the optional features chosen in it, read from Frameleaf Cloud each time the choices change, and accepting records exactly that version and text. An optional feature can need a newer version than the rest of the terms; turning it on shows that version to read first. If the terms change before you accept, the dialog shows the new ones to read again. When Frameleaf Cloud requires a newer version, the Cloud processing page asks an administrator to review it, and Frameleaf Cloud usually sends a message about it too; until then cloud jobs are refused, and nothing on this server changes. An accepted version never goes back to an older one.

Administrators can always confirm Frameleaf Cloud jobs. Anyone else can confirm them only once an administrator allows them under **Settings › Frameleaf Cloud › Cloud processing › Who can spend the AI Wallet**, each with an optional monthly limit in USD. The limit belongs to the person who confirms a job, not to the owner of the photo or video: a job counts against whoever confirmed it. It counts the jobs they confirmed this month (by the date each was confirmed), plus any earlier job that still holds part of the AI Wallet. A settled job counts what it was charged, and a job that has not settled counts what the AI Wallet holds for it. A job not sent yet counts 10 % more than its hold, because it may be estimated that much higher if it waits past its estimate. A job that would go past the limit is refused. Everyone else still sees the estimate, with a message that an administrator can allow them. The server checks this when a job is confirmed, so removing someone from the list stops their next confirmation; jobs they already confirmed carry on, and can be cancelled in Activity.

Cloud processing runs in your Frameleaf account's data region: Europe (`eu`) or North America (`na`, which also covers Canada). The server takes the processing address from Frameleaf Cloud's service list for the region your account reported when the server was linked; it never uses a fixed address or guesses a region. If Frameleaf Cloud answers that the server is using the wrong region, the server reads the service list and its link again and tries once more. If it's still refused, cloud processing stops, the job says why, and administrators get the notice **Cloud processing is using the wrong region**. Check that `FRAMELEAF_CLOUD_URL` points to Frameleaf Cloud, then link the server again.

The estimate shows:

- the model, on a slider from lighter to heavier, with its GPU class, rate and start fee. Choosing another model estimates again. A full render always runs the model its preview was reviewed with, so it shows that model without a slider;
- a range from the typical to the high-end cost, start fees included. Cost is metered GPU time × the model's rate plus one start fee per worker; long videos run in chunks on up to five workers, each with its own start fee;
- a range per photo or per minute, which is an estimate, never a fixed price;
- the amount held in your AI Wallet (the high-end estimate) and what is available in it.

An estimate holds for 15 minutes. After that, or when the model is withdrawn or the cloud processing terms change, the job is estimated again and must be confirmed again. Confirming names the terms version shown with the estimate. When the AI Wallet cannot hold the job, or the daily limit or a budget would be passed, the estimate says so and nothing is sent; a lighter model is never chosen for you. Each person keeps up to 10 unconfirmed estimates; older ones are dropped with their prepared files.

Every job is a preview first. For a restoration, the preview is a small area of a photo or a short clip of a video; for Smooth motion (2×, 4× or 8× the frames), a short clip. Review the preview before and after, then accept it to run the whole file with the same model and settings, which is its own estimate and confirmation. Before the first estimate of a whole video, the server prepares a copy of it in the background; the estimate shows that it is preparing and follows once the copy is ready, and later estimates of the same video reuse it. One person prepares one video at a time. The result is saved as a new version; the original is never changed.

What leaves this server is a copy made for the job with its metadata removed. Photos are re-encoded from their pixels, which drops EXIF, GPS, XMP and IPTC (the colour profile is kept). Videos keep only their first video stream: audio, subtitles and other streams stay on this server, container and stream tags, titles, dates and chapters are stripped, and a copied H.264 or HEVC stream also loses the SEI messages where cameras put their own data. Files are uploaded to storage that Frameleaf Cloud names for the job, and a part that fails is sent again on its own. Results are checked against their SHA-256 checksums before they are kept. The server asks Frameleaf Cloud to delete the job's files only once the new version is saved; until then Frameleaf Cloud keeps the result, so a failed or interrupted save is tried again without paying for the job twice.

The job shows in Activity under **In progress**, grouped by stage (Queued, Starting, Running or Paused), and then under **Recent** as Done, Failed or Cancelled. Each job shows the model, the estimate, what was metered so far, the amount held and, once Frameleaf Cloud settles it, what was charged. A job that fails on Frameleaf Cloud's side is not charged. Cancelling a running job stops it on Frameleaf Cloud and charges only the GPU time used; cancelling a full render before anything was sent puts its preview back up for review. A job can be paused only before it is sent. While Frameleaf Cloud does not answer, a running job waits and is read again (never sooner than Frameleaf Cloud asks) instead of failing. A job survives a restart of this server and carries on from where Frameleaf Cloud reports it.
