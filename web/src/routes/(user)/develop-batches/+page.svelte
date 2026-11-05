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
  /* The standard page gutter beside the rail, as RAW support and Activity; the column stays readable. */
  main {
    max-inline-size: 60rem;
    padding: var(--fl-space-5) var(--fl-space-6) var(--fl-space-6);
  }
  /* The page title in the app's display style, as on RAW support and Library Care. */
  h1 {
    margin-block-end: var(--fl-space-6);
    font: var(--fl-type-display);
    letter-spacing: var(--fl-tracking-display);
  }
  @media (max-width: 700px) {
    /* With the page's own 8px, the 16px phone gutter. */
    main {
      padding: var(--fl-space-4) var(--fl-space-2);
    }
  }
</style>
