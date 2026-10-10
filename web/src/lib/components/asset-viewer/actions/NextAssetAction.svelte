<script lang="ts">
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { t } from 'svelte-i18n';
  import NavigationArea from '../NavigationArea.svelte';

  interface Props {
    onNextAsset: () => void;
  }

  let { onNextAsset }: Props = $props();

  // FL-148: the ArrowRight shortcut is bound once, unconditionally, by AssetViewer itself - this
  // component only renders while `nextAsset` is already resolved, so a shortcut bound here would have
  // no listener for a keypress that arrives while that (async) lookup is still in flight.
</script>

<NavigationArea onClick={onNextAsset} label={$t('view_next_asset')}>
  <Icon icon={mdiChevronRight} size={ICON_SIZE.xl} aria-hidden />
</NavigationArea>
