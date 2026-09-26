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

When descriptions are allowed on Frameleaf Cloud (**Both** or **Cloud only** in **Where each job runs**) and routed to it, photos are never described one at a time. They are sent in batches: one owner's photos per batch, one cloud job per batch, and jobs of the same model carry the same pack key so they can share a started worker. Each batch shows in its owner's **Activity**.

- **Describe your library** in **Frameleaf Cloud processing** estimates first and queues nothing. The estimate is scaled from the model's measured GPU time for a sample of the photos: a likely and an at-most (p50–p90) cost, the cost per photo, the start fee each batch pays and the AI Wallet balance. It is refused when the wallet, the daily limit or the destination's budget cannot cover it. **Describe** then queues the batches. The job that describes the whole library from **Jobs** does not queue photos for Frameleaf Cloud; use this estimate instead.
- **Describe new photos automatically** (off by default) collects new photos and batches them within its daily budget. The budget counts per calendar day in the server's time zone. When it is used up, no new batch starts that day, administrators are told once, and batching carries on the next day.
- Before a batch is sent, Frameleaf Cloud seals an estimate for exactly its photos. The batch is sent only if the wallet can hold that amount, today's limit and the destination's budget leave room for it and, for a batch you approved, the estimate is not more than 20% above what you saw. Otherwise nothing is sent.
- Locked photos are never sent. The copy that would leave the server is the preview written again without EXIF, XMP or IPTC, so no location or camera data leaves it. Videos are not described on Frameleaf Cloud.
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

## API

`GET /api/admin/workers` returns the inventory for administrators. It reads stored state only: loads are counts, runner identities are process names, and no owner, asset or credential is returned. Destinations, routes, consent and checks use the `/api/ml-destinations` endpoints; Frameleaf Cloud's status, destination, AI Wallet, catalogue and consent records use `/api/admin/cloud/ml`.
