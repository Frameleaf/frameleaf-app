<script lang="ts">
  /**
   * Backup › Restore (FL-362): one place to get something back. It asks what is needed, lists the
   * dates each place can go back to, and holds the restore steps the app already has for Cloud Backup
   * and Buddy Backup; restoring only the library data is on the "On this server" page, with its
   * saved snapshots. Nothing here is a new way to restore: each row opens today's steps for that job.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import MaintenanceRestoreTest from '$lib/components/frameleaf/MaintenanceRestoreTest.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import { BACKUP_PLACE_COPY } from '$lib/components/frameleaf/backup/backup-places';
  import BuddyBackupSection from '$lib/components/frameleaf/cloud/BuddyBackupSection.svelte';
  import CloudBackupRestoreSection from '$lib/components/frameleaf/cloud/CloudBackupRestoreSection.svelte';
  import HistoryList from '$lib/components/frameleaf/settings/kit/HistoryList.svelte';
  import HistoryRow from '$lib/components/frameleaf/settings/kit/HistoryRow.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { backupWhen, localSnapshots, type BackupPlaceId } from '$lib/frameleaf/backup-overview';
  import { restoreDates } from '$lib/frameleaf/backup-restore';
  import { backupPageUrl } from '$lib/frameleaf/settings-areas';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getBuddyBackupStatus,
    getCloudBackupManifests,
    getCloudBackupStatus,
    listBuddyBackupSnapshots,
    listDatabaseBackups,
    type BuddyStatusDto,
    type CloudBackupStatusResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiDatabaseOutline, mdiHistory, mdiImageMultipleOutline, mdiServerOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let cloud = $state<CloudBackupStatusResponseDto | null>(null);
  let buddy = $state<BuddyStatusDto | null>(null);
  let points = $state<{ place: BackupPlaceId; at: Date }[]>([]);
  let loaded = $state(false);
  let failed = $state(false);
  let disposed = false;

  /** Every finished backup each place still holds. A place that cannot list its backups adds none. */
  const load = async () => {
    failed = false;
    const [cloudResult, buddyResult, localResult] = await Promise.allSettled([
      getCloudBackupStatus(),
      getBuddyBackupStatus(),
      listDatabaseBackups(),
    ]);
    if (disposed) {
      return;
    }
    cloud = cloudResult.status === 'fulfilled' ? cloudResult.value : null;
    buddy = buddyResult.status === 'fulfilled' ? buddyResult.value : null;
    failed = cloudResult.status === 'rejected' || buddyResult.status === 'rejected';
    const found: typeof points = [];
    if (localResult.status === 'fulfilled') {
      for (const backup of localSnapshots(localResult.value.backups)) {
        if (backup.at) {
          found.push({ place: 'local', at: backup.at });
        }
      }
    }
    const [manifests, snapshots] = await Promise.allSettled([
      cloud?.configured ? getCloudBackupManifests() : Promise.resolve({ manifests: [] }),
      buddy?.pairing && buddy.keyFingerprint
        ? listBuddyBackupSnapshots({ offset: 0 })
        : Promise.resolve({ snapshots: [], nextOffset: null }),
    ]);
    if (disposed) {
      return;
    }
    if (manifests.status === 'fulfilled') {
      found.push(
        ...manifests.value.manifests.map(({ createdAt }) => ({ place: 'cloud' as const, at: new Date(createdAt) })),
      );
    }
    if (snapshots.status === 'fulfilled') {
      found.push(
        ...snapshots.value.snapshots.map(({ createdAt }) => ({ place: 'buddy' as const, at: new Date(createdAt) })),
      );
    }
    points = found;
    loaded = true;
  };

  onMount(() => {
    void load();
    return () => {
      disposed = true;
    };
  });

  const now = new Date();
  const when = (date: Date) => {
    const { key, values } = backupWhen(date, { locale: $locale, now });
    return $t(key, { values });
  };
  const formatWhen = (value: string | null | undefined) =>
    value ? new Intl.DateTimeFormat($locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';

  const cloudOn = $derived(!!cloud?.configured);
  const buddyOn = $derived(!!buddy?.pairing);
  const offsite = $derived(cloudOn || buddyOn);
  /** Where each place's restore steps are. */
  const PLACE_HREF: Record<BackupPlaceId, string> = {
    cloud: '#restore-cloud',
    buddy: '#restore-buddy',
    local: backupPageUrl('local') + '#snapshots',
  };
  const first = $derived(cloudOn ? PLACE_HREF.cloud : PLACE_HREF.buddy);
  const needs = $derived($t('frameleaf_backup_restore_needs_offsite'));

  const choices = $derived<LinkRow[]>([
    {
      icon: mdiImageMultipleOutline,
      title: $t('frameleaf_backup_restore_some'),
      body: offsite ? $t('frameleaf_backup_restore_some_body') : needs,
      href: first,
      disabled: !offsite,
    },
    {
      icon: mdiHistory,
      title: $t('frameleaf_backup_restore_whole'),
      body: offsite ? $t('frameleaf_backup_restore_whole_body') : needs,
      href: first,
      disabled: !offsite,
    },
    {
      icon: mdiServerOutline,
      title: $t('frameleaf_backup_restore_new_server'),
      body: offsite ? $t('frameleaf_backup_restore_new_server_body') : needs,
      href: buddyOn ? PLACE_HREF.buddy : PLACE_HREF.cloud,
      disabled: !offsite,
    },
    {
      icon: mdiDatabaseOutline,
      title: $t('frameleaf_backup_restore_data'),
      body: $t('frameleaf_backup_restore_data_body'),
      href: PLACE_HREF.local,
    },
  ]);

  const dates = $derived(restoreDates(points, 8));
</script>

<Section title={$t('frameleaf_backup_restore_what')} description={$t('frameleaf_backup_restore_what_description')}>
  <Links rows={choices} />
</Section>

<Section title={$t('frameleaf_backup_restore_dates')} description={$t('frameleaf_backup_restore_dates_description')}>
  {#if !loaded}
    <div class="pad" role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="text" lines={3} />
    </div>
  {:else}
    {#if failed}
      <div class="pad"><InlineError compact message={$t('frameleaf_backup_status_failed')} onRetry={load} /></div>
    {/if}
    {#if dates.length > 0}
      <HistoryList>
        {#each dates as date (date.day)}
          <HistoryRow when={when(date.newest)} datetime={date.newest.toISOString()}>
            {#snippet middle()}
              <span class="chips">
                {#each date.places as place (place)}
                  <a
                    href={PLACE_HREF[place]}
                    aria-label={$t('frameleaf_backup_restore_from', {
                      values: { place: $t(BACKUP_PLACE_COPY[place].name), when: when(date.newest) },
                    })}
                  >
                    <Icon icon={BACKUP_PLACE_COPY[place].icon} size="14" aria-hidden />
                    {$t(BACKUP_PLACE_COPY[place].name)}
                  </a>
                {/each}
              </span>
            {/snippet}
          </HistoryRow>
        {/each}
      </HistoryList>
    {:else}
      <p class="pad empty">{$t('frameleaf_backup_restore_dates_empty')}</p>
    {/if}
  {/if}
</Section>

{#if cloud?.configured}
  <div id="restore-cloud" class="tool">
    <CloudBackupRestoreSection status={cloud} {formatWhen} onStatus={(next) => (cloud = next)} />
  </div>
{/if}
{#if buddyOn}
  <div id="restore-buddy" class="tool">
    <BuddyBackupSection view="restore" />
  </div>
{/if}

<MaintenanceRestoreTest />

<style>
  .pad {
    padding: var(--fl-space-4) 0 var(--fl-space-5);
    border-top: 1px solid var(--fl-border);
  }
  .empty {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .chips a {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 32px;
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    text-decoration: none;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
  }
  .chips a:hover {
    border-color: var(--fl-accent);
  }
  .chips a:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  @media (pointer: coarse) {
    .chips a {
      min-height: var(--fl-control-height);
    }
  }
  .tool {
    min-width: 0;
    scroll-margin-top: var(--fl-space-6);
  }
</style>
