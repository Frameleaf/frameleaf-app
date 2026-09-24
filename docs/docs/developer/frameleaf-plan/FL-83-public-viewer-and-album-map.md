# FL-83 public viewer and album map placements

Placements and decisions for the public shared-link viewer (FL-83, FL-56) and the album-scoped map (FL-51) that the September 22 prototype does not draw. `design/frameleaf/template/src/PublicViewer.jsx` and `MapView.jsx` remain authoritative for everything they do draw.

## Public shared-link viewer

- **Slideshow.** A shared link's viewer has no More menu, so its slideshow (`action:viewer:slideshow-play-pause-previous-next-repeat-shuffle`, entry point `route:/share/[key]/[[photos=photos]]/[[assetId=id]]`) is the Play slideshow button in the viewer bar (`AssetViewerNavBar.svelte`). It keeps the old public header's gate: only when the link allows downloads, and only when there is another item to move to. Signed-in library viewers keep it in the More menu. The preservation ledger row has no placement field (its new-UI target is generated from the source audit), so the placement is recorded here.
