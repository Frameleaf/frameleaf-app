<script lang="ts">
  import ShareSheet from '$lib/components/frameleaf/ShareSheet.svelte';
  import { frameleafShell } from '$lib/frameleaf/rollout';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import SharedLinkCreateModal from '$lib/modals/SharedLinkCreateModal.svelte';
  import { IconButton, modalManager } from '@immich/ui';
  import { mdiShareVariantOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // Frameleaf shell rollout (FL-30/FL-54): ShareSheet is a plain `bind:open` dialog rather
  // than a `modalManager` modal, so this component holds the open state itself instead of
  // awaiting `modalManager.show`. Both branches read the same live selection.
  let shareSheetOpen = $state(false);

  const handleClick = async () => {
    if ($frameleafShell) {
      shareSheetOpen = true;
      return;
    }
    await modalManager.show(SharedLinkCreateModal, { assetIds: assetMultiSelectManager.assets.map(({ id }) => id) });
  };
</script>

<IconButton
  shape="round"
  color="secondary"
  variant="ghost"
  aria-label={$t('share')}
  icon={mdiShareVariantOutline}
  onclick={handleClick}
/>

{#if $frameleafShell}
  <ShareSheet bind:open={shareSheetOpen} assetIds={assetMultiSelectManager.assets.map(({ id }) => id)} />
{/if}
