<script lang="ts">
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { Route } from '$lib/route';
  import { getTakeoutRoots, type TakeoutRootDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The settings entry to Google Photos imports (FL-65), the prototype's "Google Photos & server
   * imports" section with its "Preview import workflow" action. The import itself is a wizard page;
   * its two switches ("Recreate album memberships", "Review ambiguous sidecars") are choices made for
   * each import there, where they apply.
   *
   * With `showRoots`, an administrator also sees which server folders imports may read from. That
   * list is the operator's `IMMICH_IMPORT_ROOTS`; it is read from the server, never typed here.
   */
  let { showRoots = false }: { showRoots?: boolean } = $props();

  let roots = $state<TakeoutRootDto[] | undefined>();

  onMount(() => {
    if (showRoots) {
      void getTakeoutRoots()
        .then((result) => (roots = result.roots))
        .catch(() => (roots = []));
    }
  });
</script>

<div class="takeout-section">
  {#if showRoots}
    <div class="roots">
      <h4>{$t('frameleaf_takeout_settings_roots')}</h4>
      {#if roots === undefined}
        <p class="note">{$t('loading')}</p>
      {:else if roots.length === 0}
        <p class="note">{$t('frameleaf_takeout_settings_roots_none')}</p>
      {:else}
        <ul>
          {#each roots as root (root.id)}
            <li><code>{root.path}</code></li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
  <div class="action">
    <Button onclick={() => void goto(Route.takeout())}>
      {$t('frameleaf_takeout_settings_action')}
      <span aria-hidden="true"><Icon icon={mdiChevronRight} size="16" /></span>
    </Button>
  </div>
</div>

<style>
  .takeout-section {
    display: grid;
    gap: 0.75rem;
    color: var(--fl-text);
  }
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  h4 {
    margin: 0 0 0.25rem;
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  ul {
    display: grid;
    gap: 0.25rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  code {
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  .action {
    display: flex;
  }
</style>
