# CLOUD-01 · What Frameleaf Cloud is

| Field | Value |
| --- | --- |
| Series | Frameleaf Cloud |
| Type | Learn |
| Target length | 2:30 |
| Audience | Operators deciding whether to link their server; anyone who wants to know what the cloud can and cannot see |
| Features demonstrated | Optional services, nothing before linking, what never leaves the server, Account & link "Not set up" and "Not linked" states and their benefit rows, check-in contents, no silent fallback |
| Source docs | docs/docs/administration/frameleaf-cloud.md, docs/docs/administration/workers-and-endpoints.md |
| Capture checklist | frameleaf.home signed in as Taylor (admin). Settings → Frameleaf Cloud → Account & link in two states: "Not set up" (no FRAMELEAF_CLOUD_URL) and "Not linked" (address set, never linked). Settings → Compute & jobs → Workload destinations with the "Where each job runs" table showing "Runs on this server" on Smart search, Face recognition, Text in photos and Studio export. Timeline of the sample library for the opening shot. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:15 | LOWER-THIRD "What Frameleaf Cloud is · Frameleaf Cloud". SCREEN: the timeline on frameleaf.home, Taylor signed in, Summer in the Rockies photos visible. At 0:10 a TITLE "Frameleaf Cloud" with subheading "Optional extras for your own server" replaces it. | Frameleaf Cloud · Optional extras for your own server | "Frameleaf runs on your own server and works fully on its own. Frameleaf Cloud is a set of optional extras for that server." |
| 3 | 0:15–0:30 | CARD headline "Three optional extras"; bullets appear one per clause: "Remote access and the mobile app from anywhere", "Cloud processing on Frameleaf Cloud GPUs, paid per job", "Cloud backup to an encrypted bucket only this server uses". | Three optional extras | "There are three. Remote access and the Frameleaf mobile app from anywhere, without opening ports or managing certificates. Cloud processing on Frameleaf Cloud GPUs, paid per job. And cloud backup to an encrypted bucket only your server uses." |
| 4 | 0:30–0:42 | SCREEN: Settings → Frameleaf Cloud → Account & link in the "Not set up" state. ZOOM on the chip "Not set up" and the heading "Frameleaf Cloud is not set up on this server"; CALLOUT on the line "Until then this server never contacts Frameleaf Cloud." | Not set up · never contacts Frameleaf Cloud | "Before anyone sets it up, your server never contacts Frameleaf Cloud. Account & link says so: Frameleaf Cloud is not set up on this server." |
| 5 | 0:42–0:54 | SCREEN: the same page in the "Not linked" state. HIGHLIGHT the chip "Not linked", then ZOOM down the four benefit rows (mobile apps, Remote access, Cloud processing, Cloud backup). | Not linked · what a link would add | "Once the address is set, the page shows Not linked and lists what a link would add. Nothing is on yet." |
| 6 | 0:54–1:06 | ZOOM on the sentence "You approve the link on … with a short code. Nothing from your library is uploaded by linking." HIGHLIGHT the "Link to Frameleaf" button without clicking. | Nothing from your library is uploaded by linking. | "Linking is a short code you approve in a free Frameleaf account. Nothing from your library is uploaded by linking." |
| 7 | 1:06–1:18 | DIAGRAM: node "frameleaf.home" (green) on the left, node "Frameleaf Cloud" (blue) on the right. A thin teal arrow "check-in · every few minutes" carries small tags that appear as named: Frameleaf version, Uptime, Health, Endpoints. | Check-in: version · uptime · health · endpoints | "After you link, the server checks in every few minutes. It sends its version, uptime, health, and the addresses it uses for remote access." |
| 8 | 1:18–1:30 | DIAGRAM continues: a second row under the server node, struck through in muted grey: Photos, Videos, Thumbnails, Metadata, Names, Accounts, Usage. Then SCREEN inset of the "What this server sends" list with its "Never sent" row. | Never sent: photos · videos · thumbnails · metadata · names · accounts · usage | "It never sends photos, videos, thumbnails, metadata, names, accounts or usage. What this server sends lists every field, so you can read it yourself." |
| 9 | 1:30–1:43 | SCREEN: Settings → Compute & jobs → Workload destinations, the "Where each job runs" table. HIGHLIGHT the rows Smart search, Face recognition, Text in photos and Studio export, each showing "Runs on this server"; CALLOUT on "Faces never leave this server." | Runs on this server: Smart search · Face recognition · Text in photos · Studio export | "Some work never leaves your server at all. Faces, search, text in photos and Studio exports always run at home, even with cloud processing on." |
| 10 | 1:43–1:58 | CARD headline "Nothing falls back silently"; bullets: "Every cloud job shows its model and cost first", "Off or unreachable means refused, not moved", "The refusal says why". | Nothing falls back silently | "Nothing falls back to the cloud silently. Every cloud job shows its model and its estimated cost before it starts. If Frameleaf Cloud is off or does not answer, the job is refused and says why." |
| 11 | 1:58–2:12 | CARD headline "Your library never depends on it"; bullets: "No link, plan or licence needed to self-host", "If a plan ends, only cloud-connected features pause", "Unlink at any time". | Your library never depends on it | "Your photos never depend on a link, a plan or a licence. If a plan ends, only cloud-connected features pause. Unlink at any time, and everything local keeps working exactly as before." |
| 12 | 2:12–2:27 | SCREEN: Account & link "Not linked" state. CURSOR moves to "Link to Frameleaf" and rests on it with a HIGHLIGHT ring; no click. Screen dips as the outro begins. | Link to Frameleaf | "When you are ready, Link to Frameleaf is where it starts. The next episodes walk through each service in turn." |
| 13 | 2:27–2:30 | LOGO OUTRO | Guide: Frameleaf Cloud | "The written guide is linked below." |

## Voice-over (clean)

Frameleaf runs on your own server and works fully on its own. Frameleaf Cloud is a set of optional extras for that server.

There are three. Remote access and the Frameleaf mobile app from anywhere, without opening ports or managing certificates. Cloud processing on Frameleaf Cloud GPUs, paid per job. And cloud backup to an encrypted bucket only your server uses.

[pause]

Before anyone sets it up, your server never contacts Frameleaf Cloud. Account & link says so: Frameleaf Cloud is not set up on this server.

Once the address is set, the page shows Not linked and lists what a link would add. Nothing is on yet.

Linking is a short code you approve in a free Frameleaf account. Nothing from your library is uploaded by linking.

[pause]

After you link, the server checks in every few minutes. It sends its version, uptime, health, and the addresses it uses for remote access.

It never sends photos, videos, thumbnails, metadata, names, accounts or usage. What this server sends lists every field, so you can read it yourself.

Some work never leaves your server at all. Faces, search, text in photos and Studio exports always run at home, even with cloud processing on.

[pause]

Nothing falls back to the cloud silently. Every cloud job shows its model and its estimated cost before it starts. If Frameleaf Cloud is off or does not answer, the job is refused and says why.

Your photos never depend on a link, a plan or a licence. If a plan ends, only cloud-connected features pause. Unlink at any time, and everything local keeps working exactly as before.

[beat]

When you are ready, Link to Frameleaf is where it starts. The next episodes walk through each service in turn.

The written guide is linked below.

## Production notes

- Narration tone: Calm and factual; reassuring without selling. Second person, present tense.
- Prerequisites: two captures of Account & link are needed. "Not set up" requires a server started without `FRAMELEAF_CLOUD_URL`; "Not linked" requires the address set and the server restarted, never linked. Both states are available in the current build (inventory: only these states appear on a real server today).
- The "Where each job runs" table is captured under Settings → Compute & jobs → Workload destinations. On an unlinked server the cloud choices are disabled and the table still shows "Runs on this server" on the four local-only rows, which is exactly what beat 9 needs. If the build gates the table behind linking, capture the same rows from the Cloud processing page on the e2e mock network and keep the READY status only if the rows read identically.
- Doc wording mismatch: workers-and-endpoints.md still calls the area "Administration > Processing destinations"; the shipped navigation is Settings → Compute & jobs → Workers & endpoints and Workload destinations (inventory ⚠ note). The VO does not name the page.
- The check-in field list in beat 7 is abridged for time. The full list on the page is Frameleaf version, Start marker, Uptime, Health, Endpoints, Remote access, Permissions and Licence; beat 8 shows the page so the full list is on screen.
- Do not name a GPU, storage or hosting provider anywhere in the captures; "Frameleaf Cloud GPUs" is the only wording for processing hardware. Frameleaf does not claim to own GPUs or data centres.
- No prices appear in this episode. Cloud processing is "paid per job"; plan and supporter pricing is in CLOUD-04.
- Sample data: Taylor signed in on frameleaf.home; opening timeline shows Summer in the Rockies.
