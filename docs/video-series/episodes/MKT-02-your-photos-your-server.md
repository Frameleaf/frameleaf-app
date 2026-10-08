# MKT-02 · Your photos, your server

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:10 |
| Audience | Privacy-minded people deciding whether to move off a big-tech photo cloud |
| Features demonstrated | Docker Compose install, first-run setup (Local account only, Where processing runs → Local only, Privacy step), no telemetry, update checks as your choice (Privacy step, Settings → Server & updates), Frameleaf Cloud Account & link in its Not linked state |
| Source docs | docs/docs/features/monitoring.md, docs/docs/features/fork-privacy-suite.md, docs/docs/overview/quick-start.mdx |
| Capture checklist | A fresh server for the first-run setup (Welcome, How you'll sign in, Processing, Privacy steps); a terminal with the Frameleaf docker-compose.yml and .env in ./frameleaf-app; Settings → Server & updates with Check for updates as the Privacy step left it (on) and the row Third-party release checks · External release services prohibited; Settings → Frameleaf Cloud → Account & link in the Not linked state; Library timeline as Taylor for the closing beat |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:11 | LOWER-THIRD "Your photos, your server · Meet Frameleaf". TERMINAL: prompt in ./frameleaf-app, `docker compose up -d` typed, four containers report Started. Cut at 0:08 to SCREEN: first-run setup "Welcome to Frameleaf" with the line "Your photos, beautifully kept. On your own server." | Welcome to Frameleaf | "Frameleaf runs on your own server. Install it with Docker Compose, open a browser, and your whole library lives at home." |
| 3 | 0:11–0:17 | SCREEN: setup step "How you'll sign in". Two cards; CURSOR clicks "Local account only". CALLOUT on its bullet "Nothing leaves your network". | Local account only | "During setup, pick Local account only, and your account is stored only on this server." |
| 4 | 0:17–0:23 | SCREEN: setup step "Processing". "Detected on this server" shows Search and faces. Under "Where processing runs", HIGHLIGHT then CURSOR clicks "Local only". CALLOUT: "Everything runs here. Nothing leaves your network." | Local only | "Then you choose where processing runs. Pick Local only, and everything runs here." |
| 5 | 0:23–0:30 | DIAGRAM: node "Your server" (green) centre; inside a green ring, four teal nodes appear as the VO names them: Search, Faces, Text in photos, Descriptions. A blue node "The internet" sits far right with no line to the ring. | — | "With Local only, search, faces, text in photos and descriptions are all worked out on your own hardware." |
| 6 | 0:30–0:42 | CARD "No usage reporting" with bullets appearing per clause: "No telemetry, by design", "Update checks: your choice", "Frameleaf releases only, nothing about your library". Cut at 0:37 to SCREEN: Settings → Server & updates; ZOOM on the "Check for updates" toggle, then on the row "Third-party release checks · External release services prohibited". | Check for updates · Frameleaf releases only | "There is no usage reporting to switch off, because there is none. Update checks are your choice, and they ask only Frameleaf's own releases. Nothing about your library is sent." |
| 7 | 0:42–0:52 | SCREEN: setup step "Privacy" with the toggles "Map tiles" and "Check for Frameleaf updates". CALLOUT on the footer line "Other outside calls Frameleaf doesn't need stay off." Both toggles start on; CURSOR leaves them as they are. | Map tiles · Check for Frameleaf updates | "The Privacy step shows the outside calls that are yours to decide: map tiles and update checks. Everything Frameleaf does not need stays off." |
| 8 | 0:52–1:00 | SCREEN: Settings → Frameleaf Cloud → Account & link, chip "Not linked", heading "This server is not linked". ZOOM on the line "Nothing from your library is uploaded by linking." CURSOR does not click "Link to Frameleaf". | Not linked | "Frameleaf Cloud is optional, and it stays quiet until you link a server. Even linking uploads nothing from your library." |
| 9 | 1:00–1:07 | SCREEN: Library timeline as Taylor, Summer in the Rockies photos, slow scroll. TITLE overlay at 1:03, lower centre. | Your photos. Your server. | "Your photos stay where you put them. Frameleaf works for you, and reports to no one." |
| 10 | 1:07–1:10 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

Frameleaf runs on your own server. Install it with Docker Compose, open a browser, and your whole library lives at home.

During setup, pick Local account only, and your account is stored only on this server.

Then you choose where processing runs. Pick Local only, and everything runs here.

With Local only, search, faces, text in photos and descriptions are all worked out on your own hardware.

[beat]

There is no usage reporting to switch off, because there is none. Update checks are your choice, and they ask only Frameleaf's own releases. Nothing about your library is sent.

The Privacy step shows the outside calls that are yours to decide: map tiles and update checks. Everything Frameleaf does not need stays off.

Frameleaf Cloud is optional, and it stays quiet until you link a server. Even linking uploads nothing from your library.

[pause]

Your photos stay where you put them. Frameleaf works for you, and reports to no one.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- The first-run setup (beats 2, 3, 4 and 7) is the shipped "Set up Frameleaf" flow from the cloud inventory, section 4: chapters Welcome · Account · Library · Protection · Ready. Capture on a server that has not been set up yet. On a server that is not linked, "Local account only" is marked Recommended and the "Frameleaf account" card is disabled; keep the disabled card in shot but do not zoom on its "Unavailable on this server for now" text.
- Beat 4: the "Frameleaf Cloud GPUs" choice under "Where processing runs" only appears when the server is linked. On the unlinked server it shows Local only, which is what this episode wants.
- Beat 2 TERMINAL: use the Frameleaf release files (docker-compose.yml and example.env renamed to .env from github.com/Frameleaf/frameleaf-app/releases/latest/download/) in a folder named ./frameleaf-app. Container names are frameleaf_server, frameleaf_machine_learning, frameleaf_postgres and frameleaf_redis. Blur DB_PASSWORD if .env is ever in frame.
- Beat 6: monitoring.md states telemetry is permanently disabled and that version checks, when turned on, ask only Frameleaf's own GitHub releases. The Privacy step's own line for the toggle is "Asks GitHub once a day whether a new Frameleaf release is out. Nothing about your library is sent." The older Version Check accordion text in system-settings.md contradicts this; do not capture that page.
- Correction (checked against the current build): the VO used to say update checks "stay off until you turn them on". Off is only the server's default (`newVersionCheck.enabled: false`, server/src/dtos/config.dto.ts); the first-run Privacy step starts with "Check for Frameleaf updates" and "Map tiles" both on (web/src/lib/frameleaf/first-run-setup.ts) and saves them, so anyone who went through setup has update checks on unless they turned them off. Beat 6 now says update checks are your choice, the card drops "No version phone-home" and "off until you turn them on", and beat 7 shows both Privacy toggles on.
- Beat 5 is a diagram, not a claim about every deployment: the narration is scoped to "With Local only". Faces never run on Frameleaf Cloud in any configuration; search and text recognition always stay on your own workers (workers-and-endpoints.md).
- Beat 7 wording "Other outside calls Frameleaf doesn't need stay off." is the setup step's own footer. fork-privacy-suite.md lists what still touches the network when you use it: model downloads, configured remote workers or Frameleaf Cloud, OAuth, email and map tiles. The narration does not claim the server is a network sandbox.
- Beat 8 needs the server deployed with FRAMELEAF_CLOUD_URL so Account & link shows "Not linked" rather than "Not set up". If only "Not set up" is available, capture that state and change the on-screen text to "Not set up"; the narration still holds because neither state contacts anything.
- Quick-start still names the upstream product in its prose; the narration uses only "Frameleaf".
