# OPS-24 · Logs and troubleshooting

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | How-to |
| Target length | 2:30 |
| Audience | Administrators diagnosing a problem on their Frameleaf server before asking for help |
| Features demonstrated | docker compose ps and docker compose logs by service name, Settings → Server & updates → Logs & diagnostics (Enable logging, Level from Fatal to Verbose), IMMICH_LOG_LEVEL precedence, IMMICH_LOG_FORMAT json, the immich-admin command line (help, reset-admin-password, enable-password-login, list-users, version, schema-check, enable and disable maintenance mode), the WebSocket symptom (Installed build channel reads Unknown), Download diagnostics, Support & Feedback (Documentation, Community chat, Report a problem) |
| Source docs | docs/docs/administration/server-commands.md, docs/docs/features/monitoring.md, docs/docs/guides/docker-help.md, docs/docs/FAQ.mdx, docs/docs/administration/system-settings.md, docker/README.md |
| Capture checklist | A terminal on frameleaf.home in the compose folder `~/frameleaf`, with all four containers healthy (frameleaf_server, frameleaf_machine_learning, frameleaf_redis, frameleaf_postgres); a short reproducible warning in the server log (for example a failed upload retried by the phone); Taylor signed in as administrator; Settings → Server & updates → Logs & diagnostics with Level "Log"; Versions & compatibility captured once through a proxy without WebSocket headers so Installed build channel reads "Unknown"; the account menu with Support & Feedback, on a server started with FRAMELEAF_DOCS_URL, FRAMELEAF_SUPPORT_URL and FRAMELEAF_BUG_FEATURE_URL set to fictional https addresses so the rows appear; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD "Logs and troubleshooting · Running Frameleaf". TERMINAL: empty prompt in `~/frameleaf`. | LOWER-THIRD | "When something goes wrong, start with the logs. Everything in this episode stays on your own server; Frameleaf does not send its logs anywhere." |
| 3 | 0:15–0:28 | TERMINAL: `docker compose ps` lists frameleaf_server, frameleaf_machine_learning, frameleaf_redis and frameleaf_postgres, each "Up" and "healthy". HIGHLIGHT the status column. | TERMINAL; CALLOUT "All four up and healthy" | "From the folder with your compose file, list the containers and check that all four are up and healthy. A container that keeps restarting shows it here." |
| 4 | 0:28–0:44 | TERMINAL: `docker compose logs --follow immich-server` streams lines; a warning line is HIGHLIGHTED as it arrives. Then `docker compose logs immich-machine-learning`. CALLOUT "Service names work with any container name". | TERMINAL; CALLOUT "Follow while you reproduce it" | "Then read the server's log, and follow it live while you repeat the problem. The machine-learning container has its own log. Use the service names; they work whatever the containers are called." |
| 5 | 0:44–0:57 | SCREEN: Settings → Server & updates → Logs & diagnostics. HIGHLIGHT Enable logging (on); CURSOR opens Level (Fatal, Error, Warn, Log, Debug, Verbose), chooses Debug; CURSOR clicks Save changes. | CALLOUT "Settings → Server & updates → Logs & diagnostics"; CALLOUT "Level" | "For more detail, open Settings, then Server & updates, then Logs & diagnostics. Raise Level from Log to Debug while you reproduce the issue, then set it back." |
| 6 | 0:57–1:12 | TERMINAL: a server log line `LogLevel=debug (set via IMMICH_LOG_LEVEL)`. Then the .env line `IMMICH_LOG_FORMAT=json` and a few JSON log lines with `level`, `timestamp`, `message` and `context`. | TERMINAL; CALLOUT "The variable wins"; CALLOUT "json for log tools" | "If the log level variable is set, it wins, and this page cannot change it. The log format variable switches to one JSON object per line for log tools." |
| 7 | 1:12–1:21 | TERMINAL: `docker compose exec immich-server immich-admin help` prints the command list. | TERMINAL; CALLOUT "Admin command line" | "The server image also carries an admin command line. Run it inside the server container to list its commands." |
| 8 | 1:21–1:41 | ZOOM on the list as each is HIGHLIGHTED: `reset-admin-password`, `enable-password-login`, `list-users`, `version`, `schema-check`, `enable-maintenance-mode`, `disable-maintenance-mode`. CALLOUT on enable-password-login: "Locked out by single sign-on?" | CALLOUT "Locked out? enable-password-login" | "It can reset the administrator's password, turn password login back on, list users, print the version, check the database schema, and switch maintenance mode on or off. Password login is the one to remember if single sign-on locks you out." |
| 9 | 1:41–1:56 | SCREEN: Settings → Server & updates → Versions & compatibility; ZOOM on "Installed build channel: Unknown". DIAGRAM inset: browser → reverse proxy → frameleaf.home, with the "Upgrade / Connection" headers missing on the proxy node (red), then added (green). | CALLOUT "Unknown = WebSockets blocked" | "One symptom is worth knowing. If pages load but the installed build channel reads Unknown, your reverse proxy is not passing WebSockets. Add the upgrade headers from the reverse proxy episode." |
| 10 | 1:56–2:07 | SCREEN: Logs & diagnostics, row "Diagnostics" with the text "A file with this server's version, features, storage totals, job queues and settings, without photos or credentials." CURSOR clicks Download diagnostics; the file lands in Downloads. | CALLOUT "Download diagnostics" | "Before you ask for help, choose Download diagnostics. It saves this server's version, features, storage totals, job queues and settings, without photos or credentials." |
| 11 | 2:07–2:27 | SCREEN: account menu → Support & Feedback. The dialog lists Documentation, Community chat and Report a problem; CURSOR hovers Report a problem. CALLOUT "Rows appear when your installation provides them". | CALLOUT "Support & Feedback" | "Then open Support & Feedback from the account menu. Documentation, Community chat and Report a problem appear when your installation provides them. Attach the diagnostics file and the log lines around the error, and leave out any keys or passwords." |
| 12 | 2:27–2:30 | LOGO OUTRO | Next: CLOUD-01 · What Frameleaf Cloud is | "Next up: What Frameleaf Cloud is." |

## Voice-over (clean)

When something goes wrong, start with the logs. Everything in this episode stays on your own server; Frameleaf does not send its logs anywhere.

[pause]

From the folder with your compose file, list the containers and check that all four are up and healthy. A container that keeps restarting shows it here.

Then read the server's log, and follow it live while you repeat the problem. The machine-learning container has its own log. Use the service names; they work whatever the containers are called.

For more detail, open Settings, then Server & updates, then Logs & diagnostics. Raise Level from Log to Debug while you reproduce the issue, then set it back.

[beat]

If the log level variable is set, it wins, and this page cannot change it. The log format variable switches to one JSON object per line for log tools.

[pause]

The server image also carries an admin command line. Run it inside the server container to list its commands.

It can reset the administrator's password, turn password login back on, list users, print the version, check the database schema, and switch maintenance mode on or off. Password login is the one to remember if single sign-on locks you out.

[pause]

One symptom is worth knowing. If pages load but the installed build channel reads Unknown, your reverse proxy is not passing WebSockets. Add the upgrade headers from the reverse proxy episode.

[beat]

Before you ask for help, choose Download diagnostics. It saves this server's version, features, storage totals, job queues and settings, without photos or credentials.

Then open Support & Feedback from the account menu. Documentation, Community chat and Report a problem appear when your installation provides them. Attach the diagnostics file and the log lines around the error, and leave out any keys or passwords.

[pause]

Next up: What Frameleaf Cloud is.

## Production notes

- Commands are service-based, as docker/README.md recommends: `docker compose ps`, `docker compose logs immich-server`, `docker compose exec immich-server immich-admin …`. docker-help.md still shows `docker logs immich_server` and `docker exec -it immich_server bash`; the Frameleaf containers are named `frameleaf_*`, so the container-name form would need `frameleaf_server`. Service names and the `immich-admin` tool appear on screen only; the VO describes them. `--follow` streams new lines (docker-help.md tip).
- Logs & diagnostics (build labels): "Enable logging", "Level" with Fatal, Error, Warn, Log, Debug, Verbose; default Log. The level is part of the settings draft, so it needs Save changes. system-settings.md "Logging" describes the default level as Log.
- IMMICH_LOG_LEVEL precedence is verified in source (`server/src/services/system-config.service.ts`): the variable overrides the page, the log prints "(set via IMMICH_LOG_LEVEL)", and logging changes are refused while it is set. IMMICH_LOG_FORMAT=json (monitoring.md) outputs `level`, `pid`, `timestamp`, `message` and `context`; logs are never forwarded to an external collector.
- Admin commands shown are from server-commands.md: reset-admin-password, enable-password-login (the recovery named in OPS-13), list-users, version, schema-check, enable-maintenance-mode, disable-maintenance-mode. Others exist (disable-password-login, enable/disable-oauth-login, grant-admin, revoke-admin, change-media-location). The doc's example output uses another product's sample names; capture real output from the sample server instead.
- WebSocket symptom: FAQ.mdx describes "Server Status Offline | Version Unknown", which is the previous interface. In the current build the version reaches the web app over the WebSocket, so Versions & compatibility → Installed build channel reads "Unknown" when WebSockets are blocked (verified in `NewVersionCheckSettings.svelte`, `release-channel.ts`, `stores/websocket.ts`). The fix is the Upgrade and Connection headers from OPS-18.
- Download diagnostics (build: Logs & diagnostics, row "Diagnostics"): the file holds version, features, storage totals, job queues and settings, without photos or credentials.
- Support & Feedback (`HelpFeedbackDialog.svelte`): the rows Documentation, Community chat, Report a problem, Feature requests and Source code appear only when FRAMELEAF_DOCS_URL, FRAMELEAF_SUPPORT_URL, FRAMELEAF_BUG_FEATURE_URL or FRAMELEAF_SOURCE_URL are set (environment-variables.md "Help links"); nothing falls back to another project's sites. The dialog also lists a "Built on Immich" attribution block; keep the capture on the top rows so that block stays out of shot.
