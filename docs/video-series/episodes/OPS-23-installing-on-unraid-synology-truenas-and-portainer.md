# OPS-23 · Installing on Unraid, Synology, TrueNAS and Portainer

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | Learn |
| Target length | 2:45 |
| Audience | People installing Frameleaf on a NAS or a Docker management tool instead of a plain Linux server |
| Features demonstrated | Frameleaf release files (docker-compose.yml, example.env), the two settings that matter (UPLOAD_LOCATION, DB_DATA_LOCATION) plus DB_PASSWORD, Unraid Docker Compose Manager (Add New Stack, Compose File, Env File, share paths, Compose Up, Update Stack), Synology Container Manager (project folder, Project → Create, DB_STORAGE_TYPE HDD, firewall rules, Stop, Clean, Remove Unused Images, Build), TrueNAS Community app (data and pgData datasets, Host Path storage, Update), Portainer (Add stack, Web Editor, stack.env, Advanced and Simple mode, Deploy the stack), updating safely everywhere |
| Source docs | docs/docs/install/unraid.md, docs/docs/install/synology.md, docs/docs/install/truenas.md, docs/docs/install/portainer.md, docker/README.md, docs/docs/install/docker-compose.mdx |
| Capture checklist | The Frameleaf release files `docker-compose.yml` and `example.env`; a TERMINAL for the .env close-up; screen recordings of an Unraid test server with the Docker Compose Manager plugin, a Synology test NAS with Container Manager, a TrueNAS Community Edition test system (dataset screens and the app's Storage Configuration only) and a Portainer test instance; stack and project names "frameleaf"; share paths `/mnt/user/images/frameleaf` and `/mnt/user/appdata/postgresql/data` on Unraid; project folder `docker/frameleaf` on Synology; datasets `tank/frameleaf/data` and `tank/frameleaf/pgData` on TrueNAS; no real serial numbers, IP addresses or user names visible; dark theme where the platform offers one |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:18 | LOWER-THIRD "Installing on Unraid, Synology, TrueNAS and Portainer · Running Frameleaf". TITLE "Same files, different homes" with subheading "Unraid · Synology · TrueNAS · Portainer". Two file icons, "docker-compose.yml" and "example.env", drop onto the title. | Same files, different homes | "Frameleaf installs the same way on any Docker host: a compose file and an environment file from a Frameleaf release. On a NAS, the question is where those two files go." |
| 3 | 0:18–0:35 | TERMINAL: `example.env` with `UPLOAD_LOCATION=` and `DB_DATA_LOCATION=` highlighted in turn, then `DB_PASSWORD=` (blurred). CALLOUT on DB_DATA_LOCATION: "Local disk, SSD if you can, never a network share". | TERMINAL; CALLOUT "Where your photos live"; CALLOUT "Where the database lives" | "Two settings matter most. The upload location is where your photos and videos live. The database location should be a local disk, ideally an SSD, never a network share. And change the database password." |
| 4 | 0:35–0:48 | SCREEN (Unraid): Plugins → Compose.Manager → Add New Stack, label "frameleaf"; the cog → Edit Stack → Compose File, CURSOR pastes the Frameleaf compose file; then Env File, CURSOR pastes the example environment. | CALLOUT "Unraid · Docker Compose Manager" | "On Unraid, install the Docker Compose Manager plugin. Add a new stack, paste the Frameleaf compose file into Compose File, and the example environment into Env File." |
| 5 | 0:48–1:04 | ZOOM on the Unraid Env File: `UPLOAD_LOCATION=/mnt/user/images/frameleaf`, `DB_DATA_LOCATION=/mnt/user/appdata/postgresql/data`; CALLOUT on the default path "Default path: database keeps restarting". CURSOR clicks Save Changes, then Compose Up; the popup ends with "Connection Closed" and CURSOR clicks Done. Cut to the Docker page where `frameleaf_server` shows its port mapping. | CALLOUT "Absolute share paths"; CALLOUT "Compose Up" | "Use absolute share paths, with the database on appdata; left at the default path, the database keeps restarting. Save, choose Compose Up, and open the address shown next to the Frameleaf server container." |
| 6 | 1:04–1:14 | SCREEN (Unraid): Docker tab, Compose section; CALLOUT on the "update ready" label ("ignore"); HIGHLIGHT "Update Stack" next to the frameleaf stack. | CALLOUT "Ignore 'update ready'"; CALLOUT "Update Stack" | "To update, ignore Unraid's update ready label. When Frameleaf tells you a release is out, choose Update Stack." |
| 7 | 1:14–1:32 | SCREEN (Synology): File Station showing `docker/frameleaf` with `library`, `postgres`, `docker-compose.yml` and `.env`. Then Container Manager → Project → Create; Project name "frameleaf"; Path `docker/frameleaf`; the compose preview with `# DB_STORAGE_TYPE: 'HDD'` HIGHLIGHTED. | CALLOUT "Synology · Container Manager"; CALLOUT "HDD? Uncomment this line" | "On Synology, put both files in a project folder with library and postgres subfolders. In Container Manager, create a project on that path. If the database sits on hard drives, uncomment the HDD storage line." |
| 8 | 1:32–1:45 | SCREEN (Synology): Control Panel → Security → Firewall → Edit Rules; a Source IP rule for the server container's address and a Ports rule for 2283. Then Project → Stop, Action → Clean, Image → Remove Unused Images, Action → Build, each HIGHLIGHTED in turn. | CALLOUT "Firewall: container IP + port 2283"; CALLOUT "Update: Stop · Clean · Remove Unused Images · Build" | "Then allow the server container's address and port 2283 in the firewall. To update, stop the project, clean it, remove unused images, and build it again." |
| 9 | 1:45–2:06 | SCREEN (TrueNAS): Datasets with a parent `frameleaf` and children `data` and `pgData`; then the app's Storage Configuration with both set to "Host Path (Path that already exists on the system)" and CALLOUT "not ixVolume". The app name and catalog header are cropped out. CARD overlay: "Check which images the app runs". | CALLOUT "TrueNAS · two datasets"; CALLOUT "Host Path, not ixVolume" | "The TrueNAS guide uses its Community app rather than a compose file. Prepare two datasets, one for data and one for the database, and choose both as host paths. Before you point it at a Frameleaf library, check that the app runs the Frameleaf images." |
| 10 | 2:06–2:17 | SCREEN (Portainer): Stacks → Add stack; name "frameleaf"; build method Web Editor; CURSOR pastes the compose file; ZOOM as each `.env` under `env_file` is changed to `stack.env`. | CALLOUT "Portainer · Stacks"; CALLOUT ".env → stack.env" | "In Portainer, add a stack, paste the compose file into the web editor, and change each environment file reference to stack env." |
| 11 | 2:17–2:28 | SCREEN (Portainer): Environment variables → Advanced mode, CURSOR pastes the example environment; Simple mode, CURSOR edits DB_PASSWORD (blurred), DB_DATA_LOCATION and UPLOAD_LOCATION; HIGHLIGHT "Deploy the stack". | CALLOUT "Advanced mode, then Simple mode"; CALLOUT "Deploy the stack" | "Paste the example environment in Advanced mode, set the password and both locations in Simple mode, and deploy the stack." |
| 12 | 2:28–2:42 | CARD "Wherever you run it": bullet 1 "Read the release notes before each update"; bullet 2 "Keep the same stack, .env and paths"; bullet 3 "Never a second stack on the same database folder". | Wherever you run it | "Wherever you run it, read the release notes before each update, keep the same stack, environment file and paths, and never start a second stack against the same database folder." |
| 13 | 2:42–2:45 | LOGO OUTRO; small credit line "Built on Immich" under the lockup | Guide: Unraid · Synology · TrueNAS · Portainer | "The written guide is linked below." |

## Voice-over (clean)

Frameleaf installs the same way on any Docker host: a compose file and an environment file from a Frameleaf release. On a NAS, the question is where those two files go.

[pause]

Two settings matter most. The upload location is where your photos and videos live. The database location should be a local disk, ideally an SSD, never a network share. And change the database password.

On Unraid, install the Docker Compose Manager plugin. Add a new stack, paste the Frameleaf compose file into Compose File, and the example environment into Env File.

Use absolute share paths, with the database on appdata; left at the default path, the database keeps restarting. Save, choose Compose Up, and open the address shown next to the Frameleaf server container.

To update, ignore Unraid's update ready label. When Frameleaf tells you a release is out, choose Update Stack.

[pause]

On Synology, put both files in a project folder with library and postgres subfolders. In Container Manager, create a project on that path. If the database sits on hard drives, uncomment the HDD storage line.

Then allow the server container's address and port 2283 in the firewall. To update, stop the project, clean it, remove unused images, and build it again.

[pause]

The TrueNAS guide uses its Community app rather than a compose file. Prepare two datasets, one for data and one for the database, and choose both as host paths. Before you point it at a Frameleaf library, check that the app runs the Frameleaf images.

In Portainer, add a stack, paste the compose file into the web editor, and change each environment file reference to stack env.

Paste the example environment in Advanced mode, set the password and both locations in Simple mode, and deploy the stack.

[pause]

Wherever you run it, read the release notes before each update, keep the same stack, environment file and paths, and never start a second stack against the same database folder.

The written guide is linked below.

## Production notes

- Narration tone: practical; one short stop per platform. The steps are the documented ones; platform menu names are shown as the platforms spell them.
- Release files (docker/README.md, docker-compose.mdx): use the `docker-compose.yml` and `example.env` attached to a published Frameleaf release; they select the Frameleaf server and machine-learning images, and container names are `frameleaf_*`.
- Doc vs doc: synology.md and portainer.md still link the compose and env files of another project's releases, and their step names use that project's name ("immich-app", stack "immich"). The episode uses the Frameleaf release files (docker/README.md) and the names "frameleaf" / `docker/frameleaf`; flag both pages for a docs update. unraid.md already points to the Frameleaf release files.
- TrueNAS (truenas.md): the guide installs the TrueNAS Community train application and prepares two datasets, `data` and `pgData` (pgData owned by `netdata`, UID 999; data with modify permission for the app user, default `apps`, UID 568), selected as Host Path rather than ixVolume. The guide does not state that the catalog app runs the Frameleaf images, and issues go to the TrueNAS apps repository, so the VO adds one caution line and the capture crops the app name. Confirm with the docs owner before publishing; if TrueNAS is documented with a Frameleaf compose route later, re-record beat 9.
- Unraid (unraid.md): Docker Compose Manager plugin, Add New Stack, Compose File, Env File, Save Changes, Compose Up; UPLOAD_LOCATION as an absolute share path; DB_DATA_LOCATION on a share such as appdata, since the default `/boot/config/plugins/compose.manager/...` path lacks permissions and the database container restarts continuously; the container `frameleaf_server` carries the port mapping to open. Updating: ignore the permanent "update ready" label, use Update Stack, and do not run Compose Down first. The guide also says Unraid 6.12.10 (Docker Engine 24) cannot use a database health check `start_interval`; the Frameleaf compose file in the integration checkout sets only `healthcheck: disable: false` on the database, so the VO leaves that step out. If a release file carries `start_interval` again, add a CALLOUT to beat 5 ("Unraid 6.12: comment out start_interval").
- Synology (synology.md): Container Manager project on the folder holding both files; uncomment `DB_STORAGE_TYPE: 'HDD'` for hard drives; firewall rules for the server container's IP and port 2283; update by Stop, Action → Clean, Image → Remove Unused Images, Action → Build, then re-check the firewall IP (a fixed subnet avoids that).
- Portainer (portainer.md): Stacks → Add stack, Web Editor, replace `.env` with `stack.env`, Environment variables Advanced mode to paste, Simple mode to set DB_PASSWORD, DB_DATA_LOCATION and UPLOAD_LOCATION, Deploy the stack. The guide has no Portainer-specific update steps; the closing card gives the general rules from docker/README.md and upgrading.md.
- Never a second stack against the same PostgreSQL directory, and never `docker compose down --volumes` when changing images (docker/README.md).
- The four guides are linked together in the description; the outro card lists the four platforms. The outro carries the small "Built on Immich" credit line; it is not read aloud.
