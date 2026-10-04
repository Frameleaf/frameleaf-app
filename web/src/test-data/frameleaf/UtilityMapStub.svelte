<script lang="ts">
  import { mapStub } from './utility-map-stub';

  let { mapMarkers = [], onViewChange }: { mapMarkers?: { id: string }[]; onViewChange?: () => void } = $props();
  $effect(() => {
    mapStub.viewChanged = () => onViewChange?.();
  });
  export const addClipMapMarker = () => {};
  export const zoomIn = () => {
    mapStub.calls.push('zoomIn');
  };
  export const zoomOut = () => {
    mapStub.calls.push('zoomOut');
  };
  export const centerOn = (lng: number, lat: number) => {
    mapStub.calls.push(`centerOn ${lng},${lat}`);
  };
  export const getCenter = () => mapStub.center;
  export const contains = () => mapStub.inside;
</script>

<div aria-label="Map"><output aria-label="Map markers">{mapMarkers.map((marker) => marker.id).join(',')}</output></div>
