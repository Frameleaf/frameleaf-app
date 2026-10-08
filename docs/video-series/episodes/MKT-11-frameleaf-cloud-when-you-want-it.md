# MKT-11 · Frameleaf Cloud, when you want it

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:20 |
| Audience | Self-hosters who want remote access, a bigger GPU or an off-site copy without giving up a home server |
| Features demonstrated | Account & link (Link to Frameleaf, What this server sends), remote access with Sign in with Frameleaf, cloud processing with Where each job runs and the AI Wallet, the cloud processing privacy terms, cloud backup with your own key, Unlink |
| Source docs | docs/docs/administration/frameleaf-cloud.md, docs/docs/administration/workers-and-endpoints.md, /Users/adamtaylor/Github/frameleaf-cloud/docs (client side only) |
| Capture checklist | HOLD: Account & link, Cloud processing, Where each job runs and AI Wallet can be captured from the integration build in their shipped states; the linking approval, remote access page, a running cloud job and cloud backup setup come from the design prototype (design/frameleaf/template FrameleafCloud.jsx) or the mock network; every UI beat carries the on-screen label Preview; phone frame for the remote-access beat; no staff console, no account-site checkout, no prices on screen |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:11 | LOWER-THIRD "Frameleaf Cloud, when you want it · Meet Frameleaf". SCREEN: Settings → Frameleaf Cloud → Account & link, chip "Not linked", heading "This server is not linked", the four benefit rows beneath. CURSOR idle. "Preview" label top right. | Preview · Not linked | "Frameleaf runs entirely at home. Frameleaf Cloud is the set of extras you add only when you want them." |
| 3 | 0:11–0:18 | SCREEN: CURSOR clicks "Link to Frameleaf" (0:12). The page shows "Your code 7K3D-P2QX", a QR code, "Expires in 9:58" and "Waiting for approval…". At 0:16 the chip flips to "Linked". "Preview" label. | Preview · Your code 7K3D-P2QX | "Link a server with a short code you approve from your account. Linking uploads nothing from your library." |
| 4 | 0:18–0:26 | SCREEN: Linked state. ZOOM on "What this server sends": Frameleaf version, Start marker, Uptime, Health, Endpoints, Remote access, Permissions, Licence; then on the line "Never sent: Photos, videos, thumbnails, metadata, names, accounts or usage". "Preview" label. | Preview · What this server sends | "You can read exactly what a linked server sends. Never a photo, a name, or how you use it." |
| 5 | 0:26–0:34 | SCREEN: Frameleaf Cloud → remote access page. CURSOR switches on "Allow remote access" (0:27); status "Remote access is on."; the Apps card flips "At home only" → "Available anywhere". Cut at 0:31 to a phone frame away from home: the Frameleaf mobile app opens the library; the sign-in page shows the "Sign in with Frameleaf" button. "Preview" label. | Preview · Available anywhere | "Switch on Allow remote access, and your library reaches you anywhere, with no port to open and no certificate to manage." |
| 6 | 0:34–0:44 | SCREEN: Frameleaf Cloud → Cloud processing. Toggle "Use Frameleaf Cloud for chosen jobs" on. ZOOM on the "Where each job runs" table: Descriptions & tags set to "Both"; Face recognition, Smart search and Text in photos (OCR) fixed at "Never" with their reasons. HIGHLIGHT rings the three Never rows. "Preview" label. | Preview · Where each job runs | "Cloud processing puts Frameleaf Cloud GPUs behind the heavy jobs, each priced before it starts. Faces, search and text in photos never go." |
| 7 | 0:44–0:51 | SCREEN: the AI Wallet card: Balance, Held for running jobs, Available, "Spent today" with "Daily spending cap"; the amounts are blurred. Beside it, "Estimate a job" for Descriptions & tags with its amounts blurred and the line "This job could start now." "Preview" label. | Preview · AI Wallet · US dollars | "You pay from a prepaid AI Wallet, in US dollars, and a daily cap holds the line." |
| 8 | 0:51–0:59 | CARD "What the cloud never gets" with bullets per clause: "Your originals", "Location and camera details", "Files after the job is done". Behind it the "Cloud processing terms" dialog, dimmed. "Preview" label. | Preview · Cloud processing terms | "Originals never leave your server. Location and camera details are stripped first, and files are deleted when the job is done." |
| 9 | 0:59–1:07 | SCREEN: Frameleaf Cloud → Cloud backup → "Set up cloud backup". Step "Encryption key": CURSOR picks "Generate a key for me"; the "Frameleaf recovery kit" panel appears with a "Download key file" button. At 1:05 the banner "Cloud backup is set up. The first run starts tonight." "Preview" label. | Preview · Frameleaf recovery kit | "Cloud backup sends your originals to an encrypted bucket only your server can read. You hold the key." |
| 10 | 1:07–1:17 | SCREEN: Account & link, CURSOR clicks "Unlink…"; the dialog "Unlink this server from Frameleaf?" lists what stops, then the line "Local photos, albums, accounts and sign-in keep working exactly as before." ZOOM on that line; CURSOR chooses "Keep linked". "Preview" label; TITLE "When you want it." fades in over the dimmed page at 1:14. | Preview · When you want it. | "Unlink, and every photo, album and account keeps working as before. This is a preview of Frameleaf Cloud. Your server never depends on it." |
| 11 | 1:17–1:20 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

Frameleaf runs entirely at home. Frameleaf Cloud is the set of extras you add only when you want them.

Link a server with a short code you approve from your account. Linking uploads nothing from your library.

You can read exactly what a linked server sends. Never a photo, a name, or how you use it.

[beat]

Switch on Allow remote access, and your library reaches you anywhere, with no port to open and no certificate to manage.

Cloud processing puts Frameleaf Cloud GPUs behind the heavy jobs, each priced before it starts. Faces, search and text in photos never go.

You pay from a prepaid AI Wallet, in US dollars, and a daily cap holds the line.

Originals never leave your server. Location and camera details are stripped first, and files are deleted when the job is done.

Cloud backup sends your originals to an encrypted bucket only your server can read. You hold the key.

[pause]

Unlink, and every photo, album and account keeps working as before. This is a preview of Frameleaf Cloud. Your server never depends on it.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- HOLD. Shipped and capturable from the integration build (cloud inventory, STATUS): Account & link in every state, Sign in with Frameleaf, the Cloud processing page with its terms dialog, AI Wallet card, Models slider, Where each job runs and Estimate a job. Not live: the remote access page and relay, a cloud job actually running, cloud backup setup and restore, and the account site. Capture those from the design prototype or the mock network, and carry the on-screen label "Preview" in every UI beat. Publish only after the dependencies ship.
- Beat 3 linking flow is frameleaf-cloud.md: "Link to Frameleaf" shows a code XXXX-XXXX, a QR code and a ten-minute countdown; approval is picked up by the page; "Get a new code" if it expires. The code on screen is sample data. The server needs FRAMELEAF_CLOUD_URL for anything other than "Not set up".
- Beat 4 list is the doc's check-in contents: Frameleaf version, start marker, uptime, health, remote-access addresses and state, permission choices and the licence's signing key. "Photos, videos, thumbnails, metadata, names, accounts and usage are never sent."
- Beat 5: remote access is HOLD (cloud inventory, section 6). Labels: "Allow remote access", "Remote access is on.", Apps card "Available anywhere" / "At home only". Remote visitors sign in with Frameleaf; the doc notes the server does not yet refuse passwords over remote access, so the narration says nothing about passwords. Do not show the relay address, bandwidth limits or a custom domain. Frame the phone so no upstream app name or store badge is visible.
- Beat 6: workers-and-endpoints.md and the Cloud processing page: nothing falls back; faces never run on Frameleaf Cloud; search and text recognition stay on your own workers; Studio export never renders in the cloud. "Use Frameleaf Cloud for chosen jobs", "Where each job runs" with Local only / Both / Cloud only are the page's labels. "Each priced before it starts" is the page's "Each job still shows its model and cost before it starts."
- Beat 7: the AI Wallet is prepaid and shown in US dollars with held amounts (workers-and-endpoints.md); "Daily spending cap" means jobs that would pass it wait until tomorrow. Blur every amount: GPU class rates and per-photo figures in the cloud docs are planning estimates, and the plan prices in frameleaf-cloud.md ($6 a month, $60 a year, backup from $7.99 a month per TB) conflict with the cloud docs' "1 TB included"; no price is spoken or shown. Never say "credits" as a currency.
- Beat 8 is the terms text on the Cloud processing page: only previews are sent, never originals; location and camera metadata are stripped first; zero retention, files deleted as soon as the job finishes and within 24 hours at most; nothing is used to train models.
- Beat 9: cloud backup is HOLD (cloud inventory, section 5). One dedicated encrypted bucket per server; the cloud sees only names and sizes; key choices "Generate a key for me" or "I'll maintain my own key"; the recovery kit is shown once. Never name the storage provider or the region; say "an encrypted bucket". Do not show the managed-storage card with its included-storage figure.
- Beat 10 is the documented Unlink dialog: remote access, cloud processing and scheduled backups stop, linked accounts disconnect, and "Local photos, albums, accounts and sign-in keep working exactly as before."
- The staff console, super-admin tooling and the store checkout never appear. Do not name any GPU, storage or hosting provider; cloud GPUs are "Frameleaf Cloud GPUs".
- Beat 10's "preview" is the single HOLD mention in narration; the word is not used elsewhere in the VO.
