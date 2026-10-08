# AI-01 · How Frameleaf's AI works

| Field | Value |
| --- | --- |
| Series | Frameleaf AI |
| Type | Learn |
| Target length | 2:45 |
| Audience | Operators and administrators deciding where machine learning runs |
| Features demonstrated | Processing destinations (this server, home-network workers, Frameleaf Cloud), what never leaves the network (faces, search, text recognition), Workers & endpoints inventory, GPU check, curated description models, Activity, Job manager queues |
| Source docs | docs/docs/administration/workers-and-endpoints.md, docs/docs/features/ml-hardware-acceleration.md, docs/docs/features/image-enrichment.md |
| Capture checklist | Signed in as Taylor (admin). Settings → Compute & jobs → Workers & endpoints with the built-in machine-learning container in state "Model ready" and one home-network worker "CPU only"; Processing destinations with the "Where each job runs" routes; Hardware & GPU showing "GPU ready"; Settings → Search & intelligence → Image Description with the Description model dropdown open; Activity page with two finished jobs and one running; Job manager with the Face detection, Face recognition and Descriptions & tags queues visible. Frameleaf Cloud stays in its "Not linked" state; no cloud pages beyond the destination row. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "How Frameleaf's AI works · Frameleaf AI"; TITLE "Where the work goes" with subheading "This server, your network, and an optional cloud" | Where the work goes | "Frameleaf's AI runs where you decide. This episode explains where the work goes, what stays at home and how to watch it." |
| 3 | 0:13–0:25 | DIAGRAM: node "Your Frameleaf server" (green) with a child node "Machine-learning container" (teal); four small labels fade in beside it as the VO names them: Faces, Search, Text, Descriptions | Machine-learning container | "Every server ships with one machine-learning container. It finds faces, builds search, reads text and writes descriptions." |
| 4 | 0:25–0:36 | DIAGRAM adds node "Home-network worker" (teal) to the right, linked by a 2 px line; a small "GPU" chip on the worker; the Descriptions label slides across to it | Home-network worker | "You can add another computer on your home network as a worker. A GPU there takes the heavy jobs, and the server keeps the rest." |
| 5 | 0:36–0:48 | DIAGRAM adds node "Frameleaf Cloud" (blue) above, dashed line, chip "Optional"; a padlock icon on the line until the VO says "turns cloud processing on" | Frameleaf Cloud · optional | "Frameleaf Cloud is optional. Nothing is contacted until an administrator links the server and turns cloud processing on." |
| 6 | 0:48–1:00 | CARD headline "What never leaves your network"; bullets: "Face recognition", "Smart search", "Text in photos (OCR)"; the DIAGRAM dims behind it | What never leaves your network | "Some work never leaves. Faces never run on Frameleaf Cloud. Search and text recognition always stay on your own workers." |
| 7 | 1:00–1:13 | SCREEN Settings → Compute & jobs → Workers & endpoints; CURSOR moves down the inventory; CALLOUT on the State column: "Model ready" on the built-in container, "CPU only" on the home-network worker | Workers & endpoints | "Open Settings, then Compute & jobs, then Workers & endpoints. Every worker is listed with its state, such as Model ready, CPU only, Unreachable or Turned off." |
| 8 | 1:13–1:26 | SCREEN Processing destinations; ZOOM on the "Where each job runs" routes; HIGHLIGHT the "Descriptions & tags" row and its destination picker | Where each job runs | "Processing destinations is where you choose where each kind of work runs. Descriptions and tags can go to this server, a home-network worker or Frameleaf Cloud." |
| 9 | 1:26–1:37 | CARD headline "Nothing falls back"; bullets: "Destination off or unreachable: refused", "Over budget or no consent: refused", "The reason is shown" | Nothing falls back | "Nothing falls back. A job whose destination is off, unreachable or over budget is refused, and Frameleaf says why." |
| 10 | 1:37–1:49 | SCREEN Compute & jobs → Hardware & GPU; ZOOM on the "GPU check" card showing "GPU ready"; CALLOUT on the "What this hardware can run" list | GPU check | "Hardware & GPU runs the GPU check. It reports GPU ready, Processor only or Needs attention, and lists what this hardware can run." |
| 11 | 1:49–2:03 | SCREEN Settings → Search & intelligence → Image Description; CURSOR opens the "Description model" dropdown; HIGHLIGHT "Qwen2.5-VL 3B (default)"; CALLOUT on "Fallback model: microsoft/Florence-2-base-ft" | Description model | "Descriptions come from a vision-language model in a curated list. Qwen2.5-VL 3B is the default. Florence-2 is a caption-only fallback that ignores your prompt." |
| 12 | 2:03–2:17 | SCREEN top bar → Activity; CURSOR clicks the filter chips All, Running, Done, Failed in turn; ZOOM on one job row showing destination "This server", another "A computer on your network" | Activity | "Durable jobs appear in Activity. Filter by All, Running, Done or Failed. Each job names its destination: This server, a computer on your network, or Frameleaf Cloud." |
| 13 | 2:17–2:29 | SCREEN Settings → Compute & jobs → Job manager; CURSOR scrolls to the Face detection, Face recognition and Descriptions & tags queues; COUNTER on the Descriptions & tags waiting count | Job manager | "Background queues such as Face detection, Face recognition and Descriptions & tags live in Job manager, also under Compute & jobs." |
| 14 | 2:29–2:42 | CARD headline "Before you switch everything on"; bullets: "Confirm the description model", "Run facial recognition and name people", "Preview a description first" | Start in this order | "Before you switch everything on, confirm the model, run facial recognition and name your people, then preview a description. The next episodes take each step in turn." |
| 15 | 2:42–2:45 | LOGO OUTRO | Guide: Workers and Endpoints | "The written guide is linked below." |

## Voice-over (clean)

Frameleaf's AI runs where you decide. This episode explains where the work goes, what stays at home and how to watch it. [pause]

Every server ships with one machine-learning container. It finds faces, builds search, reads text and writes descriptions. [beat] You can add another computer on your home network as a worker. A GPU there takes the heavy jobs, and the server keeps the rest. [beat] Frameleaf Cloud is optional. Nothing is contacted until an administrator links the server and turns cloud processing on. [pause]

Some work never leaves. Faces never run on Frameleaf Cloud. Search and text recognition always stay on your own workers. [pause]

Open Settings, then Compute & jobs, then Workers & endpoints. Every worker is listed with its state, such as Model ready, CPU only, Unreachable or Turned off. [beat] Processing destinations is where you choose where each kind of work runs. Descriptions and tags can go to this server, a home-network worker or Frameleaf Cloud. [beat] Nothing falls back. A job whose destination is off, unreachable or over budget is refused, and Frameleaf says why. [pause]

Hardware & GPU runs the GPU check. It reports GPU ready, Processor only or Needs attention, and lists what this hardware can run. [beat] Descriptions come from a vision-language model in a curated list. Qwen2.5-VL 3B is the default. Florence-2 is a caption-only fallback that ignores your prompt. [pause]

Durable jobs appear in Activity. Filter by All, Running, Done or Failed. Each job names its destination: This server, a computer on your network, or Frameleaf Cloud. [beat] Background queues such as Face detection, Face recognition and Descriptions & tags live in Job manager, also under Compute & jobs. [pause]

Before you switch everything on, confirm the model, run facial recognition and name your people, then preview a description. The next episodes take each step in turn. [pause]

The written guide is linked below.

## Production notes

- Prerequisites: one home-network worker configured under Machine-learning endpoints so the inventory shows two rows; Hardware & GPU captured on a server whose GPU check reads "GPU ready". Frameleaf Cloud must remain "Not linked"; the Frameleaf Cloud destination row is shown only inside "Where each job runs", never the Cloud processing page.
- Never name the GPU model in the capture; crop or blur the GPU name inside the GPU check card if the build prints one.
- Doc wording mismatch: workers-and-endpoints.md says "Administration > Processing destinations"; the current build is Settings → Compute & jobs, with "Workers & endpoints" and "Processing destinations" as sections (integration inventory wins). image-enrichment.md still says "Administration > Settings > Machine Learning Settings"; the current path is Settings → Search & intelligence → Image Description (panel heading in the build reads "Image descriptions and tags").
- The "what never leaves" line quotes workers-and-endpoints.md: "Faces never run on Frameleaf Cloud; search and text recognition stay on your own workers." Do not extend it to other job kinds.
- Model names are the documented dropdown labels: "Qwen2.5-VL 3B (default)" and the fallback `microsoft/Florence-2-base-ft`. The Florence banner appears only when Florence is chosen as the primary model; keep the primary on Qwen in the capture.
- Activity destination labels are from the build: "This server", "A computer on your network", "Frameleaf Cloud". Queue labels in Job manager are "Face detection", "Face recognition" and "Descriptions & tags".
- Outro CTA on screen: `Guide: Workers and Endpoints`; producer fills the public URL.
