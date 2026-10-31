<script lang="ts">
  import DragDropUploadOverlay from '../DragDropUploadOverlay.svelte';
  import { createDropUploadContext } from '$lib/stores/drag-and-drop-files.store';
  import { onDestroy } from 'svelte';

  const { receive }: { receive: (files: File[]) => void } = $props();
  const channel = createDropUploadContext();
  onDestroy(channel.register(receive));
</script>

<DragDropUploadOverlay />
