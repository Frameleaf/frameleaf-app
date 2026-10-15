<script lang="ts">
  /**
   * Search and recognition progress (FL-366, after the approved prototype `settings-v2/care/fixes.jsx`
   * `Progress`): what Frameleaf still has to read in the photos, one line per feature, and "Finish
   * now" when work is held. It replaces Library care → Enrichment completeness (two switches, a
   * paragraph and two buttons).
   *
   * The counts are the work queues the Job manager shows (`getQueues`): what is queued or being read
   * for each feature, plus Library Care's count of photos whose details have not been read yet. A
   * paused queue is the one held-up state the app knows; "Finish now" resumes it the way the Job
   * manager does, or queues the photo details still to read. How many photos each feature has
   * finished, and how long the rest will take, wait for the server (follow-up of FL-366).
   *
   * The two switches are today's settings in the prototype's words: "Keep what I wrote myself"
   * (`libraryCare.manualMetadata`) and "Redo only what changed" (`libraryCare.incrementalEnrichment`).
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { isFeatureOff, jobCounts, jobQueue } from '$lib/frameleaf/job-queues';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleResumeQueue } from '$lib/services/queue.service';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getQueues,
    getSummary,
    QueueCommand,
    QueueName,
    runQueueCommandLegacy,
    type QueueResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiCameraOutline,
    mdiCheckCircleOutline,
    mdiChevronRight,
    mdiCommentTextOutline,
    mdiFaceRecognition,
    mdiImageMultipleOutline,
    mdiImageSearchOutline,
    mdiPlayOutline,
    mdiProgressClock,
    mdiTextRecognition,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    /** How often the counts are read again; tests shorten it. */
    pollMs?: number;
  };
  let { pollMs = 5000 }: Props = $props();

  type FeatureId = 'search' | 'faces' | 'text' | 'captions' | 'details' | 'alike';
  type Feature = { id: FeatureId; icon: string; queues: QueueName[]; href?: string };

  /** In the prototype's order, with the photo details every other feature starts from. */
  const FEATURES: readonly Feature[] = [
    {
      id: 'search',
      icon: mdiImageSearchOutline,
      queues: [QueueName.SmartSearch],
      href: commandCenterUrl('intelligence', 'smart-search'),
    },
    {
      id: 'faces',
      icon: mdiFaceRecognition,
      queues: [QueueName.FaceDetection, QueueName.FacialRecognition],
      href: commandCenterUrl('intelligence', 'faces'),
    },
    {
      id: 'text',
      icon: mdiTextRecognition,
      queues: [QueueName.Ocr],
      href: commandCenterUrl('intelligence', 'documents'),
    },
    {
      id: 'captions',
      icon: mdiCommentTextOutline,
      queues: [QueueName.ImageDescription],
      href: commandCenterUrl('intelligence', 'descriptions'),
    },
    { id: 'details', icon: mdiCameraOutline, queues: [QueueName.MetadataExtraction] },
    {
      id: 'alike',
      icon: mdiImageMultipleOutline,
      queues: [QueueName.DuplicateDetection],
      href: commandCenterUrl('care', 'duplicates'),
    },
  ];
  const words = (id: FeatureId, part: string) => $t(`frameleaf_care_prog_${id}_${part}` as Translations);

  // ---- the settings ----
  const settingsDraft = requireSystemConfigDraft();
  const held = $derived(featureFlagsManager.value.configFile);
  const care = $derived(settingsDraft.draft.libraryCare);
  const setKeepMine = (value: boolean) => {
    const draft = settingsDraft.draft;
    if (draft.libraryCare) {
      draft.libraryCare.manualMetadata = value;
    }
  };
  const setOnlyChanged = (value: boolean) => {
    const draft = settingsDraft.draft;
    if (draft.libraryCare) {
      draft.libraryCare.incrementalEnrichment = value;
    }
  };

  // ---- the counts ----
  let queues = $state<QueueResponseDto[]>();
  /** Photos whose details have not been read yet (Library Care). */
  let detailsPending = $state(0);
  let loaded = $state(false);
  let said = $state('');
  let finishing = $state(false);

  const load = async () => {
    const [list, health] = await Promise.all([
      getQueues().catch(() => undefined),
      getSummary({ allAccounts: true }).catch(() => undefined),
    ]);
    queues = list;
    detailsPending = health?.queues.enrichmentPending ?? 0;
    loaded = true;
  };

  onMount(() => {
    void load();
    const interval = setInterval(() => void load(), pollMs);
    return () => clearInterval(interval);
  });

  type Progress = {
    off: boolean;
    paused: QueueName[];
    left: number;
    active: number;
    failed: number;
    /** The photo details still to read, when nothing has queued them yet. */
    unqueued: boolean;
  };

  const progressOf = (feature: Feature): Progress => {
    const flags = featureFlagsManager.value;
    const found = (queues ?? []).filter((queue) => feature.queues.includes(queue.name));
    const off = feature.queues.every((name) => {
      const definition = jobQueue(name);
      return definition ? isFeatureOff(definition, flags) : false;
    });
    let left = 0;
    let active = 0;
    let failed = 0;
    for (const queue of found) {
      const counts = jobCounts(queue.statistics);
      left += counts.pending + counts.active;
      active += counts.active;
      failed += counts.failed;
    }
    const unqueued = feature.id === 'details' && left === 0 && detailsPending > 0;
    if (feature.id === 'details') {
      left = Math.max(left, detailsPending);
    }
    return {
      off: off && feature.id !== 'details',
      paused: found.filter((queue) => queue.isPaused).map((queue) => queue.name),
      left,
      active,
      failed,
      unqueued,
    };
  };

  const progress = $derived(loaded ? FEATURES.map((feature) => ({ feature, ...progressOf(feature) })) : []);
  const working = $derived(progress.filter((row) => !row.off));
  const left = $derived(working.reduce((sum, row) => sum + row.left, 0));
  const paused = $derived(working.flatMap((row) => row.paused));
  const unqueued = $derived(working.some((row) => row.unqueued));
  const finishable = $derived(paused.length > 0 || unqueued);

  /** "Finish now": a held queue is resumed, as the Job manager does; photo details still to read are queued. */
  const finishNow = async () => {
    finishing = true;
    try {
      for (const name of new Set(paused)) {
        await handleResumeQueue({ name });
      }
      if (unqueued) {
        await runQueueCommandLegacy({
          name: QueueName.MetadataExtraction,
          queueCommandDto: { command: QueueCommand.Start, force: false },
        });
      }
      said = $t('frameleaf_care_prog_finish_started');
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_care_prog_finish_failed'));
    } finally {
      finishing = false;
    }
  };

  const hero = $derived.by(() => {
    if (paused.length > 0) {
      return {
        tone: 'warn' as const,
        icon: mdiAlertCircleOutline,
        title: $t('frameleaf_care_prog_hero_paused'),
        body: $t('frameleaf_care_prog_hero_paused_body', { values: { count: left } }),
      };
    }
    if (left > 0) {
      return {
        tone: 'good' as const,
        icon: mdiProgressClock,
        title: $t('frameleaf_care_prog_hero_reading', { values: { count: left } }),
        body: $t('frameleaf_care_prog_hero_reading_body'),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiCheckCircleOutline,
      title: $t('frameleaf_care_prog_hero_done'),
      body: $t('frameleaf_care_prog_hero_done_body'),
    };
  });

  const rowState = (row: Progress): { tone: KitTone; status: string; note?: string } => {
    if (row.off) {
      return { tone: 'off', status: $t('frameleaf_care_prog_off'), note: $t('frameleaf_care_prog_off_note') };
    }
    if (row.paused.length > 0) {
      return {
        tone: 'warn',
        status: $t('frameleaf_care_prog_paused'),
        note: $t('frameleaf_care_prog_left', { values: { count: row.left } }),
      };
    }
    if (row.left > 0) {
      return {
        tone: 'off',
        status: $t('frameleaf_care_prog_left', { values: { count: row.left } }),
        note: row.active > 0 ? $t('frameleaf_care_prog_reading_now') : $t('frameleaf_care_prog_waiting_turn'),
      };
    }
    if (row.failed > 0) {
      return {
        tone: 'warn',
        status: $t('frameleaf_care_prog_failed', { values: { count: row.failed } }),
        note: $t('frameleaf_care_prog_failed_note'),
      };
    }
    return { tone: 'good', status: $t('frameleaf_care_prog_none') };
  };
</script>

<KitPage>
  {#if said}
    <Said message={said} onDismiss={() => (said = '')} />
  {/if}

  <Hero
    tone={loaded ? hero.tone : 'quiet'}
    icon={hero.icon}
    title={loaded ? hero.title : $t('frameleaf_care_prog_loading')}
    body={loaded ? hero.body : undefined}
    label={$t('frameleaf_care_prog_hero_label')}
  >
    {#snippet actions()}
      {#if loaded && finishable}
        <Button variant="primary" disabled={finishing || held} onclick={finishNow}>
          <Icon icon={mdiPlayOutline} size="1em" aria-hidden />
          {$t('frameleaf_care_prog_finish')}
        </Button>
      {/if}
    {/snippet}
  </Hero>

  <Section title={$t('frameleaf_care_prog_list_title')} description={$t('frameleaf_care_prog_list_description')}>
    <ItemList>
      {#each progress as row (row.feature.id)}
        {@const state = rowState(row)}
        {@const name = words(row.feature.id, 'name')}
        <Item
          icon={row.feature.icon}
          off={row.off}
          {name}
          detail={words(row.feature.id, 'detail')}
          tone={state.tone}
          status={state.status}
          note={state.note}
        >
          {#snippet action()}
            {#if row.feature.href}
              {@const href = row.feature.href}
              <Button label={$t('frameleaf_care_prog_open_named', { values: { name } })} onclick={() => goto(href)}>
                {$t('frameleaf_care_prog_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
              </Button>
            {/if}
          {/snippet}
        </Item>
      {/each}
    </ItemList>
  </Section>

  <Section title={$t('frameleaf_care_prog_when_title')}>
    <Row label={$t('frameleaf_care_overnight')} help={$t('frameleaf_care_prog_overnight_help')}>
      <Button onclick={() => goto(commandCenterUrl('processing', 'nightly-tasks'))}>
        {$t('frameleaf_care_overnight_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
      </Button>
    </Row>
    <Row label={$t('frameleaf_care_prog_where')} help={$t('frameleaf_care_prog_where_help')}>
      <Button onclick={() => goto(commandCenterUrl('processing', 'routing'))}>
        {$t('frameleaf_care_prog_where_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
      </Button>
    </Row>
  </Section>

  {#if care}
    <Section title={$t('frameleaf_care_prog_again_title')} description={$t('frameleaf_care_prog_again_description')}>
      <Row label={$t('frameleaf_care_prog_keep')} help={$t('frameleaf_care_prog_keep_help')}>
        <Switch label={$t('frameleaf_care_prog_keep')} checked={care.manualMetadata} {held} onChange={setKeepMine} />
      </Row>
      {#if !care.manualMetadata}
        <Notice tone="warn" title={$t('frameleaf_care_prog_keep_off_title')}>
          {$t('frameleaf_care_prog_keep_off_body')}
        </Notice>
      {/if}
      <Row label={$t('frameleaf_care_prog_only_changed')} help={$t('frameleaf_care_prog_only_changed_help')}>
        <Switch
          label={$t('frameleaf_care_prog_only_changed')}
          checked={care.incrementalEnrichment}
          {held}
          onChange={setOnlyChanged}
        />
      </Row>
    </Section>
  {/if}
</KitPage>
