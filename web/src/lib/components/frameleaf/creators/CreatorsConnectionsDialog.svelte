<script lang="ts">
  import '$lib/components/frameleaf/media/boards-media.css';
  import type { MediaAuthenticationMethod } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import MediaConnections from '$lib/components/frameleaf/media/MediaConnections.svelte';

  /** Connected sites, in its own sheet: opened from the Creators rail's foot and from a sign-in notice. */
  let { methods, onClosed }: { methods: MediaAuthenticationMethod[]; onClosed: () => void } = $props();
  let open = $state(true);
</script>

<Dialog title={$t('frameleaf_boards_media_connections')} closeLabel={$t('close')} bind:open size="medium" {onClosed}>
  {#if open}
    <div class="boards-media"><MediaConnections {methods} /></div>
  {/if}
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('close')}</Button>
  {/snippet}
</Dialog>
