<script lang="ts">
  let { panorama, originalPanorama }: { panorama: { source: string }; originalPanorama?: { source: string } } =
    $props();
</script>

<div data-testid="panorama" data-source={panorama.source} data-original={originalPanorama?.source ?? ''}></div>
