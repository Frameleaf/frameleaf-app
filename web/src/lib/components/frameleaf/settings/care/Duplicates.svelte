<script lang="ts">
  /**
   * Library care › Duplicates (FL-366, after the approved prototype `settings-v2/care/duplicates.jsx`):
   * one page for exact copies, which Frameleaf stores once by itself, and look-alike photos, where the
   * person chooses. It replaces the "Duplicate Detection" group of the old machine-learning page and
   * the "Group near-duplicates for review" switch of Repair suggestions.
   *
   * Server settings it edits (through the shared draft):
   * - `machineLearning.duplicateDetection.enabled` and `libraryCare.duplicateReview`: one switch,
   *   "Find look-alike photos", which is on only while both are on and writes both.
   * - `machineLearning.duplicateDetection.maxDistance`: "How alike they must be" (see ./duplicates.ts),
   *   and the photo distance under Advanced.
   * - `machineLearning.duplicateDetection.enhancedVideo.enabled`, `.minMatchFraction` and
   *   `.maxHashDistance`: the video comparison (FL-651: whole timelines lined up), its numbers under
   *   Advanced. `enhancedVideo.frameCount`, `enhancedVideo.minMatchingFrames` and
   *   `enhancedVideo.maxDistance` are deprecated: the sampled frames they tuned are no longer made.
   * - `machineLearning.duplicateDetection.preferOriginalFormat` is deprecated and always on: camera
   *   originals are always suggested first, so it is said as a promise, not a switch.
   *
   * Storing identical files once has no off position in the app (owner, 10 October: "Take no action").
   * FL-413 merges identical files automatically for the whole server; FL-416 (the approved FL-415
   * prototype) says how that stands in "Identical files are stored once": the space saved (Library
   * analytics), the last check and "Check again" (`getIdenticalFilesStatus`, `checkIdenticalFiles`), the
   * extra copies waiting in Unused files, and the files the check skipped, in three kinds: unreadable,
   * changed while it was being read, and in folders Frameleaf never changes (external libraries).
   * Unused files opens only for the server owner (`unusedFilesAccess`).
   *
   * FL-520: each "How alike" choice says about how many groups it makes in this library, and changing it
   * says, before saving, how long comparing every photo again takes, with "Save and start tonight",
   * "Save and start now" and "Undo" (`getDuplicateEstimate`, `recompareDuplicates`). Extra copies already
   * on the drive are counted without a run (`getIdenticalFilesExtraCopies`) and said under the facts.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import { ALIKE_CHOICES, alikeChoiceOf, aboutDuration } from '$lib/components/frameleaf/settings/care/duplicates';
  import Explain from '$lib/components/frameleaf/settings/intelligence/Explain.svelte';
  import Figure from '$lib/components/frameleaf/settings/intelligence/Figure.svelte';
  import MasterOff from '$lib/components/frameleaf/settings/intelligence/MasterOff.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Coverage from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Promises from '$lib/components/frameleaf/settings/kit/Promises.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { identicalProblems, PROBLEM_COPY } from '$lib/components/frameleaf/settings/care/identical-files';
  import { backupWhen } from '$lib/frameleaf/backup-overview';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { unusedFilesAccess } from '$lib/frameleaf/unused-files.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AnalyticsRange,
    checkIdenticalFiles,
    DuplicateRecompareWhen,
    getAllLibraries,
    getAnalyticsReport,
    getDuplicateEstimate,
    getIdenticalFilesExtraCopies,
    getIdenticalFilesStatus,
    getSummary,
    recompareDuplicates,
    type AnalyticsReportResponseDto,
    type DuplicateEstimateResponseDto,
    type IdenticalFilesExtraCopiesDto,
    type IdenticalFilesStatusDto,
    type LibraryResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiContentCopy,
    mdiFileAlertOutline,
    mdiFolderNetworkOutline,
    mdiImageMultipleOutline,
    mdiRefresh,
    mdiShieldCheckOutline,
    mdiStarOutline,
    mdiVideoOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const ml = $derived(settingsDraft.draft.machineLearning);
  const dupes = $derived(settingsDraft.draft.machineLearning.duplicateDetection);
  const saved = $derived(settingsDraft.baseline.machineLearning.duplicateDetection);
  const review = $derived(settingsDraft.draft.libraryCare?.duplicateReview ?? false);

  /** Look-alikes are only found while both of today's switches are on. */
  const looking = $derived(dupes.enabled && review);
  const alike = $derived(alikeChoiceOf(dupes.maxDistance));
  const distanceChanged = $derived(dupes.maxDistance !== saved.maxDistance);

  /** Look-alike groups waiting in this account's review. */
  let groups = $state<number | null>(null);

  /** FL-520: groups for each choice and the time comparing again takes; extra copies on the drive. */
  let estimate = $state<DuplicateEstimateResponseDto>();
  let extra = $state<IdenticalFilesExtraCopiesDto>();
  let said = $state('');
  let saving = $state(false);

  /** FL-416: where the identical-files check stands, the space it saves and the folders it never changes. */
  let status = $state<IdenticalFilesStatusDto>();
  let report = $state<AnalyticsReportResponseDto>();
  let external = $state<LibraryResponseDto[]>([]);
  let checking = $state(false);

  const readStatus = async () => {
    try {
      status = await getIdenticalFilesStatus();
    } catch {
      // the facts say the check has not been read
    }
  };

  onMount(() => {
    void unusedFilesAccess.loadForCurrentUser();
    void readStatus();
    void (async () => {
      try {
        report = await getAnalyticsReport({ scope: 'all', range: AnalyticsRange.Year });
      } catch {
        // the space saved is left out
      }
    })();
    void (async () => {
      try {
        external = (await getAllLibraries({})).filter((library) => !library.deletedAt);
      } catch {
        external = [];
      }
    })();
  });

  // A check in progress: read where it stands again every few seconds until it finishes.
  $effect(() => {
    if (status?.status !== 'running') {
      return;
    }
    const timer = setInterval(() => void readStatus(), 5000);
    return () => clearInterval(timer);
  });

  onMount(() => {
    getSummary({})
      .then((summary) => (groups = summary.queues.duplicates))
      .catch(() => (groups = null));
    void (async () => {
      try {
        estimate = await getDuplicateEstimate({ maxDistances: ALIKE_CHOICES.map((choice) => choice.maxDistance) });
      } catch {
        // without an estimate the choices say only what each one means
      }
    })();
    void (async () => {
      try {
        extra = await getIdenticalFilesExtraCopies();
      } catch {
        // the row is left out
      }
    })();
  });

  const groupsFor = (maxDistance: number) =>
    estimate?.choices.find((choice) => Math.abs(choice.maxDistance - maxDistance) < 1e-9)?.groups;

  const duration = $derived(estimate ? aboutDuration(estimate.seconds) : undefined);
  const recompareTitle = $derived(
    estimate && duration
      ? $t('frameleaf_dupes_recompare_estimate_title', {
          values: { count: estimate.comparable, duration: $t(duration.key, { values: duration.values }) },
        })
      : $t('frameleaf_dupes_recompare_title'),
  );

  /** Save "How alike", then compare every photo again tonight or now. */
  const saveAndCompare = async (when: DuplicateRecompareWhen) => {
    saving = true;
    try {
      if (!(await settingsDraft.saveKeys(['machineLearning', 'libraryCare']))) {
        return;
      }
      await recompareDuplicates({ duplicateRecompareDto: { when } });
      said =
        when === DuplicateRecompareWhen.Now && duration
          ? $t('frameleaf_dupes_recompare_said_now', {
              values: { duration: $t(duration.key, { values: duration.values }) },
            })
          : when === DuplicateRecompareWhen.Now
            ? $t('frameleaf_dupes_recompare_said_now_unknown')
            : $t('frameleaf_dupes_recompare_said_tonight');
    } catch (error) {
      handleError(error, $t('frameleaf_dupes_recompare_failed'));
    } finally {
      saving = false;
    }
  };

  /** "Check again": read every file again. A check in progress carries on instead. */
  const checkAgain = async () => {
    checking = true;
    try {
      status = await checkIdenticalFiles();
      said = $t('frameleaf_dupes_check_started');
    } catch (error) {
      handleError(error, $t('frameleaf_dupes_extra_failed'));
    } finally {
      checking = false;
    }
  };

  const waiting = $derived(looking && groups ? groups : 0);
  const savedSize = $derived(report ? formatBytes(report.summary.savedBytes, $locale) : undefined);
  const running = $derived(status?.status === 'running');
  /** The files the last check skipped, by kind (./identical-files.ts). Nothing was merged on a guess. */
  const problems = $derived(identicalProblems(status?.problems ?? []));
  const problemCount = $derived(problems.reduce((sum, problem) => sum + problem.count, 0));
  const merges = $derived(status ? status.counts.photosMerged + status.counts.linked : 0);
  const finishedAt = $derived(status?.finishedAt ? new Date(status.finishedAt) : undefined);
  const lastChecked = $derived.by(() => {
    if (running) {
      return $t('frameleaf_dupes_checking_now');
    }
    if (!finishedAt) {
      return $t('frameleaf_dupes_not_checked');
    }
    const words = backupWhen(finishedAt, { locale: $locale });
    return $t(words.key, { values: words.values });
  });

  const hero = $derived.by(() => {
    if (problemCount > 0) {
      return {
        tone: 'warn' as const,
        icon: mdiContentCopy,
        title: $t('frameleaf_dupes_hero_problems', { values: { count: problemCount } }),
        body: savedSize
          ? $t('frameleaf_dupes_hero_problems_body', { values: { size: savedSize } })
          : $t('frameleaf_dupes_hero_problems_body_unsized'),
      };
    }
    if (waiting > 0) {
      return {
        tone: 'good' as const,
        icon: mdiContentCopy,
        title: $t('frameleaf_dupes_hero_once'),
        body: savedSize
          ? $t('frameleaf_dupes_hero_saved_groups_body', { values: { count: waiting, size: savedSize } })
          : $t('frameleaf_dupes_hero_once_groups_body', { values: { count: waiting } }),
      };
    }
    if (looking) {
      return {
        tone: 'good' as const,
        icon: mdiCheckCircleOutline,
        title: $t('frameleaf_dupes_hero_clear'),
        body: savedSize
          ? $t('frameleaf_dupes_hero_saved_clear_body', { values: { size: savedSize } })
          : $t('frameleaf_dupes_hero_clear_body'),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiContentCopy,
      title: $t('frameleaf_dupes_hero_once'),
      body: savedSize
        ? $t('frameleaf_dupes_hero_saved_off_body', { values: { size: savedSize } })
        : $t('frameleaf_dupes_hero_once_off_body'),
    };
  });

  const openReview = () => goto(Route.duplicatesUtility());

  const setLooking = (value: boolean) => {
    settingsDraft.draft.machineLearning.duplicateDetection.enabled = value;
    // The server always sends `libraryCare`; the DTO marks it optional only because it has a default.
    const care = settingsDraft.draft.libraryCare;
    if (care) {
      care.duplicateReview = value;
    }
  };

  const alikeHelp = $derived.by(() => {
    if (alike === 'custom') {
      return $t('frameleaf_dupes_how_alike_custom_help', { values: { distance: dupes.maxDistance } });
    }
    const help = $t(`frameleaf_dupes_how_alike_${alike}_help` as Translations);
    const count = groupsFor(dupes.maxDistance);
    return count === undefined ? help : `${help} ${$t('frameleaf_dupes_how_alike_groups', { values: { count } })}`;
  });

  const advancedOpen = $derived(page.url.searchParams.get('section') === 'advanced-duplicate-matching');
</script>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />
  <Hero tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body} label={$t('frameleaf_dupes_status')}>
    {#snippet actions()}
      {#if waiting > 0}
        <Button variant={problemCount > 0 ? 'default' : 'primary'} onclick={openReview}
          >{$t('frameleaf_dupes_review')}</Button
        >
      {/if}
    {/snippet}
    <Coverage
      rows={[
        {
          icon: mdiContentCopy,
          name: $t('frameleaf_dupes_exact'),
          detail: $t('frameleaf_dupes_exact_detail'),
          tone: problemCount > 0 ? 'warn' : 'good',
          value:
            problemCount > 0
              ? $t('frameleaf_dupes_exact_not_checked', { values: { count: problemCount } })
              : $t('frameleaf_dupes_exact_stored_once'),
          note: savedSize
            ? $t('frameleaf_dupes_saved', { values: { size: savedSize } })
            : $t('frameleaf_dupes_exact_automatic'),
        },
        {
          icon: mdiImageMultipleOutline,
          name: $t('frameleaf_dupes_alike'),
          detail: $t('frameleaf_dupes_alike_detail'),
          tone: waiting > 0 || !looking ? 'off' : 'good',
          value: looking
            ? waiting > 0
              ? $t('frameleaf_dupes_alike_groups', { values: { count: waiting } })
              : $t('frameleaf_dupes_alike_none')
            : $t('frameleaf_dupes_alike_off'),
          note: looking ? $t('frameleaf_dupes_alike_you_choose') : $t('frameleaf_dupes_alike_not_looking'),
        },
      ]}
    />
  </Hero>

  <Section title={$t('frameleaf_dupes_once_title')} description={$t('frameleaf_dupes_exact_description')}>
    {#snippet action()}
      <Button disabled={disabled || checking || running} onclick={checkAgain}>
        <Icon icon={mdiRefresh} size="1em" aria-hidden />
        {running ? $t('frameleaf_dupes_checking') : $t('frameleaf_dupes_check_again')}
      </Button>
    {/snippet}
    <Facts
      rows={[
        {
          label: $t('frameleaf_dupes_fact_saved'),
          value: savedSize ?? $t('frameleaf_dupes_unread'),
          detail: report
            ? $t('frameleaf_dupes_fact_saved_detail', { values: { count: report.summary.duplicateReferences } })
            : undefined,
        },
        {
          label: $t('frameleaf_dupes_fact_checked'),
          value: lastChecked,
          detail:
            status && status.status !== 'never-run'
              ? $t('frameleaf_dupes_fact_checked_detail', { values: { count: status.totalOriginals } })
              : $t('frameleaf_dupes_fact_checked_tonight'),
        },
        {
          label: $t('frameleaf_dupes_fact_extra'),
          value: status
            ? $t('frameleaf_dupes_fact_extra_value', {
                values: {
                  count: status.counts.filesMovedToUnused,
                  size: formatBytes(status.counts.bytesMovedToUnused, $locale),
                },
              })
            : $t('frameleaf_dupes_unread'),
          detail: $t('frameleaf_dupes_fact_extra_detail'),
        },
      ]}
    />
    <Promises
      rows={[
        {
          icon: mdiShieldCheckOutline,
          text: $t('frameleaf_dupes_pledge'),
          detail: $t('frameleaf_dupes_pledge_detail'),
        },
      ]}
    />
    {#if extra && extra.files > 0 && !running}
      <Notice tone="warn" title={$t('frameleaf_dupes_extra')}>
        {$t('frameleaf_dupes_extra_found', {
          values: { files: extra.files, contents: extra.contents, size: formatBytes(extra.bytes, $locale) },
        })}
      </Notice>
    {/if}
    <Row
      label={$t('frameleaf_dupes_recent')}
      help={merges > 0
        ? $t('frameleaf_dupes_recent_help', { values: { count: merges } })
        : $t('frameleaf_dupes_recent_none')}
    >
      <Button onclick={openReview}>
        {$t('frameleaf_dupes_see_merges')}
        <Icon icon={mdiChevronRight} size="1em" aria-hidden={true} />
      </Button>
    </Row>
    <Row
      label={$t('frameleaf_dupes_extra_copies')}
      help={unusedFilesAccess.isOwner
        ? $t('frameleaf_dupes_extra_copies_help')
        : $t('frameleaf_dupes_extra_copies_help_owner')}
    >
      {#if unusedFilesAccess.isOwner}
        <Button onclick={() => goto(commandCenterUrl('care', 'unused-files'))}>
          {$t('frameleaf_unused_title')}
          <Icon icon={mdiChevronRight} size="1em" aria-hidden={true} />
        </Button>
      {/if}
    </Row>
    <div class="subhead">
      <strong>{$t('frameleaf_dupes_problems')}</strong>
      <span>
        {problemCount > 0
          ? $t('frameleaf_dupes_problems_some')
          : external.length > 0
            ? $t('frameleaf_dupes_problems_none_external')
            : $t('frameleaf_dupes_problems_none')}
      </span>
    </div>
    {#if problems.length > 0 || external.length > 0}
      <ItemList>
        {#each problems as problem (problem.kind)}
          <Item
            icon={problem.kind === 'changed' ? mdiVideoOutline : mdiFileAlertOutline}
            name={problem.name ?? $t(PROBLEM_COPY[problem.kind].count, { values: { count: problem.count } })}
            detail={problem.name
              ? $t(PROBLEM_COPY[problem.kind].count, { values: { count: problem.count } })
              : undefined}
            tone="warn"
            status={$t(PROBLEM_COPY[problem.kind].status)}
            note={$t(PROBLEM_COPY[problem.kind].note)}
          >
            {#snippet action()}
              {#if problem.kind === 'unreadable'}
                <Button onclick={() => goto(commandCenterUrl('care', 'integrity-checks'))}
                  >{$t('frameleaf_dupes_problem_file_checks')}</Button
                >
              {/if}
            {/snippet}
          </Item>
        {/each}
        {#each external as library (library.id)}
          <Item
            icon={mdiFolderNetworkOutline}
            name={$t('frameleaf_dupes_problem_external_name', { values: { name: library.name } })}
            detail={$t('frameleaf_dupes_problem_external_detail')}
            tone="off"
            status={$t('frameleaf_dupes_problem_external')}
            note={$t('frameleaf_dupes_problem_external_note')}
          />
        {/each}
      </ItemList>
    {/if}
  </Section>

  <Section title={$t('frameleaf_dupes_alike')} description={$t('frameleaf_dupes_alike_description')}>
    {#if !ml.enabled}
      <MasterOff />
    {:else if !ml.clip.enabled && looking}
      <Notice tone="warn" title={$t('frameleaf_dupes_visual_search_off_title')}>
        {$t('frameleaf_dupes_visual_search_off_body')}
        {#snippet action()}
          <Button onclick={() => goto(commandCenterUrl('intelligence', 'smart-search'))}>
            {$t('frameleaf_dupes_visual_search_open')}
          </Button>
        {/snippet}
      </Notice>
    {/if}
    <!-- One switch for libraryCare.duplicateReview and duplicateDetection.enabled together. -->
    <Row
      label={$t('frameleaf_dupes_find')}
      help={looking ? $t('frameleaf_dupes_find_on_help') : $t('frameleaf_dupes_find_off_help')}
    >
      <Switch label={$t('frameleaf_dupes_find')} checked={looking} held={disabled} onChange={setLooking} />
    </Row>
    {#if looking}
      <!-- duplicateDetection.maxDistance, as three choices. -->
      <Row label={$t('frameleaf_dupes_how_alike')} help={alikeHelp}>
        <SegmentedControl
          label={$t('frameleaf_dupes_how_alike')}
          value={alike}
          {disabled}
          options={[
            ...ALIKE_CHOICES.map((choice) => ({
              value: choice.id,
              label: $t(`frameleaf_dupes_how_alike_${choice.id}` as Translations),
            })),
            ...(alike === 'custom' ? [{ value: 'custom', label: $t('frameleaf_dupes_how_alike_custom') }] : []),
          ]}
          onChange={(value) => {
            const choice = ALIKE_CHOICES.find((item) => item.id === value);
            if (choice) {
              settingsDraft.draft.machineLearning.duplicateDetection.maxDistance = choice.maxDistance;
            }
          }}
        />
      </Row>
      {#if distanceChanged}
        <Notice tone="warn" title={recompareTitle}>
          {$t('frameleaf_dupes_recompare_estimate_body')}
          {#snippet action()}
            <Button disabled={saving || disabled} onclick={() => saveAndCompare(DuplicateRecompareWhen.Tonight)}>
              {$t('frameleaf_dupes_recompare_tonight')}
            </Button>
            <Button disabled={saving || disabled} onclick={() => saveAndCompare(DuplicateRecompareWhen.Now)}>
              {$t('frameleaf_dupes_recompare_now')}
            </Button>
            <Button
              onclick={() => (settingsDraft.draft.machineLearning.duplicateDetection.maxDistance = saved.maxDistance)}
            >
              {$t('frameleaf_dupes_undo')}
            </Button>
          {/snippet}
        </Notice>
      {/if}
      <!-- duplicateDetection.preferOriginalFormat is deprecated: originals are always suggested first. -->
      <Promises
        rows={[
          {
            icon: mdiStarOutline,
            text: $t('frameleaf_dupes_originals_promise'),
            detail: $t('frameleaf_dupes_originals_promise_detail'),
          },
        ]}
      />
      <Row label={$t('frameleaf_dupes_videos')} help={$t('frameleaf_dupes_videos_help')}>
        <Switch
          label={$t('frameleaf_dupes_videos')}
          checked={dupes.enhancedVideo.enabled}
          held={disabled}
          onChange={(value) => (settingsDraft.draft.machineLearning.duplicateDetection.enhancedVideo.enabled = value)}
        />
      </Row>
    {/if}
    <Row label={$t('frameleaf_dupes_visual_search')} help={$t('frameleaf_dupes_visual_search_help')}>
      <Button onclick={() => goto(commandCenterUrl('intelligence', 'smart-search'))}>
        {$t('frameleaf_dupes_visual_search_open')}
        <Icon icon={mdiChevronRight} size="1em" aria-hidden={true} />
      </Button>
    </Row>
    <Advanced summary={$t('frameleaf_dupes_advanced')} open={advancedOpen}>
      <Explain>{$t('frameleaf_dupes_advanced_explain')}</Explain>
      <Row label={$t('frameleaf_dupes_photo_distance')} help={$t('frameleaf_dupes_photo_distance_help')}>
        <Figure
          label={$t('frameleaf_dupes_photo_distance')}
          unit={$t('frameleaf_dupes_unit_distance')}
          min={0.001}
          max={0.1}
          step={0.0005}
          value={dupes.maxDistance}
          disabled={disabled || !looking}
          onChange={(value) => (settingsDraft.draft.machineLearning.duplicateDetection.maxDistance = value)}
        />
      </Row>
      <Row label={$t('frameleaf_dupes_video_match')} help={$t('frameleaf_dupes_video_match_help')}>
        <Amount
          label={$t('frameleaf_dupes_video_match')}
          unit={$t('frameleaf_dupes_unit_percent')}
          min={50}
          max={100}
          value={Math.round((dupes.enhancedVideo.minMatchFraction ?? 0.7) * 100)}
          disabled={disabled || !looking || !dupes.enhancedVideo.enabled}
          onChange={(value) =>
            (settingsDraft.draft.machineLearning.duplicateDetection.enhancedVideo.minMatchFraction = value / 100)}
        />
      </Row>
      <Row label={$t('frameleaf_dupes_video_difference')} help={$t('frameleaf_dupes_video_difference_help')}>
        <Amount
          label={$t('frameleaf_dupes_video_difference')}
          unit={$t('frameleaf_dupes_unit_of_64')}
          min={0}
          max={16}
          value={dupes.enhancedVideo.maxHashDistance ?? 8}
          disabled={disabled || !looking || !dupes.enhancedVideo.enabled}
          onChange={(value) =>
            (settingsDraft.draft.machineLearning.duplicateDetection.enhancedVideo.maxHashDistance = value)}
        />
      </Row>
    </Advanced>
  </Section>
</KitPage>

<style>
  /* settings-v2/care.css .care-subhead: a small heading inside a section, above a list of findings. */
  .subhead {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--fl-space-2) var(--fl-space-3);
    padding: var(--fl-space-5) 0;
    border-top: 1px solid var(--fl-border);
    font-size: var(--fl-font-small);
  }
  .subhead span {
    color: var(--fl-muted);
  }
</style>
