# PRIV-01 · Privacy by design

| Field | Value |
| --- | --- |
| Series | Private by design |
| Type | Learn |
| Target length | 2:30 |
| Audience | Administrators and privacy-minded households deciding what their server may say to the outside world |
| Features demonstrated | No telemetry (removed from the server, blocked in machine-learning libraries, old variables ignored), no version phone-home to other services, first-run Privacy step (Check for Frameleaf updates, Map tiles), Versions & compatibility (Check for updates, Third-party release checks locked off), Maps & geography (Enable map features, local place names), what still uses the network (model downloads, workers you add, your own sign-in provider and email), Frameleaf Cloud optional with nothing contacted without an address, linking uploads nothing, what a check-in contains |
| Source docs | docs/docs/features/monitoring.md, docs/docs/features/fork-privacy-suite.md, docs/docs/administration/frameleaf-cloud.md |
| Capture checklist | Signed in as Taylor (admin), dark theme. A fresh test server on the first-run setup's Privacy step. The sample server's Settings → Server & updates with Versions & compatibility and Maps & geography. Settings → Frameleaf Cloud → Account & link in the "Not linked" state (deployment has a Frameleaf Cloud address, no link). No linked-state captures. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD "Privacy by design · Private by design"; TITLE "What your server says, and to whom" with subheading "Never · Your choice · Only when you ask" | Privacy by design | "Frameleaf is built so your server tells the outside world as little as possible. This episode covers what never leaves, what you decide, and what still uses the network." |
| 3 | 0:15–0:29 | DIAGRAM: node "Your Frameleaf server" (green) in the centre; a blue node "Usage reporting" to the right with its line struck through; three labels appear as the VO names them: "Removed from the server", "Blocked in machine-learning libraries", "Old settings ignored" | No telemetry | "Start with what never leaves. There is no telemetry: the reporting code is removed from the server, reporting in the bundled machine-learning libraries is blocked, and old telemetry settings do nothing." |
| 4 | 0:29–0:40 | DIAGRAM continues: a blue node "Other release services" with its line struck through; a dashed blue line to "Frameleaf releases" labelled "only if you allow" | Update checks: Frameleaf only | "There is no version phone-home to other services either. Update checks ask only for new Frameleaf releases, and only if you allow them." |
| 5 | 0:40–0:59 | SCREEN first-run setup, step "Privacy": two switches, "Check for Frameleaf updates" ("Asks GitHub once a day whether a new Frameleaf release is out. Nothing about your library is sent.") and "Map tiles" ("Loads map images so photos can be shown on the map. The tile server sees which areas you view."); CALLOUT on each description as the VO reaches it | Privacy step | "During setup, the Privacy step shows the two outside calls that are yours to decide. Check for Frameleaf updates asks GitHub once a day and sends nothing about your library. Map tiles loads map images, and the tile server sees which areas you view." |
| 6 | 0:59–1:12 | SCREEN Settings → Server & updates → Versions & compatibility; panel "Frameleaf updates" with "Frameleaf update service" and "You decide when to install"; HIGHLIGHT the "Check for updates" toggle; ZOOM on "Third-party release checks" (off, greyed) with "External release services prohibited" | Versions & compatibility | "You can change both later. In Settings, Server & updates, Versions & compatibility holds Check for updates. Third-party release checks is shown off, and it cannot be turned on." |
| 7 | 1:12–1:26 | SCREEN Server & updates → Maps & geography; HIGHLIGHT "Enable map features"; CURSOR scrolls to the reverse geocoding toggle; CALLOUT "Place names: a database on this server" | Maps & geography | "Maps & geography holds Enable map features. With it off, no tiles load. Place names come from a database on your own server, so naming a place never needs an outside call." |
| 8 | 1:26–1:47 | CARD headline "Uses the network because you asked"; bullets: "Model downloads: the host sees the file and your address", "Workers you add: the images they process", "Your own sign-in provider and email: only once set up" | Because you asked | "Some things still use the network, because you asked for them. Downloading a model tells the download host which file you want and your network address. Workers you add receive the images they process. Your own sign-in provider and email server hear from Frameleaf only when you set them up." |
| 9 | 1:47–2:01 | SCREEN Settings → Frameleaf Cloud → Account & link; chip "Not linked"; heading "This server is not linked"; ZOOM on "Nothing from your library is uploaded by linking."; the CURSOR stays off "Link to Frameleaf" | Not linked | "Frameleaf Cloud is optional. Without a Frameleaf Cloud address in the deployment, the server never contacts it. Linking is your choice, and linking uploads nothing from your library." |
| 10 | 2:01–2:15 | CARD headline "If you link"; bullets: "A check-in every few minutes", "Every field listed on the page", "Never: photos, videos, thumbnails, metadata, names, accounts, usage" | If you link | "Once linked, the server checks in every few minutes, and the page lists every field it sends. Photos, videos, thumbnails, metadata, names, accounts and usage are never among them." |
| 11 | 2:15–2:27 | CARD headline "What to do"; bullets: "Walk through the Privacy step", "Decide on updates and map tiles", "Link Frameleaf Cloud only for extras you want" | What to do | "So walk through the Privacy step, decide on updates and map tiles, and link Frameleaf Cloud only for the extras you want." |
| 12 | 2:27–2:30 | LOGO OUTRO | Guide: Monitoring | "The written guide is linked below." |

## Voice-over (clean)

Frameleaf is built so your server tells the outside world as little as possible. This episode covers what never leaves, what you decide, and what still uses the network.

[pause]

Start with what never leaves. There is no telemetry: the reporting code is removed from the server, reporting in the bundled machine-learning libraries is blocked, and old telemetry settings do nothing.

There is no version phone-home to other services either. Update checks ask only for new Frameleaf releases, and only if you allow them.

[pause]

During setup, the Privacy step shows the two outside calls that are yours to decide. Check for Frameleaf updates asks GitHub once a day and sends nothing about your library. Map tiles loads map images, and the tile server sees which areas you view.

You can change both later. In Settings, Server & updates, Versions & compatibility holds Check for updates. Third-party release checks is shown off, and it cannot be turned on.

Maps & geography holds Enable map features. With it off, no tiles load. Place names come from a database on your own server, so naming a place never needs an outside call.

[pause]

Some things still use the network, because you asked for them. Downloading a model tells the download host which file you want and your network address. Workers you add receive the images they process. Your own sign-in provider and email server hear from Frameleaf only when you set them up.

[pause]

Frameleaf Cloud is optional. Without a Frameleaf Cloud address in the deployment, the server never contacts it. Linking is your choice, and linking uploads nothing from your library.

Once linked, the server checks in every few minutes, and the page lists every field it sends. Photos, videos, thumbnails, metadata, names, accounts and usage are never among them.

[pause]

So walk through the Privacy step, decide on updates and map tiles, and link Frameleaf Cloud only for the extras you want.

The written guide is linked below.

## Production notes

- Sources: monitoring.md (telemetry permanently disabled; no OpenTelemetry, exporters or collectors; old telemetry variables cannot re-enable reporting; version checks never contact another service and, when on, ask only Frameleaf's own GitHub releases); the privacy-suite page's "Telemetry and automatic reporting" section (machine-learning library reporting blocked; model downloads, configured remote workers and Frameleaf Cloud processing, OAuth, email and map tiles stay functional; download hosts receive the requested file and network address; remote inference receives the images it needs); reverse-geocoding.md (place names from a GeoNames database loaded into your own Postgres); frameleaf-cloud.md (no address means never contacted; "Nothing from your library is uploaded by linking"; check-in fields and the never-sent list).
- Default states: the first-run Privacy step starts with both switches on as recommendations; a server that never ran setup has Check for updates off (server default). The VO says only that they are yours to decide. MKT-02 states "update checks stay off until you turn them on", which is true of the server default but not of the setup screen; keep this episode's wording.
- The footer "Other outside calls Frameleaf doesn't need stay off." appears on the Privacy step only in the existing-library flow; capture it only if you capture that flow.
- Beat 7: the "Enable map features" subtitle names the default third-party tile host. Keep the ZOOM on the toggle title, not its subtitle, and do not narrate the host. The Reverse Geocoding toggle sits below it in the same page.
- Doc vs docs: the privacy-suite page says "External version checks never run"; monitoring.md and the build say Frameleaf's own update check runs when turned on and nothing else is ever contacted. The narration follows monitoring.md and the build.
- Beat 10 is a CARD, not a capture: the linked state depends on Frameleaf Cloud services (CLOUD-02 is HOLD). Do not capture "What this server sends" for this episode.
- Guide CTA: the privacy-suite page's title contains a word the series never shows, so the outro points to "Guide: Monitoring", which links to the telemetry section. The producer fills in the public docs URL.
