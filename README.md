<p align="center">
  <a href="https://frameleaf.app">
    <img src="https://frameleaf.app/og.png" alt="Frameleaf — Your photos. Your server. Everywhere." width="100%">
  </a>
</p>

<h1 align="center">Frameleaf</h1>

<p align="center">
  <strong>Your photos. Your server. Everywhere.</strong><br>
  A self-hosted photo and video library — bring a lifetime of photos home, find any moment, edit it, and share it with the people who were there.
</p>

<p align="center">
  <a href="https://frameleaf.app">Website</a> ·
  <a href="https://frameleaf.app/docs/start/introduction/">Docs</a> ·
  <a href="https://frameleaf.app/docs/start/install/">Install</a> ·
  <a href="https://frameleaf.app/docs/start/features/">Features</a> ·
  <a href="https://frameleaf.app/docs/help/faq/">FAQ</a>
</p>

---

<p align="center">
  <img src="https://frameleaf.app/web/library-grid.webp" alt="Frameleaf library timeline in the web app" width="100%">
</p>

## What is Frameleaf?

Frameleaf runs on your NAS, home server or any Linux machine with Docker. Your originals stay as ordinary files on your own disks — no subscription or cloud account required.

It comes in three parts:

- **The server** — the Frameleaf Library web app and API (open source, AGPLv3).
- **The apps** — native iPhone/iPad and Android apps *(coming soon)*.
- **Frameleaf Cloud** *(optional)* — encrypted remote access, off-site backup and cloud GPU processing.

➡️ Read more in [What is Frameleaf?](https://frameleaf.app/docs/start/introduction/)

## Features

| | |
|---|---|
| 🗂️ **Library & timeline** | Every photo and video in one chronological view. [Docs](https://frameleaf.app/docs/using/library/) |
| 🔎 **Search & AI** | Find a photo by describing it. [Docs](https://frameleaf.app/docs/using/search/) |
| 🧑‍🤝‍🧑 **People & pets** | Face recognition that runs on your server. [Docs](https://frameleaf.app/docs/using/people/) |
| 🗺️ **Memories & places** | Rediscover moments and browse them on a map. [Docs](https://frameleaf.app/docs/using/memories/) |
| 🔗 **Sharing** | Partners, shared spaces and links. [Docs](https://frameleaf.app/docs/using/sharing/) |
| 🎨 **Photo editor** | Non-destructive edits with saved versions. [Docs](https://frameleaf.app/docs/using/editing/) |
| 🎬 **Studio** | Built-in video editor — timeline, colour, audio, captions, restoration and export. [Docs](https://frameleaf.app/docs/studio/overview/) |
| 🧹 **Library Care** | Duplicate review, missing-original repair and trash. [Docs](https://frameleaf.app/docs/using/library-care/) |
| 🔒 **Privacy** | Locked content and control over what stays on your server. [Docs](https://frameleaf.app/docs/using/private-content/) |

<table>
  <tr>
    <td width="50%"><img src="https://frameleaf.app/web/search-palette.webp" alt="Smart search"><br><sub><b>Search</b> — describe what you remember</sub></td>
    <td width="50%"><img src="https://frameleaf.app/web/people.webp" alt="People and pets"><br><sub><b>People & pets</b> — recognised on your own hardware</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://frameleaf.app/web/memories.webp" alt="Memories"><br><sub><b>Memories</b> — moments resurfaced</sub></td>
    <td width="50%"><img src="https://frameleaf.app/web/explore.webp" alt="Explore"><br><sub><b>Explore</b> — places, things and people</sub></td>
  </tr>
</table>

### Studio

<table>
  <tr>
    <td width="50%"><img src="https://frameleaf.app/studio/edit-timeline-clip-selected.webp" alt="Studio timeline editing"><br><sub><b>Timeline editing</b></sub></td>
    <td width="50%"><img src="https://frameleaf.app/studio/color-wheels-adjust.webp" alt="Studio colour wheels"><br><sub><b>Colour grading</b></sub></td>
  </tr>
</table>

### Apps

<p align="center">
  <img src="https://frameleaf.app/shots/ios-library-all.webp" alt="iPhone library" width="24%">
  <img src="https://frameleaf.app/shots/ios-memories.webp" alt="iPhone memories" width="24%">
  <img src="https://frameleaf.app/shots/ios-editor-looks.webp" alt="iPhone editor" width="24%">
  <img src="https://frameleaf.app/shots/and-library-all.webp" alt="Android library" width="24%">
</p>

Native iPhone/iPad and Android apps are coming soon. See [iPhone and Android apps](https://frameleaf.app/docs/using/mobile-apps/).

## Get started

1. **Check the [requirements](https://frameleaf.app/docs/start/requirements/)** — Linux with Docker and Docker Compose v2.
2. **Install** with one of:
   - [**Frameleaf Manager**](https://frameleaf.app/docs/start/install/) — guided install and upgrades (recommended).
   - [**Docker Compose**](https://frameleaf.app/docs/start/manual-install/) — for experienced administrators.
   - **NAS apps** — [Unraid](https://frameleaf.app/docs/nas/unraid/), [Synology](https://frameleaf.app/docs/nas/synology/) and [TrueNAS](https://frameleaf.app/docs/nas/truenas/).
3. **Open** `http://<server-ip>:2283` and follow [First steps after installing](https://frameleaf.app/docs/start/first-steps/).

### Quick start with Docker Compose

```bash
mkdir frameleaf-app && cd frameleaf-app
curl -fL -o docker-compose.yml https://github.com/Frameleaf/frameleaf-app/releases/latest/download/docker-compose.yml
curl -fL -o .env https://github.com/Frameleaf/frameleaf-app/releases/latest/download/example.env
docker compose up -d
```

Edit `.env` first if you want your photos (`UPLOAD_LOCATION`) or database (`DB_DATA_LOCATION`) somewhere other than the current folder. To upgrade later, run `docker compose pull && docker compose up -d` — see [Upgrading](https://frameleaf.app/docs/admin/upgrading/).

<p>
  <a href="https://frameleaf.app/docs/nas/unraid/"><img src="https://frameleaf.app/brand/nas/unraid.svg" alt="Unraid" height="32"></a>&nbsp;&nbsp;
  <a href="https://frameleaf.app/docs/nas/synology/"><img src="https://frameleaf.app/brand/nas/synology.png" alt="Synology" height="32"></a>&nbsp;&nbsp;
  <a href="https://frameleaf.app/docs/nas/truenas/"><img src="https://frameleaf.app/brand/nas/truenas.png" alt="TrueNAS" height="32"></a>
</p>

> [!TIP]
> Your library on one server is a single copy. Protect it with [Cloud backup](https://frameleaf.app/docs/cloud/cloud-backup/), [Buddy backup](https://frameleaf.app/docs/cloud/buddy-backup/) or your own copies — see [Backup and restore](https://frameleaf.app/docs/admin/backup-and-restore/).

### Switching from another service?

- [Switch from your existing photo server](https://frameleaf.app/docs/migrate/from-immich/)
- [Import from iCloud Photos](https://frameleaf.app/docs/migrate/icloud-photos/)
- [Import from Google Photos](https://frameleaf.app/docs/migrate/google-photos/)
- [Import from a folder or another app](https://frameleaf.app/docs/migrate/from-a-folder/)

## Frameleaf Cloud (optional)

Self-hosting is free. [Frameleaf Cloud](https://frameleaf.app/docs/cloud/overview/) adds:

- 🌐 [Remote access](https://frameleaf.app/docs/cloud/remote-access/) — encrypted access from anywhere
- ☁️ [Cloud backup](https://frameleaf.app/docs/cloud/cloud-backup/) — 1 TB off-site, plus [buddy backup](https://frameleaf.app/docs/cloud/buddy-backup/) *(beta)*
- ⚡ [Cloud GPU](https://frameleaf.app/docs/cloud/cloud-gpu/) — run heavy AI jobs without local hardware

See [frameleaf.app](https://frameleaf.app) for current pricing.

## Documentation

| Topic | Where |
|---|---|
| Using Frameleaf | [Library, search, sharing, editing…](https://frameleaf.app/docs/using/library/) |
| Studio | [Video editing guide](https://frameleaf.app/docs/studio/overview/) |
| Running your server | [Command Center, settings, upgrades…](https://frameleaf.app/docs/admin/command-center/) |
| Server API | [API overview](https://frameleaf.app/docs/api/overview/) |
| Help | [FAQ](https://frameleaf.app/docs/help/faq/) · [Troubleshooting](https://frameleaf.app/docs/help/troubleshooting/) · [Supported formats](https://frameleaf.app/docs/help/supported-formats/) |

## License

The Frameleaf Library server is open source under the [GNU AGPLv3](LICENSE).
