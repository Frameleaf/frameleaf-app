# OPS-04 · Compute & jobs: workers, endpoints and the GPU check

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators who want to see which machines do Frameleaf's processing, whether the GPU is used, and where each kind of work runs |
| Features demonstrated | Compute & jobs directory, Workers & endpoints inventory (states, capabilities, GPU memory, credentials, Routed here, Admission, Load, Check capabilities, Library analysis routes, refresh), Hardware & GPU (GPU check states, both containers, What needs fixing, compose fix, What this hardware can run, Run a short benchmark), Workload destinations (Where each job runs: Local only, Both, Cloud only), Processing destinations (destinations, Where each kind of work runs), no fallback |
| Source docs | docs/docs/administration/workers-and-endpoints.md |
| Capture checklist | Taylor signed in as administrator on frameleaf.home, dark theme. Settings → Compute & jobs directory. Workers & endpoints with two library-analysis workers: "This server" (the built-in machine-learning container, Model ready, accelerator reported) and "Office PC" (a home-network worker at `http://192.168.1.50:3003`, CPU only); Descriptions, tags and content checks routed to Office PC, everything else to This server. Hardware & GPU on a server with a GPU (status "GPU ready"), plus a second capture where the machine-learning container runs the processor image ("Needs attention"). Workload destinations with Frameleaf Cloud not linked. For the no-fallback beat, Office PC switched off so its health reads "Unreachable". |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Compute & jobs: workers, endpoints and the GPU check · Running Frameleaf". SCREEN: Settings → Compute & jobs directory with the groups "Workers & destinations" (Workers & endpoints, Hardware & GPU, Workload destinations), "Job management" (Job manager) and "Schedules & caching" (Nightly work & model cache). | Settings → Compute & jobs | "Compute & jobs is where you see every worker, check the GPU and choose where work runs. Open Settings, then Compute & jobs." |
| 3 | 0:13–0:31 | CURSOR clicks "Workers & endpoints" ("Discover capabilities per endpoint, including machines on your home network."). The inventory: "This server · ML inference · Model ready" and "Office PC · ML inference · CPU only". CALLOUT on the state chip of each as named; a small CARD beside them lists the other states: "Not checked", "Unreachable", "No models ready", "Turned off". | Workers & endpoints | "Workers & endpoints lists every worker with its state. Not checked means no check has run yet. Model ready and CPU only mean it serves its work, with or without an accelerator. Unreachable, No models ready and Turned off mean it cannot." |
| 4 | 0:31–0:46 | CURSOR expands "This server". HIGHLIGHT each field as named: Capabilities, GPU memory, Credentials ("No credentials in the URL"), Routed here, Admission ("Search and similarity: accepted"), Load ("2 running · 40 waiting"). CURSOR clicks "Check capabilities"; the button reads "Checking…" then "Last check" updates. | Check capabilities | "Open a worker to see what it reported: capabilities, GPU memory, credentials as a state only, the work routed here, what admission would answer, and its load. Check capabilities checks that one worker now." |
| 5 | 0:46–0:56 | SCREEN scrolls to "Library analysis routes": "Face recognition · This server", "Search and similarity · This server", "Text in photos · This server", "Descriptions, tags and content checks · Office PC", each with its waiting count. ZOOM on the header line "Updated 09:14". | Library analysis routes · Updated every 30 s | "Library analysis routes shows where each kind of library work goes. The page refreshes every thirty seconds and says when a snapshot is old." |
| 6 | 0:56–1:12 | CURSOR opens "Hardware & GPU". Card "GPU check" with status "GPU ready" and "Last checked …". Two rows below, HIGHLIGHT each as named: "Video playback and export · Server container · converts videos and exports Studio projects" with "GPU in use", and "AI features · ML container · search, faces, captions and restoration" with "GPU in use". Vendor, Model (blurred), GPU memory, Driver / runtime and Backend beside each. | GPU check | "Hardware & GPU runs the GPU check on both containers: the server, for video playback, and machine learning, for AI features. Each needs its own access to the card, so each is checked." |
| 7 | 1:12–1:28 | SPLIT of three GPU check headers: "GPU ready", "Processor only", "Needs attention". Then the Needs attention capture: "What needs fixing · Until this is resolved, work runs on the processor." with the problem "The machine-learning container runs the processor image. Use the image that matches your GPU: -cuda, -openvino or -rocm.", the line "Shown in the logs as …", and the button "Copy the docker compose fix for NVIDIA". ZOOM on "After changing docker compose, recreate the containers with docker compose up -d, then run the check again." HIGHLIGHT "Run check again". | GPU ready · Processor only · Needs attention | "The result is GPU ready, Processor only or Needs attention. When something needs fixing, the check names the problem, shows the log line, and offers a compose fix to copy. Recreate the containers, then run the check again." |
| 8 | 1:28–1:38 | Back on the GPU ready capture. ZOOM on "What this hardware can run · The model sliders in Where each job runs follow this result." with lines such as "Up to … here, on your GPU." CURSOR clicks "Run a short benchmark"; "Running a short benchmark…" then "Benchmark run · Search test … ms · 1080p transcode …× real time". | What this hardware can run · Run a short benchmark | "What this hardware can run lists the largest models that fit here. Run a short benchmark to time your own hardware." |
| 9 | 1:38–1:55 | CURSOR opens "Workload destinations". Table "Where each job runs": rows Face recognition ("Faces never leave this server."), Smart search, Text in photos, each marked "Runs on this server"; Descriptions & tags with the chips "Local only", "Both", "Cloud only", where Both and Cloud only are disabled. CALLOUT on the note "Link this server to Frameleaf to choose Frameleaf Cloud or both." | Where each job runs · Local only · Both · Cloud only | "Next, Workload destinations. Where each job runs sets each kind of work to Local only, Both or Cloud only. Faces, search and text in photos always stay local. Cloud choices stay off until you link Frameleaf Cloud and turn on cloud processing." |
| 10 | 1:55–2:11 | SCREEN scrolls to "Processing destinations": cards "This server · This server · Healthy" and "Office PC · Home network · Healthy", each with Allowed work and Last check; buttons "Add home-network worker" and "Add Frameleaf Cloud". Then the list "Where each kind of work runs"; CURSOR opens the select for "Descriptions, tags and content checks" showing This server and Office PC; closes it on Office PC. | Processing destinations · Where each kind of work runs | "Below it, Processing destinations lists each destination with its allowed work and health. Where each kind of work runs picks exactly one destination per kind of work. Only enabled destinations that allow that work are offered." |
| 11 | 2:11–2:24 | CARD "Nothing falls back": bullet 1 "Destination off or unreachable: refused"; bullet 2 "Work not routed: refused"; bullet 3 "The job says why". Then SCREEN: Office PC health "Unreachable"; the route row reads "Routed to Office PC, which currently refuses this work". | Nothing falls back | "Nothing falls back. If a destination is off or unreachable, its jobs are refused with a reason, not moved. Route the work elsewhere, or bring the worker back." |
| 12 | 2:24–2:42 | SCREEN: back on Workers & endpoints with Office PC healthy again. ZOOM on the Load field "3 running · 412 waiting" and the backlog line "Library analysis backlog: 412 jobs". Hold, then pull back. | Load | "Keep an eye on Load. A long backlog on one worker is the sign to add a GPU or a second computer, and the next two episodes show both." |
| 13 | 2:42–2:45 | LOGO OUTRO | Next: OPS-05 · Hardware acceleration for processing | "Next up: Hardware acceleration for processing." |

## Voice-over (clean)

Compute & jobs is where you see every worker, check the GPU and choose where work runs. Open Settings, then Compute & jobs.

Workers & endpoints lists every worker with its state. Not checked means no check has run yet. Model ready and CPU only mean it serves its work, with or without an accelerator. Unreachable, No models ready and Turned off mean it cannot.

Open a worker to see what it reported: capabilities, GPU memory, credentials as a state only, the work routed here, what admission would answer, and its load. Check capabilities checks that one worker now.

Library analysis routes shows where each kind of library work goes. The page refreshes every thirty seconds and says when a snapshot is old.

[pause]

Hardware & GPU runs the GPU check on both containers: the server, for video playback, and machine learning, for AI features. Each needs its own access to the card, so each is checked.

The result is GPU ready, Processor only or Needs attention. When something needs fixing, the check names the problem, shows the log line, and offers a compose fix to copy. Recreate the containers, then run the check again.

What this hardware can run lists the largest models that fit here. Run a short benchmark to time your own hardware.

[pause]

Next, Workload destinations. Where each job runs sets each kind of work to Local only, Both or Cloud only. Faces, search and text in photos always stay local. Cloud choices stay off until you link Frameleaf Cloud and turn on cloud processing.

Below it, Processing destinations lists each destination with its allowed work and health. Where each kind of work runs picks exactly one destination per kind of work. Only enabled destinations that allow that work are offered.

Nothing falls back. If a destination is off or unreachable, its jobs are refused with a reason, not moved. Route the work elsewhere, or bring the worker back.

[beat]

Keep an eye on Load. A long backlog on one worker is the sign to add a GPU or a second computer, and the next two episodes show both.

[pause]

Next up: Hardware acceleration for processing.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. workers-and-endpoints.md says "Administration > Processing destinations" with two parts; in the current build these are sections of Settings → Compute & jobs: "Workers & endpoints", "Hardware & GPU" and "Workload destinations" (the old `/admin/processing-destinations` address redirects there). Workload destinations holds the "Where each job runs" table first and the "Processing destinations" panel below it.
- State labels verified in the build: "Not checked", "Turned off", "Unreachable", "No models ready", "CPU only", "Model ready". Inventory fields: "Capabilities", "GPU memory", "Credentials", "Routed here", "Admission", "Load", "Last check", "Check capabilities", "Library analysis routes", "Updated {time}". Destination health in Processing destinations reads "Healthy", "Unreachable" or "Not checked".
- The GPU check lives in Hardware & GPU. Status labels: "GPU ready", "Processor only", "Needs attention"; container rows "Video playback and export" (server container) and "AI features" (ML container) with "GPU in use", "GPU not reached", "Processor" or "Not answering". Never show the GPU model name; blur the Model field and the benchmark's device name.
- Keep Studio and restoration out of focus: the Compute & jobs directory also lists "Render workers", the inventory has "Render workers", "Persistent video workers" and "Restoration runners on this server" blocks, and Where each job runs has rows for Video restoration, Enhance & upscale, Smooth motion, Transcripts & captions and Studio export. Those belong to the HOLD Studio and restoration episodes; frame the zooms on the four library-analysis rows. The server container's purpose line mentions Studio exports; the VO says only "video playback".
- The "Faces, search and text in photos always stay local" line follows the doc ("Faces never run on Frameleaf Cloud; search and text recognition stay on your own workers") and the table's fixed "Runs on this server" rows. Local here means this server or your home network, never the cloud.
- Frameleaf Cloud stays "Not linked" in this capture. Do not open the Cloud processing page; CLOUD-05 covers it. If the deployment has no `FRAMELEAF_CLOUD_URL`, the cloud destination shows "Not configured"; either state is fine.
- No-fallback wording follows the doc's rules list and the build's route string "Routed to {name}, which currently refuses this work". Queued jobs routed to a missing destination fail with a reason (for example "The destination did not answer.") and are retried from the Job manager (OPS-03).
- Load strings: "{active} running · {queued} waiting" and "Library analysis backlog: {n} jobs".
