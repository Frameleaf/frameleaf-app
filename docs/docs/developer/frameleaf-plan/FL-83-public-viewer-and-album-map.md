# FL-83 public viewer and album map placements

Placements and decisions for the public shared-link viewer (FL-83, FL-56) and the album-scoped map (FL-51) that the September 22 prototype does not draw. `design/frameleaf/template/src/PublicViewer.jsx` and `MapView.jsx` remain authoritative for everything they do draw.

## Public shared-link viewer

- **Slideshow.** A shared link's viewer has no More menu, so its slideshow (`action:viewer:slideshow-play-pause-previous-next-repeat-shuffle`, entry point `route:/share/[key]/[[photos=photos]]/[[assetId=id]]`) is the Play slideshow button in the viewer bar (`AssetViewerNavBar.svelte`). It keeps the old public header's gate: only when the link allows downloads, and only when there is another item to move to. Signed-in library viewers keep it in the More menu. The preservation ledger row has no placement field (its new-UI target is generated from the source audit), so the placement is recorded here.
- **Public album map.** The old public album page had a map (`AlbumMap`, shown when the link allowed metadata). `PublicViewer.jsx` has no map, so it went with the old header rather than being carried over. `GET /albums/{id}/map-markers` still answers a shared link that shows metadata, and the owner's own album keeps its Map action (`/map?albumId=`). Restoring a public map would be a product decision, not a parity gap.

## Album-scoped map (FL-51)

`/map?albumId=` is the same Map screen as the library's (prototype `setMapScope("collection")`), with "Search this area" and the settings sheet. "Search this area" opens the viewer's own Library over the visible bounds, as in the prototype.

- `GET /albums/{id}/map-markers` takes the sheet's optional query filters `isArchived`, `isFavorite`, `fileCreatedAfter`, `fileCreatedBefore`, `withPartners` and `withSharedAlbums` (`AlbumMapMarkerDto`). Each only narrows the album's own markers after the existing `AlbumRead` check and the album's hidden and Locked filtering. Omitted filters return the same markers as before, so the album header, the shared-space map and older clients are unchanged.
- `isArchived=false` leaves archived items out; an album otherwise shows them. `isFavorite` matches only the viewer's own favorites, because a favorite is private to its owner.
- The library map's `withPartners` and `withSharedAlbums` add other people's items; in an album they subtract, as the prototype's switches do: `withPartners=false` leaves out the album's items owned by the viewer's partners, and `withSharedAlbums=false` leaves out those owned by other members who are not partners. The viewer's own items always stay.
- A shared link's request ignores every filter, so its visitors cannot learn which items the link owner favorited or who the owner's partners are.
- Both scopes use the prototype's single empty state ("No located items match these settings").
