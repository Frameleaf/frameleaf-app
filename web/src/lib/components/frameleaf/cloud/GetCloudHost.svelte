<script lang="ts">
  /** FL-544: renders the Get Frameleaf Cloud sheet whenever a gate asked for it. Mounted once per layout. */
  import GetCloudSheet from '$lib/components/frameleaf/cloud/GetCloudSheet.svelte';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
</script>

{#if getCloudManager.request}
  {@const request = getCloudManager.request}
  <GetCloudSheet feature={request.feature} onDone={request.onDone} close={() => getCloudManager.close()} />
{/if}
