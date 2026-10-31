<script lang="ts">
  /**
   * Command center › Overview (FL-363, the approved prototype's `settings-v2/overnight/Overview.jsx`).
   * It opens on one answer with three levels ("Everything is working", "Working, with N things to look
   * at", "Something needs you now") and one sentence built from five checks (backup, free space, AI
   * features, background work, updates), with what needs the person directly under it, most urgent
   * first, each with the page that puts it right. Then one list of what was checked, the drive in
   * everyday units with the room left at the pace photos are added, and the library's growth.
   *
   * Every reading is the server's own: what needs attention (`getAttention`, FL-421: no backup away
   * from home, a nearly full drive, failed work, an update), plus the AI features' last answer, the
   * Frameleaf Cloud plan, Studio's computers, the restore test and the overnight schedule. "Dismiss"
   * is kept on the server for every administrator (`setAttentionDismissed`).
   *
   * Not on this page yet (FL-363 follow-up): the phones row, which needs a reading for all accounts.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import AnalyticsChart from '$lib/components/frameleaf/analytics/AnalyticsChart.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Meter from '$lib/components/frameleaf/settings/kit/Meter.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import {
    byUrgency,
    growthPerDay,
    overviewLevel,
    roomLeft,
    sentence,
    statusPhrases,
    type NeedLevel,
  } from '$lib/components/frameleaf/settings/overview/overview';
  import { nightOutcome } from '$lib/components/frameleaf/settings/overnight/overnight';
  import { attentionView, type AttentionSayings, type Words } from '$lib/frameleaf/attention';
  import { cloudGlance, gpuStudioState, mlEndpointState } from '$lib/frameleaf/overview-readiness';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { phonesBehind } from '$lib/components/frameleaf/settings/overview/overview';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    AnalyticsRange,
    createJob,
    getAboutInfo,
    getAnalyticsReport,
    getAttention,
    getBackupRestoreVerification,
    getMlWorkloadRoutes,
    getOvernight,
    getRenderWorkerCompatibility,
    getStorage,
    listAllBackupDevices,
    listMlDestinations,
    ManualJobName,
    setAttentionDismissed,
    type AnalyticsReportResponseDto,
    type AttentionResponseDto,
    type BackupDeviceDto,
    type BackupRestoreVerificationResponseDto,
    type MlDestinationResponseDto,
    type MlWorkloadRouteDto,
    type OvernightResponseDto,
    type RenderWorkerCompatibilityResponseDto,
    type ServerAboutResponseDto,
    type ServerStorageResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiCellphone,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiCloudOutline,
    mdiHarddisk,
    mdiImageSearchOutline,
    mdiMovieOpenOutline,
    mdiProgressClock,
    mdiRefresh,
    mdiServerOutline,
    mdiShieldCheckOutline,
    mdiWeatherNight,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let attention = $state<AttentionResponseDto | null>(null);
  let report = $state<AnalyticsReportResponseDto | null>(null);
  let storage = $state<ServerStorageResponseDto | null>(null);
  let about = $state<ServerAboutResponseDto | null>(null);
  let restore = $state<BackupRestoreVerificationResponseDto | null>(null);
  let compatibility = $state<RenderWorkerCompatibilityResponseDto | null>(null);
  let ml = $state<{ destinations: MlDestinationResponseDto[]; routes: MlWorkloadRouteDto[] } | null>(null);
  let overnight = $state<OvernightResponseDto | null>(null);
  /** FL-518: every account's phones that send photos here (the app's backup report). */
  let phones = $state<BackupDeviceDto[] | null>(null);
  let loading = $state(true);
  let failed = $state(false);
  let said = $state('');

  const settled = <T,>(result: PromiseSettledResult<T>) => (result.status === 'fulfilled' ? result.value : null);
  const load = async () => {
    loading = true;
    const results = await Promise.allSettled([
      getAttention(),
      getAnalyticsReport({ scope: 'all', range: AnalyticsRange.Year }),
      getStorage(),
      getAboutInfo(),
      getBackupRestoreVerification(),
      getRenderWorkerCompatibility(),
      listMlDestinations(),
      getMlWorkloadRoutes(),
      getOvernight(),
      listAllBackupDevices({ limit: 200 }),
    ]);
    attention = settled(results[0]);
    report = settled(results[1]);
    storage = settled(results[2]);
    about = settled(results[3]);
    restore = settled(results[4]);
    compatibility = settled(results[5]);
    const destinations = settled(results[6]);
    const routes = settled(results[7]);
    ml = destinations && routes ? { destinations, routes: routes.routes } : null;
    overnight = settled(results[8]);
    phones = settled(results[9])?.devices ?? null;
    failed = !attention && !storage;
    loading = false;
  };
  onMount(() => {
    void load();
    return cloudManager.listen();
  });

  const words = ({ key, values }: Words) => $t(key, { values });
  const size = (bytes: number) => formatBytes(bytes);
  const say = $derived<AttentionSayings>({
    size,
    list: (names) => new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(names),
    words,
    locale: $locale,
    now: attention ? new Date(attention.checkedAt) : undefined,
  });

  const dismissed = $derived(new Set<string>(attention?.dismissed));
  const cloud = $derived(cloudManager.status ? cloudGlance(cloudManager.status, cloudManager.license) : null);
  const aiState = $derived(ml ? mlEndpointState(ml.destinations, ml.routes) : null);
  const studioReady = $derived(compatibility ? gpuStudioState(compatibility) : null);
  const studioNeedsComputer = $derived(!!compatibility && compatibility.unavailable.length > 0);
  const checkOf = (kind: string) => attention?.checks.find((check) => check.kind === kind)?.state;
  const itemOf = (kind: string) => attention?.items.find((item) => item.kind === kind);

  type Need = {
    id: string;
    icon: string;
    level: NeedLevel;
    title: string;
    body: string;
    actions: { label: string; href: string }[];
    dismiss?: boolean;
  };

  const needs = $derived.by((): Need[] => {
    const found: Need[] = [];
    for (const item of attention?.items ?? []) {
      const view = attentionView(item, say);
      // On the Overview itself, a full drive goes to Storage, where the space is looked after.
      const action =
        item.kind === 'storage'
          ? { label: $t('frameleaf_overview_see_space'), href: commandCenterUrl('storage') }
          : { label: words(view.action.label), href: view.action.href };
      found.push({
        id: item.id,
        icon: view.icon,
        level: item.level === 'now' ? 'now' : 'look',
        title: words(view.title),
        body: words(view.detail),
        actions: [action],
      });
    }
    // A backup that was never tried: only once there is one, and only when nothing else is wrong with it.
    if (restore && !restore.metadataVerifiedAt && checkOf('backup') === 'ok') {
      found.push({
        id: 'restore-test',
        icon: mdiShieldCheckOutline,
        level: 'look',
        title: $t('frameleaf_overview_need_restore'),
        body: $t('frameleaf_overview_need_restore_body'),
        actions: [{ label: $t('frameleaf_overview_open_backup'), href: commandCenterUrl('backups', 'restore') }],
      });
    }
    // FL-518: a phone that stopped sending photos (the app may be signed out, or waiting for Wi-Fi).
    for (const phone of phonesBehind(phones ?? [])) {
      found.push({
        id: `phone-${phone.id}`,
        icon: mdiCellphone,
        level: 'look',
        title: $t('frameleaf_overview_need_phone', {
          values: { name: phone.displayName, count: phone.quietForDays ?? 0 },
        }),
        body: $t('frameleaf_overview_need_phone_body'),
        actions: [{ label: $t('frameleaf_overview_open_phones'), href: commandCenterUrl('backup', 'devices-backup') }],
      });
    }
    if (aiState === 'unreachable') {
      found.push({
        id: 'ai',
        icon: mdiImageSearchOutline,
        level: 'now',
        title: $t('frameleaf_overview_need_ai'),
        body: $t('frameleaf_overview_need_ai_body'),
        actions: [{ label: $t('frameleaf_overview_see_computers'), href: commandCenterUrl('processing', 'computers') }],
      });
    }
    if (cloud?.configured && (cloud.plan === 'grace' || cloud.plan === 'expired')) {
      found.push({
        id: 'plan',
        icon: mdiCloudOutline,
        level: 'now',
        title: $t(
          cloud.plan === 'grace' ? 'frameleaf_overview_need_plan_grace' : 'frameleaf_overview_need_plan_expired',
        ),
        body: $t(
          cloud.plan === 'grace'
            ? 'frameleaf_overview_need_plan_grace_body'
            : 'frameleaf_overview_need_plan_expired_body',
        ),
        actions: [{ label: $t('frameleaf_overview_open_plan'), href: commandCenterUrl('cloud', 'cloud-plan') }],
      });
    }
    if (studioNeedsComputer) {
      found.push({
        id: 'studio',
        icon: mdiMovieOpenOutline,
        level: 'optional',
        title: $t('frameleaf_overview_need_studio'),
        body: $t('frameleaf_overview_need_studio_body'),
        actions: [
          { label: $t('frameleaf_overview_add_computer'), href: commandCenterUrl('processing', 'computers') },
          { label: $t('frameleaf_overview_use_cloud'), href: commandCenterUrl('cloud', 'cloud-processing') },
        ],
        dismiss: true,
      });
    }
    return byUrgency(found.filter((need) => !dismissed.has(need.id)));
  });

  const level = $derived(overviewLevel(needs.map((need) => need.level)));
  const heroTitle = $derived(
    level === 'urgent'
      ? $t('frameleaf_overview_hero_urgent')
      : level === 'attention'
        ? $t('frameleaf_overview_hero_attention', {
            values: { count: needs.filter((need) => need.level !== 'optional').length },
          })
        : $t('frameleaf_overview_hero_ok'),
  );

  /** The five checks the sentence is built from; while any is wrong, it says only those (#17). */
  const heroBody = $derived.by(() => {
    if (!attention) {
      return '';
    }
    const phrases: { wrong: boolean; text: string }[] = [];
    const backup = itemOf('backup');
    phrases.push(
      backup
        ? {
            wrong: true,
            text: $t(
              backup.reason === 'not-backed-up'
                ? 'frameleaf_overview_says_not_backed_up'
                : 'frameleaf_overview_says_backup_behind',
            ),
          }
        : checkOf('backup') === 'ok'
          ? { wrong: false, text: $t('frameleaf_overview_says_backed_up') }
          : { wrong: true, text: $t('frameleaf_overview_says_not_backed_up') },
    );
    const disk = itemOf('storage');
    phrases.push(
      disk
        ? {
            wrong: true,
            text: $t(
              disk.level === 'now' ? 'frameleaf_overview_says_out_of_space' : 'frameleaf_overview_says_nearly_full',
            ),
          }
        : { wrong: false, text: $t('frameleaf_overview_says_room') },
    );
    if (aiState === 'unreachable') {
      phrases.push({ wrong: true, text: $t('frameleaf_overview_says_ai_down') });
    } else if (aiState === 'reachable') {
      phrases.push({ wrong: false, text: $t('frameleaf_overview_says_ai_ready') });
    }
    const work = itemOf('work');
    phrases.push(
      work
        ? {
            wrong: true,
            text: $t('frameleaf_overview_says_work_failed', { values: { count: work.work?.count ?? 0 } }),
          }
        : { wrong: false, text: $t('frameleaf_overview_says_work_ok') },
    );
    const version = itemOf('version');
    phrases.push(
      version
        ? { wrong: true, text: $t('frameleaf_overview_says_update') }
        : { wrong: false, text: $t('frameleaf_overview_says_up_to_date') },
    );
    // The other needs above the cards are said too, so the sentence never says all is well under a need.
    const behind = needs.filter((need) => need.id.startsWith('phone-')).length;
    if (behind > 0) {
      phrases.push({ wrong: true, text: $t('frameleaf_overview_says_phone_behind', { values: { count: behind } }) });
    }
    if (needs.some((need) => need.id === 'plan')) {
      phrases.push({ wrong: true, text: $t('frameleaf_overview_says_plan') });
    }
    if (needs.some((need) => need.id === 'restore-test')) {
      phrases.push({ wrong: true, text: $t('frameleaf_overview_says_restore_untried') });
    }
    return sentence(say.list(statusPhrases(phrases)));
  });

  // ---- what was checked ----
  type Check = {
    id: string;
    icon: string;
    name: string;
    detail: string;
    tone: KitTone;
    status: string;
    note?: string;
    href: string;
  };
  const unread = $derived($t('frameleaf_overview_unread'));
  const lastNight = $derived(overnight?.nights[0]);
  const behind = $derived(phonesBehind(phones ?? []));
  const checks = $derived.by((): Check[] => {
    const backupItem = itemOf('backup');
    const disk = storage;
    const used = disk ? Math.round(disk.diskUsagePercentage) : 0;
    const workItem = itemOf('work');
    const versionItem = itemOf('version');
    const night = lastNight ? nightOutcome(lastNight.results) : null;
    const time = (iso: string) =>
      new Intl.DateTimeFormat($locale, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
    return [
      {
        id: 'backup',
        icon: mdiShieldCheckOutline,
        name: $t('frameleaf_overview_check_backup'),
        detail: $t('frameleaf_overview_check_backup_detail'),
        tone: backupItem ? (backupItem.level === 'now' ? 'bad' : 'warn') : checkOf('backup') === 'ok' ? 'good' : 'off',
        status: backupItem
          ? $t(
              backupItem.reason === 'not-backed-up'
                ? 'frameleaf_overview_not_backed_up'
                : 'frameleaf_overview_backup_behind',
            )
          : checkOf('backup') === 'ok'
            ? $t('frameleaf_overview_backed_up')
            : unread,
        note: restore && !restore.metadataVerifiedAt && !backupItem ? $t('frameleaf_overview_never_tested') : undefined,
        href: commandCenterUrl('backups'),
      },
      {
        id: 'storage',
        icon: mdiHarddisk,
        name: $t('frameleaf_overview_check_storage'),
        detail: $t('frameleaf_overview_check_storage_detail'),
        tone: itemOf('storage') ? (itemOf('storage')!.level === 'now' ? 'bad' : 'warn') : disk ? 'good' : 'off',
        status: disk ? $t('frameleaf_overview_free', { values: { size: size(disk.diskAvailableRaw) } }) : unread,
        note: disk ? $t('frameleaf_overview_full', { values: { percent: used } }) : undefined,
        href: commandCenterUrl('storage'),
      },
      {
        id: 'ai',
        icon: mdiImageSearchOutline,
        name: $t('frameleaf_overview_check_ai'),
        detail: $t('frameleaf_overview_check_ai_detail'),
        tone: aiState === 'reachable' ? 'good' : aiState === 'unreachable' ? 'bad' : 'off',
        status: aiState ? $t(`frameleaf_overview_ai_${aiState}` as Translations) : unread,
        href: commandCenterUrl('intelligence'),
      },
      {
        id: 'work',
        icon: mdiProgressClock,
        name: $t('frameleaf_overview_check_work'),
        detail: $t('frameleaf_overview_check_work_detail'),
        tone: workItem ? 'warn' : checkOf('work') === 'ok' ? 'good' : 'off',
        status: workItem
          ? $t('frameleaf_overview_failed_count', { values: { count: workItem.work?.count ?? 0 } })
          : checkOf('work') === 'ok'
            ? $t('frameleaf_overview_nothing_failed')
            : unread,
        href: commandCenterUrl('processing', 'queues'),
      },
      {
        id: 'server',
        icon: mdiServerOutline,
        name: $t('frameleaf_overview_check_server'),
        detail: about ? $t('frameleaf_overview_version', { values: { version: about.version } }) : '',
        tone: versionItem ? 'warn' : 'good',
        status: $t('frameleaf_overview_running'),
        note: versionItem
          ? $t('frameleaf_overview_update_ready', { values: { version: versionItem.version?.available ?? '' } })
          : $t('frameleaf_overview_up_to_date'),
        href: commandCenterUrl('server', 'version-check'),
      },
      {
        id: 'cloud',
        icon: mdiCloudOutline,
        name: $t('frameleaf_settings_area_cloud'),
        detail: $t('frameleaf_overview_check_cloud_detail'),
        tone: !cloud?.configured ? 'off' : cloud.attention ? 'bad' : cloud.link === 'linked' ? 'good' : 'off',
        status: !cloud
          ? unread
          : !cloud.configured
            ? $t('frameleaf_cc_cloud_not_set_up')
            : $t(`frameleaf_cc_cloud_link_${cloud.link}` as Translations),
        note: cloud?.configured ? $t(`frameleaf_cc_cloud_plan_${cloud.plan}` as Translations) : undefined,
        href: commandCenterUrl('cloud'),
      },
      {
        id: 'phones',
        icon: mdiCellphone,
        name: $t('frameleaf_overview_check_phones'),
        detail: $t('frameleaf_overview_check_phones_detail'),
        tone: !phones || phones.length === 0 ? 'off' : behind.length > 0 ? 'warn' : 'good',
        status: !phones
          ? unread
          : phones.length === 0
            ? $t('frameleaf_overview_phones_none')
            : behind.length > 0
              ? $t('frameleaf_overview_phones_behind', { values: { count: behind.length } })
              : $t('frameleaf_overview_up_to_date'),
        note: !phones
          ? undefined
          : phones.length === 0
            ? $t('frameleaf_overview_phones_none_note')
            : behind.length > 0
              ? $t('frameleaf_overview_phones_behind_note', {
                  values: { name: behind[0].displayName, count: behind[0].quietForDays ?? 0 },
                })
              : $t('frameleaf_overview_phones_ok_note', { values: { count: phones.length } }),
        // FL-540: the phones list; with no phone yet, getting the app
        href:
          phones && phones.length > 0
            ? commandCenterUrl('backup', 'devices-backup')
            : commandCenterUrl('utilities', 'downloads'),
      },
      {
        id: 'night',
        icon: mdiWeatherNight,
        name: $t('frameleaf_overview_check_night'),
        detail: $t('frameleaf_overview_check_night_detail'),
        tone: night ? (night.problem ? 'warn' : 'good') : 'off',
        status: !overnight
          ? unread
          : overnight.run
            ? $t('frameleaf_overview_night_running')
            : lastNight && night
              ? night.problem
                ? $t('frameleaf_overview_night_not_finished', { values: { count: night.notFinished.length } })
                : $t('frameleaf_overnight_finished_at', { values: { time: time(lastNight.finishedAt) } })
              : $t('frameleaf_overview_night_first'),
        note: overnight?.nextRunAt
          ? $t('frameleaf_overview_night_next', { values: { time: time(overnight.nextRunAt) } })
          : undefined,
        href: commandCenterUrl('processing', 'nightly-tasks'),
      },
      {
        id: 'studio',
        icon: mdiMovieOpenOutline,
        name: $t('frameleaf_overview_check_studio'),
        detail: $t('frameleaf_overview_check_studio_detail'),
        tone: studioNeedsComputer ? 'off' : studioReady ? 'good' : 'off',
        status: !compatibility
          ? unread
          : studioNeedsComputer
            ? $t('frameleaf_overview_needs_computer')
            : $t('frameleaf_overview_ready'),
        href: commandCenterUrl('processing', 'computers'),
      },
    ];
  });

  // ---- storage ----
  const breakdown = $derived(report?.host.breakdown ?? null);
  const perDay = $derived(report ? growthPerDay(report.series) : null);
  const room = $derived(storage ? roomLeft(storage.diskAvailableRaw, perDay) : null);
  const storageFacts = $derived.by(() => {
    if (!storage) {
      return [];
    }
    const previews =
      breakdown && breakdown.previewsBytes !== null && breakdown.encodedVideoBytes !== null
        ? size(breakdown.previewsBytes + breakdown.encodedVideoBytes)
        : $t('frameleaf_overview_measured_tonight');
    return [
      {
        label: $t('frameleaf_overview_your_photos'),
        value: report ? size(report.summary.physicalBytes) : unread,
        detail: report ? $t('frameleaf_overview_items', { values: { count: report.summary.items } }) : undefined,
      },
      { label: $t('frameleaf_overview_previews'), value: previews, detail: $t('frameleaf_overview_previews_detail') },
      {
        label: $t('frameleaf_overview_everything_else'),
        value: breakdown ? size(breakdown.databaseBytes + breakdown.otherBytes) : unread,
        detail: $t('frameleaf_overview_everything_else_detail'),
      },
      {
        label: $t('frameleaf_overview_free_label'),
        value: size(storage.diskAvailableRaw),
        detail: $t('frameleaf_overview_full', { values: { percent: Math.round(storage.diskUsagePercentage) } }),
      },
    ];
  });

  const hasGrowth = $derived(!!report?.series.some((row) => row.items !== null));

  const dismiss = async (id: string) => {
    try {
      attention = await setAttentionDismissed({ attentionDismissDto: { id, dismissed: true } });
      said = $t('frameleaf_overview_said_dismissed');
    } catch {
      said = $t('frameleaf_overview_said_not_dismissed');
    }
  };
  const checkAgain = async () => {
    await load();
    said = $t('frameleaf_overview_said_checked');
  };
  const countNow = async () => {
    try {
      await createJob({ jobCreateDto: { name: ManualJobName.AnalyticsCollect } });
      said = $t('frameleaf_overview_said_counting');
    } catch {
      said = $t('frameleaf_overview_said_not_counting');
    }
  };
</script>

<KitPage>
  {#if said}
    <Said message={said} onDismiss={() => (said = '')} />
  {/if}

  {#if failed}
    <InlineError message={$t('frameleaf_cc_section_load_failed')} onRetry={load} />
  {:else if !attention && loading}
    <div role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="12rem" />
    </div>
  {:else}
    <Hero
      tone={level === 'urgent' ? 'bad' : level === 'attention' ? 'warn' : 'good'}
      icon={level === 'ok' ? mdiCheckCircleOutline : mdiAlertCircleOutline}
      title={heroTitle}
      body={heroBody}
      label={$t('frameleaf_overview_status')}
    >
      {#snippet actions()}
        <Button disabled={loading} onclick={checkAgain}
          ><Icon icon={mdiRefresh} size="1em" aria-hidden />{$t('frameleaf_overview_check_again')}</Button
        >
      {/snippet}
      {#if needs.length > 0}
        <ul class="needs" aria-label={$t('frameleaf_overview_needs_label')}>
          {#each needs as need, index (need.id)}
            <li class="need" class:is-now={need.level === 'now'} class:is-look={need.level === 'look'}>
              <span class="need-icon"><Icon icon={need.icon} size="1.375rem" aria-hidden /></span>
              <div class="need-words">
                <strong>{need.title}</strong>
                <span>{need.body}</span>
              </div>
              <Pill tone={need.level === 'now' ? 'bad' : need.level === 'look' ? 'warn' : 'off'}
                >{$t(
                  need.level === 'now'
                    ? 'frameleaf_attention_level_now'
                    : need.level === 'look'
                      ? 'frameleaf_attention_level_soon'
                      : 'frameleaf_overview_level_optional',
                )}</Pill
              >
              <div class="need-buttons">
                {#each need.actions as action, actionIndex (action.href)}
                  <a class="fl-control button" class:primary={index === 0 && actionIndex === 0} href={action.href}
                    >{action.label}</a
                  >
                {/each}
                <!-- UI review 2026-10-30 #17: one "Check again", on the status above, not one per row too. -->
                {#if need.dismiss}
                  <Button onclick={() => dismiss(need.id)}>{$t('frameleaf_overview_dismiss')}</Button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </Hero>

    <Section title={$t('frameleaf_overview_checked_title')} description={$t('frameleaf_overview_checked_description')}>
      <ItemList>
        {#each checks as check (check.id)}
          <Item
            icon={check.icon}
            quiet={check.tone === 'off'}
            name={check.name}
            detail={check.detail}
            tone={check.tone}
            status={check.status}
            note={check.note}
          >
            {#snippet action()}
              <a
                class="fl-control button"
                href={check.href}
                aria-label={$t('frameleaf_overview_open_named', { values: { name: check.name } })}
                >{$t('frameleaf_overview_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></a
              >
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    </Section>

    {#if storage}
      <Section
        title={$t('frameleaf_overview_storage_title')}
        description={room
          ? $t(`frameleaf_overview_room_${room.unit}` as Translations, { values: { count: room.count } })
          : $t('frameleaf_overview_room_unknown')}
      >
        {#snippet action()}
          <a class="fl-control button" href={commandCenterUrl('storage')}>{$t('frameleaf_overview_manage_storage')}</a>
        {/snippet}
        <Meter
          label={$t('frameleaf_overview_storage_meter')}
          value={$t('frameleaf_overview_used', { values: { size: size(storage.diskUseRaw) } })}
          max={$t('frameleaf_overview_of_free', {
            values: { total: size(storage.diskSizeRaw), free: size(storage.diskAvailableRaw) },
          })}
          fraction={storage.diskSizeRaw > 0 ? storage.diskUseRaw / storage.diskSizeRaw : undefined}
        />
        <Facts rows={storageFacts} />
        <p class="hint">{$t('frameleaf_overview_storage_hint')}</p>
      </Section>
    {/if}

    <Section
      title={$t('frameleaf_overview_library_title')}
      description={report
        ? $t('frameleaf_overview_library_description', { values: { count: report.summary.items } })
        : ''}
    >
      {#snippet action()}
        <a class="fl-control button" href={commandCenterUrl('analytics')}>{$t('frameleaf_overview_open_analytics')}</a>
      {/snippet}
      {#if report && hasGrowth}
        <div class="chart">
          <AnalyticsChart
            compact
            kind="line"
            title={$t('frameleaf_overview_library_title')}
            labels={report.series.map((row) => row.key)}
            datasets={[{ label: $t('frameleaf_overview_items_label'), values: report.series.map((row) => row.items) }]}
            unit=""
          />
        </div>
      {:else}
        <div class="pad">
          <Notice title={$t('frameleaf_overview_growth_tomorrow')}>
            {#snippet action()}
              <Button onclick={countNow}>{$t('frameleaf_overview_count_now')}</Button>
            {/snippet}
            {$t('frameleaf_overview_growth_tomorrow_body')}
          </Notice>
        </div>
      {/if}
    </Section>
  {/if}
</KitPage>

<style>
  .needs {
    display: grid;
    margin: 0;
    padding: 0 var(--fl-space-6);
    list-style: none;
    border-top: 1px solid var(--fl-border);
  }
  .need {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: var(--fl-space-3) var(--fl-space-4);
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .need:first-child {
    border-top: 0;
  }
  .need-icon {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border-radius: var(--fl-radius-control);
  }
  .is-now .need-icon {
    color: var(--fl-danger);
    background: color-mix(in srgb, var(--fl-danger) 14%, transparent);
  }
  .is-look .need-icon {
    color: var(--fl-warning);
    background: color-mix(in srgb, var(--fl-warning) 16%, transparent);
  }
  .need-words {
    display: grid;
    gap: var(--fl-space-1);
    min-width: 0;
  }
  .need-words span {
    max-width: 600px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .need-buttons {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .button {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-4);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .button:hover {
    background: var(--fl-hover, var(--fl-raised));
  }
  .button.primary {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .hint {
    margin: 0;
    padding: var(--fl-space-3) 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .chart,
  .pad {
    padding-bottom: var(--fl-space-5);
  }
  @container kit (max-width: 860px) {
    .need {
      grid-template-columns: 44px minmax(0, 1fr);
    }
    .need > :global(.pill),
    .need-buttons {
      grid-column: 2;
      justify-content: flex-start;
    }
  }
  @container kit (max-width: 620px) {
    .needs {
      padding: 0 var(--fl-space-4);
    }
  }
</style>
