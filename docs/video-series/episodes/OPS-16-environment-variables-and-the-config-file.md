# OPS-16 · Environment variables and the config file

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | Learn |
| Target length | 2:45 |
| Audience | Administrators who deploy Frameleaf with Docker Compose and want to know which settings live in the environment, which in the app, and when to use a config file |
| Features demonstrated | The .env file (UPLOAD_LOCATION, DB_DATA_LOCATION, TZ, IMMICH_VERSION, DB_PASSWORD), other key variables (IMMICH_LOG_LEVEL, IMMICH_LOG_FORMAT, IMMICH_TRUSTED_PROXIES, FRAMELEAF_CLOUD_URL), recreate after a change (docker compose up -d, --force-recreate), config file in JSON or YAML with IMMICH_CONFIG_FILE, Configuration transfer (Export settings, Copy settings), "Config is currently set by a config file" lock, credentials from the file, workers need the same file, log level precedence and JSON log format |
| Source docs | docs/docs/install/environment-variables.md, docs/docs/install/config-file.md, docs/docs/administration/system-settings.md, docs/docs/features/monitoring.md |
| Capture checklist | A terminal on frameleaf.home in `~/frameleaf` showing the .env from the Frameleaf release (DB_PASSWORD blurred); a second terminal showing a short `frameleaf-config.json` and the compose volume line; Settings → Server & updates → Configuration transfer with Export settings and Copy settings; a second capture of the same server started with IMMICH_CONFIG_FILE set, showing the notice "Config is currently set by a config file" at the top of Settings and the SMTP password row reading "Credentials are managed by the configuration file on the server."; Settings → Server & updates → Logs & diagnostics with the Level list open; Taylor signed in as administrator; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:18 | LOWER-THIRD "Environment variables and the config file · Running Frameleaf". TITLE "Two places for settings" with subheading "The environment, and the Settings pages". | Two places for settings | "Frameleaf reads its settings from two places. The environment decides how the server is deployed. The Settings pages decide how it behaves. A config file can take over the second." |
| 3 | 0:18–0:33 | TERMINAL: `cat .env` shows `UPLOAD_LOCATION=./library`, `DB_DATA_LOCATION=./postgres`, `TZ=America/Edmonton`, `IMMICH_VERSION=release`, `DB_PASSWORD=` (value blurred). HIGHLIGHT each line as the VO names it. | TERMINAL; CALLOUT ".env beside docker-compose.yml" | "The environment lives in the .env file beside your compose file. The upload and database locations are folders on the host. Then come the time zone, the image version and the database password." |
| 4 | 0:33–0:50 | CARD "A few more worth knowing": bullet 1 "IMMICH_LOG_LEVEL · IMMICH_LOG_FORMAT"; bullet 2 "IMMICH_TRUSTED_PROXIES"; bullet 3 "FRAMELEAF_CLOUD_URL — unset: never contacted". | CARD | "A few more are worth knowing: the log level and log format, the addresses of trusted reverse proxies, and the Frameleaf Cloud address. Leave that last one unset and Frameleaf Cloud is never contacted." |
| 5 | 0:50–1:04 | TERMINAL: `docker compose restart` typed, then struck through in muted grey. Below it `docker compose up -d` runs and shows frameleaf_server "Recreated". A third line fades in: `docker compose up -d --force-recreate`. | TERMINAL; CALLOUT "Recreate, don't restart" | "Changing a variable takes one more step. A restart keeps the old environment, so recreate the containers instead. If Docker does not notice the change, force the recreate." |
| 6 | 1:04–1:21 | TERMINAL, two panes: left, `frameleaf-config.json` with a few keys (`"trash": { "enabled": true, "days": 30 }`, `"newVersionCheck": { "enabled": true }`); right, .env line `IMMICH_CONFIG_FILE=/config/frameleaf-config.json` and the compose volume `- ./frameleaf-config.json:${IMMICH_CONFIG_FILE}`. DIAGRAM arrow from the file into the server container. | TERMINAL; CALLOUT "Path inside the container" | "If you would rather keep settings in a file, write them as JSON or YAML. Mount the file into the server container, and point the config file variable at its path inside the container." |
| 7 | 1:21–1:32 | SCREEN: Settings → Server & updates → Configuration transfer, heading "Move settings between installations". HIGHLIGHT Export settings, then Copy settings. CALLOUT on the help line "Accounts, media, credentials and pending edits are excluded." | CALLOUT "Export settings"; CALLOUT "Copy settings" | "The easiest start is Configuration transfer under Server & updates. Export settings or Copy settings gives you the saved configuration, without passwords or secrets." |
| 8 | 1:32–1:48 | SCREEN: the same server started with the config file. At the top of Settings, ZOOM on the notice "Config is currently set by a config file"; every field below is greyed out. Scroll to Notifications → Email delivery; CALLOUT on the SMTP password row "Credentials are managed by the configuration file on the server." | CALLOUT "Config is currently set by a config file" | "Once the file is in use, the Settings pages are locked. Each one says the config is set by a config file, and passwords and secrets come from the file as well." |
| 9 | 1:48–1:56 | DIAGRAM: node "frameleaf-config.json" (teal) with arrows to two nodes, "Server (api)" and "Worker (microservices)", both green. | Every worker mounts the same file | "If you run separate worker containers, mount the same file into each of them." |
| 10 | 1:56–2:13 | SCREEN: Settings → Server & updates → Logs & diagnostics. HIGHLIGHT Enable logging (on); CURSOR opens Level to show Fatal, Error, Warn, Log, Debug and Verbose, with Log selected. Then a TERMINAL inset shows the server log line `LogLevel=debug (set via IMMICH_LOG_LEVEL)`. | CALLOUT "Level"; CALLOUT "The variable wins" | "Logging shows how the two places interact. Logs & diagnostics sets the log level in the app. Set the log level variable instead and it wins, and the page can no longer change it." |
| 11 | 2:13–2:28 | TERMINAL: .env line `IMMICH_LOG_FORMAT=json`; after a recreate, the log switches from coloured console lines to JSON objects with `level`, `pid`, `timestamp`, `message` and `context`. | TERMINAL; CALLOUT "console or json" | "The log format variable switches the output from readable console lines to one JSON object per line, for log tools. Either way, the logs stay on your server." |
| 12 | 2:28–2:42 | CARD "Which to use": bullet 1 "Environment: paths, passwords, addresses"; bullet 2 "Settings pages: everyday choices, with review and history"; bullet 3 "Config file: settings you manage as code". | Which to use | "In short: use the environment for paths, passwords and addresses, the Settings pages for everyday choices, with review and change history, and a config file when you manage settings as code." |
| 13 | 2:42–2:45 | LOGO OUTRO | Guide: Environment Variables | "The written guide is linked below." |

## Voice-over (clean)

Frameleaf reads its settings from two places. The environment decides how the server is deployed. The Settings pages decide how it behaves. A config file can take over the second.

[pause]

The environment lives in the .env file beside your compose file. The upload and database locations are folders on the host. Then come the time zone, the image version and the database password.

A few more are worth knowing: the log level and log format, the addresses of trusted reverse proxies, and the Frameleaf Cloud address. Leave that last one unset and Frameleaf Cloud is never contacted.

[beat]

Changing a variable takes one more step. A restart keeps the old environment, so recreate the containers instead. If Docker does not notice the change, force the recreate.

[pause]

If you would rather keep settings in a file, write them as JSON or YAML. Mount the file into the server container, and point the config file variable at its path inside the container.

The easiest start is Configuration transfer under Server & updates. Export settings or Copy settings gives you the saved configuration, without passwords or secrets.

Once the file is in use, the Settings pages are locked. Each one says the config is set by a config file, and passwords and secrets come from the file as well.

[beat]

If you run separate worker containers, mount the same file into each of them.

[pause]

Logging shows how the two places interact. Logs & diagnostics sets the log level in the app. Set the log level variable instead and it wins, and the page can no longer change it.

The log format variable switches the output from readable console lines to one JSON object per line, for log tools. Either way, the logs stay on your server.

[pause]

In short: use the environment for paths, passwords and addresses, the Settings pages for everyday choices, with review and change history, and a config file when you manage settings as code.

The written guide is linked below.

## Production notes

- Narration tone: calm and practical. Variable names appear on screen only; the VO describes what each one does (style guide section 4).
- Recreate, not restart (environment-variables.md caution): a restart does not replace the container environment. `docker compose up -d` usually recreates the changed containers; `--force-recreate` if it does not.
- The .env in beat 3 follows docker/example.env from the Frameleaf release (IMMICH_VERSION defaults to `release`; release bundles pin it). `TZ=America/Edmonton` fits the sample library's Alberta places; blur DB_PASSWORD.
- FRAMELEAF_CLOUD_URL (environment-variables.md "Frameleaf Cloud"): unset means Frameleaf Cloud is not set up and nothing is ever contacted. It is deployment configuration, never a setting.
- Config file (config-file.md): JSON or YAML; IMMICH_CONFIG_FILE is the path inside the container; the doc recommends reusing the variable in the compose volume line; microservices workers need the file mounted too. The doc's file name `immich-config.json` is replaced by `frameleaf-config.json` in the capture; any name works.
- Doc vs UI: config-file.md says "In Administration > Settings is a button to copy the current configuration", and system-settings.md names "Export as JSON" and "Copy to clipboard". The current build has Settings → Server & updates → Configuration transfer with "Export settings", "Copy settings" and "Import settings" (help text: accounts, media, credentials and pending edits are excluded). The VO uses the build labels.
- Lock behaviour (`SettingsHost.svelte`, `NotificationSettings.svelte`): with a config file every settings form is disabled and the notice "Config is currently set by a config file" shows; credential rows read "Credentials are managed by the configuration file on the server." (system-settings.md: while a configuration file manages the settings, credentials come from that file).
- Log level precedence is verified in the server source (`system-config.service.ts`): IMMICH_LOG_LEVEL overrides the Logs & diagnostics level, the log prints "(set via IMMICH_LOG_LEVEL)", and saving a logging change is refused while the variable is set. The UI list reads Fatal, Error, Warn, Log, Debug, Verbose; the variable accepts verbose, debug, log, warn, error.
- Log format (monitoring.md): `console` by default, `json` for log aggregation; logs are not forwarded to any external collector.
- Other variables exist for workers, Redis, machine learning, help links and app releases; the guide lists them all. OPS-18 uses IMMICH_TRUSTED_PROXIES and OPS-19 uses the worker variables.
