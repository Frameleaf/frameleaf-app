<script lang="ts">
  import StudioSite from '$lib/components/frameleaf/StudioSite.svelte';
  import { publicStudio, sendInquiry, type PublicSite } from '$lib/frameleaf/photography/workflow-api';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import '$lib/frameleaf/photography/gallery.css';

  /** FL-702: the studio website a visitor opens at /studio/<address>. */
  let { site: address }: { site: string } = $props();
  let site = $state<PublicSite | null>(null);
  let error = $state('');
  let disposed = false;

  async function reload() {
    error = '';
    try {
      const result = await publicStudio(address);
      if (!disposed) {
        site = result;
      }
    } catch {
      if (!disposed) {
        site = null;
        error = $t('frameleaf_photography_public_unavailable');
      }
    }
  }
  onMount(() => {
    void reload();
  });
  onDestroy(() => {
    disposed = true;
  });
</script>

{#if site}
  <StudioSite {site} onInquiry={(inquiry) => sendInquiry(address, inquiry)} />
{:else}<div class="pc pc-gate">
    <main class="pc-access">
      <h1>{error || $t('frameleaf_photography_public_opening')}</h1>
      {#if error}<button type="button" onclick={reload}>{$t('frameleaf_error_retry')}</button>{/if}
    </main>
  </div>{/if}
