# LIB-13 · Tags and Folders

| Field | Value |
| --- | --- |
| Series | Your library |
| Type | How-to |
| Target length | 2:30 |
| Audience | People who organise with labels or who keep a curated folder structure on disk |
| Features demonstrated | Account Settings → Features (Enable tags, Show Tags in the sidebar, Enable folders, Show Folders in the sidebar), Tags page (tag tree with colour dots and counts, Find a tag, Expand all, Most used, breadcrumb, "including subtags" count, Show all), New tag and New subtag (Name, Parent tag, Colour), Rename, Change colour, More tag actions (Move to top level, Delete tag), tagging in the viewer (Add a tag, T, Tag suggestions, Create “…”), selection bar Tag dialog, XMP sidecar round trip (write on change, read from other tools), Job manager → Metadata sidecars (Discover sidecars, Synchronize all), Folders page (folder tree, Subfolders, Files in, Sort by Name / Date taken / Size, Show in timeline) |
| Source docs | docs/docs/features/tags.md, docs/docs/features/folder-view.md, docs/docs/features/xmp-sidecars.md |
| Capture checklist | Taylor signed in as administrator; tags created before capture: Trips → Rockies 2026 → Lake Louise and Banff (colour Teal), Family, Wildlife (Amber), Documents; about 120 Rockies items tagged; one sample original with a sidecar edited in another app for beat 9; storage template with the storage label "taylor" so folder paths read library / taylor / 2026 / 2026-08-14; Tags and Folders turned on in Features; dark theme |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:16 | LOWER-THIRD "Tags and Folders · Your library". SPLIT: left, the Tags page tree with coloured dots; right, the Folders page tree of year and day folders. | LOWER-THIRD; CALLOUT "Tags: labels you nest"; CALLOUT "Folders: originals as stored" | "Albums are one way to group photos. Tags and Folders are two more. Tags are labels you nest into a tree. Folders show your originals the way they are stored on disk." |
| 3 | 0:16–0:27 | SCREEN: Account Settings → Your preferences → Features. ZOOM on the rows "Enable tags" ("Organize assets with tags."), "Show Tags in the sidebar", "Enable folders" ("Browse the original folder hierarchy."), "Show Folders in the sidebar"; CURSOR turns each on; Tags and Folders appear in the sidebar. | CALLOUT "Features → Enable tags · Enable folders" | "If you do not see them, open Account Settings, then Features. Turn on Enable tags and Enable folders, and choose whether each shows in the sidebar." |
| 4 | 0:27–0:43 | SCREEN: Tags page, subtitle "12 tags · organise with nested tags such as trips / rockies-2026"; tree on the left with colour dots and counts; Find a tag, Expand all, New tag; right side "Choose a tag" with Most used. CURSOR clicks Rockies 2026: breadcrumb Tags › Trips › Rockies 2026; header "86 items · 120 including subtags"; preview thumbnails; button "Show all 120 items"; Subtags: Banff, Lake Louise. CURSOR clicks Show all; the library opens filtered to the tag. | CALLOUT "Tag tree"; CALLOUT "86 items · 120 including subtags"; CALLOUT "Show all" | "The Tags page shows every tag as a tree, with a count beside each. Choose one to see a preview. The path runs along the top, the count includes its subtags, and Show all opens those items in your library." |
| 5 | 0:43–0:58 | CURSOR clicks New tag; dialog "New tag" with Name, Parent tag (menu opens: "None (top level)", Trips, Trips / Rockies 2026) and Colour swatches; CURSOR types "Moraine Lake", picks Trips / Rockies 2026 and Teal, clicks Create; status "Tag Moraine Lake created."; the node appears under Rockies 2026. Inset: More tag actions → New subtag. | CALLOUT "Name · Parent tag · Colour"; CALLOUT "New subtag" | "Choose New tag, give it a name, and pick a Parent tag to nest it, or None for the top level. Pick a colour and choose Create. From a tag's menu, New subtag nests one straight inside." |
| 6 | 0:58–1:15 | CURSOR clicks Rename; dialog "Rename tag"; types "Rockies 2026 trip"; Save; status "Renamed to Rockies 2026 trip.". CURSOR opens Change colour, picks Green; status "Colour changed to Green.". CURSOR opens More tag actions: New subtag, Move to top level, Delete tag; picks Delete tag; dialog "Delete Trips / Rockies 2026 trip and its 3 subtags?" with "120 items will lose this tag but stay in your library."; cancel. | CALLOUT "Rename · Change colour"; CALLOUT "Move to top level · Delete tag" | "Rename changes a tag everywhere it is used. The colour menu recolours it. More tag actions can move a tag to the top level or delete it. Deleting removes the tag from its items, and the items stay in your library." |
| 7 | 1:15–1:33 | SCREEN: viewer on "Moraine Lake", information card open; CURSOR presses T; the Tags box "Add a tag" takes focus; typing "mo" lists Tag suggestions with the full path "Trips/Rockies 2026 trip/Moraine Lake" and "Create “moose”"; CURSOR picks the first; toast "Tag added". Cut to Library with 12 items selected; selection bar More → Tag; dialog "Tag" with "Add tags", "Type to search tags", Tag suggestions, Chosen tags; button "Tag 12 items". | CALLOUT "T · Add a tag"; CALLOUT "Tag suggestions"; CALLOUT "Tag 12 items" | "To tag a photo, open it and press T, or choose Add a tag. Tag suggestions list your tags as you type, and you can create a new one on the spot. For many items, select them, choose Tag, and confirm." |
| 8 | 1:33–1:51 | DIAGRAM: node "Frameleaf" with a green arrow to a file pair "IMG_0412.jpg" and "IMG_0412.jpg.xmp"; the arrow label reads "tags written to the sidecar"; the .jpg node shows a lock icon "original unchanged". A teal arrow returns from nodes "Lightroom" and "digiKam" into the .xmp, then into Frameleaf, labelled "read back". | DIAGRAM labels "IMG_0412.jpg.xmp"; "Original unchanged" | "Tags travel with your files. When you tag an item, Frameleaf writes the tag into an .xmp sidecar beside the original, and never changes the original itself. Tags written by Lightroom, digiKam and similar tools are read in the same way." |
| 9 | 1:51–2:06 | SCREEN: Settings → Compute & jobs → Job manager; ZOOM on the queue "Metadata sidecars" ("Discover sidecars or synchronize their metadata."); CURSOR selects the row; its detail shows Pause, Discover sidecars and Synchronize all; CURSOR clicks Synchronize all. CALLOUT on a read-only external library: "Read-only mount: tag changes are not saved". | CALLOUT "Metadata sidecars"; CALLOUT "Discover sidecars · Synchronize all" | "If you edit tags in another app later, an administrator opens Compute and jobs, then Job manager. Under Metadata sidecars, Discover sidecars finds new .xmp files, and Synchronize all reads existing ones again." |
| 10 | 2:06–2:23 | SCREEN: Folders page, subtitle "Browse originals the way they are stored on disk."; tree All folders › library › taylor › 2026 › 2026-08-14 with file counts and sizes; right side "Subfolders" and "Files in 2026-08-14"; CURSOR opens Sort: Name, Date taken, Size; picks Size. CURSOR clicks Show in timeline; status "Showing 2026-08-14 in the timeline." | CALLOUT "Folder tree"; CALLOUT "Sort: Name · Date taken · Size"; CALLOUT "Show in timeline" | "Folders shows your originals the way they are stored on disk, as a tree with file counts and sizes. Open a folder to see its files, sort them by Name, Date taken or Size, or choose Show in timeline. Nothing here moves or renames a file." |
| 11 | 2:23–2:27 | CARD "Tags and Folders": bullet 1 "Tags describe"; bullet 2 "Folders locate"; bullet 3 "Originals stay untouched". | CARD | "Tags describe, folders locate, and neither touches your originals." |
| 12 | 2:27–2:30 | LOGO OUTRO | Next: LIB-14 · Memories and slideshows | "Next up: Memories and slideshows." |

## Voice-over (clean)

Albums are one way to group photos. Tags and Folders are two more. Tags are labels you nest into a tree. Folders show your originals the way they are stored on disk.

If you do not see them, open Account Settings, then Features. Turn on Enable tags and Enable folders, and choose whether each shows in the sidebar.

The Tags page shows every tag as a tree, with a count beside each. Choose one to see a preview. The path runs along the top, the count includes its subtags, and Show all opens those items in your library.

Choose New tag, give it a name, and pick a Parent tag to nest it, or None for the top level. Pick a colour and choose Create. From a tag's menu, New subtag nests one straight inside.

Rename changes a tag everywhere it is used. The colour menu recolours it. More tag actions can move a tag to the top level or delete it. Deleting removes the tag from its items, and the items stay in your library.

To tag a photo, open it and press T, or choose Add a tag. Tag suggestions list your tags as you type, and you can create a new one on the spot. For many items, select them, choose Tag, and confirm.

Tags travel with your files. When you tag an item, Frameleaf writes the tag into an .xmp sidecar beside the original, and never changes the original itself. Tags written by Lightroom, digiKam and similar tools are read in the same way.

If you edit tags in another app later, an administrator opens Compute and jobs, then Job manager. Under Metadata sidecars, Discover sidecars finds new .xmp files, and Synchronize all reads existing ones again.

Folders shows your originals the way they are stored on disk, as a tree with file counts and sizes. Open a folder to see its files, sort them by Name, Date taken or Size, or choose Show in timeline. Nothing here moves or renames a file.

Tags describe, folders locate, and neither touches your originals.

Next up: Memories and slideshows.

## Production notes

- Interface vs docs: tags.md and folder-view.md name the old toggles "Account Settings > Features > Tags" and "> Folders". The current Features section (under Your preferences) has "Enable tags", "Show Tags in the sidebar", "Enable folders" and "Show Folders in the sidebar". tags.md creates tags with a "+ Add" button in the info panel; the current information card uses the "Add a tag" box (T focuses it) with "Tag suggestions" and "Create “{name}”". Narration follows the current interface; flag both docs for an update.
- "Tag suggestions" here is the list of your own tags as you type (viewer and the selection bar's Tag dialog); on screen it is an unlabelled drop-down of up to eight tags plus "Create “…”". There is no accept or dismiss step. Model-generated tags ("Suggest tags with the search model") are applied automatically under an "auto/" parent tag and belong to the AI series; keep them out of this capture.
- The Features toggles control the sidebar entries and the information card's Tags box; the Tags and Folders pages still open by address when they are off.
- The Tags page moves a tag only to the top level ("Move to top level"); nesting under another parent happens when the tag is created ("Parent tag") or with "New subtag". Tag names cannot contain slashes on this page ("Give the tag a name without slashes."). Colours offered: Grey, Green, Teal, Blue, Purple, Pink, Amber, Red.
- Tag and folder counts cover timeline items only, so archived, Locked and hidden items are not counted or listed.
- xmp-sidecars.md: Frameleaf writes tags to `digiKam:TagsList` and reads, in order, `digiKam:TagsList`, `lr:HierarchicalSubject` and `IPTC:Keywords`; a Sidecar Write job is queued automatically after a tag, rating or description change. The doc's admin jobs `DISCOVER` and `SYNC` appear in the Job manager as the "Metadata sidecars" queue with the actions "Discover sidecars" and "Synchronize all". The job names in Activity are "Write a metadata sidecar" and "Find metadata sidecars".
- Doc warning, shown as a callout in beat 9 rather than narrated: on a read-only external library mount, metadata edits "silently fail", so neither the sidecar nor the database is updated. Tag only in libraries Frameleaf can write to.
- Verify on a running build before capture: renaming or moving a tag appears not to rewrite existing .xmp files until each item is tagged again (read from code, not tested). Beat 8 therefore shows tagging an item, not renaming, as the write example. The Metadata queue's "Run missing" / "Reprocess all" is what imports tags from files that were never read.
- Beat 9 needs an administrator session; ordinary users do not see the Job manager.
- Beat 6's delete dialog is cancelled; no tag is deleted during capture.
- Keep the sample path readable (storage label "taylor"); never show a real server path.