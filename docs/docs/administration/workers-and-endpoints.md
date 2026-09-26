# Workers and Endpoints

Frameleaf sends machine-learning work to **destinations**: the machine-learning container that ships with the server, other machines on your network, and, if you add it, **Frameleaf Cloud**. **Administration > Processing destinations** shows them in two parts:

- **Workers & endpoints**, an inventory of every worker with its current state.
- **Processing destinations**, where you add workers, record cloud consent and choose where each kind of work runs.

## Two kinds of worker

Library analysis and restoration never share a worker.

| Work                                                               | Runs on                                                                           | Image                                     |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------- | ----------------------------------------- |
| Library analysis: faces, search and similarity, text, descriptions | The machine-learning endpoints or a `/predict` container on another machine       | `frameleaf-machine-learning`              |
| Restoration (Faithful and Creative)                                | A restoration worker on this server or your network                               | Built from `Dockerfile.video-restoration` |
| Descriptions, restoration, upscaling and Studio AI in the cloud    | **Frameleaf Cloud**, added by an administrator and used only for what you allowed | None: runs in Frameleaf Cloud             |

The rules the server enforces:

- A destination on this server or your network is allowed library-analysis work **or** restoration work, not both. The form closes one kind once you tick the other. Frameleaf Cloud is the exception: each cloud job gets its own capacity, so it may be allowed both.
- A restoration is refused (never moved) when its destination is still allowed both kinds of work from before this rule, or points at an endpoint a library workload is routed to.
- Nothing falls back. A job whose destination is missing, disabled, unreachable, over budget or without consent is refused and says why. Cloud destinations need recorded consent, and a restoration in the cloud also needs the person's confirmation for that request.

Destinations saved before the separation that allow both kinds of work keep running library analysis and are listed under **Workers allowed both kinds of work** until you limit them to one.

## The inventory

Each worker shows:

- **State.** _Not checked_ (no check yet), _Turned off_, _Unreachable_ (the last check got no answer, or there is no address), _No models ready_ (it answered but serves none of the work it is allowed), _CPU only_ (it serves its work without an accelerator) or _Model ready_. A configured address never counts as ready on its own.
- **Capabilities, GPU memory and acceleration** as the worker reported them. A restoration worker reports each GPU's memory; the `/predict` container reports its execution providers only, so its GPU memory shows as unknown.
- **Credentials** as a state only. Tokens are never shown after they are saved.
- **Routed here** and **Admission**: which kinds of library work are routed to this worker, and what the server would answer for each kind of work it is allowed, from the last check.
- **Load**: jobs running and waiting for this worker. For a library-analysis worker this is the backlog of the queues whose work is routed there; for a restoration worker it is its restoration jobs.

**Library analysis routes** lists each kind of library work with the worker it is routed to. A route to Frameleaf Cloud is shown as Frameleaf Cloud (cloud), never as local; an unrouted kind of work is shown as refused.

**Render workers** lists the Studio render workers by when they last checked in. They call the server, so there is no address to show. **Restoration runners on this server** lists the server processes holding restoration jobs right now.

The inventory refreshes every 30 seconds while the page is open. When a refresh fails it keeps the last snapshot on screen and says how old it is. **Check capabilities** checks exactly that worker now; nothing else is contacted.

### The machine-learning URL list

**Machine-learning endpoints** edits the machine-learning URL list from the machine-learning settings. Use each worker's base URL (HTTP or HTTPS, without a password, query or fragment); up to 32 are supported and at least one must remain. The server creates a destination for each URL on this network and routes library work that has no route yet to the first one; the order sets nothing else. When a URL leaves the list (removed, or edited to a new address) its destination is turned off: work routed to it is refused, not moved, until you route it elsewhere. If the URL is added back, that destination is turned on again. Removing a URL does not stop a remote worker, and existing restorations keep their chosen destination.

## Frameleaf Cloud

Frameleaf Cloud is an optional processing destination. Nothing is contacted until an administrator sets it up, and it is never used as a fallback: work routed to it that it cannot take is refused and says why.

1. The deployment names the Frameleaf Cloud address with `FRAMELEAF_CLOUD_URL`. Without it, Frameleaf Cloud shows as **Not configured**. The address is never a setting and is never built in.
2. The server is linked to a Frameleaf account. Requests use short-lived tokens signed with this server's own key (kept in `FRAMELEAF_IDENTITY_DIR`, by default `<media>/frameleaf/identity`, readable by the server only); no password or token for Frameleaf Cloud is stored.
3. **Add Frameleaf Cloud** in **Frameleaf Cloud processing** creates the destination. It has no URL or token, is not routed automatically, and serves nothing until consent is given. Faces never run on Frameleaf Cloud; search and text recognition stay on your own workers.
4. **Consent** is versioned. You review the version Frameleaf Cloud requires, choose each optional feature (people names in descriptions, medical signals, the text-recognition add-on; all off by default) and accept. When Frameleaf Cloud asks for a newer version, its work is refused until you accept again.
5. **AI Wallet.** Cloud work is paid from a prepaid AI Wallet, shown in US dollars with the amount held by running jobs. An empty wallet refuses the work; it never lowers quality or moves the work elsewhere. The destination's budget and the wallet's daily limit also refuse work once reached. Settled costs are recorded against the jobs that incurred them.

Admission refuses with a reason you can act on: Frameleaf Cloud not configured, not linked or unavailable; no cloud processing on the account; consent missing or out of date; wallet empty; limit reached; model no longer offered.

Setting up the link itself, and the hosted Frameleaf Cloud service, are outside this page.

### Frameleaf Cloud description batches

When descriptions are allowed on Frameleaf Cloud (**Both** or **Cloud only** in **Where each job runs**) and routed to it, photos are never described one at a time. They are sent in batches: one owner's photos per batch, one cloud job per batch, and jobs of the same model carry the same pack key so they can share a started worker. Each batch shows in its owner's **Activity**; only an administrator can describe its photos again, from the estimate.

**Not yet available.** Frameleaf Cloud has not published how a server uploads a batch's photos and reads its descriptions. Until it does, no description job is created: estimates work, but **Describe** is refused, new photos are not batched, and a batch stops before it is sent. This lifts only with the server version that implements that part of the Frameleaf Cloud contract, not when Frameleaf Cloud starts accepting jobs.

- **Describe your library** in **Frameleaf Cloud processing** checks consent first, then estimates and queues nothing. The estimate is scaled from the model's measured GPU time for a sample of the photos: a likely and an at-most (p50–p90) cost, the cost per photo, the start fee each batch pays and the AI Wallet balance. It is refused when the wallet, the daily limit or the destination's budget (with what it already spent this period and what running batches hold) cannot cover it. **Describe** then queues exactly the photos of that estimate, at its prices, within 30 minutes; photos that became Locked or joined another batch meanwhile are left out, and asking twice queues once. Regenerating descriptions from the Job manager or the machine-learning settings queues nothing for Frameleaf Cloud and says to use this estimate instead.
- **Describe new photos automatically** (off by default) collects new photos (written to its queue every 100 photos or 5 seconds) and batches them within its daily budget. The budget counts per calendar day in the server's time zone. When it is used up, no new batch starts that day, administrators are told once, and batching carries on the next day.
- Before a batch is sent, Frameleaf Cloud seals an estimate for exactly its photos. The batch is sent only if the wallet can hold that amount, today's limit and the destination's budget (with running batches' holds) leave room for it and, for a batch you approved, the estimate is not more than 20% above what you saw. Otherwise nothing is sent. A batch that waited is checked again in full, its photos included, before it is sent.
- Turning Frameleaf Cloud processing off, or setting descriptions to this server only, stops every batch: waiting ones fail with that reason, and a running cloud job is stopped. A description routed to Frameleaf Cloud while it is off is refused, not left waiting.
- Locked photos are never sent. The copy that would leave the server is the preview written again without EXIF, XMP or IPTC and converted to sRGB (its own colour profile is not kept), so no location or camera data leaves it. Videos are not described on Frameleaf Cloud.
- With a 72B-class description model, batches under about 200 photos pay mostly for the start fee; the estimate suggests a 27B/35B-class model instead.
- A batch that Frameleaf Cloud cannot take right now (for example because it has no capacity) waits and tries once more, then fails. It is never described on this server or another destination instead.

| Setting                                     | Value            |
| ------------------------------------------- | ---------------- |
| Photos per batch                            | 200              |
| Photos per backfill run (newest first)      | 5,000            |
| New photos an owner collects before a batch | 20, or 6 hours   |
| New photos waiting at most                  | 10,000           |
| How often batches move on                   | every minute     |
| How often a running batch's job is read     | every minute     |
| Batch size suggested for a 72B-class model  | about 200 photos |
| Longest a batch may run in Frameleaf Cloud  | 24 hours         |

## Deployment: a separate restoration container

The restoration worker is not qualified yet; read `machine-learning/video-restoration/README.md` first. From a source checkout, start it next to the regular services with the overlay:

```sh
docker compose -f docker-compose.yml -f docker-compose.restoration.yml up -d
```

Then add a home-network destination at `http://frameleaf-restoration:3004`, allowed restoration only, with the token from `FRAMELEAF_RESTORATION_TOKEN` if you set one. The overlay reads:

| Variable                        | Purpose                                                             | Default                 |
| ------------------------------- | ------------------------------------------------------------------- | ----------------------- |
| `FRAMELEAF_RESTORATION_GPU`     | The GPU the restoration worker uses                                 | none: you must set it   |
| `FRAMELEAF_RESTORATION_TOKEN`   | Bearer token the worker requires; store it on the destination       | empty (no token)        |
| `FRAMELEAF_RESTORATION_CONFIG`  | Folder with the model manifest and qualification record (read-only) | `./restoration/config`  |
| `FRAMELEAF_RESTORATION_WEIGHTS` | Folder with the model weights (read-only)                           | `./restoration/weights` |

### Keeping library analysis responsive

- **Separate GPUs.** Set `FRAMELEAF_RESTORATION_GPU` to a GPU the machine-learning container does not use, and pin that container to its own GPU with `device_ids` in `hwaccel.ml.yml`.
- **One GPU for both.** Tick **This worker shares a GPU with library analysis** on the restoration destination. Full restorations bound to it then stay queued while face, search, text and description jobs have work, and start when that work is done. Previews still run, because someone is waiting for them and they are short. A paused library queue does not hold restoration back.
- **On the server.** Restoration jobs are not in the library-analysis queues. Each server process runs at most one restoration at a time on its own loop, so a restoration never takes a queue's concurrency slot; queue concurrency is set under **Job Queues** as before.

## The edge worker (remote access)

The server container runs a third worker next to `api` and `microservices`: **edge**. It carries Frameleaf Cloud remote access. It is part of the default worker set, runs as a process of its own, and does nothing until remote access can run:

- Without `FRAMELEAF_CLOUD_URL`, a linked server, an active (or in-grace) remote access plan and **Allow remote access** switched on in Settings → Frameleaf Cloud → Remote access, it serves nothing and contacts nothing. It only reads the settings every 10 seconds.
- Exactly one edge worker serves at a time, however many containers run one: the one holding the edge lock in the database. Any other waits.
- It proxies every remote request to the API on this host (`127.0.0.1:IMMICH_PORT`, or `IMMICH_HOST` when that names an address), marking how it arrived with the per-boot `FRAMELEAF_EDGE_SECRET`. Without that secret it serves nothing: remote visitors are never let in as if they were at home.

### What it does once remote access is on

1. **Enrols** the server with Frameleaf Cloud (`POST /v1/remote/enroll`). The answer gives the server's label (16 characters derived from its instance ID), the direct domain in use and its names: `r.<label>.<domain>` for the relay, `<address>.<label>.<domain>` for LAN, WAN and IPv6 addresses (`192-168-1-10.<label>.frameleaf.net`). The direct domain always comes from Frameleaf Cloud; `frameleaf.net` is only the documented default.
2. **Obtains its own certificate** for `*.<label>.<domain>` and `<label>.<domain>` from Let's Encrypt with the ACME DNS-01 challenge. Frameleaf Cloud only publishes the challenge values the server hands it (`PUT` and `DELETE /v1/remote/dns/txt`) and pins the domain's CAA record to this server's ACME account. The ACME account key, the certificate and its private key are files readable by the server only (mode 0600) in `<identity folder>/edge`; they never leave the server. The server reports each certificate's serial, issuer, dates and names (never the certificate or key) so Frameleaf Cloud can watch Certificate Transparency logs for certificates it did not obtain.
3. **Renews** the certificate: it checks once a day, at a random time up to six hours later, and renews once less than 25 days or a third of the certificate's lifetime is left. A failed attempt is retried after 1 hour, then 2, 4 and so on, at most once a day, and administrators get one notice a day while it keeps failing. The current certificate keeps working until it expires.
4. **Listens for HTTPS** on `FRAMELEAF_EDGE_BIND:FRAMELEAF_EDGE_PORT` (default `0.0.0.0:2443`). A visitor on the home network (a private IPv4 address, an IPv6 unique local address or `FRAMELEAF_TRUSTED_LAN_CIDRS`) who opens one of the server's LAN names, such as `https://192-168-1-10.<label>.frameleaf.net:2443`, arrives as **home**; everyone else arrives as **remote** and signs in with Frameleaf. With **Relay only**, connections from outside the home network are closed; **Relay and direct** serves them too.

The proxy streams uploads and downloads without buffering (a request may run for up to 24 hours), passes byte ranges and WebSocket connections through, adds HSTS to every answer, and accepts at most 512 connections at once and 64 from one address (an IPv6 visitor counts by its /64).

**Docker networking.** Publish the listener's port on the server container (`ports: ['2443:2443']` next to `2283:2283`), with the same number inside and outside so the LAN names the server publishes work. The edge worker must see each visitor's real address. With the default bridge network, Docker keeps the address for IPv4 connections to a published port, but connections Docker forwards through its own proxy (IPv6 to an IPv4-only network, or hairpin connections from the same host) appear to come from the network's gateway, a private address. Such a visitor is still only treated as home when they also opened one of the server's own LAN names; to be sure, publish the port on a host with IPv6 enabled for Docker or use host networking. Set `FRAMELEAF_LOCAL_URL` to the address the home network knows the server by, so the LAN name the server publishes is that address rather than the container's.

### Turning it off

Switching remote access off or unlinking the server closes the listener and every connection and removes the certificates and their keys; the ACME account key stays, so the CAA record still names this server's account. When only the plan lapses, the listener closes and the certificates stay until they expire. Stopping or restarting the server closes every connection within five seconds.

### Your own domain

A server can also be reached at a hostname on a domain you own, such as `photos.example.com`, through the relay. Add it in Settings → Frameleaf Cloud → Remote access → **Use your own domain** and create these two records at your DNS provider:

| Type  | Name                                 | Points to                               |
| ----- | ------------------------------------ | --------------------------------------- |
| CNAME | `photos.example.com`                 | `r.<label>.frameleaf.net`               |
| CNAME | `_acme-challenge.photos.example.com` | `_acme-challenge.<label>.frameleaf.net` |

The page shows the exact values for your server. **Check DNS** asks Frameleaf Cloud whether both records point to this server; once they do, the hostname is verified and the edge worker obtains and renews a certificate for it through the second record, the same way as for its own names. Hostnames under Frameleaf's own domains (`frameleaf.net`, `frameleaf-direct.net`, `frameleaf.cloud`) are refused. **Use my domain** publishes the verified hostname as the server's public address, in links, emails and to the apps; **Use the Frameleaf address** goes back to `https://r.<label>.frameleaf.net`. **Remove domain** stops using it; you can then delete the records.

### Connections and the public address

`GET /api/server/connections` lists the ways to reach the server, in the order apps should try them: local (LAN names), WAN and IPv6 (in **Relay and direct** mode), the verified custom hostname, then the relay. `/api/server/config` and `/.well-known/immich` publish the public address. The check-in with Frameleaf Cloud reports the same list and whether the relay and direct connections are up.

**Test connection** on the Remote access page checks the certificate, that the HTTPS listener is running, and that a request through it reaches the server, and shows what the relay and router reported last.

The relay tunnel and automatic router port mapping arrive in later versions; until then remote visitors reach the server through direct connections only.

## API

`GET /api/admin/workers` returns the inventory for administrators. It reads stored state only: loads are counts, runner identities are process names, and no owner, asset or credential is returned. Destinations, routes, consent and checks use the `/api/ml-destinations` endpoints; Frameleaf Cloud's status, destination, AI Wallet, catalogue and consent records use `/api/admin/cloud/ml`.
