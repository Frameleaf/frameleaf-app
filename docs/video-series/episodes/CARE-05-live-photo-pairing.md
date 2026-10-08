# CARE-05 · Live Photo pairing

| Field | Value |
| --- | --- |
| Series | Library Care |
| Type | How-to |
| Target length | 2:00 |
| Audience | Anyone whose Live Photos arrived as a separate still and video |
| Features demonstrated | Live Photo pairing (Live Photo pairs repair entry), confident matches (Matched by identifier) vs review matches (Matched by filename and time), Inspect evidence (Still image, Motion video, Confidence, Evidence), Relink one pair (Review pair, Review Live Photo pairs, Confirm), Relink all confident (Link high-confidence pairs), Linked badge |
| Source docs | README.md (Live Photo Relinking), docs/docs/guides/icloud-photos-sync.md |
| Capture checklist | Dark theme, Taylor signed in on frameleaf.home. Six separated pairs in Taylor's library: four with the Apple identifier intact (Lake reflection, Moraine Lake, Emma at the lake, Glacier creek, each a `.HEIC` still and a `.MOV`), two with metadata stripped and matching names within two seconds (`Cabin at dusk.jpg` / `Cabin at dusk.mp4`, `Campfire evening.jpg` / `Campfire evening.mp4`). Timeline scrolled to Lake reflection showing the still and the video as two tiles. Library care setting "Suggest Live Photo relinking" on. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:17 | LOWER-THIRD "Live Photo pairing · Library Care". SCREEN: timeline with `Lake reflection` as two tiles side by side, a still and a video with its duration badge. CALLOUT "One moment, two items". Cut to Settings → Library care, Repair queues; HIGHLIGHT "Live Photo pairs" ("Pair photos with their motion clips"). | Library care → Live Photo pairs | "A Live Photo is a still and a short video that belong together. Imported from a backup or another app, they can arrive as two separate items. Live Photo pairing puts them back together." |
| 3 | 0:17–0:30 | CURSOR clicks "Live Photo pairs". Utilities → Live Photo pairing: subtitle "Reconnect photos with their motion clips using matching evidence."; toolbar Account, Find items, Show; counter "6 candidate pairs"; a list of cards, each with the still, the video thumbnail with a play icon, filenames and owner. | Live Photo pairing · 6 candidate pairs | "Open Library Care, then Live Photo pairs, or find Live Photo pairing under Utilities. Every account can use it. It lists candidate pairs, each with the still and its video." |
| 4 | 0:30–0:47 | ZOOM on two cards. First: `Lake reflection.HEIC` / `Lake reflection.MOV · Taylor`, evidence "Matched on the embedded live photo identifier", badge "Matched by identifier". Second: `Cabin at dusk.jpg` / `Cabin at dusk.mp4 · Taylor`, evidence "Matched on filename and capture time", amber badge "Matched by filename and time". | Matched by identifier · Matched by filename and time | "Each pair says how it was matched. Matched by identifier means both files carry the identifier Apple writes into a Live Photo, so the match is exact. Matched by filename and time is a best guess for files whose metadata was stripped." |
| 5 | 0:47–1:03 | CURSOR clicks "Inspect" on Cabin at dusk. Dialog with "Still image" and "Motion video" side by side; CURSOR plays the video. Below: "Confidence · Matched by filename and time", "Evidence · Matched on filename and capture time". CURSOR clicks "Done". | Inspect · Still image · Motion video | "Inspect shows the still and plays the motion video next to it, with the confidence and the evidence. Use it on every lower-confidence pair before you link it." |
| 6 | 1:03–1:19 | CURSOR clicks "Review pair" on Cabin at dusk. Dialog "Review Live Photo pairs": "The pairs below are fixed for this operation. Changing the account or search afterward will not add more.", the row with the warning "This pairing is uncertain. Check the filename and capture time before linking.", note "Original files and ownership are retained; only the video is hidden as the still's motion clip." CURSOR clicks "Confirm 1 pair"; the card shows the "Processing" loader, then the badge "Linked". | Review pair · Confirm 1 pair · Linked | "To relink one pair, choose Review pair, read the warning if it is uncertain, and confirm. The original files stay; only the video is hidden as the still's motion clip." |
| 7 | 1:19–1:34 | HIGHLIGHT "Link high-confidence pairs" in the toolbar, CURSOR clicks. The review dialog lists the four identifier matches; CURSOR clicks "Confirm 4 pairs". Four cards show loaders, then "Linked". Campfire evening (filename and time) is untouched. | Link high-confidence pairs · Confirm 4 pairs | "To relink every confident match at once, choose Link high-confidence pairs, check the list and confirm. Lower-confidence pairs are never included; they wait for you." |
| 8 | 1:34–1:46 | SCREEN: timeline; Lake reflection is one tile with the Live Photo badge; the viewer plays its motion. Back in the tool, Show switched to "All results": the linked pairs are listed with the "Linked" badge. | One Live Photo again · Show: All results | "The pair becomes one playable Live Photo again, just as if it had been uploaded intact. Show All results to see what you linked." |
| 9 | 1:46–1:57 | CARD "Good to know": bullets "The optional audio track is not carried", "iCloud Photos imports link their own Live Photos". | Good to know | "The separate audio track some Live Photos include is not carried over. Live Photos imported through iCloud Photos are linked by the import itself." |
| 10 | 1:57–2:00 | LOGO OUTRO | Next: CARE-06 · Large files and the location editor | "Next up: Large files and the location editor." |

## Voice-over (clean)

A Live Photo is a still and a short video that belong together. Imported from a backup or another app, they can arrive as two separate items. Live Photo pairing puts them back together.

Open Library Care, then Live Photo pairs, or find Live Photo pairing under Utilities. Every account can use it. It lists candidate pairs, each with the still and its video.

Each pair says how it was matched. Matched by identifier means both files carry the identifier Apple writes into a Live Photo, so the match is exact. Matched by filename and time is a best guess for files whose metadata was stripped.

Inspect shows the still and plays the motion video next to it, with the confidence and the evidence. Use it on every lower-confidence pair before you link it.

To relink one pair, choose Review pair, read the warning if it is uncertain, and confirm. The original files stay; only the video is hidden as the still's motion clip.

To relink every confident match at once, choose Link high-confidence pairs, check the list and confirm. Lower-confidence pairs are never included; they wait for you.

The pair becomes one playable Live Photo again, just as if it had been uploaded intact. Show All results to see what you linked.

[beat]

The separate audio track some Live Photos include is not carried over. Live Photos imported through iCloud Photos are linked by the import itself.

[pause]

Next up: Large files and the location editor.

## Production notes

- Docs vs interface: README.md calls the tool "Utilities → Relink live photos", and icloud-photos-sync.md says "Utilities → Relink live photos"; the current name is "Live Photo pairing" (Library care repair entry "Live Photo pairs"). The index lists the actions "Relink" and "Relink all confident"; those strings ("Relink", "Relink all confident ({count})") remain in the translations, but the current tool shows "Review pair" for one pair and "Link high-confidence pairs" for every identifier match in view, both confirmed in the "Review Live Photo pairs" dialog ("Confirm {n} pairs"). Narration uses the current labels while describing both actions as relinking.
- Matching (server source): the identifier match is "Matched on the embedded live photo identifier" (high confidence); the fallback pairs a still and a video with the same base filename whose capture times are within two seconds, "Matched on filename and capture time" (low confidence). Up to 200 candidate pairs are listed. Only pairs where both files are yours can be reviewed.
- README.md: relinking hides the standalone video and restores the playable Live Photo "just as if it had been uploaded intact"; the optional AAC audio track is not part of the reassembled pair.
- For iCloud Photos imports, the import links still and movie itself using Apple source identities (icloud-photos-sync.md); an ambiguous pair from iCloud appears in the iCloud Photos reconciliation with a "Review" button that opens this tool.
- If the Library care setting "Suggest Live Photo relinking" is off, the tool shows "Live Photo suggestions are turned off in Library care settings." and lists nothing. Administrators set it in Library care → Repair queues.
- Large selections are queued as a background job with one automatic retry and per-card loaders; a pair the server refuses (already changed, deleted or claimed by another pair) stays in the list with "Could not complete: {reason}".
- Seed data: export the sample Live Photos as separate files; strip metadata from the two low-confidence pairs and keep their capture times within two seconds. File names are sample data.
