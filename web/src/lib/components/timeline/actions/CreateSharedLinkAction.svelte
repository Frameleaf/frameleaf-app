<script lang="ts">
  import ShareSheet from '$lib/components/frameleaf/ShareSheet.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { IconButton } from '@immich/ui';
  import { mdiShareVariantOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  // FL-54: ShareSheet is a plain `bind:open` dialog rather than a `modalManager` modal, so
  // this component holds the open state itself. It reads the live selection.
  let shareSheetOpen = $state(false);

  const handleClick = () => {
    shareSheetOpen = true;
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

<ShareSheet bind:open={shareSheetOpen} assetIds={assetMultiSelectManager.assets.map(({ id }) => id)} />
