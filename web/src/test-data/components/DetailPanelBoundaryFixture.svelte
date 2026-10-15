<script lang="ts">
  let {
    onFacesChanged,
    center,
    mapMarkers,
  }: {
    onFacesChanged?: () => Promise<void>;
    center?: { lat: number; lng: number };
    mapMarkers?: Array<{ id: string; lat: number; lon: number }>;
  } = $props();
</script>

{#if onFacesChanged}
  <button onclick={() => void onFacesChanged?.()}>Refresh people</button>
{/if}
{#if center}
  <output data-testid="map-input">{JSON.stringify({ center, mapMarkers })}</output>
{/if}
