# OPS-01 · The settings Command Center

| Field | Value |
| --- | --- |
| Series | Running Frameleaf |
| Type | Learn |
| Target length | 2:45 |
| Audience | Administrators who are new to Frameleaf's settings and want to know how changes are saved, reviewed and tracked |
| Features demonstrated | Settings areas and rail groups (Command center, Your library, Your server, Personal), settings search, one shared draft (unsaved markers, Review changes, Save changes, Discard, Reset this page, leave warning), conflict handling (Keep my changes, Discard this draft and load latest), stored credentials (Stored, Not set, Replace credential, Clear), Configuration transfer (Export settings, Copy settings, Import settings), Change history |
| Source docs | docs/docs/administration/system-settings.md |
| Capture checklist | Taylor signed in as administrator on frameleaf.home, dark theme. Library timeline with the sidebar expanded so the footer (Library Care, Settings, Support Frameleaf) is visible. Settings opening on the Overview. Search field typed "transcoding" returning "Video playback proxies". Storage & originals → Trash & retention with Number of days 30, changed to 60; Editing & playback → Video playback proxies with Target resolution 720p, changed to 1080p; the rail showing the unsaved dot on both areas; save bar reading "2 unsaved changes". Review settings changes dialog with both rows. Reset this page at the foot of Video playback proxies. A second administrator session (Taylor in a second browser profile) to save a conflicting change to Target resolution. Notifications → Email delivery with the SMTP password row reading "Stored". Server & updates → Configuration transfer. A prepared settings file with three supported and one unsupported setting. Change history with at least three entries, one of them a credential replacement. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD "The settings Command Center · Running Frameleaf". SCREEN: Library timeline (Taylor). CURSOR travels to the sidebar footer; HIGHLIGHT "Settings"; click. Cross-dissolve to the Command Center open on Overview, rail on the left. | LOWER-THIRD; CALLOUT "Settings" | "Every Frameleaf setting lives in one place, the settings Command Center. Open Settings at the bottom of the sidebar. Administrators land on the Overview." |
| 3 | 0:14–0:31 | SCREEN: the rail. ZOOM on the group headings; each gets a HIGHLIGHT as named: "Command center" (Overview, Library analytics), "Your library" (Storage & originals, Import & protection, Search & intelligence, Editing & playback, People & sharing, Library care, Libraries, Utilities, Trash), "Your server" (Compute & jobs, Frameleaf Cloud, Access & security, Notifications, Server & updates, Maintenance, Users), "Personal" (Your preferences, Change history). | Command center · Your library · Your server · Personal | "The rail groups the areas. Command center holds the Overview and Library analytics. Your library covers storage, imports, search, editing and care. Your server covers processing, access, email, updates, maintenance and users. Personal holds your own preferences and Change history." |
| 4 | 0:31–0:43 | SCREEN: context bar. CURSOR clicks the search field "Find a setting, feature, or task…" and types "transcoding"; results page "Search results · 1 matching settings section" shows "Video playback proxies". Then SPLIT: left the administrator's rail, right the rail of Jamie (not an administrator) showing only Import & protection, People & sharing, Library care, Utilities, Trash, Access & security, Notifications, Your preferences and Change history. | Search all settings; CALLOUT "Jamie · not an administrator" | "Not sure where something lives? Search all settings from the field at the top, for example for transcoding. Accounts that are not administrators see only their own settings." |
| 5 | 0:43–0:59 | SCREEN: Storage & originals → Trash & retention. CURSOR changes Number of days from 30 to 60. CURSOR opens Editing & playback → Video playback proxies and changes Target resolution from 720p to 1080p. ZOOM on the rail: a small dot appears beside Storage & originals and Editing & playback. | CALLOUT "Unsaved change" | "Every settings page edits one shared draft. Change the trash retention here, then the playback resolution in another area. Both changes wait in the draft, and each area with changes gets a dot in the rail." |
| 6 | 0:59–1:11 | ZOOM on the save bar at the bottom: "2 unsaved changes · Review the scope and effect before saving." with Discard and Review changes. CURSOR clicks Review changes; dialog "Review settings changes" lists "Days · Storage & originals · Trash & retention · 30 › 60" and "Target resolution · Editing & playback · Video playback proxies · 720 › 1080". CURSOR clicks Save changes; notice "Settings saved." | Review changes · Save changes | "The bar at the bottom counts them. Review changes lists each change with its page, the saved value and the new one. Save changes saves everything together." |
| 7 | 1:11–1:27 | SCREEN: Video playback proxies after another edit. HIGHLIGHT Discard in the save bar; then scroll to the foot of the page and HIGHLIGHT "Reset this page"; CURSOR clicks it; notice "Defaults restored to your draft. Review changes to save them." CURSOR clicks "Back to library"; the save bar turns into "You have 1 unsaved settings change." with Keep editing and Discard and leave. | Discard · Reset this page · Keep editing · Discard and leave | "Discard returns every page to the saved settings. Reset this page puts that page's defaults into the draft, for you to review. Leave with unsaved changes, and Frameleaf asks whether to keep editing or discard them." |
| 8 | 1:27–1:49 | SPLIT: left, Taylor's second session saves Target resolution 480p; right, the first session's draft still holds 1080p. The right side's notice panel appears: "Settings were changed elsewhere since you opened this page. Your draft is kept here until you choose what to do." with "1 of your changes was also changed elsewhere:", "Saved now: 480", "Your draft: 1080", and the buttons Keep my changes and Discard this draft and load latest. HIGHLIGHT both buttons in turn. | Keep my changes · Discard this draft and load latest | "If another administrator saves while you edit, your draft is kept. Your changes to other settings are carried onto theirs, and you review and save again. Where you both changed the same setting, you see the saved value and yours: keep your changes, or discard your draft and load the latest." |
| 9 | 1:49–2:05 | SCREEN: Notifications → Email delivery. ZOOM on the credential row "SMTP password · Stored" with the line "Values are hidden after saving.". HIGHLIGHT Replace credential; CURSOR clicks; dialog with one field "New value" (blurred); CURSOR clicks Cancel. HIGHLIGHT Clear. Small CARD beside it: "Never in the draft · Never exported". | Stored · Not set · Replace credential · Clear | "Passwords and secrets are never part of the draft. The SMTP password and the OAuth client secret show only Stored or Not set. Replace credential sends a new value once. Clear removes it after a confirmation." |
| 10 | 2:05–2:26 | SCREEN: Server & updates → Configuration transfer, heading "Move settings between installations". HIGHLIGHT Export settings, then Copy settings; CURSOR opens "What is included": "Editable server settings. Installation-managed policies and hidden credentials are excluded." CURSOR clicks Import settings and picks the prepared file; notices: "3 settings from the file are in your draft. Review changes to save them." and "1 setting in the file is not supported here and was ignored". | Export settings · Copy settings · Import settings | "To move settings between servers, open Server & updates, then Configuration transfer. Export settings and Copy settings leave out passwords, secrets and keys. Import settings puts a file into your draft for review; settings this server does not have are listed and ignored, and credentials are never applied." |
| 11 | 2:26–2:42 | SCREEN: rail → Personal → Change history. Timeline newest first: "2 settings changed · Taylor · 26 Sep 2026, 10:12", an entry for the SMTP password. CURSOR clicks View changes on the first entry: "Days 30 › 60", "Target resolution 720 › 1080". ZOOM on the credential entry showing "Replaced". | Change history · View changes | "Change history, under Personal, lists every saved change, newest first, with who saved it, when, and each value before and after. Credentials show only as replaced or cleared. Every administrator sees the same history of the latest fifty saves." |
| 12 | 2:42–2:45 | LOGO OUTRO | Guide: System Settings | "The written guide is linked below." |

## Voice-over (clean)

Every Frameleaf setting lives in one place, the settings Command Center. Open Settings at the bottom of the sidebar. Administrators land on the Overview.

The rail groups the areas. Command center holds the Overview and Library analytics. Your library covers storage, imports, search, editing and care. Your server covers processing, access, email, updates, maintenance and users. Personal holds your own preferences and Change history.

Not sure where something lives? Search all settings from the field at the top, for example for transcoding. Accounts that are not administrators see only their own settings.

[pause]

Every settings page edits one shared draft. Change the trash retention here, then the playback resolution in another area. Both changes wait in the draft, and each area with changes gets a dot in the rail.

The bar at the bottom counts them. Review changes lists each change with its page, the saved value and the new one. Save changes saves everything together.

Discard returns every page to the saved settings. Reset this page puts that page's defaults into the draft, for you to review. Leave with unsaved changes, and Frameleaf asks whether to keep editing or discard them.

[pause]

If another administrator saves while you edit, your draft is kept. Your changes to other settings are carried onto theirs, and you review and save again. Where you both changed the same setting, you see the saved value and yours: keep your changes, or discard your draft and load the latest.

[pause]

Passwords and secrets are never part of the draft. The SMTP password and the OAuth client secret show only Stored or Not set. Replace credential sends a new value once. Clear removes it after a confirmation.

To move settings between servers, open Server & updates, then Configuration transfer. Export settings and Copy settings leave out passwords, secrets and keys. Import settings puts a file into your draft for review; settings this server does not have are listed and ignored, and credentials are never applied.

[pause]

Change history, under Personal, lists every saved change, newest first, with who saved it, when, and each value before and after. Credentials show only as replaced or cleared. Every administrator sees the same history of the latest fifty saves.

[pause]

The written guide is linked below.

## Production notes

- Capture from a build of `master/frameleaf-implementation`. The Command Center lives at `/user-settings`; the old `/admin/system-settings` address only redirects there. system-settings.md still calls it "Administration > Settings" and never names the areas; narrate the current rail.
- Rail labels verified in the build: groups "Command center", "Your library", "Your server", "Personal"; areas as listed in beat 3. Overview and Library analytics appear only for administrators; a non-administrator lands on "Your preferences". For the SPLIT in beat 4, capture Jamie's rail from a real non-administrator session.
- The review and history rows name each setting by its configuration path (for example "Days" and "Target resolution") and show raw values ("720 › 1080"), not the dropdown labels; reproduce what the build prints.
- Save bar and review strings: "{n} unsaved changes", "Review the scope and effect before saving.", "Discard", "Review changes", dialog "Review settings changes" with the intro "Review what will change. Jobs already in progress keep their current settings and processing location.", "Keep editing", "Save changes". Save changes is inside the review dialog, not on the bar. Leave guard: "You have {n} unsaved settings change(s).", "Keep editing", "Discard and leave". Page tool: "Reset this page"; notice "Defaults restored to your draft. Review changes to save them."
- Conflict strings (beat 8): "Settings were changed elsewhere since you opened this page. Your draft is kept here until you choose what to do.", "{n} of your changes was also changed elsewhere:", "Saved now: {value}", "Your draft: {value}", "Keep my changes", "Discard this draft and load latest". When the other save touches different settings only, the notice instead reads "Settings were saved elsewhere while you were editing. Your changes are kept on top of the latest settings; review them and save again." The sample library has one administrator, so use a second browser session for Taylor rather than promoting Jamie.
- Doc vs UI: the doc names the transfer actions "Export as JSON", "Copy to clipboard" and "Import from JSON" (those names survive in the command palette). The Configuration transfer section's buttons read "Export settings", "Copy settings" and "Import settings"; the VO uses the section's labels. The imported-file notices are "{n} settings from the file are in your draft. Review changes to save them." and "{n} setting(s) in the file is/are not supported here and was/were ignored: {paths}". When the file carried credentials, the extra line "Credentials in the imported file were not applied. Replace them in their settings." also appears.
- Credentials: only the OAuth client secret (Access & security → Sign-in methods) and the SMTP password (Notifications → Email delivery) are write-only rows. Blur the "New value" field. Do not save a real credential in the capture; cancel the dialog as scripted.
- Reloading the tab brings the draft back except passwords, keys and addresses containing credentials (doc "Saving changes"); not narrated, to stay within length.
- Actions that start something on the server (Send test email, unlinking OAuth accounts) run on their own, and a successful test email also saves the email settings. That is covered in OPS-14 and left out here for length.
- Change history keeps the latest 50 saves on the server; credential entries show only "Replaced" or "Cleared". Every account also sees its own preference history here; the administrator view mixes both. Keep the capture on settings entries.
- Outro CTA on screen: `Guide: System Settings`; the producer fills in the public docs URL.
