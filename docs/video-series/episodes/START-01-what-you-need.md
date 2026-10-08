# START-01 · What you need

| Field | Value |
| --- | --- |
| Series | Start here |
| Type | Learn |
| Target length | 2:00 |
| Audience | People choosing or preparing a machine to run Frameleaf for the first time |
| Features demonstrated | Requirements: operating system (64-bit Linux recommended, Windows and macOS through Docker Desktop discouraged, full virtual machines, Docker in LXC not recommended), RAM (6 GB minimum, 8 GB recommended, 4 GB with machine learning off), CPU (2 cores minimum, 4 recommended, amd64 and arm64, x86-64-v2 for machine learning on amd64), storage (Unix-compatible filesystem with ownership and permissions, 10–20% for thumbnails and transcodes), database on local SSD (1–3 GB, never a network share, 2 GB RAM under Docker limits), Docker Engine or Docker Desktop with the Compose plugin (`docker compose`), Windows caveat (database not on NTFS, exFAT/FAT32 or a WSL-mounted folder; Docker volume instead) |
| Source docs | docs/docs/install/requirements.md |
| Capture checklist | Mostly motion graphics on the dark canvas: the requirement CARDs and DIAGRAMs below. One TERMINAL on a Linux server (`docker compose version` returning a Compose v2 line, prompt `taylor@frameleaf:~$`). One editor capture of a `.env` showing `DB_DATA_LOCATION=./postgres` becoming `DB_DATA_LOCATION=pgdata`, and the bottom of `docker-compose.yml` gaining `pgdata:` under `volumes:`. No product UI, no hardware brand logos. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD "What you need · Start here". DIAGRAM: a small server node labelled "frameleaf.home" in the centre; four nodes appear around it as the VO names them: "Operating system", "Memory & processor", "Storage", "Docker". Green lines connect each to the server. | LOWER-THIRD; "Operating system · Memory & processor · Storage · Docker" | "Frameleaf runs on a computer you own, usually a home server. Before you install, check four things: the operating system, memory and processor, storage, and Docker." |
| 3 | 0:14–0:30 | CARD "Operating system": bullet 1 "Linux, 64-bit (Ubuntu, Debian…): recommended"; bullet 2 "Windows or macOS through Docker Desktop: strongly discouraged"; bullet 3 "Full virtual machine: fine · Docker in LXC: not recommended". The first bullet carries a green tick; the second and third a muted note mark. | Operating system | "Linux is the recommended system: any 64-bit distribution, such as Ubuntu or Debian. Windows and macOS work through Docker Desktop, but are strongly discouraged. A full virtual machine is fine; Docker inside an LXC container is not recommended." |
| 4 | 0:30–0:44 | CARD "Memory and processor". COUNTER "RAM" ticks 0 → 6 GB (label "minimum"), then a second COUNTER to 8 GB ("recommended"). Small muted line "4 GB: machine learning off". Then COUNTER "Cores" 0 → 2 ("minimum") and 4 ("recommended"). Two chips fade in: "amd64", "arm64". | RAM 6 GB min · 8 GB recommended; Cores 2 min · 4 recommended; amd64 · arm64 | "Memory: at least six gigabytes, and eight is better. With only four, Frameleaf can run with machine learning turned off. Processor: at least two cores, four recommended, on amd64 or arm64." |
| 5 | 0:44–0:56 | ZOOM on the "amd64" chip. CALLOUT "Machine learning needs x86-64-v2 · most CPUs since ~2012". A second small CALLOUT beside a VM icon: "Virtual machine: pick a CPU type that supports it". | x86-64-v2 | "On amd64, machine learning needs the x86-64-v2 instruction level, which most processors since about 2012 have. In a virtual machine, choose a CPU type that passes it through." |
| 6 | 0:56–1:10 | DIAGRAM: node "Library storage" with a stack of photo thumbnails (Moraine Lake, Lake reflection, Cabin at dusk). Filesystem chips appear under it: "EXT4", "ZFS", "APFS", with a small line "ownership + permissions". A teal bar grows on top of the stack: "+10–20% thumbnails and transcoded video". | Unix-compatible filesystem; +10–20% | "Store photos on a Unix-compatible filesystem, such as EXT4, ZFS or APFS, that keeps file ownership and permissions. Thumbnails and converted videos usually add ten to twenty percent to the library's size, so leave room." |
| 7 | 1:10–1:27 | DIAGRAM: node "Database" with a size tag "1–3 GB". Green line to a node "Local SSD" (tick). A second, muted node "Network share" with a strike-through appears and fades. Small CALLOUT on the database node: "Docker resource limits: give it ≥ 2 GB RAM". | Database: local SSD, never a network share | "The database is small, usually one to three gigabytes, but it needs speed and a steady connection. Keep it on a local SSD, never on a network share. If you set Docker resource limits, give it at least two gigabytes of memory." |
| 8 | 1:27–1:42 | TERMINAL: types `docker compose version`; output one line "Docker Compose version v2…". Beside it CARD "Docker": bullet 1 "Docker Engine: Linux servers (or Windows through WSL 2)"; bullet 2 "Docker Desktop: Windows or macOS, not recommended on Linux"; bullet 3 "`docker compose`, not `docker-compose`". | CALLOUT "docker compose (with a space)" | "Frameleaf runs in Docker with the Compose plugin. On a Linux server, use Docker Engine; Docker Desktop is for Windows and macOS. The command is docker compose, with a space; the old hyphenated command is not supported." |
| 9 | 1:42–1:57 | CARD "On Windows": bullet 1 "Database folder: not on NTFS or exFAT/FAT32"; bullet 2 "Not a Windows folder mounted in WSL (/mnt/…)"; bullet 3 "Use a Docker volume instead". SCREEN inset: `.env` in an editor, the line `DB_DATA_LOCATION=./postgres` changes to `DB_DATA_LOCATION=pgdata`; then `docker-compose.yml` gains `pgdata:` under `volumes:`. | On Windows: use a Docker volume for the database | "On Windows, the database folder can't be on NTFS or FAT drives, or on a Windows folder mounted into WSL. Use a Docker volume for it instead; the written guide shows the two changes." |
| 10 | 1:57–2:00 | LOGO OUTRO | Guide: Requirements | "The written guide is linked below." |

## Voice-over (clean)

Frameleaf runs on a computer you own, usually a home server. Before you install, check four things: the operating system, memory and processor, storage, and Docker.

Linux is the recommended system: any 64-bit distribution, such as Ubuntu or Debian. Windows and macOS work through Docker Desktop, but are strongly discouraged. A full virtual machine is fine; Docker inside an LXC container is not recommended.

Memory: at least six gigabytes, and eight is better. With only four, Frameleaf can run with machine learning turned off. Processor: at least two cores, four recommended, on amd64 or arm64.

On amd64, machine learning needs the x86-64-v2 instruction level, which most processors since about 2012 have. In a virtual machine, choose a CPU type that passes it through.

[pause]

Store photos on a Unix-compatible filesystem, such as EXT4, ZFS or APFS, that keeps file ownership and permissions. Thumbnails and converted videos usually add ten to twenty percent to the library's size, so leave room.

The database is small, usually one to three gigabytes, but it needs speed and a steady connection. Keep it on a local SSD, never on a network share. If you set Docker resource limits, give it at least two gigabytes of memory.

[pause]

Frameleaf runs in Docker with the Compose plugin. On a Linux server, use Docker Engine; Docker Desktop is for Windows and macOS. The command is docker compose, with a space; the old hyphenated command is not supported.

On Windows, the database folder can't be on NTFS or FAT drives, or on a Windows folder mounted into WSL. Use a Docker volume for it instead; the written guide shows the two changes.

The written guide is linked below.

## Production notes

- Doc wording: requirements.md still says "Immich" throughout ("Hardware and software requirements for Immich", "Immich requires Docker…"). Narration and on-screen text say Frameleaf only; flag the page for the product-name pass.
- Version numbers in the doc (the "since v3" note and the last x86-64-v1 release) are upstream release numbers. They are deliberately left out of the narration and the CARDs; the rule shown is only "x86-64-v2 on amd64, most CPUs since about 2012".
- Voice talent: read "x86-64-v2" as "x eighty-six sixty-four v two", "amd64" as "A M D sixty-four", "arm64" as "arm sixty-four", "EXT4" as "ext four", "WSL" as letters.
- Beat 4: the doc's note is "For systems with only 4GB of RAM, Immich can be run with machine learning features disabled." The VO says "can run with machine learning turned off"; do not imply 4 GB is a supported default.
- Beat 7: the doc also says the database directory is set by `DB_DATA_LOCATION`; that variable is introduced properly in START-02, so it only appears on screen in beat 9 here.
- Beat 8: `docker compose version` is a standard Docker command used only to show that the Compose plugin is installed; it is not a Frameleaf command. The doc states `docker-compose` is deprecated and no longer supported.
- Beat 9: the two changes come straight from the doc's "Database storage on Windows systems" section: `DB_DATA_LOCATION=pgdata` in `.env`, and `pgdata:` added under `volumes:` (after `model-cache:`) at the bottom of `docker-compose.yml`. Show both, briefly; the VO only says "two changes".
- Keep hardware generic: no CPU, GPU, NAS or SSD brand names or logos on screen.
- CTA card: `Guide: Requirements` (producer fills in the public docs URL).
