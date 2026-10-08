# MKT-05 · Locked, by you

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:00 |
| Audience | Anyone who keeps documents, records or private photos in the same library as the family album |
| Features demonstrated | Mark Sensitive, PIN unlock for the session, the Locked view with reasons, sensitive-content detection with review, Locked tags & people, what partners and shared links never see |
| Source docs | docs/docs/features/locked.md, docs/docs/features/fork-privacy-suite.md |
| Capture checklist | Dark theme as Taylor with a PIN set; timeline with Through the forest selectable; album Summer in the Rockies; the Locked shield in the top bar and the six-digit PIN dialog; Library → Locked with filter All / Marked / Detected and tiles badged Sensitive; Settings → Search & intelligence NSFW detection accordion; an information card "Image enrichment" section with Accept and Mark safe; Settings → Access & security → Locked tags & people with tag "documents"; a public shared-link viewer of Summer in the Rockies |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:10 | LOWER-THIRD "Locked, by you · Meet Frameleaf". SCREEN: timeline. CURSOR selects Through the forest (0:05); the selection bar appears; HIGHLIGHT then click on "Mark Sensitive" (0:08). The tile fades out and the grid closes the gap. | Mark Sensitive | "Some photos are yours alone. Select one, choose Mark Sensitive, and it leaves the timeline." |
| 3 | 0:10–0:19 | SCREEN: album Summer in the Rockies, grid without the locked tile. CARD top right "Still yours" with bullets per clause: "In its albums", "With its tags", "In its place in time". | Nothing moved | "It has not moved. It keeps its albums, its tags and its place in time. It is simply not shown until you say so." |
| 4 | 0:19–0:27 | SCREEN: top bar. CURSOR clicks the Locked shield (0:20); the six-digit PIN dialog appears; dots fill; the timeline refreshes and Through the forest returns with a "Revealed for this session" chip. CALLOUT on the dialog note: hides again when you leave the tab or after one hour. | Revealed for this session | "Your PIN reveals it for this session. Leave the tab, or wait an hour, and it hides again on its own." |
| 5 | 0:27–0:33 | SCREEN: sidebar Library → Locked. Filter chips All, Marked, Detected. Tiles badged "Sensitive": Through the forest, Trailhead directions, two scanned pages. ZOOM on the filter chips. | Locked · All · Marked · Detected | "Locked lists everything hidden, with the reason: marked by you, or detected for you." |
| 6 | 0:33–0:41 | SCREEN: Settings → Search & intelligence, NSFW detection accordion: "Detect NSFW images" on, "Hide detected NSFW assets" off. Cut at 0:37 to an information card "Image enrichment" section on a landscape photo with the buttons Accept and Mark safe; CURSOR clicks "Mark safe". | Review before hiding | "Detection is optional. It runs on your server, and you review what it finds before anything is hidden automatically." |
| 7 | 0:41–0:49 | SCREEN: Settings → Access & security → "Locked tags & people". CURSOR types "documents" under tags and presses Enter; scope shows "My photos and videos". Cut at 0:46 to the timeline: the scanned pages are gone. | Locked tags & people | "Locked tags and people hide a whole subject at once, every scanned document, say, without touching photos one by one." |
| 8 | 0:49–0:57 | SPLIT: left, Jamie's partner view of Taylor's library; right, the public shared-link viewer for Summer in the Rockies. Neither shows Through the forest. CARD centre bottom "Never shown to" with bullets: Partners, Album members, Shared links. | Never shown to partners, members or links | "Partners, album members and shared links never see a locked item, whatever their own session." |
| 9 | 0:57–1:00 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

Some photos are yours alone. Select one, choose Mark Sensitive, and it leaves the timeline.

It has not moved. It keeps its albums, its tags and its place in time. It is simply not shown until you say so.

Your PIN reveals it for this session. Leave the tab, or wait an hour, and it hides again on its own.

Locked lists everything hidden, with the reason: marked by you, or detected for you.

[beat]

Detection is optional. It runs on your server, and you review what it finds before anything is hidden automatically.

Locked tags and people hide a whole subject at once, every scanned document, say, without touching photos one by one.

Partners, album members and shared links never see a locked item, whatever their own session.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- Sensitive examples are landscapes and documents only (STYLE-GUIDE.md section 6): Through the forest, Trailhead directions and two plain scanned pages. Nothing suggestive is ever shown.
- Taylor needs a PIN (Settings → Your preferences → PIN code) before capture. Unlocking is per session and the dialog states it hides again when you leave the tab or after one hour (integration inventory, Locked & privacy).
- Beat 2 and the viewer More menu use "Mark Sensitive" / "Unmark Sensitive" (the older "Move to Locked folder" wording is gone). locked.md: a lock is metadata; the item keeps albums, stacks, favorites, tags and its place in the timeline.
- Beat 5: the Locked view filter is All, Moved from old Locked folder, Marked and Detected, with tiles badged Locked or Sensitive. Only Marked and Detected are shown here; keep the "Moved from old Locked folder" chip out of the zoom on a fresh library.
- Beat 6: detection settings are "Detect NSFW images", "NSFW threshold" and "Hide detected NSFW assets" (image-enrichment.md). The rollout order in fork-privacy-suite.md is detect, review, then hide, which is what the narration says. Review buttons in the information card are Rerun, Accept, Mark NSFW and Mark safe. The docs place these under Administration → System Settings → Machine Learning; the integration build groups them in the Settings Command Center, expected under Search & intelligence. Confirm the area name on the capture build and correct the on-screen path if it differs.
- Beat 7: "Locked tags & people" lives in Settings → Access & security and now includes pets; scope is "My photos and videos" or "All photos and videos I can access". fork-privacy-suite.md still calls this "Suppressed content" under Account settings; use the current label.
- Beat 8: locked.md states partners, album and space members and shared links never see a locked item, whatever their own session, and that a partner's device that already had it is told to hide it. Detection is images only.
- Locking is not a security boundary (fork-privacy-suite.md); the narration does not call it encryption.
