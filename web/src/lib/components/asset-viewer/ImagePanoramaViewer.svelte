<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetUrl } from '$lib/utils';
  import { AssetMediaSize, viewAsset, type AssetResponseDto } from '@frameleaf/sdk';
  import { LoadingSpinner } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';
  import { motionFade } from '$lib/frameleaf/motion';

  type Props = {
    asset: AssetResponseDto;
  };

  let { asset }: Props = $props();

  const assetId = $derived(asset.id);

  const adapter = import('./PhotoSphereViewerAdapter.svelte');
  let assetData = $state<Promise<string>>();
  $effect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    assetData = viewAsset(
      { ...authManager.params, id: assetId, size: AssetMediaSize.Preview },
      { signal: controller.signal },
    ).then((data) => {
      controller.signal.throwIfAborted();
      return (objectUrl = URL.createObjectURL(data));
    });
    return () => {
      controller.abort();
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  });
</script>

{#if assetData}
  {#key assetData}
    <div
      transition:motionFade={{ duration: 150 }}
      class="flex h-full place-content-center place-items-center select-none"
    >
      {#await Promise.all([assetData, adapter])}
        <LoadingSpinner />
      {:then [data, { default: PhotoSphereViewer }]}
        <PhotoSphereViewer panorama={data} originalPanorama={getAssetUrl({ asset, forceOriginal: true })} />
      {:catch}
        {$t('errors.failed_to_load_asset')}
      {/await}
    </div>
  {/key}
{/if}
