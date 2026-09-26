<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiChevronRight, mdiChevronLeft } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import NavigationArea from '../NavigationArea.svelte';
  import { languageManager } from '$lib/managers/language-manager.svelte';

  interface Props {
    onNextAsset: () => void;
  }

  let { onNextAsset }: Props = $props();

  // FL-148: the ArrowRight shortcut is bound once, unconditionally, by AssetViewer itself - this
  // component only renders while `nextAsset` is already resolved, so a shortcut bound here would have
  // no listener for a keypress that arrives while that (async) lookup is still in flight.
</script>

<NavigationArea onClick={onNextAsset} label={$t('view_next_asset')}>
  <Icon icon={languageManager.rtl ? mdiChevronLeft : mdiChevronRight} size="36" aria-hidden />
</NavigationArea>
