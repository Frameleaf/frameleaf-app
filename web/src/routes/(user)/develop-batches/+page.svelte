<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import DevelopBatchPanel from '$lib/components/frameleaf/DevelopBatchPanel.svelte';
  import type { PageData } from './$types';
  import { t } from 'svelte-i18n';
  let { data }: { data: PageData } = $props();
</script>

<UserPageLayout
  ><main>
    <h1>{$t('frameleaf_batch.title')}</h1>
    <DevelopBatchPanel initialBatchId={data.batchId} />
  </main></UserPageLayout
>

<style>
  main {
    max-inline-size: 60rem;
    margin-inline: auto;
    padding: 2rem 1rem;
  }
  h1 {
    font-size: 1.75rem;
    margin-block-end: 1.5rem;
  }
</style>
