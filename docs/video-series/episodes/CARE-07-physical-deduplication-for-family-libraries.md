# CARE-07 · Physical deduplication for family libraries

| Field | Value |
| --- | --- |
| Series | Library Care |
| Type | How-to |
| Target length | 2:45 |
| Audience | Administrators of a household server where several accounts upload the same photos |
| Features demonstrated | Physical deduplication (Storage & originals), Enable physical deduplication and Master account, Scan scope, Retain originals in, Prepare preview plan, plan name and metrics, match evidence and skip reasons, Share this original in the plan, Mark plan reviewed, Apply reviewed plan with typed APPLY confirmation, apply job (Pause, Resume, Stop, Activity), Review history |
| Source docs | docs/docs/features/physical-deduplication.md, README.md (Family-Library Physical Deduplication) |
| Capture checklist | Dark theme, Taylor (administrator) on frameleaf.home. Jamie and Emma have each uploaded copies of photos Taylor already holds (Family hike, Summit view, Moraine Lake, Wildflowers). Settings → Storage & originals → Originals & folder structure with the Physical deduplication group; Enable physical deduplication on and Master account "Taylor (taylor@example.test)" saved. Settings → Storage & originals → Physical deduplication with no plan yet, then a prepared plan (sample name `PD-1A2B3C4D`), one copy in an external library to show a skip, and one earlier applied plan in Review history. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:18 | LOWER-THIRD "Physical deduplication for family libraries · Library Care". DIAGRAM: three account nodes, Taylor, Jamie and Emma, each holding "Family hike"; three teal file nodes on disk beneath them. Then two of the file nodes fade, and all three accounts point at one file. | Three accounts · one stored file | "In a family, the same photo is often uploaded by everyone who was there. Physical deduplication keeps one stored copy of that file, while every account keeps its own photo, albums and details." |
| 3 | 0:18–0:30 | CARD "Nothing about ownership changes": bullets "Owner, albums, favorites, faces", "Shared links, stacks, Locked state, permissions", "Only the file behind the photo changes". | Nothing about ownership changes | "Nothing about ownership changes. Each photo keeps its owner, albums, favorites, faces, shared links and Locked state. Only the file behind it changes." |
| 4 | 0:30–0:45 | CALLOUT "Keep an independent, verified backup". SCREEN: Settings → Storage & originals → Originals & folder structure. ZOOM on the group "Physical deduplication": toggle "Enable physical deduplication" (on), select "Master account" set to "Taylor (taylor@example.test)"; CURSOR saves. | Enable physical deduplication · Master account | "First, keep an independent, verified backup. Then, as an administrator, open Storage and originals, turn on Enable physical deduplication, and save the Master account whose originals are kept." |
| 5 | 0:45–0:59 | SCREEN: Storage & originals → Physical deduplication. Empty state "Start with a preview". Toolbar: "Scan scope" ("All accounts"), "Retain originals in Taylor" with "Change", primary button "Prepare preview plan". CURSOR clicks it; status "Scanning…". | Scan scope · Retain originals in · Prepare preview plan | "Open Physical deduplication in the same area. Choose the Scan scope, all accounts or just one, and choose Prepare preview plan. The preview is a background scan; no file changes." |
| 6 | 0:59–1:15 | Plan heading: badge "Preview ready", name `PD-1A2B3C4D`, "19 Sep 2026, 10:20 · All accounts · Retain in Taylor". COUNTER on metrics "Copies to share 1,284", "Retained originals 1,102", "Space to reclaim 412 GB", "Skipped copies 37". ZOOM on group "Family hike.HEIC": badge "Retained original", "1 reference now · 1 → 3 after this plan", copies "Jamie's copy" and "Emma's copy", each "Share original · 4.1 MB reclaimed". | Preview ready · Copies to share · Space to reclaim | "The plan has its own name. It lists every exact copy beside the retained original it matches, with how many photos point at that original now and after the plan, and the space you would get back." |
| 7 | 1:15–1:29 | CURSOR opens "Evidence" on Jamie's copy: File, SHA-256, Retained copy, Match evidence "Checksum and byte size match". CURSOR switches the view to "Evidence": columns Duplicate copy, Retained original, Match evidence, References, Plan decision. ZOOM on a row "Skip · External library". | Checksum and byte size match · Skip · External library | "Open the evidence to see each checksum and size. Copies that cannot share are skipped with a reason, such as an external library, whose files are never moved, linked or deleted." |
| 8 | 1:29–1:41 | Back to the Media view. On group "Wildflowers" CURSOR clears "Share this original in the plan"; its copies now read "Keep separate · left out of this plan". Footer note "This plan shares 1,281 copies; 1 group stays as they are. Changing a group needs a new review." | Share this original in the plan | "Decide group by group. Clear Share this original in the plan to leave a group as it is; its copies keep their own files." |
| 9 | 1:41–1:56 | CURSOR clicks "Mark plan reviewed". Notice "PD-1A2B3C4D is reviewed: every copy and retained original still matches its evidence. Apply it only if the retained copies and reference counts are correct."; badge "Reviewed". Inset: the refusal "This plan no longer matches the library, or another plan is being applied. Nothing changed." | Mark plan reviewed · Reviewed | "Choose Mark plan reviewed. The server checks the plan against the library again. If anything has changed since the preview, it refuses, nothing changes, and you prepare a new plan." |
| 10 | 1:56–2:12 | CURSOR clicks "Apply reviewed plan". Dialog "Apply this reviewed plan?": "Reviewed plan PD-1A2B3C4D", "Scan scope All accounts", "Retain originals in Taylor", "Copies to share 1,281", "Estimated space 411 GB", "Groups left as they are 1", the backup reminder, field "Type APPLY PD-1A2B3C4D to confirm". The caret types it; "Apply this plan" enables; CURSOR clicks. | Apply reviewed plan · Type APPLY PD-1A2B3C4D to confirm | "Choose Apply reviewed plan. The confirmation shows the plan, its scope, the retained account and the space to reclaim. Type APPLY and the plan's name exactly, then apply it." |
| 11 | 2:12–2:28 | Panel "Plan being applied": badge "Applying", progress bar, counts "412 of 1,281 copies checked · 409 sharing the retained original · 3 left as they were · 0 failed · 1.6 GB reclaimed", buttons "Pause" and "Stop", link "Open Activity". Notice "Each copy is checked again before its file changes." | Applying · Pause · Stop · Open Activity | "Applying is a background job you can pause, resume or stop, and it survives a restart. Each copy is checked again before its file changes, and a retained original is never deleted." |
| 12 | 2:28–2:42 | CURSOR expands "Review history": entries "Applied · PD-1A2B3C4D" with "1,281 of 1,281 copies shared · 0 left as they were · 0 failed · 411 GB reclaimed · Taylor" and an older plan below, each with its time. | Review history | "Review history lists recent plans, who applied them, and what they shared and reclaimed. For copies uploaded later, prepare a new plan." |
| 13 | 2:42–2:45 | LOGO OUTRO | Next: CARE-08 · iCloud Photos: import your library | "Next up: iCloud Photos: import your library." |

## Voice-over (clean)

In a family, the same photo is often uploaded by everyone who was there. Physical deduplication keeps one stored copy of that file, while every account keeps its own photo, albums and details.

Nothing about ownership changes. Each photo keeps its owner, albums, favorites, faces, shared links and Locked state. Only the file behind it changes.

First, keep an independent, verified backup. Then, as an administrator, open Storage and originals, turn on Enable physical deduplication, and save the Master account whose originals are kept.

Open Physical deduplication in the same area. Choose the Scan scope, all accounts or just one, and choose Prepare preview plan. The preview is a background scan; no file changes.

The plan has its own name. It lists every exact copy beside the retained original it matches, with how many photos point at that original now and after the plan, and the space you would get back.

Open the evidence to see each checksum and size. Copies that cannot share are skipped with a reason, such as an external library, whose files are never moved, linked or deleted.

Decide group by group. Clear Share this original in the plan to leave a group as it is; its copies keep their own files.

Choose Mark plan reviewed. The server checks the plan against the library again. If anything has changed since the preview, it refuses, nothing changes, and you prepare a new plan.

Choose Apply reviewed plan. The confirmation shows the plan, its scope, the retained account and the space to reclaim. Type APPLY and the plan's name exactly, then apply it.

[pause]

Applying is a background job you can pause, resume or stop, and it survives a restart. Each copy is checked again before its file changes, and a retained original is never deleted.

Review history lists recent plans, who applied them, and what they shared and reclaimed. For copies uploaded later, prepare a new plan.

[pause]

Next up: iCloud Photos: import your library.

## Production notes

- Docs vs interface: physical-deduplication.md places the tool at "Administration > Physical deduplication" and the setting at "Administration > Settings > Storage Template", calling it the "retained account". In the current build the tool is Settings → Storage & originals → Physical deduplication (the old `/admin/physical-deduplication` page redirects there), and the setting is Storage & originals → Originals & folder structure → "Physical deduplication": "Enable physical deduplication" and "Master account". The tool itself says "Retain originals in {name}" with a "Change" button that jumps to that setting. VO names the setting label "Master account"; flag the doc.
- Without the feature on or an account saved, the page says "Enable file reuse before preparing a plan." or "Choose and save an account to retain shared originals before preparing a plan." A preview can use another account chosen on the page, but applying always uses the saved one ("This preview retains originals in {name}, not the saved retained account. Prepare a new plan.").
- Plan names follow `PD-` plus eight characters, a fingerprint of the evidence; the confirmation phrase is exactly `APPLY` followed by the plan name (web source: `APPLY ${planId}`), as the doc says. Preparing a new preview replaces the plan with a new name.
- The list holds the first 500 copies; totals cover all and the plan applies only the listed copies ("Showing the first {n} copies…"). Another account's Locked media is counted but never listed ("{n} copies are another account's Locked media…").
- Mark plan reviewed is refused when a newer preview replaced the plan, the plan was already applied, any copy or retained original changed, a copy already points at its retained original, or reference counts moved. Reviews are signed and do not survive a server restart. Changing a group after the review asks for a new review.
- Apply job (doc): one plan at a time for all administrators; listed in Activity and the notifications panel of the administrator who applied it, and on this page for every administrator; only that administrator can pause, resume or stop it. A copy that fails is retried once. A plan that changed any file reads "Applied" or "Partly applied" and cannot be applied again; Activity offers no Retry. Prepare a new plan, which skips copies already shared.
- Not narrated but visible: the Media and Evidence view switch, "Export review", "How the bytes add up", and for applied plans "Verify" and "Restore own file" (not described in the doc).
- Physical deduplication runs only on this server's own workers, never on a render worker (doc). External-library files are never moved, linked or deleted.
- All counts, sizes and the plan name are sample data.
