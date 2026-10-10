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

  const loadAssetData = async (id: string) => {
    const data = await viewAsset({ ...authManager.params, id, size: AssetMediaSize.Preview });
    return URL.createObjectURL(data);
  };
</script>

<div transition:motionFade={{ duration: 150 }} class="flex h-full place-content-center place-items-center select-none">
  {#await Promise.all([loadAssetData(assetId), import('./PhotoSphereViewerAdapter.svelte')])}
    <LoadingSpinner />
  {:then [data, { default: PhotoSphereViewer }]}
    <PhotoSphereViewer panorama={data} originalPanorama={getAssetUrl({ asset, forceOriginal: true })} />
  {:catch}
    {$t('errors.failed_to_load_asset')}
  {/await}
</div>
