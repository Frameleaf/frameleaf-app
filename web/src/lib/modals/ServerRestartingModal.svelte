<script lang="ts">
  /** Shown while the server restarts; the page reloads itself when the server is back. */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Spinner from '$lib/components/frameleaf/Spinner.svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: () => void;
  };

  const { onClose }: Props = $props();

  let open = $state(true);
</script>

<Dialog bind:open title={$t('server_restarting_title')} closeLabel={$t('close')} onClosed={onClose}>
  <p><Spinner size="lg" decorative /> {$t('server_restarting_description')}</p>
</Dialog>

<style>
  p {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    margin: 0;
    font-weight: 500;
  }
</style>
