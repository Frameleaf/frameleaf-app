<script lang="ts" generics="T">
  /**
   * Loads what a Command Center section needs when it opens (FL-71). The old administration pages
   * loaded the same data in their route loaders; the Command Center page loads none of it, so moving
   * between sections never fetches another section's data.
   */
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
  <p class="state" role="alert">
    {$t('frameleaf_cc_load_failed')}
    <button type="button" onclick={() => attempt++}>{$t('retry')}</button>
  </p>
{:else}
  <p class="state" role="status">{$t('loading')}</p>
{/if}

<style>
  .state {
    margin: 0;
    padding: 16px 0;
    color: var(--fl-muted);
  }
  .state button {
    margin-inline-start: 8px;
    color: var(--fl-accent);
    background: none;
    border: 0;
    cursor: pointer;
  }
</style>
