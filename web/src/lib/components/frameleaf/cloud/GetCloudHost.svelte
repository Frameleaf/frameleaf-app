<script lang="ts">
  /**
   * FL-544: renders the Get Frameleaf Cloud sheet whenever a gate asked for it. Mounted once per layout,
   * so the sheet is loaded on demand to keep it out of every signed-in route's up-front bundle.
   */
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
</script>

{#if getCloudManager.request}
  {@const request = getCloudManager.request}
  {#key request}
    {#await import('$lib/components/frameleaf/cloud/GetCloudSheet.svelte') then { default: GetCloudSheet }}
      <GetCloudSheet
        feature={request.feature}
        onDone={request.onDone}
        topUpUrl={request.topUpUrl}
        close={() => getCloudManager.close()}
      />
    {/await}
  {/key}
{/if}
