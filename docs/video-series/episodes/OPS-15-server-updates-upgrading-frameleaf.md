# OPS-15 · Server & updates: upgrading Frameleaf

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:30 |
| Audience | Administrators who run Frameleaf with Docker Compose and want to name the server, follow releases and upgrade safely |
| Features demonstrated | Settings → Server & updates, Server identity & network (Server name, External domain, Welcome message), Versions & compatibility (Frameleaf updates panel, Check for updates toggle and button, Update channel Stable or Release candidate, Third-party release checks, Installed build channel), About Frameleaf check, new-version notice with Release notes, back up first, Frameleaf mobile app first, IMMICH_VERSION pin, docker compose pull and up, docker image prune, no downgrades |
| Source docs | docs/docs/install/upgrading.md, docs/docs/administration/system-settings.md, docker/README.md, docker/example.env |
| Capture checklist | Taylor signed in as administrator on frameleaf.home; Settings → Server & updates with its six sections listed (Server identity & network, Versions & compatibility, Logs & diagnostics, Maps & geography, Branding & client compatibility, Configuration transfer); Server name empty at the start; Versions & compatibility with automatic checks off (badge "Checks off") and Update channel "Stable"; a build older than the newest published Frameleaf release, so Check for updates returns "Frameleaf … is available" with a Release notes link; the version notice banner after automatic checks run; the account menu with About Frameleaf; a terminal on the server in the compose folder `~/frameleaf` with an .env that pins IMMICH_VERSION; a phone frame of the Frameleaf mobile app; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "Server & updates: upgrading Frameleaf · Running Frameleaf". SCREEN: Settings open on the Server & updates area; the six section rows are listed; cursor idle. | LOWER-THIRD | "Server & updates is where Frameleaf keeps its name and learns about new releases. The upgrade itself happens where Frameleaf runs, with two commands." |
| 3 | 0:16–0:32 | SCREEN: Server identity & network. CURSOR types "Home server" into Server name; CALLOUT on its description "Shown in the command center and connection picker. Leave empty to show the server's address." HIGHLIGHT External domain and Welcome message below it in turn. | CALLOUT "Server name"; CALLOUT "External domain"; CALLOUT "Welcome message" | "Start with Server identity & network. Server name appears in the command center and the connection picker; leave it empty to show the address. External domain and the login Welcome message live here too." |
| 4 | 0:32–0:47 | SCREEN: Versions & compatibility. ZOOM on the panel "Frameleaf updates" with the badge "Checks off" and the line "Frameleaf update service · You decide when to install". HIGHLIGHT the toggle "Check for updates"; CURSOR turns it on. | CALLOUT "Checks off until you turn them on" | "Versions & compatibility controls update checks. They stay off until you turn on Check for updates. Then the server asks Frameleaf's own release feed once an hour, and sends no library data." |
| 5 | 0:47–1:01 | ZOOM on Update channel; CURSOR opens it to show "Stable" and "Release candidate", leaves Stable. CALLOUT on Third-party release checks (off, policy "External release services prohibited"). CALLOUT on Installed build channel (read-only, "Stable"). | CALLOUT "Update channel"; CALLOUT "Installed build channel" | "Update channel picks stable releases, or release candidates as well, which change more often. Third-party release checks stay off, and Installed build channel shows which channel this build came from." |
| 6 | 1:01–1:16 | CURSOR clicks the "Check for updates" button in the panel; the result line appears: "Frameleaf … is available. Checked just now." with a "Release notes" link. SPLIT: right, the account menu → About Frameleaf dialog with its own "Check for updates" button. | CALLOUT "Check for updates"; CALLOUT "About Frameleaf" | "Check for updates asks right now, even with automatic checks off, and so does About Frameleaf in the account menu. Everyone else sees the last result there. Checking never installs anything." |
| 7 | 1:16–1:31 | SCREEN: the timeline with the notice "A new version is available. Read the release notes before you update, especially if something updates this server automatically." CURSOR clicks "release notes"; the Frameleaf release page opens in a new tab and scrolls to its notes. | CALLOUT "Read the release notes first" | "When a release is found, administrators see a notice that links to the release notes. Read them before you update, and look for anything marked as a breaking change." |
| 8 | 1:31–1:48 | CARD "Before you upgrade": bullet 1 "Back up the database and originals"; bullet 2 "Update the Frameleaf mobile app first"; bullet 3 "Keep the same folder, .env and paths". On bullet 2 a phone frame of the Frameleaf mobile app slides in beside the card. | CARD | "Before you upgrade, back up the database and your originals. Update the Frameleaf mobile app on every phone first: the app works with the current and previous major version, but the server only with its own." |
| 9 | 1:48–2:03 | TERMINAL: `cd ~/frameleaf` then `grep IMMICH_VERSION .env` prints `IMMICH_VERSION=<pinned version>`. CALLOUT on the line: "Pinned? Change it to the new release". A second line fades in: `# release = latest stable`. | TERMINAL; CALLOUT "Pinned version? Update it" | "On the server, open the folder with your compose file. If your .env pins a version, change it to the new release. The release tag always follows the latest stable version." |
| 10 | 2:03–2:15 | TERMINAL: `docker compose pull && docker compose up -d`; output shows the frameleaf-server and frameleaf-machine-learning images pulling, then frameleaf_server and frameleaf_machine_learning recreated and started. Then `docker image prune` with its confirmation prompt answered. | TERMINAL | "Then pull the new images and recreate the containers. Once everything is running, you can remove the old images to free disk space." |
| 11 | 2:15–2:27 | SCREEN: browser reload; account menu → About Frameleaf shows the new version; cut to Versions & compatibility with the badge "Up to date". | CALLOUT "Up to date" | "Reload Frameleaf and open About Frameleaf to confirm the new version. Downgrading is not supported, which is why the backup comes first." |
| 12 | 2:27–2:30 | LOGO OUTRO; small credit line "Built on Immich" under the lockup | Next: OPS-16 · Environment variables and the config file | "Next up: Environment variables and the config file." |

## Voice-over (clean)

Server & updates is where Frameleaf keeps its name and learns about new releases. The upgrade itself happens where Frameleaf runs, with two commands.

[pause]

Start with Server identity & network. Server name appears in the command center and the connection picker; leave it empty to show the address. External domain and the login Welcome message live here too.

Versions & compatibility controls update checks. They stay off until you turn on Check for updates. Then the server asks Frameleaf's own release feed once an hour, and sends no library data.

Update channel picks stable releases, or release candidates as well, which change more often. Third-party release checks stay off, and Installed build channel shows which channel this build came from.

[beat]

Check for updates asks right now, even with automatic checks off, and so does About Frameleaf in the account menu. Everyone else sees the last result there. Checking never installs anything.

When a release is found, administrators see a notice that links to the release notes. Read them before you update, and look for anything marked as a breaking change.

[pause]

Before you upgrade, back up the database and your originals. Update the Frameleaf mobile app on every phone first: the app works with the current and previous major version, but the server only with its own.

On the server, open the folder with your compose file. If your .env pins a version, change it to the new release. The release tag always follows the latest stable version.

Then pull the new images and recreate the containers. Once everything is running, you can remove the old images to free disk space.

[beat]

Reload Frameleaf and open About Frameleaf to confirm the new version. Downgrading is not supported, which is why the backup comes first.

[pause]

Next up: Environment variables and the config file.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. Section titles from the build: "Server identity & network", "Versions & compatibility", "Logs & diagnostics", "Maps & geography", "Branding & client compatibility", "Configuration transfer". The doc names "Server Settings" and "Version Check"; the VO uses the build labels.
- Version checks (system-settings.md "Version Check", monitoring.md): when on, the server checks Frameleaf's own GitHub releases every hour; no Immich service is contacted and no library data is sent. The shipped default is off (`newVersionCheck.enabled: false`), so the panel badge reads "Checks off" until the toggle is saved. Remember the toggle joins the settings draft: save it with Save changes.
- The "Check for updates" name is used twice in the build: the toggle (automatic hourly checks) and the button in the panel (check now). About Frameleaf has the same button; other accounts see the result of the last check there (system-settings.md).
- Do not stage a fictional version number. Capture against the real release feed on an older build; if the build is current the result reads "You're running the latest version. Checked just now." and beats 6 and 7 should be captured on an older build instead.
- Mobile first (upgrading.md "Versioning Policy"): the mobile app is typically compatible with the current and prior major version, the server only with the matching major, so update phones before the server. Downgrading is not supported (upgrading.md).
- Upgrading.md still links release notes and breaking changes to another project's pages; Frameleaf release notes are the Frameleaf GitHub releases, which the in-app "Release notes" link opens (`version-check.ts`). The VO says "anything marked as a breaking change" without naming a page.
- IMMICH_VERSION (docker/README.md, example.env): release bundles pin it to their version; the `release` and `latest` tags follow stable releases, `edge` follows development builds. Back up the database and originals before changing releases (docker/README.md). OPS-10 covers backups.
- Commands are service-based and work with the `frameleaf_*` container names. `docker image prune` is optional clean-up (upgrading.md). Keep the same Compose project, .env, paths and volumes (docker/README.md "Existing installations").
- Outro carries the small "Built on Immich" credit line; it is not read aloud.
