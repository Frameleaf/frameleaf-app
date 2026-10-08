# START-06 · Get the mobile app and sign in

| Field | Value |
| --- | --- |
| Series | Start here |
| Type | How-to |
| Target length | 2:15 |
| Audience | Frameleaf users installing the Frameleaf mobile app on a phone for the first time |
| Features demonstrated | Settings → Utilities → Connect → Mobile applications ("Frameleaf on your devices": Platform, Architecture, Download Android app, Open App Store, signing certificate fingerprint, Setup checklist, Release information, unavailable state), Obtainium setup ("Direct Android updates": Server address, Create download-only access, Open in Obtainium, Copy configuration), mobile sign-in (Server Endpoint URL, Next, Email, Password, Login), photo access permission, matching app and server versions, Signed-in devices |
| Source docs | docs/docs/features/mobile-app.mdx, docs/docs/administration/frameleaf-app-transition.md |
| Capture checklist | Server `frameleaf.home` started with the three Android release variables and the iOS URL set (`FRAMELEAF_ANDROID_RELEASE_URL`, `FRAMELEAF_ANDROID_APP_ID`, `FRAMELEAF_ANDROID_SIGNING_SHA256`, `FRAMELEAF_IOS_APP_URL`) pointing at a test release folder, so downloads are offered; a second server (or a restart without them) for the unavailable state. Taylor signed in on the web, dark theme. An Android phone in a device frame with the Frameleaf mobile app installed but not signed in, on the same network as the server; Obtainium installed. The photos uploaded in START-05 in the library. Phone status bar clean; no store listing, launcher store icons or app-store names in shot. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Get the mobile app and sign in · Start here". SPLIT: left, the web library; right, a phone frame showing the Frameleaf mobile app timeline with the same photos. | LOWER-THIRD | "The Frameleaf mobile app lets you browse your library and back up your phone. Your server tells you where to get it." |
| 3 | 0:13–0:25 | SCREEN: web. CURSOR clicks Settings in the sidebar footer; in the areas list clicks Utilities; the tool directory shows the groups Organize, Repair, Import, Automate, Connect. HIGHLIGHT "Mobile applications · Choose a mobile app and review backup and migration setup." under Connect; CURSOR clicks it. | CALLOUT "Settings → Utilities → Mobile applications" | "Open Settings, then Utilities. Under Connect, choose Mobile applications. Utilities belong to every account, so anyone on your server can do this." |
| 4 | 0:25–0:43 | SCREEN: "Frameleaf on your devices" with the line "Browse your library, back up new photos, and keep your account connected." Platform "Android", Architecture "Automatic"; ZOOM on "Signing certificate SHA-256: …" (fingerprint partly blurred) and the button "Download Android app". CURSOR switches Platform to iOS: the Architecture field disappears and the button becomes "Open App Store" (not clicked). | CALLOUT "Platform · Architecture"; CALLOUT "Signing certificate SHA-256"; CALLOUT "Download Android app · Open App Store" | "Choose your platform. On Android, leave Architecture on Automatic and choose Download Android app; the signing certificate's fingerprint is shown so you can check what you install. On an iPhone, Open App Store takes you to the app's page." |
| 5 | 0:43–0:53 | ZOOM on the right-hand panel "Setup checklist": "Sign in to your Frameleaf account", "Grant access to the photos you want to back up", "Choose Wi-Fi and background upload preferences", "Disable the previous automatic uploader", then the buttons "Manage device access" and "Release information". CURSOR ticks the first box. | CALLOUT "Setup checklist" | "The Setup checklist beside it walks you through the rest, from signing in to switching off any previous uploader." |
| 6 | 0:53–1:02 | SCREEN: the same page on a server without release settings: the line "No signed release is available for this installation yet." and a disabled "Download Android app". | CALLOUT "No signed release is available" | "If the page says no signed release is available, app downloads haven't been set up on this server yet; ask your administrator." |
| 7 | 1:02–1:20 | SCREEN: back in Utilities, CURSOR clicks "Obtainium setup". Page "Direct Android updates": Architecture "Automatic", Server address prefilled `http://frameleaf.home:2283`, "Download-only access key" (masked). CURSOR clicks "Create download-only access"; notice "Download-only access created. It is included in the configuration below."; "Open in Obtainium" and "Copy configuration" become active. Small line: "Obtainium is an independent open-source app updater. It installs Frameleaf from this server's signed releases." Inset: the phone, Obtainium showing the imported "Frameleaf" entry. | CALLOUT "Server address"; CALLOUT "Create download-only access"; CALLOUT "Open in Obtainium" | "On Android, Obtainium setup lets Obtainium, an independent open-source updater, keep the app current from your server's releases. Check the Server address, then choose Create download-only access; that key can only download the app. Open in Obtainium imports the configuration." |
| 8 | 1:20–1:38 | PHONE: the Frameleaf mobile app's sign-in screen. Field "Server Endpoint URL" with the hint "http://your-server-ip:port"; CURSOR (touch ripple) types `http://frameleaf.home:2283`; taps Next. Fields "Email" (`taylor@example.test`) and "Password" (masked); taps Login. | CALLOUT "Server Endpoint URL"; CALLOUT "Port 2283" | "Now open the app. In Server Endpoint URL, enter your server's address with port 2283, the one you use in the browser, and choose Next. Then enter your email and password and choose Login." |
| 9 | 1:38–1:49 | PHONE: the system prompt for photo access (framed so only the prompt and the app name area are visible); tap Allow. The timeline loads with Moraine Lake, Lake reflection and Glacier creek from START-05 at the top. | CALLOUT "Allow photo access" | "Allow access to your photos when the phone asks. Your library appears, including anything you uploaded from the browser." |
| 10 | 1:49–2:03 | CARD "Can't sign in after an update?": bullet 1 "App and server: same major and minor version"; bullet 2 "Release information shows the server's version". SCREEN inset: web, Mobile applications → Release information opens "About Frameleaf" with the Version row highlighted. | CARD; CALLOUT "Release information" | "If the app can't sign in after an update, check that the app and server run the same major and minor version. Release information, on the Mobile applications page, shows your server's version." |
| 11 | 2:03–2:12 | SCREEN: web, Settings → Access & security → "Signed-in devices": the new phone session listed at the top alongside this browser. | CALLOUT "Signed-in devices" | "Each person signs in to their own account. The phone now appears under Signed-in devices, in Access and security." |
| 12 | 2:12–2:15 | LOGO OUTRO | Next: START-07 · Your first mobile backup | "Next up: Your first mobile backup." |

## Voice-over (clean)

The Frameleaf mobile app lets you browse your library and back up your phone. Your server tells you where to get it.

Open Settings, then Utilities. Under Connect, choose Mobile applications. Utilities belong to every account, so anyone on your server can do this.

Choose your platform. On Android, leave Architecture on Automatic and choose Download Android app; the signing certificate's fingerprint is shown so you can check what you install. On an iPhone, Open App Store takes you to the app's page.

The Setup checklist beside it walks you through the rest, from signing in to switching off any previous uploader.

If the page says no signed release is available, app downloads haven't been set up on this server yet; ask your administrator.

[pause]

On Android, Obtainium setup lets Obtainium, an independent open-source updater, keep the app current from your server's releases. Check the Server address, then choose Create download-only access; that key can only download the app. Open in Obtainium imports the configuration.

[pause]

Now open the app. In Server Endpoint URL, enter your server's address with port 2283, the one you use in the browser, and choose Next. Then enter your email and password and choose Login.

Allow access to your photos when the phone asks. Your library appears, including anything you uploaded from the browser.

If the app can't sign in after an update, check that the app and server run the same major and minor version. Release information, on the Mobile applications page, shows your server's version.

Each person signs in to their own account. The phone now appears under Signed-in devices, in Access and security.

Next up: Your first mobile backup.

## Production notes

- Labels verified in the build (ApplicationSetup.svelte, utilities.ts, i18n `frameleaf_apps.*` and `library_care_tool_*`): Utilities groups "Organize", "Repair", "Import", "Automate", "Connect"; tools "Mobile applications" and "Obtainium setup"; page titles "Frameleaf on your devices" and "Direct Android updates"; "Platform", "Architecture" (Automatic, arm64-v8a, armeabi-v7a, x86_64, Universal), "Download Android app", "Open App Store", "Signing certificate SHA-256: {fingerprint}", "Setup checklist", "Manage device access", "Release information", "No signed release is available for this installation yet.", "Server address", "Download-only access key", "Create download-only access", "Open in Obtainium", "Copy configuration", "Update access" (the Obtainium page's checklist). Settings area "Access & security", section "Signed-in devices".
- Mobile sign-in labels (i18n used by the mobile app): "Server Endpoint URL" (hint "http://your-server-ip:port"), "Next", "Email", "Password", "Login".
- Docs vs interface: mobile-app.mdx (via the `_mobile-app-download.md` partial) still lists public store listings, GitHub releases and F-Droid for the other app, and says the Obtainium link comes from "the Utilities page of your Immich server". The current build offers only this server's configured signed releases (Settings → Utilities → Mobile applications) and never falls back to another product's listings; Obtainium setup builds the configuration itself with download-only access. Narration follows the build; flag mobile-app.mdx and the partial. docs/docs/install/environment-variables.md documents the variables and says "Without them the Mobile applications and Obtainium setup pages say that no signed release is available" (beat 6).
- "Open App Store" is the button's own label; say it, but do not follow it to a store page. Keep every store listing and app-store name out of shot, as the style guide requires.
- The Obtainium access key is shown once and masked in the field; blur it anyway. The Obtainium inset shows only the imported entry named "Frameleaf" (the configuration sets `appName: 'Frameleaf'`).
- Beat 8: the partial says to use `http://<machine-ip-address>:2283`. Use the host name only if the phone resolves `frameleaf.home`; otherwise show a private IP such as `http://192.168.1.20:2283`.
- Beat 9: frameleaf-app-transition.md says the phone asks again for photo library, notification and background access; only the photo prompt is shown. Some mobile screens and system prompts may still show an older app name in places; frame or crop so only Frameleaf branding is visible.
- Beat 10 comes from FAQ.mdx ("Verify that the mobile app and server are both running the same version (major and minor)"). Release information opens the "About Frameleaf" dialog with the Version row.
- Beat 11: frameleaf-app-transition.md says the Frameleaf app's session "is a new session, listed separately under Signed-in devices in the account settings". Moving from another app to this one is covered in START-08.
