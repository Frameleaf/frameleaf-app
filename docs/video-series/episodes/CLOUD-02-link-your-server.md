# CLOUD-02 · Link your server to a Frameleaf account

| Field | Value |
| --- | --- |
| Series | Frameleaf Cloud |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators linking a server for the first time |
| Features demonstrated | Link to Frameleaf, short code and approval, Linked state, Apps card, Allow Frameleaf Cloud to…, What this server sends, Check in now, expired and declined codes, Unlink |
| Source docs | docs/docs/administration/frameleaf-cloud.md, /Users/adamtaylor/Github/frameleaf-cloud/design/prototype/README.md |
| Capture checklist | HOLD: capture on the e2e mock network or the design prototype with the on-screen label "Preview". frameleaf.home as Taylor (admin): Account & link "Not linked", pending state with code and QR, "Linked" state with facts, Apps card "At home only", "Allow Frameleaf Cloud to…" toggles, "What this server sends" list, "Check in now" toast, "The code expired" state, "Unlink this server from Frameleaf?" dialog. Phone frame: account site Servers → Link a server → code entry → "A server wants to link to your account" with Deny / Approve and link. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:17 | LOWER-THIRD "Link your server to a Frameleaf account · Frameleaf Cloud". SCREEN: Settings → Frameleaf Cloud → Account & link in the "Not linked" state; CURSOR traces the path Settings → Frameleaf Cloud → Account & link in the sidebar. | Preview · Settings → Frameleaf Cloud → Account & link | "This is a preview of linking a server to a Frameleaf account. You need a free Frameleaf account, and the Frameleaf Cloud address set on your server. Open Settings, Frameleaf Cloud, then Account & link." |
| 3 | 0:17–0:25 | HIGHLIGHT the "Link to Frameleaf" button; CURSOR clicks. Toast "Link started. Enter the code on the approval page." | Preview · Link to Frameleaf | "Choose Link to Frameleaf." |
| 4 | 0:25–0:39 | SCREEN: pending state. ZOOM on "Your code" showing an eight-character code, the QR panel "Link this server", "Expires in" counting down, "Server key" fingerprint, and "Waiting for approval…". | Preview · Approve this server on <host> · Your code · Expires in · Server key | "The page shows Your code, a QR code and a countdown. Expires in counts down from ten minutes. Server key is this server's fingerprint. Keep this page open; it waits for approval." |
| 5 | 0:39–0:49 | ZOOM on the two buttons "Copy link" and "Download QR code" under the QR panel; CURSOR hovers each. | Preview · Copy link · Download QR code | "Copy link and Download QR code give you other ways to hand the address to the device you approve from." |
| 6 | 0:49–1:01 | SPLIT: left, the server page still "Waiting for approval…"; right, a phone frame on the Frameleaf account site, Servers → "Link a server" → "Enter the code from your server", the code being typed. | Preview · Enter the code from your server | "On your phone or another computer, open that address, sign in to your Frameleaf account, and enter the code, or scan the QR code." |
| 7 | 1:01–1:13 | Phone frame: "A server wants to link to your account" listing server name "frameleaf.home", version and key fingerprint; ZOOM compares the fingerprint with the "Server key" on the left. CURSOR taps "Approve and link". | Preview · A server wants to link to your account · Deny · Approve and link | "The approval page shows the server's name, version and key fingerprint. Only approve if they match what your server shows. Then choose Approve and link." |
| 8 | 1:13–1:26 | SCREEN: the server page updates by itself. The chip flips to "Linked"; heading "Linked to Frameleaf"; ZOOM down the facts Account, Linked, Last contact, Instance ID, Key fingerprint, Data region. | Preview · Linked to Frameleaf · Account · Last contact · Data region | "Your server picks up the approval by itself. The chip changes to Linked, and the page shows your account, the last contact and your data region." |
| 9 | 1:26–1:36 | ZOOM on the Apps card reading "At home only" with its help text. | Preview · Apps · At home only | "The Apps card says At home only for now. It changes to Available anywhere once remote access is on." |
| 10 | 1:36–1:51 | ZOOM on "Allow Frameleaf Cloud to…": three toggles "Turn remote access on or off" (off), "Start a cloud backup" (on), "Refresh your plan automatically" (on). HIGHLIGHT each as named. | Preview · Allow Frameleaf Cloud to… | "Allow Frameleaf Cloud to… sets what your account may ask this server to do. Turn remote access on or off starts off. Start a cloud backup and Refresh your plan automatically start on. The server records every request." |
| 11 | 1:51–2:03 | ZOOM on "What this server sends": Frameleaf version, Start marker, Uptime, Health, Endpoints, Remote access, Permissions, Licence; then the "Never sent" row. | Preview · What this server sends · Never sent | "What this server sends lists every field of a check-in. Photos, videos, thumbnails, metadata, names, accounts and usage are never sent." |
| 12 | 2:03–2:13 | HIGHLIGHT "Check in now"; CURSOR clicks; toast "Checked in with Frameleaf Cloud."; "Last contact" updates. | Preview · Check in now | "Check in now sends a check-in straight away and confirms with Checked in with Frameleaf Cloud." |
| 13 | 2:13–2:27 | CARD headline "If it goes wrong"; bullets: "The code expired → Get a new code", "Linking was declined → start again", "Nothing was uploaded either way". Inset SCREEN of the "The code expired" state. | Preview · The code expired · Get a new code | "If nobody approves in time, the page says The code expired. Get a new code starts over. A declined code changes nothing." |
| 14 | 2:27–2:42 | SCREEN: CURSOR clicks "Unlink…". Dialog "Unlink this server from Frameleaf?" lists the consequences; ZOOM on "Local photos, albums, accounts and sign-in keep working exactly as before."; buttons "Keep linked" and "Unlink server". CURSOR chooses "Keep linked". | Preview · Unlink this server from Frameleaf? · Keep linked · Unlink server | "To undo it, choose Unlink. The dialog lists what stops: remote access, cloud jobs and scheduled cloud backups. Local photos, albums, accounts and sign-in keep working exactly as before. You can link again at any time." |
| 15 | 2:42–2:45 | LOGO OUTRO | Next up: Sign in with Frameleaf | "Next up: Sign in with Frameleaf." |

## Voice-over (clean)

This is a preview of linking a server to a Frameleaf account. You need a free Frameleaf account, and the Frameleaf Cloud address set on your server. Open Settings, Frameleaf Cloud, then Account & link.

Choose Link to Frameleaf.

The page shows Your code, a QR code and a countdown. Expires in counts down from ten minutes. Server key is this server's fingerprint. Keep this page open; it waits for approval.

Copy link and Download QR code give you other ways to hand the address to the device you approve from.

[pause]

On your phone or another computer, open that address, sign in to your Frameleaf account, and enter the code, or scan the QR code.

The approval page shows the server's name, version and key fingerprint. Only approve if they match what your server shows. Then choose Approve and link.

Your server picks up the approval by itself. The chip changes to Linked, and the page shows your account, the last contact and your data region.

The Apps card says At home only for now. It changes to Available anywhere once remote access is on.

[pause]

Allow Frameleaf Cloud to… sets what your account may ask this server to do. Turn remote access on or off starts off. Start a cloud backup and Refresh your plan automatically start on. The server records every request.

What this server sends lists every field of a check-in. Photos, videos, thumbnails, metadata, names, accounts and usage are never sent.

Check in now sends a check-in straight away and confirms with Checked in with Frameleaf Cloud.

[pause]

If nobody approves in time, the page says The code expired. Get a new code starts over. A declined code changes nothing.

To undo it, choose Unlink. The dialog lists what stops: remote access, cloud jobs and scheduled cloud backups. Local photos, albums, accounts and sign-in keep working exactly as before. You can link again at any time.

Next up: Sign in with Frameleaf.

## Production notes

- Narration tone: Step-by-step and calm; every label spoken as printed.
- HOLD dependency: Frameleaf Cloud services are not yet live. On a real server only "Not set up", "Not linked" and "unavailable" states appear. Capture the pending, Linked, Check in now and Unlink beats from the e2e mock network, and the phone-side approval from the account-site design prototype (`design/prototype`, route `#/servers/link`, sample code BDFK-QRTW; `ZZZZ-ZZZZ` shows the expired state). Every beat carries the "Preview" label until the service ships.
- "<host>" in beat 4 is whatever host the build prints in "Approve this server on {host}"; do not invent one. The account site in the prototype is account.frameleaf.cloud.
- Prerequisites: `FRAMELEAF_CLOUD_URL` set and the server restarted; Taylor is an administrator. The identity folder (`FRAMELEAF_IDENTITY_DIR`) must be on persistent storage; if it is lost the link stops working (docs). Not said in the VO; keep for the written guide.
- Headless linking (account Servers → Add server → Create link token, then `FRAMELEAF_LINK_TOKEN=fll_…`, single use, one hour) is deliberately left out of the VO for time; the "Linking a server without a browser" card can appear in beat 13's inset if space allows.
- Sample data: server name frameleaf.home, Taylor's account, data region as the prototype shows (North America). Blur the instance ID and key fingerprint if a real one is captured; the mock network's values are fine.
- Beat 14 ends on "Keep linked" so the capture stays linked for CLOUD-03 onwards.
- Never show the staff console or any provider name on the account site captures.
