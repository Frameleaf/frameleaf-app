<script lang="ts">
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { mdiClose } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import ArchiveOperationsModal from '$lib/modals/ArchiveOperationsModal.svelte';
  import { Button, modalManager } from '@immich/ui';

  type Props = {
    children?: Snippet;
  };

  let { children }: Props = $props();

  const onClose = () => assetMultiSelectManager.clear();

  const assets = $derived(assetMultiSelectManager.assets);
</script>

<ControlAppBar {onClose} backIcon={mdiClose}>
  {#snippet leading()}
    <div class="font-medium text-primary">
      <p class="block sm:hidden">{assets.length}</p>
      <p class="hidden sm:block">{$t('selected_count', { values: { count: assets.length } })}</p>
    </div>
  {/snippet}
  {#snippet trailing()}
    <Button size="small" variant="ghost" onclick={() => modalManager.show(ArchiveOperationsModal, {})}
      >{$t('archive_operations.recent')}</Button
    >
    {@render children?.()}
  {/snippet}
</ControlAppBar>
