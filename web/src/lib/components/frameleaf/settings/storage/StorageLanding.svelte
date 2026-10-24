<script lang="ts">
  /**
   * Storage & originals (FL-365, the approved prototype's `settings-v2/library/storage.jsx`): the area
   * opens on how much room is left, then where photos are kept and what happens to deleted things.
   * It replaces a directory of four links.
   *
   * The drive is the server's own reading (`getStorage`), what the photos use and how fast they grow
   * come from Library analytics, and what waits in every Trash from `getTrashEveryone`. "Warn me when
   * the disk is nearly full" is `storageWarning.percent`, saved with the settings bar.
   *
   * Each person's total counts the full size of a file two people share (as the app does; owner call
   * defaulted on FL-365). FL-416: "Identical files are stored once: X saved" opens Library care ›
   * Duplicates, and the server owner alone also sees what waits in Unused files (`unusedFilesAccess`).
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Meter from '$lib/components/frameleaf/settings/kit/Meter.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { growthPerDay, roomLeft, WARN_PERCENTS } from '$lib/components/frameleaf/settings/storage/storage';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { unusedFilesAccess } from '$lib/frameleaf/unused-files.svelte';
  import {
    AnalyticsRange,
    getAnalyticsReport,
    getStorage,
    getTrashEveryone,
    getTrashSummary,
    type AnalyticsReportResponseDto,
    type ServerStorageResponseDto,
    type TrashEveryoneResponseDto,
    type TrashSummaryResponseDto,
  } from '@frameleaf/sdk';
  import {
    mdiContentCopy,
    mdiDeleteRestore,
    mdiFolderOutline,
    mdiHarddisk,
    mdiTrashCanOutline,
    mdiTruckOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let storage = $state<ServerStorageResponseDto | null>(null);
  let report = $state<AnalyticsReportResponseDto | null>(null);
  let everyone = $state<TrashEveryoneResponseDto | null>(null);
  let own = $state<TrashSummaryResponseDto | null>(null);

  const settled = <T,>(result: PromiseSettledResult<T>) => (result.status === 'fulfilled' ? result.value : null);
  onMount(async () => {
    void unusedFilesAccess.loadForCurrentUser();
    const results = await Promise.allSettled([
      getStorage(),
      getAnalyticsReport({ scope: 'all', range: AnalyticsRange.Year }),
      getTrashEveryone({}),
      getTrashSummary(),
    ]);
    storage = settled(results[0]);
    report = settled(results[1]);
    everyone = settled(results[2]);
    own = settled(results[3]);
  });

  const settingsDraft = getSystemConfigDraft();
  const draft = $derived(settingsDraft?.draft);
  // A configuration file holds the settings: the settings bar says so and saves nothing.
  const disabled = $derived(!draft);
  const warnAt = $derived(draft?.storageWarning?.percent ?? 90);
  const trashDays = $derived(draft?.trash.enabled ? draft.trash.days : 0);
  const accountDays = $derived(draft?.user.deleteDelay ?? 7);
  const sorted = $derived(draft?.storageTemplate.enabled ?? false);

  const size = (bytes: number) => formatBytes(bytes);
  const photos = $derived(report?.summary.physicalBytes ?? null);
  const free = $derived(storage?.diskAvailableRaw ?? null);
  const usedPercent = $derived(storage ? storage.diskUsagePercentage : 0);
  const tight = $derived(!!storage && warnAt > 0 && usedPercent >= warnAt);
  const room = $derived(free !== null && report ? roomLeft(free, growthPerDay(report.series)) : null);
  const roomWords = $derived(
    room ? $t(`frameleaf_storage_room_${room.unit}` as Translations, { values: { count: room.count } }) : '',
  );
  const breakdown = $derived(report?.host.breakdown ?? null);

  const warnOptions = $derived(
    [...new Set([...WARN_PERCENTS, warnAt])]
      .sort((a, b) => a - b)
      .map((percent) => ({
        value: String(percent),
        label:
          percent === 0
            ? $t('frameleaf_storage_warn_off')
            : percent === 85
              ? $t('frameleaf_storage_warn_at_recommended', { values: { percent } })
              : $t('frameleaf_storage_warn_at', { values: { percent } }),
      })),
  );
  const warnHelp = $derived(
    warnAt === 0
      ? $t('frameleaf_storage_warn_off_help')
      : storage
        ? $t('frameleaf_storage_warn_help', {
            values: { size: size((storage.diskSizeRaw * (100 - warnAt)) / 100) },
          })
        : $t('frameleaf_storage_warn_help_unread'),
  );

  const keptRows = $derived<LinkRow[]>([
    {
      icon: mdiFolderOutline,
      title: $t('frameleaf_storage_link_layout'),
      body: sorted ? $t('frameleaf_storage_link_layout_on') : $t('frameleaf_storage_link_layout_off'),
      href: commandCenterUrl('storage', 'storage-template'),
    },
    {
      icon: mdiTruckOutline,
      title: $t('frameleaf_storage_link_move'),
      body: $t('frameleaf_storage_link_move_body'),
      href: commandCenterUrl('storage', 'migration'),
    },
  ]);
  const deletedRows = $derived<LinkRow[]>([
    {
      icon: mdiTrashCanOutline,
      title: $t('frameleaf_storage_link_deleted'),
      body: [
        trashDays > 0
          ? $t('frameleaf_storage_link_deleted_body', { values: { days: trashDays, accountDays } })
          : $t('frameleaf_storage_link_deleted_off'),
        everyone ? $t('frameleaf_storage_link_deleted_waiting', { values: { count: everyone.count } }) : '',
      ]
        .filter(Boolean)
        .join(' '),
      href: commandCenterUrl('storage', 'trash'),
    },
    {
      icon: mdiDeleteRestore,
      title: $t('frameleaf_storage_link_trash'),
      body: own
        ? $t('frameleaf_storage_link_trash_body', { values: { count: own.count } })
        : $t('frameleaf_storage_link_trash_body_unread'),
      href: commandCenterUrl('trash', 'contents'),
    },
  ]);
  const identicalRows = $derived<LinkRow[]>([
    {
      icon: mdiContentCopy,
      title: report
        ? $t('frameleaf_storage_identical_saved', { values: { size: size(report.summary.savedBytes) } })
        : $t('frameleaf_storage_identical_title'),
      body: report
        ? $t('frameleaf_storage_identical_saved_body', { values: { count: report.summary.duplicateReferences } })
        : $t('frameleaf_storage_identical_unread_body'),
      href: commandCenterUrl('care', 'duplicates'),
    },
    ...(unusedFilesAccess.totals
      ? [
          {
            icon: mdiTrashCanOutline,
            title: $t('frameleaf_storage_unused', {
              values: { count: unusedFilesAccess.totals.files, size: size(unusedFilesAccess.totals.bytes) },
            }),
            body: $t('frameleaf_storage_unused_body'),
            href: commandCenterUrl('care', 'unused-files'),
          },
        ]
      : []),
  ]);
</script>

<KitPage>
  <Hero
    tone={tight ? 'warn' : 'good'}
    icon={mdiHarddisk}
    label={$t('frameleaf_storage_status')}
    title={!storage
      ? $t('frameleaf_storage_hero_unread')
      : tight
        ? $t('frameleaf_storage_hero_tight', { values: { free: size(storage.diskAvailableRaw) } })
        : photos === null
          ? $t('frameleaf_storage_hero_free', { values: { free: size(storage.diskAvailableRaw) } })
          : $t('frameleaf_storage_hero', { values: { photos: size(photos), free: size(storage.diskAvailableRaw) } })}
    body={tight
      ? [$t('frameleaf_storage_hero_tight_body'), roomWords].filter(Boolean).join(' ')
      : roomWords || $t('frameleaf_storage_hero_body_new')}
  >
    {#snippet actions()}
      {#if tight}
        <Button variant="primary" onclick={() => goto(commandCenterUrl('storage', 'migration'))}
          >{$t('frameleaf_storage_move_bigger')}</Button
        >
      {/if}
      <Button onclick={() => goto(commandCenterUrl('utilities', 'large-files'))}
        >{$t('frameleaf_storage_see_space')}</Button
      >
    {/snippet}
    {#if storage}
      <div class="extra">
        <Meter
          label={$t('frameleaf_storage_meter')}
          value={$t('frameleaf_storage_used', { values: { size: size(storage.diskUseRaw) } })}
          max={$t('frameleaf_storage_of', { values: { size: size(storage.diskSizeRaw) } })}
          fraction={storage.diskSizeRaw > 0 ? storage.diskUseRaw / storage.diskSizeRaw : undefined}
        />
        <Facts
          rows={[
            {
              label: $t('frameleaf_storage_fact_photos'),
              value: photos === null ? $t('frameleaf_storage_unread') : size(photos),
              detail: report ? $t('frameleaf_storage_items', { values: { count: report.summary.items } }) : undefined,
            },
            {
              label: $t('frameleaf_storage_fact_previews'),
              value:
                breakdown && breakdown.previewsBytes !== null && breakdown.encodedVideoBytes !== null
                  ? size(breakdown.previewsBytes + breakdown.encodedVideoBytes + breakdown.databaseBytes)
                  : $t('frameleaf_storage_measured_tonight'),
              detail: $t('frameleaf_storage_fact_previews_detail'),
            },
            {
              label: $t('frameleaf_storage_fact_other'),
              value: breakdown ? size(breakdown.otherBytes) : $t('frameleaf_storage_unread'),
              detail: $t('frameleaf_storage_fact_other_detail'),
            },
            {
              label: $t('frameleaf_storage_fact_free'),
              value: size(storage.diskAvailableRaw),
              detail: $t('frameleaf_storage_full', { values: { percent: Math.round(usedPercent) } }),
            },
          ]}
        />
      </div>
    {/if}
  </Hero>

  <Section title={$t('frameleaf_storage_before_full')}>
    <Row label={$t('frameleaf_storage_warn')} help={warnHelp}>
      <SegmentedControl
        label={$t('frameleaf_storage_warn_label')}
        options={warnOptions}
        value={String(warnAt)}
        {disabled}
        onChange={(value) => {
          if (draft) {
            draft.storageWarning = { percent: Number(value) };
          }
        }}
      />
    </Row>
  </Section>

  <Section title={$t('frameleaf_storage_kept_title')}>
    <Links rows={keptRows} stacked />
  </Section>

  <Section title={$t('frameleaf_storage_deleted_title')}>
    <Links rows={deletedRows} stacked />
  </Section>

  <Section title={$t('frameleaf_storage_identical_title')} description={$t('frameleaf_storage_identical_description')}>
    <Links rows={identicalRows} stacked />
  </Section>
</KitPage>

<style>
  .extra {
    display: grid;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4) var(--fl-space-6) var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
  }
  @container kit (max-width: 620px) {
    .extra {
      padding: var(--fl-space-4);
    }
  }
</style>
