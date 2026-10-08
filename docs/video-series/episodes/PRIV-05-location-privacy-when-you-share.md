# PRIV-05 · Location privacy when you share

| Field | Value |
| --- | --- |
| Series | Private by design |
| Type | How-to |
| Target length | 2:15 |
| Audience | Frameleaf users who share with partners or public links and want to keep where photos were taken to themselves |
| Features demonstrated | Share my location with this partner (per partner, with the already-seen note), what a hidden partner no longer gets (coordinates, place names, map markers, embedded location in downloaded originals), links and albums can't bring it back, Show metadata on shared links (no downloads without it, videos play without location), Edit location → Remove location with its confirmation, metadata file and Live Photo video cleared, Location editor for many photos |
| Source docs | docs/docs/features/partner-sharing.md, docs/docs/features/sharing.md |
| Capture checklist | Signed in as Taylor, dark theme. Jamie is a partner who can see Taylor's library and shares back, so the location toggle shows. Summer in the Rockies geotagged at Lake Louise and Banff; Cabin life geotagged with a Live Photo video. A second browser profile signed in as Jamie with the Map open. The Create shared link dialog for Summer in the Rockies. Settings → Utilities → Location editor with three photos selected. |

## Storyboard

| # | Time | Visual | On-screen text | Voice-over |
| --- | --- | --- | --- | --- |
| 1 | 0:00–0:03 | LOGO INTRO | — | (sting, no VO) |
| 2 | 0:03–0:13 | LOWER-THIRD "Location privacy when you share · Private by design"; SCREEN viewer on Emma at the lake; ZOOM on the information card's location "Lake Louise, Alberta" with its small map | Where it was taken | "A photo's location tells people where you were, and sometimes where you live. Frameleaf gives you three ways to keep it to yourself." |
| 3 | 0:13–0:30 | SCREEN Settings → People & sharing → "Partners & recipient groups" → "Partner libraries"; Jamie's row: "Can see your library · Shares with you"; HIGHLIGHT "Share my location with this partner" ("Applies to places recorded on the photos and videos you share with Jamie."); CURSOR turns it off; the note appears: "Jamie may already have seen locations on items shared before this was turned off." | Share my location with this partner | "First, partners. Open Settings, then People & sharing. Each partner who can see your library has Share my location with this partner. Turn it off for Jamie. Frameleaf notes that Jamie may already have seen earlier locations." |
| 4 | 0:30–0:46 | SPLIT: left, Jamie's view of Emma at the lake with the information card's location row gone; right, Jamie's Map with Taylor's markers gone; CARD strip below: "Coordinates · Place names · Map markers · Location inside downloaded originals" | What Jamie no longer gets | "From then on, your photos reach Jamie without coordinates or place names, and they are left off Jamie's map. An original Jamie downloads is a copy with the location removed, or nothing if that can't be guaranteed." |
| 5 | 0:46–0:58 | DIAGRAM: node "Your photo" (green) → node "Jamie's album" → nodes "Emma" and "Public link"; each arrow carries a struck-through pin icon as the VO names it | No way around it | "Jamie can't get it back another way. A link Jamie makes shows no more than Jamie sees, and in Jamie's albums your photos show no location to anyone." |
| 6 | 0:58–1:17 | SCREEN dialog "Create shared link" for Summer in the Rockies; ZOOM on "Show metadata" (off) with "Camera, exposure, capture time and location (EXIF)."; CURSOR tries "Allow download" and the note appears: "Originals contain their camera and location details, so turn on Show metadata to allow downloads."; the public page opened in a logged-out window plays Lake morning.mov with no details panel | Show metadata | "Second, shared links. With Show metadata off, a link shows no camera details, capture time or location. Originals carry all of that inside the file, so a link without metadata never offers downloads, and its videos play without their location." |
| 7 | 1:17–1:36 | SCREEN viewer on Cabin life (Live Photo badge); CURSOR clicks the location on the information card; dialog "Edit location" with City, State or region, Country, coordinates and the pin map; CURSOR clicks "Remove location"; confirmation "Remove location?" with "Its coordinates and place names are cleared, here and in its metadata file, and from its Live Photo video. The map and place searches no longer show it."; CURSOR confirms "Remove location" | Edit location → Remove location | "Third, remove a location for good. In the viewer, choose the location on the information card, then Remove location, and confirm. The coordinates and place names are cleared, here and in the photo's metadata file, and from a Live Photo's video too." |
| 8 | 1:36–1:50 | The card now reads "Add a location"; cut to the Map without Cabin life; cut to Settings → Utilities → "Location editor" with three photos selected and the action "Remove location from 3 selected" | Location editor | "The photo leaves the map and place searches. To clear many at once, the Location editor in Settings, Utilities, removes the location from a selection." |
| 9 | 1:50–2:12 | CARD headline "Keep locations to yourself"; bullets appear per clause: "Partners: Share my location with this partner", "Links: Show metadata off", "For good: Remove location" | Three controls | "In short: switch location off for each partner who shouldn't have it, keep Show metadata off on links you post widely, and remove a location that no one should ever see." |
| 10 | 2:12–2:15 | LOGO OUTRO | Next: CARE-01 · Library Care overview | "Next up: Library Care overview." |

## Voice-over (clean)

A photo's location tells people where you were, and sometimes where you live. Frameleaf gives you three ways to keep it to yourself.

[pause]

First, partners. Open Settings, then People & sharing. Each partner who can see your library has Share my location with this partner. Turn it off for Jamie. Frameleaf notes that Jamie may already have seen earlier locations.

From then on, your photos reach Jamie without coordinates or place names, and they are left off Jamie's map. An original Jamie downloads is a copy with the location removed, or nothing if that can't be guaranteed.

Jamie can't get it back another way. A link Jamie makes shows no more than Jamie sees, and in Jamie's albums your photos show no location to anyone.

[pause]

Second, shared links. With Show metadata off, a link shows no camera details, capture time or location. Originals carry all of that inside the file, so a link without metadata never offers downloads, and its videos play without their location.

[pause]

Third, remove a location for good. In the viewer, choose the location on the information card, then Remove location, and confirm. The coordinates and place names are cleared, here and in the photo's metadata file, and from a Live Photo's video too.

The photo leaves the map and place searches. To clear many at once, the Location editor in Settings, Utilities, removes the location from a selection.

[pause]

In short: switch location off for each partner who shouldn't have it, keep Show metadata off on links you post widely, and remove a location that no one should ever see.

Next up: Library Care overview.

## Production notes

- Labels verified in the build: Settings → People & sharing → "Partners & recipient groups" → "Partner libraries"; per partner "Can see your library" / "Shares with you", "Show shared photos in my timeline", "Share my location with this partner" with "Applies to places recorded on the photos and videos you share with {name}." and, when off, "{name} may already have seen locations on items shared before this was turned off."; the toggle shows only for a partner you share with. Shared-link form "Show metadata" ("Camera, exposure, capture time and location (EXIF).") and the download note in beat 6. Information card location button "Edit location" (owner only), dialog with "Remove location", confirmation "Remove location?" with the Live Photo variant quoted in beat 7; empty row "Add a location"; Utilities tool "Location editor" with "Remove location from {count} selected".
- What gets stripped (server partner-location policy): latitude, longitude, city, state and country are cleared on every read for the hidden partner; the partner's map omits the owner's items; originals the partner downloads are sent as a copy without embedded location, or refused when that can't be guaranteed. A link created by that partner inherits the partner's view, and an item reached through an album owned by a partner it is hidden from shows no location to anyone viewing through that album. A shared link with Show metadata off refuses original downloads and streams original videos without location.
- Doc vs build: partner-sharing.md still says partners get "all metadata, including GPS information" and describes older screens; the per-partner location toggle is newer and not in the docs (LIB-07 shows it too). sharing.md still shows the older link form; LIB-06 covers the current "Create shared link" dialog. reverse-geocoding.md says "An item's coordinates can be moved but not removed"; the current build has "Remove location" (owner decision, 25 September 2026). Narration follows the build; flag these docs for an update.
- The Location editor is under Settings → Utilities (it is not one of the Library Care hub's repair tools); CARE-06 demonstrates it in full.
- Locked items never reach partners or links at all (PRIV-02), so they are not part of this episode.
- Outro card: "Next: CARE-01 · Library Care overview" (first episode of the next series in the index).
