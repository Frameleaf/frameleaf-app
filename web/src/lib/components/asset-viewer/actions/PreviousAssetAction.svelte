<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiChevronLeft, mdiChevronRight } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import NavigationArea from '../NavigationArea.svelte';
  import { languageManager } from '$lib/managers/language-manager.svelte';

  interface Props {
    onPreviousAsset: () => void;
  }

  let { onPreviousAsset }: Props = $props();

  // FL-148: the ArrowLeft shortcut is bound once, unconditionally, by AssetViewer itself - this
  // component only renders while `previousAsset` is already resolved, so a shortcut bound here would
  // have no listener for a keypress that arrives while that (async) lookup is still in flight.
</script>

<NavigationArea onClick={onPreviousAsset} label={$t('view_previous_asset')}>
  <Icon icon={languageManager.rtl ? mdiChevronRight : mdiChevronLeft} size="36" aria-hidden />
</NavigationArea>
