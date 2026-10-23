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
   * - `machineLearning.duplicateDetection.enhancedVideo.enabled`, `.frameCount`, `.minMatchingFrames`
   *   and `.maxDistance`: the video comparison, its numbers under Advanced.
   * - `machineLearning.duplicateDetection.preferOriginalFormat` is deprecated and always on: camera
   *   originals are always suggested first, so it is said as a promise, not a switch.
   *
   * Storing identical files once has no off position in the app (owner, 10 October: "Take no action"),
   * so it is a promise too. FL-413 merges identical files automatically for the whole server; the old
   * per-account "Merge older copies" is retired, and its status block comes with FL-416.
   *
   * Left for later (server work): a count of look-alike groups for each choice, a time estimate for
   * comparing again, and starting that comparison from the save.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import { ALIKE_CHOICES, alikeChoiceOf } from '$lib/components/frameleaf/settings/care/duplicates';
  import Explain from '$lib/components/frameleaf/settings/intelligence/Explain.svelte';
  import Figure from '$lib/components/frameleaf/settings/intelligence/Figure.svelte';
  import MasterOff from '$lib/components/frameleaf/settings/intelligence/MasterOff.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Coverage from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Promises from '$lib/components/frameleaf/settings/kit/Promises.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { getSummary } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiContentCopy,
    mdiImageMultipleOutline,
    mdiShieldCheckOutline,
    mdiStarOutline,
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

  onMount(() => {
    getSummary({})
      .then((summary) => (groups = summary.queues.duplicates))
      .catch(() => (groups = null));
  });

  const waiting = $derived(looking && groups ? groups : 0);

  const hero = $derived.by(() => {
    if (waiting > 0) {
      return {
        icon: mdiContentCopy,
        title: $t('frameleaf_dupes_hero_once'),
        body: $t('frameleaf_dupes_hero_once_groups_body', { values: { count: waiting } }),
      };
    }
    if (looking) {
      return {
        icon: mdiCheckCircleOutline,
        title: $t('frameleaf_dupes_hero_clear'),
        body: $t('frameleaf_dupes_hero_clear_body'),
      };
    }
    return {
      icon: mdiContentCopy,
      title: $t('frameleaf_dupes_hero_once'),
      body: $t('frameleaf_dupes_hero_once_off_body'),
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

  const alikeHelp = $derived(
    alike === 'custom'
      ? $t('frameleaf_dupes_how_alike_custom_help', { values: { distance: dupes.maxDistance } })
      : $t(`frameleaf_dupes_how_alike_${alike}_help` as Translations),
  );

  const advancedOpen = $derived(page.url.searchParams.get('section') === 'advanced-duplicate-matching');
</script>

<KitPage>
  <Hero
    tone={waiting > 0 ? 'warn' : 'good'}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_dupes_status')}
  >
    {#snippet actions()}
      {#if waiting > 0}
        <Button variant="primary" onclick={openReview}>{$t('frameleaf_dupes_review')}</Button>
      {/if}
    {/snippet}
    <Coverage
      rows={[
        {
          icon: mdiContentCopy,
          name: $t('frameleaf_dupes_exact'),
          detail: $t('frameleaf_dupes_exact_detail'),
          tone: 'good',
          value: $t('frameleaf_dupes_exact_stored_once'),
          note: $t('frameleaf_dupes_exact_automatic'),
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

  <Section title={$t('frameleaf_dupes_exact')} description={$t('frameleaf_dupes_exact_description')}>
    <Promises
      rows={[
        {
          icon: mdiContentCopy,
          text: $t('frameleaf_dupes_promise_once'),
          detail: $t('frameleaf_dupes_promise_once_detail'),
        },
        {
          icon: mdiShieldCheckOutline,
          text: $t('frameleaf_dupes_promise_in_use'),
          detail: $t('frameleaf_dupes_promise_in_use_detail'),
        },
      ]}
    />
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
        <Notice tone="warn" title={$t('frameleaf_dupes_recompare_title')}>
          {$t('frameleaf_dupes_recompare_body')}
          {#snippet action()}
            <Button onclick={() => goto(commandCenterUrl('processing', 'queues'))}>
              {$t('frameleaf_dupes_background_work')}
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
      <Row label={$t('frameleaf_dupes_frames')} help={$t('frameleaf_dupes_frames_help')}>
        <Amount
          label={$t('frameleaf_dupes_frames')}
          unit={$t('frameleaf_dupes_unit_moments')}
          min={2}
          max={8}
          value={dupes.enhancedVideo.frameCount}
          disabled={disabled || !looking || !dupes.enhancedVideo.enabled}
          onChange={(value) => {
            const video = settingsDraft.draft.machineLearning.duplicateDetection.enhancedVideo;
            video.frameCount = value;
            if (video.minMatchingFrames > value) {
              video.minMatchingFrames = value;
            }
          }}
        />
      </Row>
      <Row label={$t('frameleaf_dupes_matching')} help={$t('frameleaf_dupes_matching_help')}>
        <Amount
          label={$t('frameleaf_dupes_matching')}
          unit={$t('frameleaf_dupes_unit_moments')}
          min={1}
          max={dupes.enhancedVideo.frameCount}
          value={dupes.enhancedVideo.minMatchingFrames}
          disabled={disabled || !looking || !dupes.enhancedVideo.enabled}
          onChange={(value) =>
            (settingsDraft.draft.machineLearning.duplicateDetection.enhancedVideo.minMatchingFrames = value)}
        />
      </Row>
      <Row label={$t('frameleaf_dupes_video_distance')} help={$t('frameleaf_dupes_video_distance_help')}>
        <Figure
          label={$t('frameleaf_dupes_video_distance')}
          unit={$t('frameleaf_dupes_unit_distance')}
          min={0.001}
          max={0.1}
          step={0.0005}
          value={dupes.enhancedVideo.maxDistance}
          disabled={disabled || !looking || !dupes.enhancedVideo.enabled}
          onChange={(value) =>
            (settingsDraft.draft.machineLearning.duplicateDetection.enhancedVideo.maxDistance = value)}
        />
      </Row>
    </Advanced>
  </Section>
</KitPage>
