<script lang="ts" generics="T">
  /**
   * Loads what a Command Center section needs when it opens (FL-71). The old administration pages
   * loaded the same data in their route loaders; the Command Center page loads none of it, so moving
   * between sections never fetches another section's data.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let { load, children }: { load: () => Promise<T>; children: Snippet<[T]> } = $props();

  let data = $state<{ value: T }>();
  let failed = $state(false);
  let attempt = $state(0);

  $effect(() => {
    void attempt;
    const run = load;
    let cancelled = false;
    failed = false;
    void run()
      .then((value) => {
        if (!cancelled) {
          data = { value };
        }
      })
      .catch(() => {
        if (!cancelled) {
          failed = true;
        }
      });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if data}
  {@render children(data.value)}
{:else if failed}
  <InlineError message={$t('frameleaf_cc_section_load_failed')} onRetry={() => attempt++} />
{:else}
  <div class="loading" role="status" aria-busy="true">
    <span class="sr-only">{$t('loading')}</span>
    <Skeleton variant="block" height="4.5rem" />
    <Skeleton variant="block" height="4.5rem" />
    <Skeleton variant="block" height="4.5rem" />
  </div>
{/if}

<style>
  .loading {
    display: grid;
    gap: var(--fl-space-3);
    padding: var(--fl-space-4) 0;
  }
</style>
