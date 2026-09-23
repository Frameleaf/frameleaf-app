# Workers and Endpoints

Frameleaf sends machine-learning work to **destinations**: the machine-learning container that ships with the server, other machines on your network, and RunPod in the cloud. **Administration > Processing destinations** shows them in two parts:

- **Workers & endpoints**, an inventory of every worker with its current state.
- **Processing destinations**, where you add workers, record cloud consent and choose where each kind of work runs.

## Two kinds of worker

Library analysis and restoration never share a worker.

| Work                                                               | Runs on                                                                                        | Image                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Library analysis: faces, search and similarity, text, descriptions | The machine-learning endpoints, a `/predict` container on another machine, or the RunPod pod   | `frameleaf-machine-learning`              |
| Restoration (Faithful and Creative)                                | A restoration worker on this server or your network, or a **RunPod video worker** in the cloud | Built from `Dockerfile.video-restoration` |

The rules the server enforces:

- A destination is allowed library-analysis work **or** restoration work, not both. The form closes one kind once you tick the other.
- The managed RunPod pod runs the ordinary image and is a library-analysis worker only. Restoration in the cloud uses a separate **RunPod video worker**: a persistent worker you run on RunPod, with its own URL and token, which the server never starts or stops.
- A restoration is refused (never moved) when its destination is the library-analysis pod, is still allowed both kinds of work from before this rule, or points at an endpoint a library workload is routed to.
- Nothing falls back. A job whose destination is missing, disabled, unreachable, over budget or without consent is refused and says why. Cloud destinations need recorded consent, and a restoration in the cloud also needs the person's confirmation for that request.

Destinations saved before the separation that allow both kinds of work keep running library analysis and are listed under **Workers allowed both kinds of work** until you limit them to one.

## The inventory

Each worker shows:

- **State.** _Not checked_ (no check yet), _Turned off_, _Unreachable_ (the last check got no answer, or there is no address), _No models ready_ (it answered but serves none of the work it is allowed), _CPU only_ (it serves its work without an accelerator) or _Model ready_. A configured address never counts as ready on its own.
- **Capabilities, GPU memory and acceleration** as the worker reported them. A restoration worker reports each GPU's memory; the `/predict` container reports its execution providers only, so its GPU memory shows as unknown.
- **Credentials** as a state only. Tokens are never shown after they are saved.
- **Routed here** and **Admission**: which kinds of library work are routed to this worker, and what the server would answer for each kind of work it is allowed, from the last check.
- **Load**: jobs running and waiting for this worker. For a library-analysis worker this is the backlog of the queues whose work is routed there; for a restoration worker it is its restoration jobs.

**Library analysis routes** lists each kind of library work with the worker it is routed to. A route to RunPod is shown as RunPod (cloud); an unrouted kind of work is shown as refused.

**Render workers** lists the Studio render workers by when they last checked in. They call the server, so there is no address to show. **Restoration runners on this server** lists the server processes holding restoration jobs right now.

The inventory refreshes every 30 seconds while the page is open. When a refresh fails it keeps the last snapshot on screen and says how old it is. **Check capabilities** checks exactly that worker now; nothing else is contacted.

### The machine-learning URL list

**Machine-learning endpoints** edits the machine-learning URL list from the machine-learning settings. Use each worker's base URL (HTTP or HTTPS, without a password, query or fragment); up to 32 are supported and at least one must remain. The server creates a destination for each URL on this network and routes library work that has no route yet to the first one; the order sets nothing else. When a URL leaves the list (removed, or edited to a new address) its destination is turned off: work routed to it is refused, not moved, until you route it elsewhere. If the URL is added back, that destination is turned on again. Removing a URL does not stop a remote worker, and existing restorations keep their chosen destination.

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

`GET /api/admin/workers` returns the inventory for administrators. It reads stored state only: loads are counts, runner identities are process names, and no owner, asset or credential is returned. Destinations, routes, consent and checks use the `/api/ml-destinations` endpoints.
