<script lang="ts">
  /**
   * One library as a page of its own (Libraries › Manage › or Details ›), after the approved
   * prototype's folder page (`settings-v2/library/folders.jsx` FolderForm, `section=folder`). It
   * replaces the tabbed detail panel (FL-78) and keeps all of it:
   *
   * - A folder: its state first (up to date, being looked through with Stop, can't be checked, not
   *   checked yet, or being removed) with Check now and Check every file again, and the scan's own
   *   words under it; what it holds; the folder; whose library and its name; what it skips; recent
   *   changes; and removing it from Frameleaf. "Change…" opens the edit form (folders, name, skips).
   * - Someone's uploads: how many photos and videos, and when the last one was added; what they hold;
   *   recent changes. Uploads belong to their account, so there is nothing to remove here.
   *
   * The heading (name, "‹ Libraries", View analytics) is the Libraries manager's.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import HistoryList from '$lib/components/frameleaf/settings/kit/HistoryList.svelte';
  import HistoryRow from '$lib/components/frameleaf/settings/kit/HistoryRow.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Meter from '$lib/components/frameleaf/settings/kit/Meter.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { describeAdminEvent, formatHistoryDate, isLibraryEvent } from '$lib/frameleaf/account-history';
  import {
    DEFAULT_EXCLUSION_PATTERNS,
    canScanLibrary,
    isScanActive,
    scanMessage,
    scanNeedsAttention,
    type LibraryRow,
  } from '$lib/frameleaf/libraries';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getUserHistoryAdmin, type UserAdminHistoryEventResponseDto } from '@frameleaf/sdk';
  import { getByteUnitString } from '@frameleaf/ui';
  import {
    mdiFolderAlertOutline,
    mdiFolderCheckOutline,
    mdiFolderRemoveOutline,
    mdiFolderSyncOutline,
    mdiImageMultipleOutline,
    mdiSync,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    row: LibraryRow;
    /** When the statistics on this page were read, for the note under them. */
    snapshotAt: Date;
    busy?: boolean;
    onEdit: () => void;
    onRemove: () => void;
    onScan: () => void;
    /** FL-539: "Check every file again": reads every file, not only the new and changed ones. */
    onScanEveryFile?: () => void;
    onCancelScan: () => void;
  };

  let { row, snapshotAt, busy = false, onEdit, onRemove, onScan, onScanEveryFile, onCancelScan }: Props = $props();

  const external = $derived(row.kind === 'external');
  const active = $derived(row.lifecycle === 'active');
  const scanning = $derived(isScanActive(row.scan));
  const attention = $derived(!!row.scan && scanNeedsAttention(row.scan));
  const message = $derived(scanMessage(row.scan));
  const messageText = $derived(
    message.parts
      ? message.parts.map((part) => $t(part.key, { values: part.values })).join(' · ')
      : $t(message.key, { values: message.values }),
  );
  const checkedAt = $derived(row.scan?.finishedAt ?? row.refreshedAt);
  /** Folders are checked every night unless the administrator turned that off (Folder checks). */
  const settingsDraft = getSystemConfigDraft();
  const next = $derived(
    (settingsDraft?.baseline.library.scan.enabled ?? true)
      ? $t('frameleaf_checks_next_tonight')
      : $t('frameleaf_checks_next_none'),
  );

  const bytes = (value: number) => getByteUnitString(value, $locale, 1);
  const count = (value: number) => value.toLocaleString($locale);
  const ago = (iso: string) => DateTime.fromISO(iso, { locale: $locale }).toRelative() ?? '';
  /** A folder the way the prototype names it, by its last two folders: "Family NAS › Family photos". */
  const pathWords = (path: string) => path.split('/').filter(Boolean).slice(-2).join(' › ') || path;

  const hero = $derived.by((): { tone: 'good' | 'warn' | 'quiet'; icon: string; title: string; body?: string } => {
    if (!external) {
      const lastAdded = row.stats?.lastAddedAt;
      return {
        tone: 'good',
        icon: mdiImageMultipleOutline,
        title: $t('frameleaf_library_page_uploads_title', { values: { count: row.stats?.items ?? 0 } }),
        body: [
          $t('frameleaf_library_page_uploads_body', { values: { name: row.ownerName } }),
          lastAdded ? $t('frameleaf_library_page_last_added', { values: { when: ago(lastAdded) } }) : '',
        ]
          .filter(Boolean)
          .join(' '),
      };
    }
    if (!active) {
      return { tone: 'quiet', icon: mdiFolderRemoveOutline, title: $t('frameleaf_library_page_title_removing') };
    }
    if (scanning) {
      return { tone: 'good', icon: mdiSync, title: $t('frameleaf_library_page_title_checking') };
    }
    if (attention) {
      return { tone: 'warn', icon: mdiFolderAlertOutline, title: $t('frameleaf_library_page_title_attention') };
    }
    if (!checkedAt) {
      return { tone: 'quiet', icon: mdiFolderSyncOutline, title: $t('frameleaf_library_page_title_never') };
    }
    return { tone: 'good', icon: mdiFolderCheckOutline, title: $t('frameleaf_library_page_title_ok') };
  });

  /** What the folder skips, in words: the two recommended choices, and how many patterns of its own. */
  const skips = $derived.by(() => {
    const recommended = DEFAULT_EXCLUSION_PATTERNS.every((pattern) => row.exclusionPatterns.includes(pattern));
    const more = row.exclusionPatterns.filter((pattern) => !DEFAULT_EXCLUSION_PATTERNS.includes(pattern)).length;
    return {
      label: recommended ? $t('frameleaf_checks_skip_recommended') : $t('frameleaf_checks_skip_own'),
      help:
        more > 0
          ? $t('frameleaf_checks_skip_more', { values: { count: more } })
          : $t('frameleaf_checks_skip_nothing_more'),
    };
  });

  // Recent changes: the library's own entries, or for uploads the account's entries without a library.
  let history = $state<UserAdminHistoryEventResponseDto[]>([]);
  let historyStatus = $state<'loading' | 'loaded' | 'error'>('loading');
  const loadHistory = async () => {
    historyStatus = 'loading';
    try {
      const page = await getUserHistoryAdmin({ id: row.ownerId, take: 100 });
      history = page.events
        .filter((event) => (external ? event.libraryId === row.id : !isLibraryEvent(event)))
        .slice(0, 10);
      historyStatus = 'loaded';
    } catch {
      historyStatus = 'error';
    }
  };
  onMount(() => {
    void loadHistory();
  });
</script>

{#snippet heroActions()}
  {#if scanning}
    <Button disabled={busy} onclick={onCancelScan}>{$t('frameleaf_libraries_stop')}</Button>
  {:else}
    <Button variant={attention ? 'primary' : 'default'} disabled={busy || !canScanLibrary(row)} onclick={onScan}>
      {$t('frameleaf_libraries_scan_start')}
    </Button>
    {#if onScanEveryFile}
      <Button disabled={busy || !canScanLibrary(row)} onclick={onScanEveryFile}>
        {$t('frameleaf_libraries_scan_every_file')}
      </Button>
    {/if}
  {/if}
{/snippet}

{#snippet change()}
  <Button onclick={onEdit}>{$t('frameleaf_library_page_change')}</Button>
{/snippet}

{#snippet remove()}
  <Button variant="danger" onclick={onRemove}>{$t('frameleaf_library_page_remove_button')}</Button>
{/snippet}

<section class="library-page" aria-label={$t('frameleaf_libraries_detail_label', { values: { name: row.name } })}>
  <KitPage>
    <Hero
      label={external ? $t('frameleaf_library_page_label_folder') : $t('frameleaf_library_page_label_uploads')}
      tone={hero.tone}
      icon={hero.icon}
      title={hero.title}
      body={hero.body}
      actions={external && active ? heroActions : undefined}
    >
      {#if external && active}
        <div class="scan">
          <p role="status">
            {#if !scanning && !attention && checkedAt}{$t('frameleaf_library_page_checked', {
                values: { ago: ago(checkedAt) },
              })}{/if}<span data-testid="library-scan-message">{messageText}</span
            >{#if !scanning && !attention}{`${/[.!?]$/.test(messageText) ? '' : '.'} ${next}`}{/if}
          </p>
          {#if scanning && row.scan}
            <Meter
              label={$t('frameleaf_libraries_scan_progress')}
              value="{Math.round(row.scan.progress)}%"
              fraction={row.scan.progress / 100}
            />
          {/if}
        </div>
      {/if}
    </Hero>

    <Section title={$t('frameleaf_library_page_holds')}>
      <Facts
        rows={[
          { label: $t('frameleaf_libraries_stat_photos'), value: count(row.stats?.photos ?? 0) },
          { label: $t('frameleaf_libraries_stat_videos'), value: count(row.stats?.videos ?? 0) },
          { label: $t('frameleaf_libraries_stat_logical'), value: bytes(row.stats?.logical ?? 0) },
          { label: $t('frameleaf_libraries_stat_physical'), value: bytes(row.stats?.physical ?? 0) },
        ]}
      />
      <p class="hint">
        {$t('frameleaf_libraries_snapshot_footnote', {
          values: { date: formatHistoryDate(snapshotAt.toISOString(), $locale) },
        })}
        {#if !external}{$t('frameleaf_libraries_danger_upload')}{/if}
      </p>
    </Section>

    {#if external}
      <Section
        title={$t('frameleaf_library_page_folder')}
        description={$t('frameleaf_libraries_folders_description')}
        action={active ? change : undefined}
      >
        {#each row.importPaths as path (path)}
          <Row label={pathWords(path)} help={path} />
        {:else}
          <p class="hint">{$t('frameleaf_libraries_folders_none')}</p>
        {/each}
      </Section>

      <Section title={$t('frameleaf_library_page_whose')}>
        <Row label={$t('frameleaf_library_page_show_in')} help={$t('frameleaf_library_page_show_in_help')}>
          <span class="value">{$t('frameleaf_library_page_owner_library', { values: { name: row.ownerName } })}</span>
        </Row>
        <Row label={$t('frameleaf_library_page_name')} help={$t('frameleaf_library_page_name_help')}>
          <span class="value">{row.name}</span>
        </Row>
      </Section>

      <Section
        title={$t('frameleaf_library_page_skip')}
        description={$t('frameleaf_library_page_skip_description')}
        action={active ? change : undefined}
      >
        <Row label={skips.label} help={skips.help} />
        <Advanced summary={$t('frameleaf_library_page_patterns')}>
          {#if row.exclusionPatterns.length > 0}
            <ul class="patterns">
              {#each row.exclusionPatterns as pattern (pattern)}
                <li>{pattern}</li>
              {/each}
            </ul>
          {:else}
            <p class="hint">{$t('frameleaf_libraries_exclusions_none')}</p>
          {/if}
        </Advanced>
      </Section>
    {/if}

    <Section title={$t('frameleaf_library_page_history')}>
      {#if historyStatus === 'loading'}
        <div class="hint" role="status" aria-busy="true">
          <span class="sr-only">{$t('loading')}</span>
          <Skeleton variant="text" lines={2} />
        </div>
      {:else if historyStatus === 'error'}
        <p class="hint error" role="alert">{$t('frameleaf_account_history_error')}</p>
      {:else if history.length > 0}
        <HistoryList>
          {#each history as event (event.id)}
            <HistoryRow
              when={formatHistoryDate(event.createdAt, $locale)}
              datetime={event.createdAt}
              what={describeAdminEvent(event, $t, bytes)}
              detail={event.subject}
            />
          {/each}
        </HistoryList>
      {:else}
        <p class="hint">{$t('frameleaf_libraries_activity_empty')}</p>
      {/if}
    </Section>

    {#if external}
      <Section
        title={$t('frameleaf_library_page_remove_title')}
        description={active
          ? $t('frameleaf_library_page_remove_description')
          : $t('frameleaf_libraries_danger_removing')}
        action={active ? remove : undefined}
      />
    {/if}
  </KitPage>
</section>

<style>
  .scan {
    display: grid;
    gap: var(--fl-space-3);
    padding: var(--fl-space-4) var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
  }
  .scan p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .hint {
    margin: 0;
    padding: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .hint.error {
    color: var(--fl-danger);
  }
  .value {
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    text-align: end;
    overflow-wrap: anywhere;
  }
  .patterns {
    display: grid;
    gap: var(--fl-space-1);
    margin: 0;
    padding: 0 0 var(--fl-space-4);
    list-style: none;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    overflow-wrap: anywhere;
  }
  @container kit (max-width: 620px) {
    .scan {
      padding: var(--fl-space-4);
    }
  }
</style>
