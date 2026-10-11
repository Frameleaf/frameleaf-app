<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import TakeoutWizard from '$lib/components/frameleaf/TakeoutWizard.svelte';
  import { Route } from '$lib/route';
  import {
    getTakeoutImport,
    getTakeoutRoots,
    listTakeoutImports,
    type TakeoutResponseDto,
    type TakeoutRootDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The settings entry to Google Photos imports (FL-65), the prototype's "Google Photos & server
   * imports" section in Backup & import. Its "Preview import workflow" action opens the import
   * workflow in place (FL-83), as the prototype's wide "Import Google Photos" dialog
   * (`CommandCenter.jsx` `showWorkflow` / `workflows.import`). The address says the dialog is open
   * (`workflow=import`) and on which import (`import`), so the old `/takeout` page, links from
   * elsewhere and a reload all land in it. The wizard's two switches ("Recreate album memberships",
   * "Review ambiguous sidecars") are choices made for each import there, where they apply.
   *
   * The imports are read from the server every time the dialog opens or moves to another import;
   * nothing about an import lives in the browser.
   *
   * With `showRoots`, an administrator also sees which server folders imports may read from. That
   * list is the operator's `FRAMELEAF_IMPORT_ROOTS`; it is read from the server, never typed here.
   */
  let { showRoots = false }: { showRoots?: boolean } = $props();

  let roots = $state<TakeoutRootDto[] | undefined>();

  const importId = $derived(page.url.searchParams.get('import') ?? undefined);
  const open = $derived(page.url.searchParams.get('workflow') === 'import' || !!importId);
  let loaded = $state<{ key: string; imports: TakeoutResponseDto[]; current?: TakeoutResponseDto }>();
  let failed = $state(false);
  const key = $derived(importId ?? '');

  $effect(() => {
    if (!open) {
      loaded = undefined;
      return;
    }
    const requested = key;
    const id = importId;
    failed = false;
    void Promise.all([
      listTakeoutImports(),
      id ? getTakeoutImport({ id }).catch(() => undefined) : Promise.resolve(undefined),
    ])
      .then(([imports, current]) => {
        if (requested === key) {
          loaded = { key: requested, imports, current };
        }
      })
      .catch(() => {
        if (requested === key) {
          failed = true;
        }
      });
  });

  const navigate = (url: string) => goto(url, { noScroll: true, keepFocus: true });
  const close = () => {
    const url = new URL(page.url);
    url.searchParams.delete('workflow');
    url.searchParams.delete('import');
    void navigate(`${url.pathname}${url.search}`);
  };

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
        <div role="status" aria-busy="true">
          <span class="sr-only">{$t('loading')}</span>
          <Skeleton variant="text" lines={2} />
        </div>
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
    <Button onclick={() => void navigate(Route.takeout())}>
      {$t('frameleaf_takeout_settings_action')}
      <span aria-hidden="true"><Icon icon={mdiChevronRight} size="16" /></span>
    </Button>
  </div>
</div>

<Dialog wide title={$t('frameleaf_takeout_title')} closeLabel={$t('close')} {open} onRequestClose={close}>
  {#if loaded && loaded.key === key}
    <!-- Another import, or none, unmounts the wizard until the server has answered for it, so each
         wizard starts from the server's state, never the last one's. -->
    <TakeoutWizard imports={loaded.imports} current={loaded.current} onClose={close} />
  {:else if failed}
    <InlineError message={$t('frameleaf_takeout_error_generic')} />
  {:else}
    <div role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="12rem" />
    </div>
  {/if}
</Dialog>

<style>
  /* Not a settings row: it brings the inset a row would have, so nothing sits on the card edge. */
  .takeout-section {
    display: grid;
    gap: 0.75rem;
    padding-block: var(--fl-space-3);
    color: var(--fl-text);
  }
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  h4 {
    margin: 0 0 var(--fl-space-2);
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
