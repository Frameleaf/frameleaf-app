# OPS-19 · Scaling across machines

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | Learn |
| Target length | 2:30 |
| Audience | Advanced administrators who want to spread Frameleaf's work over more than one container or machine |
| Features demonstrated | The api and microservices workers inside the server container, splitting them with IMMICH_WORKERS_INCLUDE and IMMICH_WORKERS_EXCLUDE, shared Postgres, Redis and files, DB_ and REDIS_ variables on every worker, config file on every worker, machine learning as a separate worker (Compute & jobs → Workers & endpoints), when scaling helps, Queue concurrency in Job manager on a single machine, scaling down safely |
| Source docs | docs/docs/guides/scaling-immich.md, docs/docs/administration/jobs-workers.md, docs/docs/install/environment-variables.md, docs/docs/administration/system-settings.md |
| Capture checklist | Mostly DIAGRAM work: node names "frameleaf.home" (home server) and "Gaming PC"; a TERMINAL with the compose diff from jobs-workers.md, renamed to the `frameleaf_*` container names; Taylor signed in as administrator on frameleaf.home; Settings → Compute & jobs → Job manager with the "Queue concurrency" dialog open; the same Job manager showing the Thumbnails and Playback videos queues with waiting counts while the second worker is stopped; the timeline (Summer in the Rockies) still browsable; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:18 | LOWER-THIRD "Scaling across machines · Running Frameleaf". DIAGRAM: one large node "frameleaf_server" (green) containing two chips that appear as named: "api" and "microservices". | LOWER-THIRD | "One Frameleaf server container does two kinds of work. Its api worker answers the web and mobile apps. Its microservices worker runs background jobs, such as thumbnails and video encoding." |
| 3 | 0:18–0:29 | DIAGRAM: the node splits into two copies side by side, then a second machine outline "Gaming PC" appears and one copy slides into it. | Built to run as several copies | "The server is built to run as several copies at once, so you can split that work across containers, or across machines." |
| 4 | 0:29–0:48 | TERMINAL titled "docker-compose.yml": the `immich-server` service gains `IMMICH_WORKERS_INCLUDE: 'api'` and keeps `ports: - 2283:2283`; a copied service `immich-microservices` with `container_name: frameleaf_microservices` gains `IMMICH_WORKERS_EXCLUDE: 'api'` and has no ports. HIGHLIGHT each change. | TERMINAL; CALLOUT "Only the api copy publishes 2283" | "To split them, copy the server service in your compose file. Give the original the setting that includes only the api worker, and give the copy the setting that excludes it. Only the api copy publishes port 2283." |
| 5 | 0:48–1:04 | DIAGRAM: both server copies (one on frameleaf.home, one on Gaming PC) connect with teal lines to three shared nodes that appear as named: "Postgres", "Redis", "Files (same mounts)". A small tag on each copy: "same DB_ and REDIS_ variables". | Shared: Postgres · Redis · Files | "Every copy must share the same infrastructure: the same Postgres database, the same Redis instance, and the same files mounted into each container. Give every copy the same database and Redis settings." |
| 6 | 1:04–1:19 | CARD "Also on every worker": bullet 1 "The config file, if you use one". Then SCREEN: Settings → Compute & jobs → Workers & endpoints with a home-network machine-learning worker listed; CALLOUT "Machine learning is a separate worker". | CARD; CALLOUT "Compute & jobs → Workers & endpoints" | "A config file, if you use one, goes into every copy as well. Machine learning is separate: another machine joins as a worker under Compute & jobs, as in the home-network episode." |
| 7 | 1:19–1:35 | CARD "How machines connect varies": bullet 1 "Replicas in a Kubernetes deployment"; bullet 2 "Network tunnels"; bullet 3 "NFS mounts for the files". | CARD | "How the machines connect depends on your setup. It might be more replicas in Kubernetes, a network tunnel, or an NFS mount for the files. The guide leaves those details to you." |
| 8 | 1:35–1:49 | CARD "When it helps": bullet 1 "A gaming PC for transcoding and thumbnails"; bullet 2 "A cluster of servers"; bullet 3 "One machine: raise concurrency instead". | When it helps | "When does it help? A gaming PC that takes on transcoding and thumbnails, or a cluster of servers. On a single machine it gains nothing; raise queue concurrency instead." |
| 9 | 1:49–1:59 | SCREEN: Settings → Compute & jobs → Job manager. CURSOR clicks Concurrency; the dialog "Queue concurrency" opens with a value per queue. CALLOUT "Stay within your CPU cores". | CALLOUT "Queue concurrency" | "That lives in Compute & jobs, Job manager, under Concurrency. Keep each value within your processor's core count." |
| 10 | 1:59–2:15 | DIAGRAM: the Gaming PC copy fades to grey with a "Stopped" chip; Postgres, Redis and Files stay lit; a small queue icon under Redis fills up. | Scaling down is safe | "Scaling down is just as safe. All state lives in Postgres, Redis and the files, so you can stop a job worker at any time, for example to use that GPU for games." |
| 11 | 2:15–2:27 | SPLIT: left, the timeline on frameleaf.home scrolling normally; right, Job manager with the Thumbnails and Playback videos waiting counts rising (COUNTER). | Browsing continues · jobs wait | "As long as an api worker is running, everyone can still browse. Jobs simply wait until a worker is available again." |
| 12 | 2:27–2:30 | LOGO OUTRO | Guide: Jobs and Workers | "The written guide is linked below." |

## Voice-over (clean)

One Frameleaf server container does two kinds of work. Its api worker answers the web and mobile apps. Its microservices worker runs background jobs, such as thumbnails and video encoding.

[pause]

The server is built to run as several copies at once, so you can split that work across containers, or across machines.

To split them, copy the server service in your compose file. Give the original the setting that includes only the api worker, and give the copy the setting that excludes it. Only the api copy publishes port 2283.

Every copy must share the same infrastructure: the same Postgres database, the same Redis instance, and the same files mounted into each container. Give every copy the same database and Redis settings.

A config file, if you use one, goes into every copy as well. Machine learning is separate: another machine joins as a worker under Compute & jobs, as in the home-network episode.

[beat]

How the machines connect depends on your setup. It might be more replicas in Kubernetes, a network tunnel, or an NFS mount for the files. The guide leaves those details to you.

[pause]

When does it help? A gaming PC that takes on transcoding and thumbnails, or a cluster of servers. On a single machine it gains nothing; raise queue concurrency instead.

That lives in Compute & jobs, Job manager, under Concurrency. Keep each value within your processor's core count.

[pause]

Scaling down is just as safe. All state lives in Postgres, Redis and the files, so you can stop a job worker at any time, for example to use that GPU for games.

As long as an api worker is running, everyone can still browse. Jobs simply wait until a worker is available again.

[pause]

The written guide is linked below.

## Production notes

- Narration tone: calm, for advanced operators. The guide deliberately gives no step-by-step for multi-machine networking (scaling-immich.md); neither does the episode.
- Worker facts (jobs-workers.md): the server container runs an `api` worker and a `microservices` worker; split by copying the service, setting `IMMICH_WORKERS_INCLUDE: 'api'` on one and `IMMICH_WORKERS_EXCLUDE: 'api'` on the copy, and removing the port from the copy. The doc's container names `immich_server` / `immich_microservices` are shown as `frameleaf_server` / `frameleaf_microservices` to match the Frameleaf containers (docker/README.md); the service keys are unchanged.
- Shared infrastructure (scaling-immich.md): same Postgres and Redis, same files mounted. All `DB_` and `REDIS_` variables must reach every worker (environment-variables.md). The release compose file runs a Valkey image under the service name `redis`; the docs call it Redis, and so does the VO.
- Config file on every worker: config-file.md note ("If you have any microservices workers, they will also need to have the config file mounted").
- Doc vs UI: jobs-workers.md says machine learning runs on the destinations under "Administration > Processing destinations" and that job status is on "Administration -> Jobs". The current build has Settings → Compute & jobs → Workers & endpoints, Workload destinations and Job manager; the VO uses the build labels. OPS-06 covers a home-network worker.
- Concurrency advice (scaling-immich.md info box, system-settings.md "Job Settings"): on a single machine, raise concurrency instead of adding containers, and do not exceed the available CPU cores. Build labels: "Concurrency" button and "Queue concurrency" dialog in Job manager.
- Scaling down (scaling-immich.md): all state is in Postgres, Redis and the filesystem, so stopping a server container is safe; with an API worker running people can browse, and jobs wait for a worker.
- The guide's title names another product, so the outro card uses the second source doc: `Guide: Jobs and Workers`; producer fills the public URL.
