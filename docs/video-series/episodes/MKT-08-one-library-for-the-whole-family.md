# MKT-08 · One library for the whole family

| Field | Value |
| --- | --- |
| Series | Meet Frameleaf |
| Type | Marketing |
| Target length | 1:15 |
| Audience | Households where several people take photos and want one place for them without giving up their own accounts |
| Features demonstrated | User accounts with quotas, shared spaces (new items since last visit, comments), partner libraries with Show in timeline and location privacy, collections, physical deduplication (Prepare preview plan, Apply reviewed plan), shared links |
| Source docs | docs/docs/features/sharing.md, docs/docs/features/partner-sharing.md, docs/docs/features/physical-deduplication.md |
| Capture checklist | Dark theme; Settings → Users listing Taylor (administrator), Jamie and Emma with quotas; shared space Family with a "new items since your last visit" banner and a comment thread; Settings → Your preferences → Partner sharing with Jamie added and Show in timeline on; Jamie's partner library page with the location privacy toggle; Albums page with the collection Family holding Summer in the Rockies, Winter 2026 and Everyday; Settings → Storage & originals → Physical deduplication with a prepared preview plan; the Create link to share form on Summer in the Rockies |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:14 | LOWER-THIRD "One library for the whole family · Meet Frameleaf". SCREEN: Settings → Users. Rows Taylor (administrator), Jamie, Emma, each with a storage meter and quota. HIGHLIGHT rings each row as the VO names them. ZOOM on Emma's quota field. | Users | "One server, one library for everyone in the house. Taylor, Jamie and Emma each get an account, a timeline and a space limit of their own." |
| 3 | 0:14–0:24 | SCREEN: sidebar Shared spaces → Family. Banner "12 new items since your last visit"; grid with Emma at the lake, Family hike, Campfire evening. CURSOR opens the activity panel; a comment from Jamie reads "@Taylor look at Max in this one"; the @Taylor mention is highlighted. | Family · 12 new items | "A shared space is the library you build together. Everyone invited adds to it, sees what is new since their last visit, and can comment." |
| 4 | 0:24–0:35 | SCREEN: Settings → Your preferences → Partner sharing. CURSOR clicks "Add partner", picks Jamie (0:26). The sidebar gains "Jamie's library". CURSOR turns on "Show in timeline" (0:29); the timeline reflows with Jamie's photos marked by a small avatar. Cut at 0:32 to Jamie's partner library header; CURSOR flips the location privacy toggle; toast "Locations are now hidden from Jamie". | Show in timeline | "Partners go further. Share your whole library with Jamie, and Jamie's photos can sit in your timeline as if they were your own, with or without their locations." |
| 5 | 0:35–0:44 | SCREEN: Albums page. A shelf "Family" (collection) with the albums Summer in the Rockies, Winter 2026 and Everyday inside it. CURSOR drags Winter 2026 from the loose albums into the Family shelf (0:38); breadcrumb "Family ▸ Winter 2026" appears when it is opened. | Collections | "Collections group albums the way your family thinks. Family holds Summer in the Rockies, Winter 2026 and Everyday, one level deep." |
| 6 | 0:44–0:54 | SPLIT for 4 s: left, Taylor's Moraine Lake tile; right, Jamie's identical Moraine Lake tile; a teal line joins both to one file icon labelled "one copy on disk". Cut at 0:48 to SCREEN: Settings → Storage & originals → Physical deduplication. CURSOR clicks "Prepare preview plan"; the plan PD-1A2B3C4D lists groups with "Share this original in the plan" ticked; footer "Reclaimable 38.2 GB". CURSOR hovers "Mark plan reviewed". | Prepare preview plan | "When two people upload the same photo, physical deduplication keeps one copy on disk, and both still own it. Preview the plan, then apply it." |
| 7 | 0:54–1:01 | SCREEN: album Summer in the Rockies, share icon, the "Create link to share" form: Password set, Expire after 30 days, "Allow public user to download" on. CURSOR clicks "Create link"; the link appears with a QR code. | Create link to share | "For the grandparents, a shared link, with a password, an expiry date and your say on downloads." |
| 8 | 1:01–1:08 | CARD "Everyone keeps their own" with bullets per clause: "Account", "Albums and favorites", "Locked photos". | Everyone keeps their own | "Everyone keeps their own account, albums, favorites and locked photos. Sharing is always something you choose." |
| 9 | 1:08–1:12 | TITLE on the dark canvas over Family hike dimmed to 40%. | One library for the whole family. | "One library for the whole family." |
| 10 | 1:12–1:15 | LOGO OUTRO with the tagline lockup; the leaf sways 4° once. | YOUR MEMORIES GROW FURTHER | "Frameleaf. Your memories grow further." |

## Voice-over (clean)

One server, one library for everyone in the house. Taylor, Jamie and Emma each get an account, a timeline and a space limit of their own.

A shared space is the library you build together. Everyone invited adds to it, sees what is new since their last visit, and can comment.

Partners go further. Share your whole library with Jamie, and Jamie's photos can sit in your timeline as if they were your own, with or without their locations.

[beat]

Collections group albums the way your family thinks. Family holds Summer in the Rockies, Winter 2026 and Everyday, one level deep.

When two people upload the same photo, physical deduplication keeps one copy on disk, and both still own it. Preview the plan, then apply it.

For the grandparents, a shared link, with a password, an expiry date and your say on downloads.

[pause]

Everyone keeps their own account, albums, favorites and locked photos. Sharing is always something you choose.

[beat]

One library for the whole family.

[beat]

Frameleaf. Your memories grow further.

## Production notes

- Beat 2: accounts and quotas are set in Settings → Users → "Create account" with a quota in GiB (user-management.mdx); external libraries do not count. Show sample meters only.
- Beat 3 labels are from the integration inventory (Sharing): shared spaces are top-level libraries everyone invited adds to, with roles, an activity feed, comments with @mentions and "N new items since your last visit". sharing.md documents only shared albums and public links; the shared space is the current build's feature. Seed the Family space with Jamie's comment.
- Beat 4: partner-sharing.md: a partner sees all non-archived photos and videos with their metadata; "Show in timeline" is per partner. The per-partner location privacy toggle and its toast "Locations are now hidden from {name}" are from the integration inventory (location is stripped from originals and archives sent to that partner). Partner sharing is one-way; Jamie must add Taylor separately to share back. The doc's path "Account Settings > Partner Sharing" is now Settings → Your preferences → Partner sharing.
- Beat 5: collections contain albums one level deep (integration inventory, Albums); the README's "nest albums to any depth" is out of date. Drag an album onto the collection shelf to move it; breadcrumbs show "Family ▸ Winter 2026".
- Beat 6: physical-deduplication.md. Before the preview, an administrator enables physical deduplication and saves the retained account under Storage Template. Flow: "Prepare preview plan" (background scan, no file changes) → per group "Share this original in the plan" → "Mark plan reviewed" → "Apply reviewed plan" (type APPLY and the plan name) → Review history. Plan names look like PD-1A2B3C4D. The doc's "Administration > Physical deduplication" path is now Settings → Storage & originals. Do not show the APPLY confirmation in a marketing cut; the narration says "then apply it" without demonstrating it. Reclaimable bytes on screen are sample data.
- Physical deduplication shares only the stored bytes; each account keeps its own asset, albums, favorites, permissions and Locked state, which is what beat 8 restates.
- Beat 7 form labels are from sharing.md: "Create link to share" with Custom URL, Password, Description, Expire after, "Show metadata", "Allow public user to download", "Allow public user to upload", then "Create link". The public address is random; do not type a real domain on screen.
- Locked items are never shown to partners, space members or shared links (locked.md), which supports "locked photos" in beat 8.
