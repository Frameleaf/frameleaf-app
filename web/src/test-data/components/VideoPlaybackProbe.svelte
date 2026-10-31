<script lang="ts">
  let { playOriginalVideo }: { playOriginalVideo: boolean } = $props();
</script>

<div data-testid="video-source" data-original={playOriginalVideo}></div>
