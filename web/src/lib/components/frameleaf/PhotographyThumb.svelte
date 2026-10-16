<script lang="ts">
  /**
   * A photograph's thumbnail in the photography workspace. A photo the server has no thumbnail for
   * yet shows a quiet placeholder instead of the browser's broken-image icon and its alt text.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiImageOffOutline } from '@mdi/js';

  let {
    src,
    alt = '',
    loading = 'lazy',
    style,
  }: { src: string | null | undefined; alt?: string; loading?: 'lazy' | 'eager'; style?: string } = $props();
  /** The address that failed to load; a new address gets a fresh try. */
  let failed = $state<string | null>(null);
</script>

{#if src && failed !== src}<img {src} {alt} {loading} {style} onerror={() => (failed = src)} />{:else}<span
    class="ph-thumb-missing"
    role={alt ? 'img' : undefined}
    aria-label={alt || undefined}><Icon icon={mdiImageOffOutline} size="1.5rem" aria-hidden={true} /></span
  >{/if}

<style>
  .ph-thumb-missing {
    display: grid;
    place-items: center;
    width: 100%;
    height: 100%;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
</style>
