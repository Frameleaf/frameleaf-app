<script lang="ts">
  /**
   * Library care (FL-366, after the approved prototype `settings-v2/care/landing.jsx`): opens on the
   * answer to "is my library all right?", then the four pages with their own state, then the tools.
   *
   * An administrator sees the whole household: Library Care's findings across every account, and the
   * file checks' lists. A member sees their own library and no settings. FL-520: an administrator's
   * counts come from the server's one source of findings (`getIntegrityOverview`), where a photo both
   * checkers report is counted once; a member's from their own Library care queues.
   *
   * FL-416: after an Immich import, an administrator sees "Checking your Immich library" while the
   * identical-files check reads every imported file (`ImportCheck`). Duplicates says the space identical
   * files save. Unused files is among the tools only for the server owner (`unusedFilesAccess`).
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import ImportCheck from '$lib/components/frameleaf/settings/care/ImportCheck.svelte';
  import { showsImportCheck } from '$lib/components/frameleaf/settings/care/import-check';
  import Coverage from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links, { type LinkRow } from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { backupWhen } from '$lib/frameleaf/backup-overview';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { unusedFilesAccess } from '$lib/frameleaf/unused-files.svelte';
  import { libraryCareToolsFor, utilitiesUrl, type UtilityId } from '$lib/frameleaf/utilities';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AnalyticsRange,
    createJob,
    getAnalyticsReport,
    getAssetStatistics,
    getIdenticalFilesStatus,
    getIntegrityCheckRuns,
    getIntegrityOverview,
    getQueue,
    getServerStatistics,
    getSummary,
    ManualJobName,
    QueueName,
    updateQueue,
    type IdenticalFilesStatusDto,
    type IntegrityCheckRunsResponseDto,
    type IntegrityOverviewResponseDto,
    type MediaHealthSummaryResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiChevronRight,
    mdiClockOutline,
    mdiContentCopy,
    mdiFileAlertOutline,
    mdiFileCheckOutline,
    mdiFileQuestionOutline,
    mdiFileSearchOutline,
    mdiImageSearchOutline,
    mdiPlayOutline,
    mdiShieldAlertOutline,
    mdiShieldCheckOutline,
    mdiTrashCanOutline,
    mdiWrenchOutline,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  const isAdmin = $derived(authManager.user.isAdmin);

  let summary = $state<MediaHealthSummaryResponseDto>();
  let integrity = $state<IntegrityOverviewResponseDto>();
  let runs = $state<IntegrityCheckRunsResponseDto>();
  let total = $state<number>();
  let loaded = $state(false);
  let said = $state('');
  let starting = $state(false);

  /** FL-416: the identical-files check after an Immich import, and whether its queue is paused. */
  let identical = $state<IdenticalFilesStatusDto>();
  let checkPaused = $state(false);
  let pausing = $state(false);
  /** The space identical files save (Library analytics), for the Duplicates row. */
  let savedBytes = $state<number>();

  const readIdentical = async () => {
    try {
      const [status, queue] = await Promise.all([
        getIdenticalFilesStatus(),
        getQueue({ name: QueueName.StorageTemplateMigration }).catch(() => undefined),
      ]);
      identical = status;
      checkPaused = queue?.isPaused ?? false;
    } catch {
      identical = undefined;
    }
  };

  $effect(() => {
    if (!isAdmin) {
      return;
    }
    void unusedFilesAccess.loadForCurrentUser();
    void readIdentical();
    void getAnalyticsReport({ scope: 'all', range: AnalyticsRange.Year })
      .then((report) => (savedBytes = report.summary.savedBytes))
      .catch(() => (savedBytes = undefined));
  });

  // While the check runs, read where it stands again every few seconds.
  $effect(() => {
    if (!isAdmin || identical?.status !== 'running') {
      return;
    }
    const timer = setInterval(() => void readIdentical(), 5000);
    return () => clearInterval(timer);
  });

  const setCheckPaused = async (isPaused: boolean) => {
    pausing = true;
    try {
      const queue = await updateQueue({ name: QueueName.StorageTemplateMigration, queueUpdateDto: { isPaused } });
      checkPaused = queue.isPaused;
      said = isPaused ? $t('frameleaf_import_check_paused_said') : $t('frameleaf_import_check_resumed_said');
    } catch (error) {
      handleError(error, $t('frameleaf_import_check_pause_failed'));
    } finally {
      pausing = false;
    }
  };

  /** FL-520: the one source of findings, or nothing when it cannot be read. */
  const overviewOf = async () => {
    try {
      return await getIntegrityOverview();
    } catch {
      return undefined;
    }
  };

  $effect(() => {
    const admin = isAdmin;
    let current = true;
    loaded = false;
    void Promise.all([
      getSummary(admin ? { allAccounts: true } : {}).catch(() => undefined),
      admin ? overviewOf() : Promise.resolve(undefined),
      admin ? getIntegrityCheckRuns().catch(() => undefined) : Promise.resolve(undefined),
      admin
        ? getServerStatistics()
            .then((stats) => stats.photos + stats.videos)
            .catch(() => undefined)
        : getAssetStatistics({})
            .then((stats) => stats.total)
            .catch(() => undefined),
    ]).then(([care, reports, checks, count]) => {
      if (!current) {
        return;
      }
      summary = care;
      integrity = reports;
      runs = checks;
      total = count;
      loaded = true;
    });
    return () => {
      current = false;
    };
  });

  const queues = $derived(summary?.queues);
  // FL-520: one count per kind, from one source, for an administrator; a member's own queues otherwise.
  const missing = $derived(integrity ? integrity.missing : (queues?.missing ?? 0));
  const damaged = $derived(
    integrity ? integrity.damaged : (queues?.damagedConfirmed ?? 0) + (queues?.damagedSuspected ?? 0),
  );
  const stray = $derived(integrity?.stray ?? 0);
  const attention = $derived(missing + damaged + stray);
  const lookAlikes = $derived(queues?.duplicates ?? 0);
  const waiting = $derived(queues?.enrichmentPending ?? 0);

  /** When the files were last checked: the newest finished check this reader can see. */
  const lastChecked = $derived.by(() => {
    const times = [
      ...Object.values(runs ?? {}),
      summary?.runs.missing?.finishedAt ?? null,
      summary?.runs.corrupt?.finishedAt ?? null,
    ]
      .filter((value): value is string => typeof value === 'string')
      .map((value) => new Date(value).getTime())
      .filter((value) => Number.isFinite(value));
    return times.length > 0 ? new Date(Math.max(...times)) : undefined;
  });
  const when = (date: Date) => {
    const words = backupWhen(date, { locale: $locale, sentence: true });
    return $t(words.key, { values: words.values });
  };
  const whenShort = (date: Date) => {
    const words = backupWhen(date, { locale: $locale });
    return $t(words.key, { values: words.values });
  };

  const hero = $derived.by(() => {
    if (attention > 0) {
      return {
        tone: 'warn' as const,
        icon: mdiShieldAlertOutline,
        title: $t('frameleaf_carehome_hero_attention', { values: { count: attention } }),
        body: lastChecked
          ? $t('frameleaf_carehome_hero_attention_body', { values: { when: when(lastChecked) } })
          : $t('frameleaf_carehome_hero_attention_body_unchecked'),
      };
    }
    if (!lastChecked) {
      return {
        tone: 'good' as const,
        icon: mdiClockOutline,
        title: $t('frameleaf_carehome_hero_new'),
        body: $t('frameleaf_carehome_hero_new_body'),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiShieldCheckOutline,
      title: $t('frameleaf_carehome_hero_ok'),
      body:
        total === undefined
          ? $t('frameleaf_carehome_hero_ok_body_nocount', { values: { when: when(lastChecked) } })
          : $t(isAdmin ? 'frameleaf_carehome_hero_ok_body' : 'frameleaf_carehome_hero_ok_body_member', {
              values: { count: total, when: when(lastChecked) },
            }),
    };
  });

  const filesFact = $derived.by((): { tone: KitTone; value: string; note: string } => {
    if (attention > 0) {
      return {
        tone: 'warn',
        value: $t('frameleaf_carehome_files_attention', { values: { count: attention } }),
        note: lastChecked ? whenShort(lastChecked) : $t('frameleaf_carehome_first_check_tonight'),
      };
    }
    if (!lastChecked) {
      return {
        tone: 'off',
        value: $t('frameleaf_carehome_not_checked'),
        note: $t('frameleaf_carehome_first_check_tonight'),
      };
    }
    return { tone: 'good', value: $t('frameleaf_carehome_files_ok'), note: whenShort(lastChecked) };
  });
  const readingFact = $derived.by((): { tone: KitTone; value: string; note: string } =>
    waiting > 0
      ? {
          tone: 'good',
          value: $t('frameleaf_carehome_reading_waiting', { values: { count: waiting } }),
          note: $t('frameleaf_carehome_reading_waiting_note'),
        }
      : { tone: 'good', value: $t('frameleaf_carehome_reading_done'), note: $t('frameleaf_carehome_reading_none') },
  );

  /** What needs attention, one row per kind, each opening the place it is fixed. */
  const problems = $derived(
    [
      {
        id: 'missing',
        count: missing,
        icon: mdiFileQuestionOutline,
        name: $t('frameleaf_carehome_problem_missing', { values: { count: missing } }),
        status: $t('frameleaf_carehome_problem_missing_status'),
        button: $t('frameleaf_carehome_find_them'),
        href: isAdmin ? utilitiesUrl('missing-media', { from: 'care' }) : commandCenterUrl('care', 'repair'),
      },
      {
        id: 'damaged',
        count: damaged,
        icon: mdiFileAlertOutline,
        name: $t('frameleaf_carehome_problem_damaged', { values: { count: damaged } }),
        status: $t('frameleaf_carehome_problem_damaged_status'),
        button: $t('frameleaf_carehome_review'),
        href: isAdmin ? commandCenterUrl('care', 'integrity-checks') : commandCenterUrl('care', 'repair'),
      },
      {
        id: 'stray',
        count: stray,
        icon: mdiFileSearchOutline,
        name: $t('frameleaf_carehome_problem_stray', { values: { count: stray } }),
        status: $t('frameleaf_carehome_problem_stray_status'),
        button: $t('frameleaf_carehome_review'),
        href: commandCenterUrl('care', 'integrity-checks'),
      },
    ].filter((problem) => problem.count > 0),
  );

  const checkNow = async () => {
    starting = true;
    try {
      for (const name of [
        ManualJobName.IntegrityMissingFiles,
        ManualJobName.IntegrityChecksumMismatch,
        ManualJobName.IntegrityUntrackedFiles,
      ]) {
        await createJob({ jobCreateDto: { name } });
      }
      said = $t('frameleaf_carehome_check_started');
    } catch (error) {
      handleError(error, $t('frameleaf_carehome_check_failed'));
    } finally {
      starting = false;
    }
  };

  /**
   * The tools, in the prototype's order. Duplicate review is reached from Duplicates. FL-416: Unused files
   * is the server owner's alone, so only they see it here.
   */
  const TOOL_ORDER: UtilityId[] = ['live-photos', 'missing-media', 'corrupt-media'];
  const tools = $derived([
    ...TOOL_ORDER.flatMap((id) => libraryCareToolsFor(isAdmin).filter((tool) => tool.id === id)).map(
      (tool): LinkRow => ({
        icon: tool.icon,
        title: $t(tool.titleKey),
        body: $t(tool.descriptionKey),
        href: utilitiesUrl(tool.id, { from: 'care' }),
      }),
    ),
    ...(isAdmin && unusedFilesAccess.isOwner
      ? [
          {
            icon: mdiTrashCanOutline,
            title: $t('frameleaf_unused_title'),
            body: $t('frameleaf_unused_tool_description'),
            href: commandCenterUrl('care', 'unused-files'),
          },
        ]
      : []),
  ]);
  const recoveredAlbumId = $derived(
    identical?.recovered.find((entry) => entry.ownerId === authManager.user.id)?.albumId ?? undefined,
  );

  const open = (key: string) => goto(commandCenterUrl('care', key));
  const openLabel = (name: Translations) => $t('frameleaf_carehome_open_named', { values: { name: $t(name) } });
</script>

<KitPage>
  {#if said}
    <Said message={said} onDismiss={() => (said = '')} />
  {/if}

  <Hero
    tone={loaded ? hero.tone : 'quiet'}
    icon={hero.icon}
    title={loaded ? hero.title : $t('frameleaf_carehome_loading')}
    body={loaded ? hero.body : undefined}
    label={$t('frameleaf_carehome_hero_label')}
  >
    {#snippet actions()}
      {#if loaded && problems.length > 0}
        <Button
          variant="primary"
          onclick={() => goto(isAdmin ? commandCenterUrl('care', 'integrity-checks') : problems[0].href)}
        >
          {isAdmin ? $t('frameleaf_carehome_see_found') : $t('frameleaf_carehome_review_it')}
        </Button>
      {:else if loaded && isAdmin}
        <Button variant="primary" disabled={starting} onclick={checkNow}>
          <Icon icon={mdiPlayOutline} size="1em" aria-hidden />
          {$t('frameleaf_carehome_check_now')}
        </Button>
      {/if}
    {/snippet}
    {#if loaded}
      <Coverage
        rows={[
          {
            icon: mdiFileCheckOutline,
            name: $t('frameleaf_carehome_fact_files'),
            detail:
              total === undefined
                ? undefined
                : $t('frameleaf_carehome_fact_files_detail', { values: { count: total } }),
            tone: filesFact.tone,
            value: filesFact.value,
            note: filesFact.note,
          },
          {
            icon: mdiImageSearchOutline,
            name: $t('frameleaf_carehome_fact_reading'),
            detail: $t('frameleaf_carehome_fact_reading_detail'),
            tone: readingFact.tone,
            value: readingFact.value,
            note: readingFact.note,
          },
        ]}
      />
    {/if}
  </Hero>

  {#if isAdmin && identical && showsImportCheck(identical)}
    <ImportCheck
      status={identical}
      paused={checkPaused}
      busy={pausing}
      {recoveredAlbumId}
      onPause={() => setCheckPaused(true)}
      onResume={() => setCheckPaused(false)}
    />
  {/if}

  {#if problems.length > 0}
    <Section
      title={$t('frameleaf_carehome_attention_title')}
      description={$t('frameleaf_carehome_attention_description')}
    >
      <ItemList>
        {#each problems as problem (problem.id)}
          <Item icon={problem.icon} name={problem.name} tone="warn" status={problem.status}>
            {#snippet action()}
              <Button onclick={() => goto(problem.href)}>{problem.button}</Button>
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    </Section>
  {/if}

  <Section
    title={$t('frameleaf_carehome_look_after')}
    description={isAdmin ? $t('frameleaf_carehome_look_after_admin') : $t('frameleaf_carehome_look_after_member')}
  >
    <ItemList>
      {#if isAdmin}
        <Item
          icon={mdiFileSearchOutline}
          name={$t('frameleaf_carehome_row_checks')}
          detail={$t('frameleaf_carehome_row_checks_detail')}
          tone={loaded ? filesFact.tone : 'off'}
          status={loaded
            ? attention > 0
              ? $t('frameleaf_carehome_row_checks_found', { values: { count: attention } })
              : lastChecked
                ? $t('frameleaf_carehome_row_checks_ok')
                : $t('frameleaf_carehome_not_checked')
            : undefined}
          note={loaded ? filesFact.note : undefined}
        >
          {#snippet action()}
            <Button label={openLabel('frameleaf_carehome_row_checks')} onclick={() => open('integrity-checks')}>
              {$t('frameleaf_carehome_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
            </Button>
          {/snippet}
        </Item>
      {/if}
      <Item
        icon={mdiWrenchOutline}
        name={$t('frameleaf_carehome_row_fix')}
        detail={$t('frameleaf_carehome_row_fix_detail')}
        status={loaded
          ? missing + damaged > 0
            ? $t('frameleaf_carehome_row_fix_waiting', { values: { count: missing + damaged } })
            : $t('frameleaf_carehome_row_fix_none')
          : undefined}
        tone={missing + damaged > 0 ? 'warn' : 'good'}
        note={$t('frameleaf_carehome_row_fix_note')}
      >
        {#snippet action()}
          <Button label={openLabel('frameleaf_carehome_row_fix')} onclick={() => open('repair')}>
            {$t('frameleaf_carehome_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
          </Button>
        {/snippet}
      </Item>
      <Item
        icon={mdiContentCopy}
        name={$t('frameleaf_carehome_row_dupes')}
        detail={$t('frameleaf_carehome_row_dupes_detail')}
        tone="good"
        status={isAdmin && savedBytes !== undefined
          ? $t('frameleaf_carehome_row_dupes_status_saved', { values: { size: formatBytes(savedBytes, $locale) } })
          : $t('frameleaf_carehome_row_dupes_status')}
        note={loaded
          ? lookAlikes > 0
            ? $t('frameleaf_carehome_row_dupes_groups', { values: { count: lookAlikes } })
            : $t('frameleaf_carehome_row_dupes_none')
          : undefined}
      >
        {#snippet action()}
          <!-- A member has no duplicate settings: their row opens the review of their own look-alikes. -->
          <Button
            label={openLabel('frameleaf_carehome_row_dupes')}
            onclick={() => (isAdmin ? open('duplicates') : goto(utilitiesUrl('duplicates', { from: 'care' })))}
          >
            {$t('frameleaf_carehome_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
          </Button>
        {/snippet}
      </Item>
      {#if isAdmin}
        <Item
          icon={mdiImageSearchOutline}
          name={$t('frameleaf_carehome_row_progress')}
          detail={$t('frameleaf_carehome_row_progress_detail')}
          tone={readingFact.tone}
          status={loaded ? readingFact.value : undefined}
          note={loaded ? readingFact.note : undefined}
        >
          {#snippet action()}
            <Button label={openLabel('frameleaf_carehome_row_progress')} onclick={() => open('enrichment-care')}>
              {$t('frameleaf_carehome_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
            </Button>
          {/snippet}
        </Item>
      {/if}
    </ItemList>
  </Section>

  {#if tools.length > 0}
    <Section title={$t('frameleaf_carehome_tools')} description={$t('frameleaf_carehome_tools_description')}>
      <Links rows={tools} />
    </Section>
  {/if}
</KitPage>
