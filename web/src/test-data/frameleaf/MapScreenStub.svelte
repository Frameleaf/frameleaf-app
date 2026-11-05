<script lang="ts">
  import { mapRouteStub } from './map-route-stub';

  // Stands in for `MapScreen`: records how the route opens an item.
  let { onOpenAsset }: { onOpenAsset: NonNullable<typeof mapRouteStub.open> } = $props();
  mapRouteStub.open = onOpenAsset;
</script>
