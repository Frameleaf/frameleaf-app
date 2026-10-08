# OPS-06 · A second computer on your home network

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators whose server is small (a NAS or mini PC) and who have a more powerful computer at home |
| Features demonstrated | Home-network worker container (compose file, port 3003, optional GPU), what moves and what stays on the server, Add home-network worker, Check now and health (Not checked, Healthy, Unreachable), worker state in Workers & endpoints, routing in Where each kind of work runs, the machine-learning URL list (Add endpoint, order), no fallback and retrying, security and version matching, Job manager Worker column and Load |
| Source docs | docs/docs/guides/remote-machine-learning.md, docs/docs/administration/workers-and-endpoints.md |
| Capture checklist | frameleaf.home running normally with Taylor signed in as administrator, dark theme. A second machine "Office PC" on the same network at `192.168.1.50` with Docker and an NVIDIA GPU (driver and Container Toolkit installed), a folder holding the compose file below and `hwaccel.ml.yml`. Before capture, Processing destinations lists only "This server". For beat 10, Office PC shut down or its container stopped, with a few Visual search jobs failed. For beat 12, jobs in the Visual search queue that ran on Office PC. Blur GPU names. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD "A second computer on your home network · Running Frameleaf". DIAGRAM: node "frameleaf.home" (green, small box icon) on the left; node "Office PC · GPU" (teal) on the right, both inside a rounded boundary labelled "Home network". A teal arrow "Previews" runs right, a green arrow "Results" runs back. | Previews → · ← Results | "If your server is small, a desktop on your home network can do the heavy machine-learning work. The server sends it image previews, and it sends back results." |
| 3 | 0:15–0:28 | CARD "What moves, what stays" in two columns. Can run on Office PC: "Search and similarity", "Face detection", "Text in photos", "Descriptions and tags". Stays on frameleaf.home: "Face matching", "Thumbnails and playback videos", "Originals and the database". A padlock icon on the second column. | What moves, what stays | "Only the machine-learning container moves. Face matching, thumbnails, playback videos, your originals and the database stay on the server. The worker keeps nothing and does not know whose photos it sees." |
| 4 | 0:28–0:45 | TERMINAL titled "Office PC": `docker-compose.yml` shown line by line: `name: frameleaf_remote_ml`, `immich-machine-learning:`, `container_name: frameleaf_machine_learning`, `image: ghcr.io/frameleaf/frameleaf-machine-learning:${IMMICH_VERSION:-release}-cuda`, `extends:` `file: hwaccel.ml.yml` `service: cuda`, `volumes: - model-cache:/cache`, `restart: always`, `ports: - 3003:3003`. HIGHLIGHT the image line, then the ports line. | Frameleaf machine-learning image · port 3003 | "On the second computer, install Docker and create a compose file with only the machine-learning service. Use the Frameleaf machine-learning image, publish port 3003, and add the acceleration file if it has a GPU, as in the last episode." |
| 5 | 0:45–0:52 | TERMINAL on Office PC: `docker compose up -d` (container started). TERMINAL titled "frameleaf.home": `curl http://192.168.1.50:3003/ping` prints `pong`. | pong | "Start it. From the server, check that the worker answers; a ping returns pong." |
| 6 | 0:52–1:07 | SCREEN: Settings → Compute & jobs → Workload destinations; scroll past Where each job runs to "Processing destinations". HIGHLIGHT "Add home-network worker"; CURSOR clicks. Dialog "Add destination · Home network": CURSOR types Name "Office PC", URL `http://192.168.1.50:3003`; under "Allowed work" ticks Face recognition, Search and similarity, Text in photos, and Descriptions, tags and content checks; the hint "A worker runs library analysis or restoration, not both." stays visible. CURSOR clicks Save. | Add home-network worker · Name · URL · Allowed work | "In Frameleaf, open Settings, then Compute & jobs, then Workload destinations. Under Processing destinations, choose Add home-network worker. Name it, enter its URL, allow the library work it should take, and save." |
| 7 | 1:07–1:20 | ZOOM on the new card "Office PC · Home network · Not checked". CURSOR clicks "Check now"; "Checking…"; health turns "Healthy" with "Last check" updated. Cut to Settings → Compute & jobs → Workers & endpoints: row "Office PC · ML inference · Model ready". | Check now · Healthy · Model ready | "Choose Check now. Health moves from Not checked to Healthy. In Workers & endpoints, the new worker shows Model ready with a GPU, or CPU only without one." |
| 8 | 1:20–1:35 | SCREEN: back to Processing destinations, list "Where each kind of work runs". CURSOR sets "Search and similarity" to Office PC, then "Descriptions, tags and content checks" to Office PC; each row reads "Runs on Office PC". Face recognition and Text in photos stay on This server. CALLOUT "Nothing is routed until you choose". | Where each kind of work runs | "Adding a worker sends it nothing yet. Under Where each kind of work runs, route Search and similarity, and Descriptions, tags and content checks, to the new worker. Leave the rest on this server." |
| 9 | 1:35–1:50 | SCREEN: Workers & endpoints → "Machine-learning endpoints": "ML endpoint 1 · http://immich-machine-learning:3003" with Move earlier, Move later and Remove; HIGHLIGHT "Add endpoint", which opens "Add ML endpoint" with the field "Endpoint URL" (CURSOR cancels). ZOOM on the note "The order only sets the default for work that has no route yet; routed work stays where it is routed." | Add endpoint · The order is not a fallback | "You can instead add the worker's URL to the machine-learning endpoint list with Add endpoint. There, the order only decides where work without a route starts. It is not a fallback list." |
| 10 | 1:50–2:07 | SPLIT: left, Office PC's card in Processing destinations reads "Unreachable" and its route row "Routed to Office PC, which currently refuses this work"; right, Job manager → Visual search → Failed tab, job detail "Last error · The destination did not answer.". Then Office PC turns "Healthy" again and CURSOR clicks "Retry failed", then HIGHLIGHT "Run missing". | Nothing falls back · Retry failed · Run missing | "Nothing falls back. If the desktop is asleep, work routed to it is refused with a reason, not sent back to the server. When it is awake again, open Job manager and retry the failed jobs, or run missing." |
| 11 | 2:07–2:21 | CARD "Keep it safe": bullet 1 "No sign-in of its own: home network only"; bullet 2 "Never forward port 3003 to the internet"; bullet 3 "Update it with the server". DIAGRAM behind dims; a red cross over a line from Office PC to a blue "Internet" node. | Keep it safe | "The worker has no protection of its own, so keep it on your home network and never expose port 3003. Update it whenever you update the server; mismatched versions can misbehave." |
| 12 | 2:21–2:32 | SCREEN: Job manager → Visual search → History; the Worker column reads "Local / LAN"; CURSOR opens one job: "Worker · Local / LAN · Office PC". Cut to Workers & endpoints, ZOOM on Office PC's "Load · 4 running · 380 waiting". | Worker · Load | "In Job manager, each job's worker shows where it ran, and Load in Workers & endpoints shows how busy the desktop is." |
| 13 | 2:32–2:42 | CARD "Three steps": bullet 1 "Run the container"; bullet 2 "Add the destination"; bullet 3 "Route the work". | Three steps | "Three steps: run the container, add the destination, and route the work." |
| 14 | 2:42–2:45 | LOGO OUTRO | Next: OPS-07 · Video transcoding and hardware transcoding | "Next up: Video transcoding and hardware transcoding." |

## Voice-over (clean)

If your server is small, a desktop on your home network can do the heavy machine-learning work. The server sends it image previews, and it sends back results.

Only the machine-learning container moves. Face matching, thumbnails, playback videos, your originals and the database stay on the server. The worker keeps nothing and does not know whose photos it sees.

[pause]

On the second computer, install Docker and create a compose file with only the machine-learning service. Use the Frameleaf machine-learning image, publish port 3003, and add the acceleration file if it has a GPU, as in the last episode.

Start it. From the server, check that the worker answers; a ping returns pong.

[pause]

In Frameleaf, open Settings, then Compute & jobs, then Workload destinations. Under Processing destinations, choose Add home-network worker. Name it, enter its URL, allow the library work it should take, and save.

Choose Check now. Health moves from Not checked to Healthy. In Workers & endpoints, the new worker shows Model ready with a GPU, or CPU only without one.

Adding a worker sends it nothing yet. Under Where each kind of work runs, route Search and similarity, and Descriptions, tags and content checks, to the new worker. Leave the rest on this server.

You can instead add the worker's URL to the machine-learning endpoint list with Add endpoint. There, the order only decides where work without a route starts. It is not a fallback list.

[pause]

Nothing falls back. If the desktop is asleep, work routed to it is refused with a reason, not sent back to the server. When it is awake again, open Job manager and retry the failed jobs, or run missing.

The worker has no protection of its own, so keep it on your home network and never expose port 3003. Update it whenever you update the server; mismatched versions can misbehave.

In Job manager, each job's worker shows where it ran, and Load in Workers & endpoints shows how busy the desktop is.

Three steps: run the container, add the destination, and route the work.

[pause]

Next up: Video transcoding and hardware transcoding.

## Production notes

- The worker's compose file for beat 4 (Frameleaf image and container name from `docker/docker-compose.yml`; the service key stays `immich-machine-learning` for compatibility):

  ```yaml
  name: frameleaf_remote_ml
  services:
    immich-machine-learning:
      container_name: frameleaf_machine_learning
      image: ghcr.io/frameleaf/frameleaf-machine-learning:${IMMICH_VERSION:-release}-cuda
      extends:
        file: hwaccel.ml.yml
        service: cuda
      volumes:
        - model-cache:/cache
      restart: always
      ports:
        - 3003:3003
  volumes:
    model-cache:
  ```

- Doc vs current build, three differences the VO follows the build on:
  - remote-machine-learning.md still shows the upstream image, project name and container name; the Frameleaf image is `ghcr.io/frameleaf/frameleaf-machine-learning` (docker/README.md). Pin the same version as the server rather than `release` when the server is pinned.
  - The guide says to click "Add URL" in Machine Learning Settings and describes the URL list as tried "one-at-a-time" with fallback to the local container. The current build does not fall back: each kind of work runs only on the destination it is routed to (workers-and-endpoints.md "Nothing falls back", "the order sets nothing else"). The "Add URL" button still exists in Settings → Search & intelligence → Machine Learning Settings, and its help text still describes one-at-a-time fallback; keep that page out of shot. Beat 9 shows the same list in Workers & endpoints, where the button reads "Add endpoint".
  - The guide's recovery step ("click Missing … in the Job Status page") is now the queue's "Run missing" or the Failed tab's "Retry failed" in Job manager.
- Why "Add home-network worker" first: it creates a destination of kind "Home network" with its own name, so Job manager and Activity say where work ran. A URL added to the endpoint list instead becomes a destination named "This server ({host})". Either way, nothing is routed to it until you choose it under "Where each kind of work runs" (unrouted work goes to the first list entry only).
- What stays on the server: the guide notes facial recognition (matching) runs between the server and the database, and that previews are the only thing sent. Thumbnails, playback videos and metadata are server-container jobs. The worker "does not persist this data or associate it with a particular user" (guide). Face detection does run on the worker when face recognition is routed there; the capture keeps Face recognition on This server to keep beat 8 simple.
- Security (guide danger note): previews travel to the worker and the machine-learning container has no security of its own. The Processing destinations dialog has an optional "Access token" field; the worker-side setting for it is not in the user docs, so the episode leaves it empty and does not mention it.
- Strings verified in the build: "Add home-network worker", "Add destination", "Home network", "Allowed work", "A worker runs library analysis or restoration, not both. Add a restoration worker as its own destination.", "Check now", "Checking…", "Healthy", "Unreachable", "Not checked", "Where each kind of work runs", "Runs on {name}", "Routed to {name}, which currently refuses this work", "Machine-learning endpoints", "Add endpoint", "Add ML endpoint", "Endpoint URL", "Move earlier", "Move later", the order note quoted in beat 9, Job manager Worker labels "Server", "Local / LAN", "Frameleaf Cloud". Workload names: "Face recognition", "Search and similarity", "Text in photos", "Descriptions, tags and content checks".
- Keep restoration out of the allowed-work ticks; restoration workers are HOLD content.
