<script lang="ts">
  import type { AlbumResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    album: AlbumResponseDto;
  }

  let { album }: Props = $props();
</script>

<span>{$t('items_count', { values: { count: album.assetCount } })}</span>
{#if album.shared}
  <span>• {$t('shared')}</span>
{/if}
