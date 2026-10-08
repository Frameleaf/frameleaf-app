# START-02 · Install with Docker Compose

| Field | Value |
| --- | --- |
| Series | Start here |
| Type | How-to |
| Target length | 2:45 |
| Audience | New operators installing Frameleaf on a Linux server that already has Docker |
| Features demonstrated | Release files (docker-compose.yml, example.env, optional hwaccel.ml.yml and hwaccel.transcoding.yml, docker-compose.rootless.yml), downloading into a new folder, .env (UPLOAD_LOCATION, DB_DATA_LOCATION, TZ, DB_PASSWORD, values below the marked line), separate backups of UPLOAD_LOCATION, `docker compose up -d`, container names (frameleaf_server, frameleaf_machine_learning, frameleaf_postgres, frameleaf_redis), port 2283, "Welcome to Frameleaf" and Getting Started, Docker version troubleshooting |
| Source docs | docs/docs/install/docker-compose.mdx, docs/docs/overview/quick-start.mdx, docker/README.md |
| Capture checklist | Linux server "frameleaf.home" with Docker Engine and the Compose plugin, no Frameleaf containers yet, prompt `taylor@frameleaf:~$`. Browser tab on the Frameleaf release page with the assets list visible (docker-compose.yml, docker-compose.rootless.yml, example.env, hwaccel.ml.yml, hwaccel.transcoding.yml). Terminal font 16 px, dark theme. An editor (nano or similar, dark) for `.env`. A fresh browser profile for `http://frameleaf.home:2283` showing "Welcome to Frameleaf" with "Getting Started" and "Restore From Backup". Images pre-pulled on a second take so the `up` beat can be sped up without cutting. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD "Install with Docker Compose · Start here". SCREEN: the Frameleaf release page, Assets list. HIGHLIGHT docker-compose.yml, then example.env. | LOWER-THIRD; CALLOUT "docker-compose.yml · example.env" | "Frameleaf installs with Docker Compose, using files attached to a published Frameleaf release. They select the Frameleaf server and machine-learning images. You need two: docker-compose.yml and example.env." |
| 3 | 0:15–0:25 | TERMINAL: `mkdir ./frameleaf-app` then `cd ./frameleaf-app`; the prompt changes to `taylor@frameleaf:~/frameleaf-app$`. | CALLOUT "One folder for the stack" | "On your server, create a folder to hold them, for example frameleaf-app, and move into it." |
| 4 | 0:25–0:41 | TERMINAL: `wget -O docker-compose.yml https://github.com/Frameleaf/frameleaf-app/releases/latest/download/docker-compose.yml` (typing speeds up after "releases/"), saved line; then `wget -O .env …/example.env`, saved line; `ls -a` shows `.env` and `docker-compose.yml`. | CALLOUT "example.env → .env"; CALLOUT "Same release" | "Download the Compose file, then download example.env, saving it as .env. If you use a browser instead, rename example.env to .env yourself. Take both files from the same release." |
| 5 | 0:41–0:52 | Back on the release page. HIGHLIGHT hwaccel.ml.yml and hwaccel.transcoding.yml, then docker-compose.rootless.yml. CARD overlay "Optional, from the same release": bullet 1 "hwaccel.ml.yml · hwaccel.transcoding.yml: hardware acceleration"; bullet 2 "docker-compose.rootless.yml: use instead of the regular file". | CARD "Optional, from the same release" | "For hardware acceleration, get the two hwaccel files from that release too. A rootless Compose file is also included, to use instead of the regular one." |
| 6 | 0:52–1:08 | SCREEN: `.env` open in the editor. HIGHLIGHT `UPLOAD_LOCATION=./library`; CURSOR edits it to `UPLOAD_LOCATION=/srv/frameleaf/library`. CALLOUT "Back this folder up yourself". | CALLOUT "UPLOAD_LOCATION: your photos and videos" | "Open .env in an editor. UPLOAD_LOCATION is where your photos and videos are stored: choose a new folder with plenty of free space. Frameleaf's database backups don't include these files, so back this folder up separately." |
| 7 | 1:08–1:18 | HIGHLIGHT `DB_DATA_LOCATION=./postgres` and the comment above it ("Network shares are not supported for the database"). CALLOUT "Local SSD · never a network share". | CALLOUT "DB_DATA_LOCATION: the database" | "DB_DATA_LOCATION is where the database lives. Keep it on local SSD storage, never a network share." |
| 8 | 1:18–1:29 | HIGHLIGHT `# TZ=Etc/UTC`; CURSOR deletes the `#` and changes the value: `TZ=America/Edmonton`. | CALLOUT "TZ: your time zone" | "To set your time zone, remove the hash in front of TZ and enter your zone, such as America/Edmonton." |
| 9 | 1:29–1:43 | HIGHLIGHT `DB_PASSWORD=postgres`; CURSOR replaces the value with a long random string (blurred as it is typed). CALLOUT "Letters and numbers only: A–Z a–z 0–9". | CALLOUT "DB_PASSWORD: change it" | "Change DB_PASSWORD to a random value, using only letters and numbers. The database isn't exposed publicly, so this password is only used locally." |
| 10 | 1:43–1:52 | ZOOM on the version line and on the comment "The values below this line do not need to be changed" with the lines beneath it. Editor saves; status bar "Wrote .env". | CALLOUT "Leave as they are" | "Leave the version line and everything below the marked line as they are, and save the file." |
| 11 | 1:52–2:05 | TERMINAL: `docker compose up -d`. Image pulls scroll (sped up), then "Container frameleaf_redis Started", "Container frameleaf_postgres Started", "Container frameleaf_machine_learning Started", "Container frameleaf_server Started". | CALLOUT "Runs in the background" | "From the same folder, start Frameleaf with docker compose up. Docker downloads the images and runs everything in the background." |
| 12 | 2:05–2:19 | TERMINAL: `docker compose ps`, cropped to the NAME, STATUS and PORTS columns. HIGHLIGHT each name as it is read: frameleaf_server, frameleaf_machine_learning, frameleaf_postgres, frameleaf_redis. ZOOM on `0.0.0.0:2283->2283/tcp` on the server row. | CALLOUT "frameleaf_server · frameleaf_machine_learning · frameleaf_postgres · frameleaf_redis"; CALLOUT "Port 2283" | "Four containers start: frameleaf_server, which also serves the web app, frameleaf_machine_learning, frameleaf_postgres for the database, and frameleaf_redis. The server listens on port 2283." |
| 13 | 2:19–2:32 | SCREEN: browser, CURSOR types `http://frameleaf.home:2283` in the address bar. The page "Welcome to Frameleaf" appears with the button "Getting Started" and the smaller "Restore From Backup". HIGHLIGHT Getting Started (not clicked). | CALLOUT "Welcome to Frameleaf"; CALLOUT "Getting Started" | "In a browser, open your server's address on port 2283. Welcome to Frameleaf means the install worked; Getting Started begins first-run setup." |
| 14 | 2:32–2:42 | CARD "If Docker rejects the command": bullet 1 "`unknown shorthand flag: 'd' in -d`"; bullet 2 "Replace your distribution's Docker with Docker Engine from Docker's repository"; bullet 3 "Health check start_interval error: needs Docker Engine 25 or later". | CARD | "If Docker rejects the command, your distribution's Docker package is probably the cause: install Docker Engine from Docker's own repository." |
| 15 | 2:42–2:45 | LOGO OUTRO. Small line under the CTA: "Built on Immich". | Next: START-03 · Set up Frameleaf: your first run | "Next up: Set up Frameleaf: your first run." |

## Voice-over (clean)

Frameleaf installs with Docker Compose, using files attached to a published Frameleaf release. They select the Frameleaf server and machine-learning images. You need two: docker-compose.yml and example.env.

On your server, create a folder to hold them, for example frameleaf-app, and move into it.

Download the Compose file, then download example.env, saving it as .env. If you use a browser instead, rename example.env to .env yourself. Take both files from the same release.

For hardware acceleration, get the two hwaccel files from that release too. A rootless Compose file is also included, to use instead of the regular one.

[pause]

Open .env in an editor. UPLOAD_LOCATION is where your photos and videos are stored: choose a new folder with plenty of free space. Frameleaf's database backups don't include these files, so back this folder up separately.

DB_DATA_LOCATION is where the database lives. Keep it on local SSD storage, never a network share.

To set your time zone, remove the hash in front of TZ and enter your zone, such as America/Edmonton.

Change DB_PASSWORD to a random value, using only letters and numbers. The database isn't exposed publicly, so this password is only used locally.

Leave the version line and everything below the marked line as they are, and save the file.

[pause]

From the same folder, start Frameleaf with docker compose up. Docker downloads the images and runs everything in the background.

Four containers start: frameleaf_server, which also serves the web app, frameleaf_machine_learning, frameleaf_postgres for the database, and frameleaf_redis. The server listens on port 2283.

In a browser, open your server's address on port 2283. Welcome to Frameleaf means the install worked; Getting Started begins first-run setup.

If Docker rejects the command, your distribution's Docker package is probably the cause: install Docker Engine from Docker's own repository.

Next up: Set up Frameleaf: your first run.

## Production notes

- Voice talent: read file names naturally ("docker compose dot yml", "example dot env", "dot env", "H W accel"), variable names as words ("upload location", "D B data location", "D B password", "T Z"), container names without the underscore ("frameleaf server", "frameleaf machine learning", "frameleaf postgres", "frameleaf redis"), and 2283 as "twenty-two eighty-three".
- Commands are shown, never spelled out: beat 11's command is `docker compose up -d` on screen; the VO says only "docker compose up". Beat 12's `docker compose ps` is standard Docker, used here only to show the container names from docker/README.md ("Displayed container names become frameleaf_server, frameleaf_machine_learning, frameleaf_postgres and frameleaf_redis").
- Crop beat 12 to NAME, STATUS and PORTS. The hidden IMAGE and SERVICE columns show the database base image and the retained compatibility service keys (`immich-server`, `database`, …), which this episode does not explain; START-08 does.
- `.env` as captured comes from the release's example.env. The version line (`IMMICH_VERSION`) and `DB_DATABASE_NAME=immich` are compatibility names kept on purpose (docker/README.md: "`IMMICH_*` environment keys … are retained for compatibility"); they are visible but not read. The small "Built on Immich" credit in the outro covers them. Release bundles pin the version line to their own version; a development checkout shows `release`.
- Beat 6 comes from quick-start.mdx: "The database only contains metadata and user information. You must setup manual backups of the images and videos stored in UPLOAD_LOCATION." Nightly database backups are chosen during setup (START-03).
- Beat 9: the doc recommends `A-Za-z0-9` only and suggests `pwgen`; blur the typed password.
- Beat 14 CARD text is from docker-compose.mdx's two info boxes. The doc's own remedy for the health check error is to comment out `start_interval` in the database section or use Docker Engine v25 or later; the CARD names only the engine version, and the VO covers only the first error.
- The wget URLs are the documented `releases/latest/download/…` links. Speed up typing after "releases/"; do not show any other repository or registry.
- Docs vs interface: quick-start.mdx still opens with "install Immich" and its admin step says "click on the Getting Started button" on a plain registration form. The current build's root page reads "Welcome to Frameleaf" with "Getting Started" and "Restore From Backup", and Getting Started opens first-run setup (START-03). Narration follows the build.
- Do not click Getting Started in this episode; START-03 opens on that click.
