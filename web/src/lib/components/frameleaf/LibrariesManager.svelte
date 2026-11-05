<script lang="ts">
  /**
   * The Frameleaf admin Libraries area (FL-78), rebuilt to the approved prototype's `Libraries`
   * (`settings-v2/library/folders.jsx`): the answer first (the folders are up to date, one is being
   * looked through, one was skipped, or none is added yet) with "Add a folder of photos" and "Check
   * now"; then "Folders on this server" and "Uploaded to Frameleaf" as kit lists (state, when last
   * checked, items and size, Manage › / Details ›); then "Keeping folders up to date", which opens
   * Folder checks (its own page). Manage or Details opens that library in place of the lists with
   * "‹ Libraries"; Add a folder of photos is a page of its own (`new=1`).
   *
   * Rows come from the page's loader; nothing here is kept in the browser. While any scan is
   * moving the list is read again every couple of seconds, so progress, failures and the end of a
   * scan show as the server records them, and a reload shows exactly the same thing.
   */
  import '$lib/frameleaf/libraries.css';
  import { goto } from '$app/navigation';
  import AddFolderPage from '$lib/components/frameleaf/AddFolderPage.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import LibraryPage from '$lib/components/frameleaf/LibraryPage.svelte';
  import LibraryFormDialog from '$lib/components/frameleaf/LibraryFormDialog.svelte';
  import LibraryRemoveDialog from '$lib/components/frameleaf/LibraryRemoveDialog.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Meter from '$lib/components/frameleaf/settings/kit/Meter.svelte';
  import PageHeading from '$lib/components/frameleaf/settings/kit/PageHeading.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import {
    LIBRARY_SCAN_POLL_MS,
    isScanActive,
    isScanMoving,
    libraryKey,
    scanNeedsAttention,
    scanStatusKey,
    scannableLibraries,
    type LibraryRow,
  } from '$lib/frameleaf/libraries';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    cancelLibraryScan,
    scanLibrary,
    scanLibraryEveryFile,
    type LibraryResponseDto,
    type UserAdminResponseDto,
  } from '@frameleaf/sdk';
  import { getByteUnitString, Icon } from '@frameleaf/ui';
  import {
    mdiChevronRight,
    mdiFolderAlertOutline,
    mdiFolderCheckOutline,
    mdiFolderOutline,
    mdiFolderPlusOutline,
    mdiFolderSyncOutline,
    mdiPlus,
    mdiSync,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    rows: LibraryRow[];
    /** Accounts that may own a new library. */
    owners: UserAdminResponseDto[];
    /** The external libraries as the server returned them, for the edit form. */
    libraries: LibraryResponseDto[];
    selectedKey: string | null;
    /** Open the edit dialog for the selected library on arrival (the edit address). */
    editOnOpen?: boolean;
    /** The add address (`new=1`): Add a folder of photos, a page of its own. */
    createOnOpen?: boolean;
    snapshotAt: Date;
    onSelect: (key: string | null) => void;
    onAnalytics: () => void;
    refresh: () => Promise<void>;
  };

  let {
    rows,
    owners,
    libraries,
    selectedKey,
    editOnOpen = false,
    createOnOpen = false,
    snapshotAt,
    onSelect,
    onAnalytics,
    refresh,
  }: Props = $props();

  let notice = $state('');
  let error = $state('');
  let busy = $state(false);
  let modal = $state<{ type: 'edit'; id: string } | { type: 'remove'; id: string } | null>(null);

  let editOnOpenHandled = false;

  const byName = (a: LibraryRow, b: LibraryRow) =>
    Number(a.lifecycle !== 'active') - Number(b.lifecycle !== 'active') || a.name.localeCompare(b.name, $locale);
  const folders = $derived(rows.filter((row) => row.kind === 'external').sort(byName));
  const uploads = $derived(rows.filter((row) => row.kind === 'upload').sort(byName));
  const liveFolders = $derived(folders.filter((row) => row.lifecycle === 'active'));
  const selected = $derived(rows.find((row) => row.key === selectedKey) ?? null);
  const scannable = $derived(scannableLibraries(rows));
  const moving = $derived(rows.some((row) => isScanMoving(row.scan)));
  const editing = $derived(libraries.find((library) => modal?.type === 'edit' && library.id === modal.id));

  $effect(() => {
    if (editOnOpenHandled || !editOnOpen || selected?.kind !== 'external' || selected.lifecycle !== 'active') {
      return;
    }

    editOnOpenHandled = true;
    modal = { type: 'edit', id: selected.id };
  });

  // Read the list again while a scan moves; stop as soon as none does.
  $effect(() => {
    if (!moving) {
      return;
    }
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refresh();
      }
    }, LIBRARY_SCAN_POLL_MS);
    return () => clearInterval(timer);
  });

  // Once the last scan ends, read the list once more: its sizes and counts settle with the last batch.
  let wasMoving = false;
  $effect(() => {
    if (wasMoving && !moving) {
      void refresh();
    }
    wasMoving = moving;
  });

  const run = async (action: () => Promise<unknown>, success: string, failure: string) => {
    busy = true;
    error = '';
    try {
      await action();
      notice = success;
    } catch (error_) {
      error = `${failure} ${getServerErrorMessage(error_) ?? ''}`.trim();
    } finally {
      busy = false;
      await refresh();
    }
  };

  const scanOne = (row: LibraryRow) =>
    run(
      () => scanLibrary({ id: row.id }),
      $t('frameleaf_libraries_notice_scan_queued'),
      $t('frameleaf_libraries_error_scan'),
    );

  const scanAll = () => {
    const targets = [...scannable];
    return run(
      () => Promise.all(targets.map((row) => scanLibrary({ id: row.id }))),
      $t('frameleaf_libraries_notice_scans_queued', { values: { count: targets.length } }),
      $t('frameleaf_libraries_error_scan'),
    );
  };

  const cancelScan = (row: LibraryRow) =>
    run(
      () => cancelLibraryScan({ id: row.id }),
      $t('frameleaf_libraries_notice_scan_cancelled'),
      $t('frameleaf_libraries_error_cancel'),
    );

  const bytes = (value: number) => getByteUnitString(value, $locale, 1);
  const ago = (iso: string) => DateTime.fromISO(iso, { locale: $locale }).toRelative() ?? '';
  /** A folder the way the prototype names it, by its last two folders: "Family NAS › Family photos". */
  const pathWords = (path: string) => path.split('/').filter(Boolean).slice(-2).join(' › ') || path;
  const ownerOf = (row: LibraryRow) => owners.find((user) => user.id === row.ownerId);

  // ---- The answer at the top ----
  /** Folders checks run every night unless the administrator turned that off (Folder checks). */
  const settingsDraft = getSystemConfigDraft();
  const nightly = $derived(settingsDraft?.baseline.library.scan.enabled ?? true);
  const checkingRow = $derived(liveFolders.find((row) => isScanActive(row.scan)));
  const skipped = $derived(liveFolders.find((row) => !!row.scan && scanNeedsAttention(row.scan)));
  const lastChecked = $derived(
    liveFolders
      .map((row) => row.scan?.finishedAt)
      .filter((at): at is string => !!at)
      .sort()
      .at(-1),
  );
  const found = $derived.by(() => {
    const sum = { added: 0, removed: 0 };
    for (const row of liveFolders) {
      sum.added += row.scan?.added ?? 0;
      sum.removed += row.scan?.offlined ?? 0;
    }
    return sum;
  });
  const next = $derived(nightly ? $t('frameleaf_checks_next_tonight') : $t('frameleaf_checks_next_none'));
  const hero = $derived.by((): { tone: 'good' | 'warn' | 'quiet'; icon: string; title: string; body: string } => {
    if (liveFolders.length === 0) {
      return {
        tone: 'good',
        icon: mdiFolderPlusOutline,
        title: $t('frameleaf_libraries_hero_new_title'),
        body: $t('frameleaf_libraries_hero_new_body'),
      };
    }
    if (checkingRow) {
      return {
        tone: 'good',
        icon: mdiSync,
        title: $t('frameleaf_libraries_hero_checking_title', { values: { name: checkingRow.name } }),
        body: $t('frameleaf_libraries_hero_checking_body', { values: { owner: checkingRow.ownerName } }),
      };
    }
    if (!lastChecked) {
      return {
        tone: 'quiet',
        icon: mdiFolderSyncOutline,
        title: $t('frameleaf_libraries_hero_unchecked_title', { values: { count: liveFolders.length } }),
        body: next,
      };
    }
    if (skipped) {
      return {
        tone: 'warn',
        icon: mdiFolderAlertOutline,
        title: $t('frameleaf_checks_skipped_title', { values: { name: skipped.name } }),
        body: `${$t('frameleaf_libraries_hero_skipped_body')} ${next}`,
      };
    }
    return {
      tone: 'good',
      icon: mdiFolderCheckOutline,
      title: $t('frameleaf_libraries_hero_ok_title', { values: { count: liveFolders.length } }),
      body: `${
        lastChecked
          ? $t('frameleaf_checks_last', {
              values: { ago: ago(lastChecked), count: liveFolders.length, added: found.added, removed: found.removed },
            })
          : $t('frameleaf_checks_never')
      } ${next}`,
    };
  });

  // ---- One row ----
  const folderState = (row: LibraryRow): { tone: KitTone; status: string; note?: string } => {
    if (row.lifecycle !== 'active') {
      return { tone: 'off', status: $t('frameleaf_libraries_status_removing') };
    }
    if (row.scan && isScanActive(row.scan)) {
      return {
        tone: 'good',
        status: $t(`frameleaf_libraries_status_${scanStatusKey(row.scan)}`),
        note: $t('frameleaf_libraries_checking_note', { values: { progress: Math.round(row.scan.progress) } }),
      };
    }
    if (row.scan && scanNeedsAttention(row.scan)) {
      return {
        tone: 'warn',
        status: $t('frameleaf_checks_recent_status_skipped'),
        note: row.scan.finishedAt
          ? $t('frameleaf_libraries_checked', { values: { ago: ago(row.scan.finishedAt) } })
          : undefined,
      };
    }
    const at = row.scan?.finishedAt ?? row.refreshedAt;
    return at
      ? {
          tone: 'good',
          status: $t('frameleaf_libraries_state_up_to_date'),
          note: $t('frameleaf_libraries_checked', { values: { ago: ago(at) } }),
        }
      : { tone: 'off', status: $t('frameleaf_libraries_not_checked') };
  };
  const roleOf = (row: LibraryRow) => {
    const user = ownerOf(row);
    if (!user) {
      return $t('frameleaf_libraries_owner_removed');
    }
    return user.isAdmin ? $t('frameleaf_users_role_admin') : $t('frameleaf_userpage_role_member');
  };

  /** Opens one library in place of the lists, from its top. */
  let pageElement: HTMLElement | undefined = $state();
  $effect(() => {
    if ((selected || createOnOpen) && pageElement) {
      pageElement.scrollIntoView?.({ block: 'start' });
    }
  });
  const openAdd = () => void goto(commandCenterUrl('libraries', undefined, { new: '1' }));
</script>

{#snippet amount(row: LibraryRow)}
  <Meter
    label={row.name}
    value={$t('frameleaf_libraries_items', { values: { count: row.stats?.items ?? 0 } })}
    max="· {bytes(row.stats?.logical ?? 0)}"
  />
{/snippet}

{#snippet addFolder(primary: boolean)}
  <Button variant={primary ? 'primary' : 'default'} onclick={openAdd}>
    <Icon icon={mdiPlus} size="1.125rem" aria-hidden />
    {$t('frameleaf_libraries_add')}
  </Button>
{/snippet}

{#snippet heroActions()}
  {#if liveFolders.length === 0}
    {@render addFolder(true)}
  {:else if checkingRow}
    <Button disabled={busy} onclick={() => checkingRow && void cancelScan(checkingRow)}
      >{$t('frameleaf_libraries_stop')}</Button
    >
  {:else if skipped}
    <Button variant="primary" disabled={busy} onclick={() => skipped && void scanOne(skipped)}>
      {$t('frameleaf_libraries_try_again')}
    </Button>
    {@render addFolder(false)}
  {:else}
    {@render addFolder(true)}
    <Button disabled={scannable.length === 0 || busy} onclick={scanAll}>{$t('frameleaf_checks_now')}</Button>
  {/if}
{/snippet}

<!-- One live region for every view (the list, a library's page, Add a folder), so a message that lands as
     the view changes is announced (FL-1248). -->
<div class="said">
  <Said message={notice} onDismiss={() => (notice = '')} />
</div>
{#if createOnOpen}
  <!-- FL-539: Add a folder of photos is a page of its own (prototype folders.jsx FolderForm) -->
  <section class="fl-libraries" aria-label={$t('frameleaf_addfolder_title')} bind:this={pageElement}>
    <PageHeading
      overline={$t('frameleaf_libraries_title')}
      title={$t('frameleaf_addfolder_title')}
      description={$t('frameleaf_addfolder_subtitle')}
      back={{ href: commandCenterUrl('libraries'), label: $t('frameleaf_libraries_title') }}
    />
    <AddFolderPage
      {owners}
      ownerId={selected?.ownerId}
      onAdded={(library, scanning) => {
        notice = scanning ? $t('frameleaf_addfolder_added_checking') : $t('frameleaf_libraries_notice_created');
        onSelect(libraryKey(library.id));
        void refresh();
      }}
      onCancel={() => onSelect(null)}
      onOpenChecks={() => void goto(commandCenterUrl('libraries', 'checking'))}
    />
  </section>
{:else if selected}
  <!-- Manage › / Details ›: the library as a page of its own, as the prototype opens a folder. -->
  <div class="fl-libraries" bind:this={pageElement}>
    <PageHeading
      overline={$t('frameleaf_libraries_title')}
      title={selected.name}
      description={selected.kind === 'external'
        ? $t('frameleaf_library_page_description_folder', { values: { name: selected.ownerName } })
        : $t('frameleaf_library_page_description_uploads', { values: { name: selected.ownerName } })}
      back={{ href: commandCenterUrl('libraries'), label: $t('frameleaf_libraries_title') }}
    >
      {#snippet actions()}
        <Button onclick={onAnalytics}>{$t('frameleaf_libraries_view_analytics')}</Button>
      {/snippet}
    </PageHeading>
    <div class="notes">
      {#if error && !modal}
        <p class="error" role="alert">{error}</p>
      {/if}
    </div>
    {#key selected.key}
      <LibraryPage
        row={selected}
        {snapshotAt}
        {busy}
        onEdit={() => (modal = { type: 'edit', id: selected.id })}
        onRemove={() => (modal = { type: 'remove', id: selected.id })}
        onScan={() => scanOne(selected)}
        onScanEveryFile={() =>
          run(
            () => scanLibraryEveryFile({ id: selected.id }),
            $t('frameleaf_libraries_notice_every_file'),
            $t('frameleaf_libraries_error_scan'),
          )}
        onCancelScan={() => cancelScan(selected)}
      />
    {/key}
  </div>
{:else}
  <section class="fl-libraries" aria-label={$t('frameleaf_libraries_title')}>
    <PageHeading
      overline={$t('frameleaf_libraries_eyebrow')}
      title={$t('frameleaf_libraries_title')}
      description={$t('frameleaf_libraries_subtitle')}
    />
    <KitPage>
      {#if error && !modal}
        <p class="error" role="alert">{error}</p>
      {/if}
      <Hero
        label={$t('frameleaf_libraries_hero_label')}
        tone={hero.tone}
        icon={hero.icon}
        title={hero.title}
        body={hero.body}
        actions={heroActions}
      >
        {#if checkingRow?.scan}
          <div class="progress">
            <Meter
              label={$t('frameleaf_libraries_scan_progress_label', { values: { name: checkingRow.name } })}
              value="{Math.round(checkingRow.scan.progress)}%"
              fraction={checkingRow.scan.progress / 100}
            />
          </div>
        {/if}
      </Hero>

      {#if folders.length > 0}
        <Section
          title={$t('frameleaf_libraries_folders_title')}
          description={$t('frameleaf_libraries_folders_description')}
        >
          <ItemList>
            {#each folders as row (row.key)}
              {@const state = folderState(row)}
              <Item
                icon={mdiFolderOutline}
                off={row.lifecycle !== 'active'}
                name={row.name}
                detail={$t('frameleaf_libraries_folder_detail', {
                  values: { path: row.importPaths.map((path) => pathWords(path)).join(', '), owner: row.ownerName },
                })}
                tone={state.tone}
                status={state.status}
                note={state.note}
              >
                {#snippet measure()}{@render amount(row)}{/snippet}
                {#snippet action()}
                  <Button
                    label={$t('frameleaf_libraries_manage_name', { values: { name: row.name } })}
                    onclick={() => onSelect(row.key)}
                    >{$t('frameleaf_libraries_manage')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></Button
                  >
                {/snippet}
              </Item>
            {/each}
          </ItemList>
        </Section>
      {/if}

      <Section
        title={$t('frameleaf_libraries_kind_upload')}
        description={$t('frameleaf_libraries_uploads_description')}
      >
        <ItemList>
          {#each uploads as row (row.key)}
            {@const user = ownerOf(row)}
            <Item
              off={row.lifecycle !== 'active'}
              name={row.name}
              detail={roleOf(row)}
              tone={row.lifecycle === 'active' ? 'good' : 'off'}
              status={row.lifecycle === 'active'
                ? $t('frameleaf_libraries_state_ready')
                : $t('frameleaf_libraries_status_removing')}
              note={row.stats?.lastAddedAt
                ? $t('frameleaf_libraries_last_added', { values: { when: ago(row.stats.lastAddedAt) } })
                : undefined}
            >
              {#snippet measure()}{@render amount(row)}{/snippet}
              {#snippet media()}
                {#if user}
                  <span class="avatar"><UserAvatar {user} noTitle /></span>
                {:else}
                  <span class="owner-gone" aria-hidden="true"><Icon icon={mdiFolderOutline} size="22" /></span>
                {/if}
              {/snippet}
              {#snippet action()}
                <Button
                  label={$t('frameleaf_libraries_details_name', { values: { name: row.name } })}
                  onclick={() => onSelect(row.key)}
                  >{$t('frameleaf_libraries_details')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></Button
                >
              {/snippet}
            </Item>
          {/each}
        </ItemList>
        {#if uploads.length === 0}
          <p class="hint">{$t('frameleaf_libraries_uploads_empty')}</p>
        {/if}
      </Section>

      <Section title={$t('frameleaf_checks_keeping')}>
        {#if liveFolders.length === 0}
          <p class="hint">{$t('frameleaf_libraries_keeping_none')}</p>
        {:else}
          <Row
            label={nightly ? $t('frameleaf_libraries_keeping_nightly') : $t('frameleaf_libraries_keeping_manual')}
            help={nightly ? $t('frameleaf_libraries_keeping_nightly_help') : $t('frameleaf_checks_nightly_off')}
          >
            <Button onclick={() => void goto(commandCenterUrl('libraries', 'checking'))}>
              {$t('frameleaf_checks_label')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
            </Button>
          </Row>
        {/if}
      </Section>
    </KitPage>
  </section>
{/if}

{#if modal?.type === 'edit' && editing}
  <LibraryFormDialog
    library={editing}
    {owners}
    onSaved={() => {
      notice = $t('frameleaf_libraries_notice_updated');
      void refresh();
    }}
    onClose={() => (modal = null)}
  />
{:else if modal?.type === 'remove'}
  <LibraryRemoveDialog
    libraryId={modal.id}
    onRemoved={() => {
      notice = $t('frameleaf_libraries_notice_removed');
      onSelect(null);
      void refresh();
    }}
    onClose={() => (modal = null)}
  />
{/if}

<style>
  /* Opened from further down the list, a page is shown from its top with the page's own air above it. */
  .fl-libraries {
    display: block;
    scroll-margin-top: var(--fl-space-8);
  }
  .avatar {
    display: block;
    width: 44px;
    height: 44px;
    overflow: hidden;
    border-radius: 50%;
  }
  /* An account being removed has no face to show: the quiet folder tile in its place (kit Item). */
  .owner-gone {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .progress {
    padding: var(--fl-space-4) var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
  }
  .hint {
    margin: 0;
    padding: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  /* What just happened sits above the page, 24px from it as the cards are apart. */
  .said:has(:global(.kit-said)) {
    margin-bottom: var(--fl-space-6);
  }
  .notes:has(.error) {
    display: grid;
    gap: var(--fl-space-3);
    margin-bottom: var(--fl-space-6);
  }
  .error {
    margin: 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-callout);
  }
</style>
