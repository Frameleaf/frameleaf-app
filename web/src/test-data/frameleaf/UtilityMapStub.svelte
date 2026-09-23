<script lang="ts">
  let { mapMarkers = [] }: { mapMarkers?: { id: string }[] } = $props();
  export const addClipMapMarker = () => {};
</script>

<div aria-label="Map"><output aria-label="Map markers">{mapMarkers.map((marker) => marker.id).join(',')}</output></div>
