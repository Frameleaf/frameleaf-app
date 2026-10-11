<script lang="ts">
  /**
   * Backup › Overview (FL-362): one answer at the top, what it covers, every place a backup is kept
   * in the same row layout, the space lent to a buddy, and the newest backups. Every figure is the
   * server's own; a place whose status cannot be read says so instead of guessing.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import { BACKUP_PLACE_COPY } from '$lib/components/frameleaf/backup/backup-places';
  import Coverage, { type CoverageRow } from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import HistoryList from '$lib/components/frameleaf/settings/kit/HistoryList.svelte';
  import HistoryRow from '$lib/components/frameleaf/settings/kit/HistoryRow.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import Meter from '$lib/components/frameleaf/settings/kit/Meter.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Steps, { type Step } from '$lib/components/frameleaf/settings/kit/Steps.svelte';
  import { behindAfterMs, clockTime, cronToSchedule, scheduleWords } from '$lib/frameleaf/backup-schedule';
  import {
    BACKUP_PLACE_IDS,
    backupSummary,
    backupWhen,
    buddyPlaceState,
    cloudPlaceState,
    localPlaceState,
    localSnapshots,
    type BackupPlaceId,
    type Words,
  } from '$lib/frameleaf/backup-overview';
  import { buddyBackupPresentation } from '$lib/frameleaf/buddy-backup';
  import { endpointHost } from '$lib/frameleaf/cloud-backup';
  import { backupPageUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import {
    CloudBackupLastRunStatus,
    CloudBackupTargetSetting,
    getBackupSchedule,
    getBuddyBackupStatus,
    getCloudBackupStatus,
    getServerStatistics,
    listDatabaseBackups,
    type BackupScheduleResponseDto,
    type BuddyStatusDto,
    type CloudBackupStatusResponseDto,
    type DatabaseBackupDto,
    type ServerStatsResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiArrowBottomLeft,
    mdiCheck,
    mdiChevronRight,
    mdiDatabaseOutline,
    mdiImageMultipleOutline,
    mdiShieldAlertOutline,
    mdiShieldCheckOutline,
    mdiShieldOffOutline,
    mdiSync,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  /** How often the page reads the statuses again while a backup is being made. */
  const ACTIVE_POLL_MS = 5000;

  let cloud = $state<CloudBackupStatusResponseDto | null>(null);
  let buddy = $state<BuddyStatusDto | null>(null);
  let snapshots = $state<DatabaseBackupDto[] | null>(null);
  let stats = $state<ServerStatsResponseDto | null>(null);
  let plan = $state<BackupScheduleResponseDto | null>(null);
  let loaded = $state(false);
  /** The places whose status could not be read; the rest of the page still shows. */
  let unread = $state<BackupPlaceId[]>([]);
  let disposed = false;

  const load = async () => {
    const [cloudResult, buddyResult, localResult, statsResult, planResult] = await Promise.allSettled([
      getCloudBackupStatus(),
      getBuddyBackupStatus(),
      listDatabaseBackups(),
      getServerStatistics(),
      getBackupSchedule(),
    ]);
    if (disposed) {
      return;
    }
    cloud = cloudResult.status === 'fulfilled' ? cloudResult.value : null;
    buddy = buddyResult.status === 'fulfilled' ? buddyResult.value : null;
    snapshots = localResult.status === 'fulfilled' ? localResult.value.backups : null;
    stats = statsResult.status === 'fulfilled' ? statsResult.value : null;
    plan = planResult.status === 'fulfilled' ? planResult.value : null;
    unread = [
      ...(cloudResult.status === 'rejected' ? (['cloud'] as const) : []),
      ...(buddyResult.status === 'rejected' ? (['buddy'] as const) : []),
      ...(localResult.status === 'rejected' ? (['local'] as const) : []),
    ];
    loaded = true;
  };

  onMount(() => {
    const stop = cloudManager.listen();
    void load();
    return () => {
      disposed = true;
      stop();
    };
  });

  const settingsDraft = getSystemConfigDraft();
  const linked = $derived(cloudManager.status?.state === 'linked');
  const entitled = $derived(linked && !!cloudManager.license?.entitlements.cloudBackup);

  // The clock the page judges "up to date" by, moved on with every reading.
  let now = $state(new Date());
  // A schedule that runs on chosen days is given longer before a backup counts as behind.
  const schedule = $derived(plan ? cronToSchedule(plan.cronExpression) : undefined);
  const behind = $derived(schedule ? behindAfterMs(schedule) : undefined);
  const places = $derived({
    cloud: cloudPlaceState(cloud, now, behind),
    buddy: buddyPlaceState(buddy, { linked, entitled }, now, behind),
    local: localPlaceState(snapshots, settingsDraft?.baseline.backup.database.enabled ?? true, now, behind),
  });

  $effect(() => {
    if (BACKUP_PLACE_IDS.every((id) => !places[id].running)) {
      return;
    }
    const timer = setInterval(() => {
      now = new Date();
      void load();
    }, ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  });

  const name = (id: BackupPlaceId) => $t(BACKUP_PLACE_COPY[id].name);
  const words = ({ key, values }: Words) => $t(key, { values });
  const when = (date: Date, sentence = false) => words(backupWhen(date, { locale: $locale, now, sentence }));
  const list = (names: string[]) => new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(names);
  const size = (bytes: number) => getByteUnitString(bytes, $locale);

  const summary = $derived(backupSummary(places, { name, list, when: (date) => when(date, true), words }));
  const HERO_ICONS = {
    none: mdiShieldOffOutline,
    first: mdiShieldAlertOutline,
    attention: mdiShieldAlertOutline,
    running: mdiSync,
    ok: mdiShieldCheckOutline,
  };

  const coverage = $derived<CoverageRow[]>([
    {
      icon: mdiImageMultipleOutline,
      name: $t('frameleaf_backup_cover_media'),
      detail: stats
        ? $t('frameleaf_backup_cover_media_detail', {
            values: { count: stats.photos + stats.videos, size: size(stats.usage) },
          })
        : undefined,
      tone: summary.media.tone,
      value: words(summary.media.value),
      note: words(summary.media.note),
    },
    {
      icon: mdiDatabaseOutline,
      name: $t('frameleaf_backup_cover_data'),
      detail: $t('frameleaf_backup_cover_data_detail'),
      tone: summary.data.tone,
      value: words(summary.data.value),
      note: words(summary.data.note),
    },
  ]);

  /** Where a place keeps its copy, in a few words. */
  const where = (id: BackupPlaceId) => {
    if (id === 'local') {
      return $t('frameleaf_backup_place_local_where');
    }
    if (id === 'buddy') {
      return $t(places.buddy.on ? 'frameleaf_backup_place_buddy_where' : 'frameleaf_backup_place_holds');
    }
    if (!places.cloud.on) {
      return $t('frameleaf_backup_place_holds');
    }
    return cloud?.target === CloudBackupTargetSetting.Managed
      ? $t('frameleaf_backup_place_cloud_where')
      : $t('frameleaf_backup_place_own_where', { values: { host: endpointHost(cloud?.endpoint) } });
  };

  /** The space a place uses, against its limit when it has one. */
  const storage = $derived.by(() => {
    const managed = cloud?.managed;
    const cloudUsed = managed?.usedBytes ?? cloud?.usage?.bytes;
    const cloudLimit = managed ? (managed.allowanceBytes ?? managed.quotaBytes) : undefined;
    const mine = buddy?.pairing?.vaults.find((vault) => vault.sourceInstanceId === buddy?.instanceId);
    const buddyUsed =
      mine && buddy?.availableBytes !== null && buddy?.availableBytes !== undefined
        ? mine.quotaBytes - buddy.availableBytes
        : undefined;
    const saved = snapshots ?? [];
    return {
      cloud: cloudUsed === undefined ? undefined : { used: cloudUsed, limit: cloudLimit },
      buddy: buddyUsed === undefined ? undefined : { used: buddyUsed, limit: mine?.quotaBytes },
      local: { count: saved.length, bytes: saved.reduce((sum, backup) => sum + backup.filesize, 0) },
    };
  });

  const scheduleSentence = $derived.by(() => {
    if (!schedule) {
      return '';
    }
    const { key, values } = scheduleWords(schedule, $locale);
    return $t(key, { values });
  });
  /** The order of a run, and where a run in progress has reached. */
  const steps = $derived.by((): Step[] => {
    const order = (plan?.places ?? []).filter((place) => place.on);
    const at = plan?.run ? order.findIndex((place) => place.id === plan?.run?.place) : -1;
    return order.map((place, index) => ({
      title: name(place.id),
      state: plan?.run ? (index < at ? 'done' : index === at ? 'now' : 'waiting') : undefined,
      detail: plan?.run
        ? $t(
            index < at
              ? 'frameleaf_backup_schedule_step_done'
              : index === at
                ? 'frameleaf_backup_state_running'
                : 'frameleaf_backup_schedule_step_waiting',
          )
        : index === 0
          ? schedule && 'time' in schedule
            ? $t('frameleaf_backup_schedule_step_starts', { values: { time: clockTime(schedule.time, $locale) } })
            : $t('frameleaf_backup_schedule_step_first')
          : $t('frameleaf_backup_schedule_step_then'),
    }));
  });
  /** The hero's sentences, with when the next run starts once everything is backed up. */
  const heroBody = $derived(
    [
      ...summary.body.map((sentence) => words(sentence)),
      ...(summary.kind === 'ok' && plan?.nextRunAt
        ? [$t('frameleaf_backup_hero_next', { values: { when: when(new Date(plan.nextRunAt), true) } })]
        : []),
      ...(summary.kind === 'running' ? [$t('frameleaf_backup_hero_running_one')] : []),
    ].join(' '),
  );

  // What this server keeps for the buddy in return.
  const hosted = $derived(buddy?.pairing?.vaults.find((vault) => vault.destinationInstanceId === buddy?.instanceId));
  const lending = $derived(
    buddy?.settings && hosted
      ? { used: buddy.hosting.committedBytes + buddy.hosting.reservedBytes, limit: hosted.quotaBytes }
      : undefined,
  );
  const incoming = $derived(buddyBackupPresentation(buddy, linked, entitled, now.getTime()).incoming);

  type Recent = { id: string; at: Date; place: BackupPlaceId; detail: string; tone: KitTone; result: Translations };
  /** The newest backups each place reports: every saved snapshot, and the last run of the others. */
  const recent = $derived.by((): Recent[] => {
    const rows: Recent[] = [];
    for (const backup of localSnapshots(snapshots ?? [])) {
      if (backup.at) {
        rows.push({
          id: backup.filename,
          at: backup.at,
          place: 'local',
          detail: $t('frameleaf_backup_recent_local', { values: { size: size(backup.filesize) } }),
          tone: 'good',
          result: 'frameleaf_backup_recent_done',
        });
      }
    }
    const run = cloud?.lastRun;
    if (run && run.status !== CloudBackupLastRunStatus.Running && (run.finishedAt ?? run.startedAt)) {
      const done = run.status === CloudBackupLastRunStatus.Completed;
      rows.push({
        id: `cloud:${run.operationId}`,
        at: new Date(run.finishedAt ?? run.startedAt),
        place: 'cloud',
        detail: $t('frameleaf_backup_recent_cloud', { values: { count: run.uploaded, size: size(run.bytesUploaded) } }),
        tone: done ? 'good' : 'warn',
        result: done ? 'frameleaf_backup_recent_done' : 'frameleaf_backup_recent_not_finished',
      });
    }
    if (buddy?.run?.finishedAt) {
      const done = buddy.run.state === 'complete';
      rows.push({
        id: `buddy:${buddy.run.id}`,
        at: new Date(buddy.run.finishedAt),
        place: 'buddy',
        detail: $t('frameleaf_backup_recent_buddy', { values: { size: size(buddy.run.uploadedBytes) } }),
        tone: done ? 'good' : 'warn',
        result: done ? 'frameleaf_backup_recent_done' : 'frameleaf_backup_recent_not_finished',
      });
    }
    return rows.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, 6);
  });

  // With nothing away from home yet, the two ways to start come first and the list shows only what is on.
  const fresh = $derived(summary.kind === 'none');
  const listed = $derived(BACKUP_PLACE_IDS.filter((id) => !fresh || places[id].on || id === 'local'));
  const CHOICES = [
    {
      id: 'cloud',
      tag: 'frameleaf_backup_choice_cloud_tag',
      body: 'frameleaf_backup_choice_cloud_body',
      points: ['frameleaf_backup_choice_cloud_1', 'frameleaf_backup_choice_cloud_2', 'frameleaf_backup_choice_cloud_3'],
      action: 'frameleaf_backup_set_up_cloud',
    },
    {
      id: 'buddy',
      tag: 'frameleaf_backup_choice_buddy_tag',
      body: 'frameleaf_backup_choice_buddy_body',
      points: ['frameleaf_backup_choice_buddy_1', 'frameleaf_backup_choice_buddy_2', 'frameleaf_backup_choice_buddy_3'],
      action: 'frameleaf_buddy_set_up_buddy_backup',
    },
  ] as const satisfies ReadonlyArray<{
    id: BackupPlaceId;
    tag: Translations;
    body: Translations;
    points: readonly Translations[];
    action: Translations;
  }>;
</script>

{#if !loaded}
  <div class="loading" role="status" aria-busy="true">
    <span class="sr-only">{$t('loading')}</span>
    <Skeleton variant="block" height="168px" />
    <Skeleton variant="block" height="240px" />
  </div>
{:else}
  {#if unread.length > 0}
    <InlineError
      compact
      message={$t('frameleaf_backup_unread', { values: { places: list(unread.map((id) => name(id))) } })}
      onRetry={load}
    />
  {/if}

  <Hero
    tone={summary.tone}
    icon={HERO_ICONS[summary.kind]}
    title={words(summary.title)}
    body={heroBody}
    label={$t('frameleaf_backup_status_label')}
  >
    {#snippet actions()}
      {#if summary.fix}
        <a class="button primary" href={backupPageUrl(summary.fix)}>{$t('frameleaf_backup_see_whats_wrong')}</a>
      {/if}
    {/snippet}
    <Coverage rows={coverage} />
  </Hero>

  {#if fresh}
    <div class="choices">
      {#each CHOICES as choice (choice.id)}
        <article class="choice fl-continuous-corners">
          <span class="tile" aria-hidden="true"><Icon icon={BACKUP_PLACE_COPY[choice.id].icon} size="22" /></span>
          <small>{$t(choice.tag)}</small>
          <h3>{name(choice.id)}</h3>
          <p>{$t(choice.body)}</p>
          <ul>
            {#each choice.points as point (point)}
              <li><Icon icon={mdiCheck} size="16" aria-hidden />{$t(point)}</li>
            {/each}
          </ul>
          <a class="button primary" href={backupPageUrl(choice.id)}>{$t(choice.action)}</a>
        </article>
      {/each}
      <p class="hint">{$t('frameleaf_backup_choice_both')}</p>
    </div>
  {/if}

  <Section title={$t('frameleaf_backup_places_title')} description={$t('frameleaf_backup_places_description')}>
    <ItemList>
      {#each listed as id (id)}
        {@const place = places[id]}
        {@const used = storage[id]}
        <Item
          icon={BACKUP_PLACE_COPY[id].icon}
          off={!place.on}
          name={name(id)}
          detail={where(id)}
          tone={place.tone}
          status={unread.includes(id) ? $t('frameleaf_backup_state_unread') : words(place.status)}
          note={place.on || place.lastAt
            ? $t('frameleaf_backup_last', {
                values: { when: place.lastAt ? when(place.lastAt) : $t('frameleaf_backup_not_yet') },
              })
            : undefined}
        >
          {#snippet measure()}
            {#if id === 'local'}
              {#if storage.local.count > 0}
                <Meter
                  label={$t('frameleaf_backup_storage_label', { values: { place: name(id) } })}
                  value={$t('frameleaf_backup_snapshots', { values: { count: storage.local.count } })}
                  max={`· ${size(storage.local.bytes)}`}
                />
              {/if}
            {:else if place.on && used && 'used' in used}
              <Meter
                label={$t('frameleaf_backup_storage_label', { values: { place: name(id) } })}
                value={size(used.used)}
                max={used.limit
                  ? $t('frameleaf_backup_storage_of', { values: { limit: size(used.limit) } })
                  : undefined}
                fraction={used.limit ? used.used / used.limit : undefined}
              />
            {/if}
          {/snippet}
          {#snippet action()}
            {#if place.on || id === 'local'}
              <a
                class="button"
                href={backupPageUrl(id)}
                aria-label={$t('frameleaf_backup_manage_place', { values: { place: name(id) } })}
              >
                {$t('frameleaf_backup_manage')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
              </a>
            {:else}
              <a
                class="button primary"
                href={backupPageUrl(id)}
                aria-label={$t('frameleaf_backup_set_up_place', { values: { place: name(id) } })}
              >
                {$t('frameleaf_backup_set_up')}
              </a>
            {/if}
          {/snippet}
        </Item>
      {/each}
    </ItemList>
  </Section>

  {#if lending}
    <Section title={$t('frameleaf_backup_lend_title')} description={$t('frameleaf_backup_lend_description')}>
      <ItemList>
        <Item
          icon={mdiArrowBottomLeft}
          quiet
          name={$t('frameleaf_backup_lend_name')}
          detail={$t('frameleaf_backup_lend_detail')}
          tone={incoming === 'frameleaf_buddy_ready_to_receive' ? 'good' : 'warn'}
          status={$t(incoming)}
        >
          {#snippet measure()}
            <Meter
              label={$t('frameleaf_backup_lend_meter')}
              value={size(lending.used)}
              max={$t('frameleaf_backup_storage_of', { values: { limit: size(lending.limit) } })}
              fraction={lending.limit > 0 ? lending.used / lending.limit : undefined}
            />
          {/snippet}
          {#snippet action()}
            <a class="button" href={backupPageUrl('buddy')} aria-label={$t('frameleaf_backup_lend_manage')}>
              {$t('frameleaf_backup_manage')}<Icon icon={mdiChevronRight} size="16" aria-hidden />
            </a>
          {/snippet}
        </Item>
      </ItemList>
    </Section>
  {/if}

  {#if schedule && steps.length > 0}
    <Section
      title={$t('frameleaf_backup_tab_schedule')}
      description={$t('frameleaf_backup_schedule_summary', { values: { schedule: scheduleSentence } })}
    >
      {#snippet action()}
        <a class="button" href={backupPageUrl('schedule')}>{$t('change')}</a>
      {/snippet}
      <div class="steps"><Steps {steps} label={$t('frameleaf_backup_schedule_order')} /></div>
    </Section>
  {/if}

  <Section title={$t('frameleaf_backup_recent_title')}>
    {#snippet action()}
      <a class="button" href={Route.activity()}>{$t('frameleaf_backup_all_activity')}</a>
    {/snippet}
    {#if recent.length > 0}
      <HistoryList>
        {#each recent as row (row.id)}
          <HistoryRow when={when(row.at)} datetime={row.at.toISOString()} what={name(row.place)} detail={row.detail}>
            <Pill tone={row.tone}>{$t(row.result)}</Pill>
          </HistoryRow>
        {/each}
      </HistoryList>
    {:else}
      <p class="empty">{$t('frameleaf_backup_recent_empty')}</p>
    {/if}
  </Section>
{/if}

<style>
  .loading {
    display: grid;
    gap: var(--fl-space-6);
  }
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-1);
    text-decoration: none;
    white-space: nowrap;
  }
  a.button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .choices {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--fl-space-4);
  }
  .choice {
    display: grid;
    align-content: start;
    justify-items: start;
    gap: var(--fl-space-3);
    padding: var(--fl-space-6);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  @supports (corner-shape: squircle) {
    .choice {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  .tile {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
    border-radius: var(--fl-radius-card);
  }
  .choice small {
    color: var(--fl-accent);
    font: var(--fl-type-micro);
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }
  .choice h3 {
    font: var(--fl-type-headline);
    letter-spacing: var(--fl-tracking-headline);
  }
  .choice p,
  .hint,
  .empty {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .choice ul {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    font-size: var(--fl-font-callout);
    list-style: none;
  }
  .choice li {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .choice li :global(svg) {
    color: var(--fl-accent);
  }
  .hint {
    grid-column: 1 / -1;
    font-size: var(--fl-font-small);
    text-align: center;
  }
  .steps {
    padding-bottom: var(--fl-space-6);
  }
  .empty {
    padding: var(--fl-space-4) 0 var(--fl-space-5);
    border-top: 1px solid var(--fl-border);
  }
  @container kit (max-width: 620px) {
    .choices {
      grid-template-columns: 1fr;
    }
    .choice {
      padding: var(--fl-space-4);
    }
  }
</style>
