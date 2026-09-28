<script lang="ts">
  /**
   * The offline notice the viewer shows over the stage when an asset's original file is
   * no longer where the library recorded it (FL-35).
   *
   * "Relink" is the existing `Show in folder` action: it takes the owner to the folder the
   * original was last seen in, which is where a library path is repaired. Nothing here
   * rewrites a path by itself — the button is hidden when the action is unavailable
   * (a non-owner, folders switched off, or no recorded directory).
   */
  import { folderOf } from '$lib/frameleaf/viewer-headline';
  import { getAssetActions } from '$lib/services/asset.service';
  import { isEnabled } from '$lib/utils';
  import type { AssetResponseDto } from '@immich/sdk';
  import { Button, Icon } from '@immich/ui';
  import { mdiLinkOff } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
  };

  let { asset }: Props = $props();

  const { ShowInFolder } = $derived(getAssetActions($t, asset));
  const folder = $derived(folderOf(asset.originalPath));
</script>

<div
  class="dark pointer-events-auto mx-auto flex max-w-2xl items-center gap-3 rounded-lg bg-black/70 px-4 py-3 text-white"
  role="alert"
  data-testid="viewer-offline-banner"
>
  <Icon icon={mdiLinkOff} size="20" aria-hidden />
  <div class="min-w-0 flex-1">
    <strong class="block text-sm font-medium">{$t('frameleaf_viewer_offline_title')}</strong>
    <span class="block truncate text-xs text-white/70" title={asset.originalPath}>
      {folder ?? $t('frameleaf_viewer_offline_description')}
    </span>
  </div>
  {#if isEnabled(ShowInFolder)}
    <Button size="small" color="secondary" onclick={() => ShowInFolder.onAction(ShowInFolder)}>
      {$t('frameleaf_viewer_relink')}
    </Button>
  {/if}
</div>
