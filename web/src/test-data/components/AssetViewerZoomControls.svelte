<script lang="ts">
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
</script>

<button type="button" disabled={!assetViewerManager.canZoomIn()}>Zoom in</button>
<button type="button" disabled={!assetViewerManager.canZoomOut()}>Zoom out</button>
