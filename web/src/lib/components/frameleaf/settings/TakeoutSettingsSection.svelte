<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Steps from '$lib/components/frameleaf/settings/kit/Steps.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import TakeoutWizard from '$lib/components/frameleaf/TakeoutWizard.svelte';
  import { takeoutProgress, takeoutStateKey, takeoutView } from '$lib/frameleaf/takeout';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import {
    createTakeoutImport,
    getTakeoutImport,
    getTakeoutRoots,
    listTakeoutImports,
    scanTakeoutImport,
    TakeoutSourceKind,
    TakeoutState,
    type TakeoutResponseDto,
    type TakeoutRootDto,
  } from '@frameleaf/sdk';
  import { mdiAlertCircleOutline, mdiGoogle, mdiSync, mdiTrayArrowDown } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Import & protection › Google Photos import (FL-65), after the prototype's page
   * (`settings-v2/library/importing.jsx` `GooglePhotos`, ACCOUNT-P6): a status answer first (the last
   * import, one running, or one waiting for you), "Before you start" in three steps, the account's
   * imports as a list with Open, and the folder import for an export already on the server behind
   * Advanced, with the folders it may read from.
   *
   * "Import from Google Photos…" opens the import flow in place (FL-83). The address says the dialog
   * is open (`workflow=import`) and on which import (`import`), so the old `/takeout` page, links
   * from elsewhere and a reload all land in it. With no import it is the short start screen
   * (default size); an import opens the flow in the medium dialog. Imports are read from the server
   * each time; nothing about an import lives in the browser.
   *
   * With `showRoots` (administrators) the Advanced folder import is offered. The folders are the
   * operator's `FRAMELEAF_IMPORT_ROOTS`, read from the server, never typed here.
   */
  let { showRoots = false }: { showRoots?: boolean } = $props();

  const importId = $derived(page.url.searchParams.get('import') ?? undefined);
  const open = $derived(page.url.searchParams.get('workflow') === 'import' || !!importId);

  /* The page: the account's imports ---------------------------------- */

  let imports = $state<TakeoutResponseDto[] | undefined>();
  let listFailed = $state(false);
  const loadImports = async () => {
    listFailed = false;
    try {
      const list = await listTakeoutImports();
      imports = [...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    } catch {
      listFailed = true;
    }
  };
  onMount(() => void loadImports());
  // Back from the flow: what it did shows on the page at once.
  let wasOpen = false;
  $effect(() => {
    if (wasOpen && !open) {
      void loadImports();
    }
    wasOpen = open;
  });

  const latest = $derived(imports?.[0]);
  const count = (value: number) => value.toLocaleString($locale);
  const dateOf = (value: string) => new Date(value).toLocaleDateString($locale, { day: 'numeric', month: 'long' });

  type Status = {
    tone: 'good' | 'warn' | 'bad' | 'quiet';
    icon: string;
    title: string;
    body: string;
    /** The hero's action: start a new import, or open the latest one. */
    open?: { label: string; primary: boolean };
  };
  const status = $derived.by((): Status | undefined => {
    if (!imports) {
      return;
    }
    if (!latest) {
      return {
        tone: 'quiet',
        icon: mdiGoogle,
        title: $t('frameleaf_takeout_page_none_title'),
        body: $t('frameleaf_takeout_page_none_body'),
      };
    }
    const view = takeoutView(latest);
    const progress = takeoutProgress(latest);
    switch (view) {
      case 'checking':
      case 'importing': {
        return {
          tone: 'good',
          icon: mdiSync,
          title:
            view === 'importing' && progress.total
              ? $t('frameleaf_takeout_page_running_title', {
                  values: { done: count(progress.done), total: count(progress.total) },
                })
              : $t('frameleaf_takeout_page_checking_title'),
          body: $t('frameleaf_takeout_page_running_body'),
          open: { label: $t('frameleaf_takeout_page_open'), primary: false },
        };
      }
      case 'unclear': {
        return {
          tone: 'warn',
          icon: mdiAlertCircleOutline,
          title: $t('frameleaf_takeout_page_unclear_title', { values: { count: latest.counts.review } }),
          body: $t('frameleaf_takeout_page_unclear_body'),
          open: {
            label: $t('frameleaf_takeout_page_unclear_action', { values: { count: latest.counts.review } }),
            primary: true,
          },
        };
      }
      case 'done': {
        return latest.state === TakeoutState.Completed
          ? {
              tone: 'good',
              icon: mdiGoogle,
              title: $t('frameleaf_takeout_page_done_title', { values: { date: dateOf(latest.updatedAt) } }),
              body: $t('frameleaf_takeout_page_done_body', {
                values: { imported: latest.counts.imported, matched: latest.counts.matched },
              }),
            }
          : {
              tone: 'warn',
              icon: mdiAlertCircleOutline,
              title: $t('frameleaf_takeout_stopped_import_title'),
              body: $t('frameleaf_takeout_stopped_import_body'),
            };
      }
      default: {
        // Uploading, stopped part-way, a check that failed or ready to import: it waits for you.
        return {
          tone: 'warn',
          icon: mdiGoogle,
          title: $t('frameleaf_takeout_page_waiting_title'),
          body: $t('frameleaf_takeout_page_waiting_body'),
          open: { label: $t('frameleaf_takeout_continue'), primary: true },
        };
      }
    }
  });

  const itemTone = (entry: TakeoutResponseDto): KitTone => {
    const view = takeoutView(entry);
    if (view === 'done') {
      return entry.state === TakeoutState.Completed ? 'good' : 'bad';
    }
    return view === 'checking' || view === 'importing' ? 'good' : 'warn';
  };
  const itemNote = (entry: TakeoutResponseDto) => {
    const view = takeoutView(entry);
    if (view === 'importing' && entry.total) {
      const progress = takeoutProgress(entry);
      return $t('frameleaf_takeout_import_progress', {
        values: { done: count(progress.done), total: count(progress.total ?? 0) },
      });
    }
    if (view === 'unclear') {
      return $t('frameleaf_takeout_page_unclear_action', { values: { count: entry.counts.review } });
    }
    return $t('frameleaf_takeout_import_summary', {
      values: { imported: entry.counts.imported, matched: entry.counts.matched },
    });
  };
  const itemDetail = (entry: TakeoutResponseDto) =>
    entry.sources.some((source) => source.kind === TakeoutSourceKind.Directory)
      ? $t('frameleaf_takeout_page_from_folder')
      : $t('frameleaf_takeout_files_count', { values: { count: entry.sources.length } });

  const navigate = (url: string) => goto(url, { reset: false });
  const start = () => void navigate(Route.takeout());
  const openImport = (id: string) => void navigate(Route.takeout({ import: id }));

  /* Advanced: an export already on this server ----------------------- */

  let roots = $state<TakeoutRootDto[] | undefined>();
  let rootId = $state('');
  let folder = $state('');
  let folderBusy = $state(false);
  let folderFailed = $state(false);
  onMount(() => {
    if (showRoots) {
      void getTakeoutRoots()
        .then((result) => {
          roots = result.roots;
          rootId = result.roots[0]?.id ?? '';
        })
        .catch(() => (roots = []));
    }
  });
  const importFolder = async () => {
    folderBusy = true;
    folderFailed = false;
    try {
      const name = $t('frameleaf_takeout_default_name', { values: { date: dateOf(new Date().toISOString()) } });
      const created = await createTakeoutImport({ takeoutCreateDto: { name, rootId, directory: folder.trim() } });
      await scanTakeoutImport({ id: created.id });
      openImport(created.id);
    } catch {
      folderFailed = true;
    } finally {
      folderBusy = false;
    }
  };

  /* The flow, in a dialog -------------------------------------------- */

  let loaded = $state<{ key: string; current?: TakeoutResponseDto }>();
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
    if (!id) {
      loaded = { key: requested };
      return;
    }
    void getTakeoutImport({ id })
      .then((current) => {
        if (requested === key) {
          loaded = { key: requested, current };
        }
      })
      .catch(() => {
        if (requested === key) {
          failed = true;
        }
      });
  });

  const close = () => {
    const url = new URL(page.url.href);
    url.searchParams.delete('workflow');
    url.searchParams.delete('import');
    void navigate(`${url.pathname}${url.search}`);
  };
</script>

<KitPage>
  {#if listFailed}
    <InlineError message={$t('frameleaf_takeout_error_generic')} onRetry={loadImports} />
  {:else if status}
    <Hero
      tone={status.tone}
      icon={status.icon}
      title={status.title}
      body={status.body}
      label={$t('frameleaf_takeout_settings_title')}
    >
      {#snippet actions()}
        {#if status.open && latest}
          <Button variant={status.open.primary ? 'primary' : 'default'} onclick={() => openImport(latest.id)}>
            {status.open.label}
          </Button>
        {:else}
          <Button variant="primary" onclick={start}>{$t('frameleaf_takeout_settings_action')}</Button>
        {/if}
      {/snippet}
    </Hero>
  {:else}
    <div role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="8rem" />
    </div>
  {/if}

  <Section title={$t('frameleaf_takeout_page_before')}>
    <div class="steps">
      <Steps
        label={$t('frameleaf_takeout_page_before')}
        steps={[
          { title: $t('frameleaf_takeout_page_before_ask'), detail: $t('frameleaf_takeout_page_before_ask_help') },
          {
            title: $t('frameleaf_takeout_page_before_download'),
            detail: $t('frameleaf_takeout_page_before_download_help'),
          },
          { title: $t('frameleaf_takeout_page_before_add'), detail: $t('frameleaf_takeout_page_before_add_help') },
        ]}
      />
    </div>
  </Section>

  <Section
    title={$t('frameleaf_takeout_previous_heading')}
    description={$t('frameleaf_takeout_page_imports_description')}
  >
    {#if imports}
      <ItemList>
        {#each imports as entry (entry.id)}
          <Item
            icon={mdiGoogle}
            name={entry.name}
            detail={itemDetail(entry)}
            tone={itemTone(entry)}
            status={$t(takeoutStateKey(entry.state))}
            note={itemNote(entry)}
          >
            {#snippet action()}
              <Button
                label={$t('frameleaf_takeout_page_open_label', { values: { name: entry.name } })}
                onclick={() => openImport(entry.id)}
              >
                {$t('frameleaf_takeout_page_open')}
              </Button>
            {/snippet}
          </Item>
        {:else}
          <Item
            icon={mdiTrayArrowDown}
            quiet
            off
            name={$t('frameleaf_takeout_page_imports_empty')}
            detail={$t('frameleaf_takeout_page_imports_empty_detail')}
          />
        {/each}
      </ItemList>
    {/if}

    {#if showRoots}
      <Advanced summary={$t('frameleaf_takeout_page_advanced')}>
        {#if roots === undefined}
          <div role="status" aria-busy="true">
            <span class="sr-only">{$t('loading')}</span>
            <Skeleton variant="text" lines={2} />
          </div>
        {:else if roots.length === 0}
          <p class="hint">{$t('frameleaf_takeout_settings_roots_none')}</p>
        {:else}
          <p class="hint">{$t('frameleaf_takeout_folder_help')}</p>
          <Row label={$t('frameleaf_takeout_root_label')}>
            <select class="field" aria-label={$t('frameleaf_takeout_root_label')} bind:value={rootId}>
              {#each roots as root (root.id)}
                <option value={root.id}>{root.path}</option>
              {/each}
            </select>
          </Row>
          <Row label={$t('frameleaf_takeout_folder_label')}>
            <input
              class="field"
              aria-label={$t('frameleaf_takeout_folder_label')}
              bind:value={folder}
              maxlength="4096"
              placeholder="Takeout"
            />
            <Button variant="primary" disabled={folderBusy || !rootId} onclick={() => void importFolder()}>
              {$t('frameleaf_takeout_import_folder')}
            </Button>
          </Row>
          {#if folderFailed}
            <InlineError compact message={$t('frameleaf_takeout_error_generic')} />
          {/if}
        {/if}
      </Advanced>
    {/if}
  </Section>
</KitPage>

<Dialog
  size={importId ? 'medium' : 'default'}
  title={$t('frameleaf_takeout_title')}
  closeLabel={$t('close')}
  {open}
  onRequestClose={close}
>
  {#if loaded && loaded.key === key}
    <!-- Another import, or none, unmounts the wizard until the server has answered for it, so each
         wizard starts from the server's state, never the last one's. -->
    <TakeoutWizard current={loaded.current} onClose={close} />
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
  .steps {
    padding-bottom: var(--fl-space-5);
  }
  .hint {
    max-width: 640px;
    margin: 0;
    padding-bottom: var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .field {
    width: 300px;
    max-width: 100%;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font: inherit;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
</style>
