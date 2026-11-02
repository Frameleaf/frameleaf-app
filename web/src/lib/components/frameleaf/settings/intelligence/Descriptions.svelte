<script lang="ts">
  /**
   * Search & intelligence › Descriptions & tags (FL-366, after the approved prototype
   * `settings-v2/care/captions.jsx`): a caption and a few tags for every photo. It opens on how far
   * along the captions are (the server's own counts), then four household choices: caption length
   * (style and sentence count), mentioning named people, things to look out for and things never to
   * guess at. Tags are the search model's suggestions (`machineLearning.clip.zeroShotTagging`).
   * Everything else is in four closed Advanced sections; each old address of a tuning page opens
   * its section (`advanced-description-runtime`, `-prompt`, `-identity`, `advanced-search-labels`).
   *
   * Moved here from the old Machine learning page: the caption model choices, the hardware
   * detection that names the graphics card "Automatic" picks, and the hardware presets. A preset is
   * applied when the kind of graphics card is chosen, never on its own when the page opens.
   *
   * "Try it on a few photos" writes sample captions in place with the choices on this page, saved or
   * not (FL-537, `CaptionTryout`); the enrichment workbench (FL-59) opens from there for more samples.
   */
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import EnrichmentWorkbench from '$lib/components/frameleaf/EnrichmentWorkbench.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import TextArea from '$lib/components/frameleaf/settings/kit/TextArea.svelte';
  import CaptionTryout from '$lib/components/frameleaf/settings/intelligence/CaptionTryout.svelte';
  import Explain from '$lib/components/frameleaf/settings/intelligence/Explain.svelte';
  import Figure from '$lib/components/frameleaf/settings/intelligence/Figure.svelte';
  import MasterOff from '$lib/components/frameleaf/settings/intelligence/MasterOff.svelte';
  import Words from '$lib/components/frameleaf/settings/intelligence/Words.svelte';
  import {
    applyChoice,
    CAPTION_LENGTH,
    choiceOf,
    FEATURE_WORK,
    roughDuration,
    TAG_AMOUNT,
    workWaiting,
    type CaptionLength,
    type TagAmount,
  } from '$lib/components/frameleaf/settings/intelligence/presets';
  import { QueryParameter } from '$lib/constants';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import ImageDescriptionRequeueModal from '$lib/modals/ImageDescriptionRequeueModal.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getEnrichmentOptions,
    getImageDescriptionRequeueEstimate,
    getMachineLearningHardware,
    MachineLearningHardwareAcceleration,
    PlaceholderValidation,
    Style,
    type AdminConfigImageDescriptionPromptDto,
    type ImageDescriptionRequeueEstimateDto,
  } from '@frameleaf/sdk';
  import { modalManager, toastManager } from '@frameleaf/ui';
  import { mdiCommentTextOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import {
    CUSTOM_MODEL,
    DESCRIPTION_MODEL_PROFILES,
    FALLBACK_MODEL_PROFILES,
    findDescriptionProfile,
    hardwareAcceleration,
    imageEnrichmentHardwarePresets,
    isImageEnrichmentHardwareAcceleration,
    parseLines,
  } from '../../../../../routes/admin/system-settings/machine-learning/machine-learning-helpers';

  onMount(() => queueManager.listen());

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const ml = $derived(settingsDraft.draft.machineLearning);
  // The server always returns these; the DTO marks them optional only because they have defaults.
  const imageDescription = $derived(settingsDraft.draft.machineLearning.imageDescription!);
  const saved = $derived(settingsDraft.baseline.machineLearning.imageDescription!);
  const prompt = $derived(imageDescription.prompt!);
  const savedPrompt = $derived(saved.prompt);
  const zeroShot = $derived(settingsDraft.draft.machineLearning.clip.zeroShotTagging);
  const keepsHandWritten = $derived(settingsDraft.baseline.libraryCare?.manualMetadata);

  const on = $derived(ml.enabled && imageDescription.enabled);
  const off = $derived(disabled || !imageDescription.enabled);
  const waiting = $derived(workWaiting(queueManager.queues, FEATURE_WORK.descriptions));
  const length = $derived<CaptionLength | 'custom'>(choiceOf(CAPTION_LENGTH, prompt) ?? 'custom');
  const tags = $derived<TagAmount | 'custom'>(choiceOf(TAG_AMOUNT, zeroShot) ?? 'custom');
  const promptChanged = $derived(JSON.stringify(prompt) !== JSON.stringify(savedPrompt));
  /** An old address of one of the four tuning pages opens this page with its section open. */
  const opened = page.url.searchParams.get('section');

  // What the server knows about captions ─────────────────────────────────────────────────────

  let stats = $state<ImageDescriptionRequeueEstimateDto>();
  let framesPerVideo = $state<number>();
  let detectedAcceleration = $state<MachineLearningHardwareAcceleration>();
  let workbenchOpen = $state(false);
  let trying = $state(false);

  const loadStats = async () => {
    try {
      stats = await getImageDescriptionRequeueEstimate();
    } catch {
      // the answer says only what is known without the counts
    }
  };

  onMount(() => {
    void loadStats();
    void getEnrichmentOptions()
      .then((options) => (framesPerVideo = options.framesPerVideo))
      .catch(() => {
        // the video row then says it without the number
      });
    // No destinationId: the server checks the first enabled local destination, never a cloud one.
    void getMachineLearningHardware({})
      .then(({ preferredAcceleration }) => {
        if (isImageEnrichmentHardwareAcceleration(preferredAcceleration)) {
          detectedAcceleration = preferredAcceleration;
        }
      })
      .catch(() => (detectedAcceleration = undefined));
    // Library care's "try it on a few photos" opens straight into the workbench.
    if (page.url.searchParams.get(QueryParameter.OPEN_SETTING) === 'workbench') {
      workbenchOpen = true;
    }
  });

  const count = (value: number) => value.toLocaleString($locale);
  const rewrite = $derived(stats ? roughDuration(stats.estimatedTotalSeconds) : undefined);

  const hero = $derived.by(() => {
    if (!on) {
      return {
        tone: 'quiet' as const,
        title: $t('frameleaf_intel_captions_off'),
        body: $t('frameleaf_intel_captions_off_body'),
      };
    }
    if (stats && stats.withoutDescription > 0) {
      return {
        tone: 'good' as const,
        title: $t('frameleaf_intel_captions_some', {
          values: { done: count(stats.withDescription), total: count(stats.totalAssets) },
        }),
        body:
          waiting > 0
            ? $t('frameleaf_intel_captions_some_waiting', { values: { count: waiting } })
            : $t('frameleaf_intel_captions_some_body'),
      };
    }
    if (stats) {
      return {
        tone: 'good' as const,
        title: $t('frameleaf_intel_captions_all'),
        body: $t('frameleaf_intel_captions_all_body'),
      };
    }
    return {
      tone: 'good' as const,
      title: $t('frameleaf_intel_captions_on'),
      body: $t('frameleaf_intel_captions_all_body'),
    };
  });

  const updateCaptions = async () => {
    const result = await modalManager.show(ImageDescriptionRequeueModal, {});
    if (!result) {
      return;
    }
    if ('deferred' in result && result.deferred) {
      toastManager.primary($t('admin.image_description_requeue_deferred_toast'));
    } else if ('cloudBatches' in result && result.cloudBatches) {
      // FL-163: descriptions routed to Frameleaf Cloud go through batches, estimate first
      toastManager.primary($t('admin.machine_learning_image_description_requeue_cloud_batches'));
    } else if ('queued' in result) {
      toastManager.primary(
        result.queued
          ? $t('admin.machine_learning_image_description_requeue_started')
          : $t('admin.machine_learning_image_description_requeue_already_in_flight'),
      );
    } else {
      return;
    }
    void loadStats();
    // The re-queue is a job, not a setting (FL-66): the reminder it writes is picked up as saved
    // state and never enters the settings draft.
    void settingsDraft.refresh();
  };

  const undoPrompt = () => {
    imageDescription.prompt = $state.snapshot(savedPrompt) as AdminConfigImageDescriptionPromptDto;
  };

  // Caption model and hardware ──────────────────────────────────────────────────────────────

  const modelChoice = $derived(
    findDescriptionProfile(imageDescription.modelName) ? imageDescription.modelName : CUSTOM_MODEL,
  );
  const fallbackChoice = $derived(
    FALLBACK_MODEL_PROFILES.some((profile) => profile.value === imageDescription.fallbackModelName)
      ? imageDescription.fallbackModelName
      : CUSTOM_MODEL,
  );
  /** "Custom" was picked while the name still matches a listed model: show the box to type one. */
  let typingModel = $state(false);
  let typingFallback = $state(false);

  const hardwareName = (acceleration: MachineLearningHardwareAcceleration) =>
    acceleration === hardwareAcceleration.Cuda
      ? $t('frameleaf_intel_captions_hardware_cuda')
      : $t('frameleaf_intel_captions_hardware_openvino');

  const applyHardware = (value: string) => {
    const selected = value as MachineLearningHardwareAcceleration;
    imageDescription.acceleration = selected;
    const preset = selected === hardwareAcceleration.Auto && detectedAcceleration ? detectedAcceleration : selected;
    if (!isImageEnrichmentHardwareAcceleration(preset)) {
      return;
    }
    const values = imageEnrichmentHardwarePresets[preset];
    imageDescription.modelName = values.imageDescriptionModelName;
    imageDescription.fallbackModelName = values.imageDescriptionFallbackModelName;
    imageDescription.device = values.imageDescriptionDevice;
    const nsfwDetection = settingsDraft.draft.machineLearning.nsfwDetection;
    if (nsfwDetection) {
      nsfwDetection.modelName = values.nsfwDetectionModelName;
      nsfwDetection.device = values.nsfwDetectionDevice;
    }
  };

  const lines = (list: readonly string[] | undefined) => (list ?? []).join('\n');
  const LISTS = [
    { key: 'customVocabulary', name: 'preferred' },
    { key: 'medicalIndicators', name: 'medical' },
    { key: 'nsfwIndicators', name: 'locked' },
  ] as const;
</script>

<KitPage>
  <Hero
    tone={hero.tone}
    icon={mdiCommentTextOutline}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_intel_captions_status')}
  >
    {#snippet actions()}
      {#if on}
        <Button
          variant={stats && stats.withoutDescription > 0 ? 'primary' : 'default'}
          {disabled}
          onclick={updateCaptions}
        >
          {$t('frameleaf_intel_captions_update')}
        </Button>
      {/if}
    {/snippet}
  </Hero>

  {#if !ml.enabled}
    <MasterOff />
  {/if}

  {#if saved.pendingRequeueAt && on}
    <Notice tone="warn" title={$t('frameleaf_intel_captions_pending_title')}>
      {$t('frameleaf_intel_captions_pending_body')}
      {#snippet action()}
        <Button {disabled} onclick={updateCaptions}>{$t('frameleaf_intel_captions_update')}</Button>
      {/snippet}
    </Notice>
  {/if}

  <Section title={$t('frameleaf_intel_captions_section')}>
    <Row label={$t('frameleaf_intel_captions_write')} help={$t('frameleaf_intel_captions_write_help')}>
      <Switch
        label={$t('frameleaf_intel_captions_write')}
        checked={imageDescription.enabled}
        held={disabled}
        onChange={(value) => (imageDescription.enabled = value)}
      />
    </Row>
    {#if imageDescription.enabled}
      <Row
        label={$t('frameleaf_intel_captions_length')}
        help={length === 'custom'
          ? $t('frameleaf_intel_captions_length_custom_help', { values: { count: prompt.sentenceCountTarget ?? 0 } })
          : $t(`frameleaf_intel_captions_length_${length}_help` as Translations)}
        lead={length === 'custom'
          ? $t('frameleaf_intel_custom')
          : $t(`frameleaf_intel_captions_length_${length}` as Translations)}
      >
        <SegmentedControl
          label={$t('frameleaf_intel_captions_length')}
          value={length}
          {disabled}
          options={[
            ...CAPTION_LENGTH.map((choice) => ({
              value: choice.id,
              label: $t(`frameleaf_intel_captions_length_${choice.id}` as Translations),
            })),
            ...(length === 'custom' ? [{ value: 'custom', label: $t('frameleaf_intel_custom') }] : []),
          ]}
          onChange={(value) => {
            const choice = CAPTION_LENGTH.find((item) => item.id === value);
            if (choice) {
              applyChoice(prompt, choice.values);
            }
          }}
        />
      </Row>
      <Row label={$t('frameleaf_intel_captions_names')} help={$t('frameleaf_intel_captions_names_help')}>
        <Switch
          label={$t('frameleaf_intel_captions_names')}
          checked={prompt.identityInjection?.enabled ?? false}
          held={disabled}
          onChange={(value) => (prompt.identityInjection!.enabled = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_captions_look_for')} help={$t('frameleaf_intel_captions_look_for_help')} />
      <Words
        label={$t('frameleaf_intel_captions_look_for')}
        words={prompt.lookFor ?? []}
        {disabled}
        onChange={(words) => (prompt.lookFor = words)}
      />
      <Row label={$t('frameleaf_intel_captions_never')} help={$t('frameleaf_intel_captions_never_help')} />
      <Words
        label={$t('frameleaf_intel_captions_never')}
        words={prompt.forbiddenInferences ?? []}
        {disabled}
        onChange={(words) => (prompt.forbiddenInferences = words)}
      />
      <Row label={$t('frameleaf_intel_captions_try')} help={$t('frameleaf_intel_captions_try_help')}>
        <Button onclick={() => (trying = !trying)}>
          {trying ? $t('frameleaf_intel_captions_try_hide') : $t('frameleaf_intel_captions_try_button')}
        </Button>
      </Row>
      {#if trying}
        <CaptionTryout draft={imageDescription} {disabled} onOpenWorkbench={() => (workbenchOpen = true)} />
      {/if}
      {#if promptChanged}
        <Notice tone="info" title={$t('frameleaf_intel_captions_change_title')}>
          {rewrite
            ? $t(`frameleaf_intel_captions_change_body_${rewrite.unit}`, {
                values: { count: rewrite.count, total: count(stats?.totalAssets ?? 0) },
              })
            : $t('frameleaf_intel_captions_change_body')}
          {#snippet action()}
            <Button onclick={undoPrompt}>{$t('frameleaf_intel_undo')}</Button>
          {/snippet}
        </Notice>
      {/if}
      <Row
        label={$t('frameleaf_intel_captions_videos')}
        help={framesPerVideo
          ? $t('frameleaf_intel_captions_videos_help', { values: { count: framesPerVideo } })
          : $t('frameleaf_intel_captions_videos_help_unknown')}
      >
        <Switch
          label={$t('frameleaf_intel_captions_videos')}
          checked={imageDescription.videoMomentCaptions ?? false}
          held={disabled}
          onChange={(value) => (imageDescription.videoMomentCaptions = value)}
        />
      </Row>
    {/if}
    <Row
      label={$t('frameleaf_intel_captions_kept')}
      help={keepsHandWritten === false
        ? $t('frameleaf_intel_captions_kept_help_off')
        : $t('frameleaf_intel_captions_kept_help')}
    >
      <Button
        label={$t('frameleaf_intel_captions_kept_open_label')}
        onclick={() => goto(commandCenterUrl('care', 'enrichment-care'))}
      >
        {$t('frameleaf_intel_captions_kept_open')}
      </Button>
    </Row>
  </Section>

  <Section title={$t('frameleaf_intel_tags_section')}>
    <Row
      label={$t('frameleaf_intel_tags_suggest')}
      help={ml.clip.enabled ? $t('frameleaf_intel_tags_suggest_help') : $t('frameleaf_intel_tags_suggest_needs_search')}
    >
      <Switch
        label={$t('frameleaf_intel_tags_suggest')}
        checked={zeroShot.enabled}
        held={disabled || !ml.clip.enabled}
        onChange={(value) => (zeroShot.enabled = value)}
      />
    </Row>
    {#if zeroShot.enabled && ml.clip.enabled}
      <Row
        label={$t('frameleaf_intel_tags_amount')}
        help={tags === 'custom'
          ? $t('frameleaf_intel_tags_amount_custom_help', { values: { count: zeroShot.maxTags } })
          : $t(`frameleaf_intel_tags_amount_${tags}_help` as Translations)}
        lead={tags === 'custom'
          ? $t('frameleaf_intel_custom')
          : $t(`frameleaf_intel_tags_amount_${tags}` as Translations)}
      >
        <SegmentedControl
          label={$t('frameleaf_intel_tags_amount')}
          value={tags}
          {disabled}
          options={[
            ...TAG_AMOUNT.map((choice) => ({
              value: choice.id,
              label: $t(`frameleaf_intel_tags_amount_${choice.id}` as Translations),
            })),
            ...(tags === 'custom' ? [{ value: 'custom', label: $t('frameleaf_intel_custom') }] : []),
          ]}
          onChange={(value) => {
            const choice = TAG_AMOUNT.find((item) => item.id === value);
            if (choice) {
              applyChoice(zeroShot, choice.values);
            }
          }}
        />
      </Row>
    {/if}
  </Section>

  <Section title={$t('frameleaf_intel_captions_where_section')}>
    <Row label={$t('frameleaf_intel_where')} help={$t('frameleaf_intel_captions_where_help')}>
      <Button onclick={() => goto(commandCenterUrl('processing', 'routing'))}>{$t('frameleaf_intel_where_open')}</Button
      >
    </Row>
    <Row label={$t('frameleaf_intel_overnight')} help={$t('frameleaf_intel_captions_overnight_help')}>
      <Button onclick={() => goto(commandCenterUrl('processing', 'nightly-tasks'))}>
        {$t('frameleaf_intel_overnight_open')}
      </Button>
    </Row>

    <Advanced summary={$t('frameleaf_intel_captions_adv_model')} open={opened === 'advanced-description-runtime'}>
      <Explain>{$t('frameleaf_intel_captions_adv_model_explain')}</Explain>
      <Row label={$t('frameleaf_intel_captions_model')}>
        <Select
          label={$t('frameleaf_intel_captions_model')}
          value={typingModel ? CUSTOM_MODEL : modelChoice}
          options={[
            ...DESCRIPTION_MODEL_PROFILES.map((profile) => ({
              value: profile.value,
              label: `${profile.label}, ${profile.vramHint}`,
            })),
            { value: CUSTOM_MODEL, label: $t('frameleaf_intel_captions_model_custom') },
          ]}
          disabled={off}
          onChange={(value) => {
            typingModel = value === CUSTOM_MODEL;
            if (value !== CUSTOM_MODEL) {
              imageDescription.modelName = value;
            }
          }}
        />
      </Row>
      {#if typingModel || modelChoice === CUSTOM_MODEL}
        <Row label={$t('frameleaf_intel_captions_model_name')} help={$t('frameleaf_intel_captions_model_name_help')}>
          <Field
            label={$t('frameleaf_intel_captions_model_name')}
            wide
            value={imageDescription.modelName}
            disabled={off}
            invalid={!imageDescription.modelName.trim()}
            onChange={(value) => (imageDescription.modelName = value)}
          />
        </Row>
      {/if}
      <Row label={$t('frameleaf_intel_captions_fallback')} help={$t('frameleaf_intel_captions_fallback_help')}>
        <Select
          label={$t('frameleaf_intel_captions_fallback')}
          value={typingFallback ? CUSTOM_MODEL : fallbackChoice}
          options={[
            ...FALLBACK_MODEL_PROFILES.map((profile) => ({ value: profile.value, label: profile.label })),
            { value: CUSTOM_MODEL, label: $t('frameleaf_intel_captions_model_custom') },
          ]}
          disabled={off}
          onChange={(value) => {
            typingFallback = value === CUSTOM_MODEL;
            if (value !== CUSTOM_MODEL) {
              imageDescription.fallbackModelName = value;
            }
          }}
        />
      </Row>
      {#if typingFallback || fallbackChoice === CUSTOM_MODEL}
        <Row label={$t('frameleaf_intel_captions_fallback_name')}>
          <Field
            label={$t('frameleaf_intel_captions_fallback_name')}
            wide
            value={imageDescription.fallbackModelName}
            disabled={off}
            invalid={!imageDescription.fallbackModelName.trim()}
            onChange={(value) => (imageDescription.fallbackModelName = value)}
          />
        </Row>
      {/if}
      <Row label={$t('frameleaf_intel_captions_hardware')} help={$t('frameleaf_intel_captions_hardware_help')}>
        <Select
          label={$t('frameleaf_intel_captions_hardware')}
          value={imageDescription.acceleration ?? hardwareAcceleration.Auto}
          options={[
            {
              value: hardwareAcceleration.Auto,
              label: detectedAcceleration
                ? $t('frameleaf_intel_captions_hardware_auto_found', {
                    values: { kind: hardwareName(detectedAcceleration) },
                  })
                : $t('frameleaf_intel_captions_hardware_auto'),
            },
            { value: hardwareAcceleration.Cuda, label: $t('frameleaf_intel_captions_hardware_cuda') },
            { value: hardwareAcceleration.OpenVino, label: $t('frameleaf_intel_captions_hardware_openvino') },
          ]}
          {disabled}
          onChange={applyHardware}
        />
      </Row>
      <Row label={$t('frameleaf_intel_captions_device')} help={$t('frameleaf_intel_captions_device_help')}>
        <Field
          label={$t('frameleaf_intel_captions_device')}
          value={imageDescription.device}
          disabled={off}
          invalid={!imageDescription.device.trim()}
          onChange={(value) => (imageDescription.device = value)}
        />
      </Row>
    </Advanced>

    <Advanced summary={$t('frameleaf_intel_captions_adv_wording')} open={opened === 'advanced-description-prompt'}>
      <Row label={$t('frameleaf_intel_captions_sentences')} help={$t('frameleaf_intel_captions_sentences_help')}>
        <Amount
          label={$t('frameleaf_intel_captions_sentences')}
          unit={$t('frameleaf_intel_unit_sentences')}
          min={1}
          max={6}
          value={prompt.sentenceCountTarget ?? 3}
          disabled={off}
          onChange={(value) => (prompt.sentenceCountTarget = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_captions_style')} help={$t('frameleaf_intel_captions_style_help')}>
        <Select
          label={$t('frameleaf_intel_captions_style')}
          value={prompt.style ?? Style.Balanced}
          options={[
            { value: Style.Terse, label: $t('frameleaf_intel_captions_style_terse') },
            { value: Style.Balanced, label: $t('frameleaf_intel_captions_style_balanced') },
            { value: Style.Rich, label: $t('frameleaf_intel_captions_style_rich') },
          ]}
          disabled={off}
          onChange={(value) => (prompt.style = value as Style)}
        />
      </Row>
      {#each LISTS as list (list.key)}
        <Row
          label={$t(`frameleaf_intel_captions_list_${list.name}` as Translations)}
          help={$t(`frameleaf_intel_captions_list_${list.name}_help` as Translations)}
        />
        <TextArea
          label={$t(`frameleaf_intel_captions_list_${list.name}` as Translations)}
          rows={3}
          value={lines(prompt[list.key])}
          disabled={off}
          onChange={(text) => (prompt[list.key] = parseLines(text))}
        />
      {/each}
      <Row label={$t('frameleaf_intel_captions_extra')} help={$t('frameleaf_intel_captions_extra_help')} />
      <TextArea
        label={$t('frameleaf_intel_captions_extra')}
        rows={3}
        value={prompt.customInstructions ?? ''}
        disabled={off}
        onChange={(text) => (prompt.customInstructions = text)}
      />
    </Advanced>

    <Advanced summary={$t('frameleaf_intel_captions_adv_names')} open={opened === 'advanced-description-identity'}>
      <Row label={$t('frameleaf_intel_captions_most_names')} help={$t('frameleaf_intel_captions_most_names_help')}>
        <Amount
          label={$t('frameleaf_intel_captions_most_names')}
          unit={$t('frameleaf_intel_unit_names')}
          min={1}
          max={20}
          value={prompt.identityInjection?.maxNames ?? 5}
          disabled={off || !prompt.identityInjection?.enabled}
          onChange={(value) => (prompt.identityInjection!.maxNames = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_captions_name_sure')} help={$t('frameleaf_intel_captions_name_sure_help')}>
        <Figure
          label={$t('frameleaf_intel_captions_name_sure')}
          unit={$t('frameleaf_intel_unit_score')}
          min={0}
          max={1}
          step={0.05}
          value={prompt.identityInjection?.minFaceConfidence ?? 0.7}
          disabled={off || !prompt.identityInjection?.enabled}
          onChange={(value) => (prompt.identityInjection!.minFaceConfidence = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_captions_own')} help={$t('frameleaf_intel_captions_own_help')}>
        <Switch
          label={$t('frameleaf_intel_captions_own')}
          checked={prompt.advanced?.enabled ?? false}
          held={off}
          onChange={(value) => {
            prompt.advanced!.enabled = value;
            // A first start gets the built-in instructions to edit, never an empty box.
            if (value && !prompt.advanced!.rawPromptTemplate) {
              prompt.advanced!.rawPromptTemplate = serverConfigManager.value.defaultImageDescriptionRawPromptTemplate;
            }
          }}
        />
      </Row>
      {#if prompt.advanced?.enabled}
        <Row label={$t('frameleaf_intel_captions_own_text')} help={$t('frameleaf_intel_captions_own_text_help')}>
          <Button
            disabled={off}
            onclick={() =>
              (prompt.advanced!.rawPromptTemplate = serverConfigManager.value.defaultImageDescriptionRawPromptTemplate)}
          >
            {$t('frameleaf_intel_captions_own_reset')}
          </Button>
        </Row>
        <TextArea
          label={$t('frameleaf_intel_captions_own_text')}
          rows={6}
          code
          value={prompt.advanced.rawPromptTemplate ?? ''}
          disabled={off}
          onChange={(text) => (prompt.advanced!.rawPromptTemplate = text)}
        />
        <Row label={$t('frameleaf_intel_captions_schema_missing')}>
          <SegmentedControl
            label={$t('frameleaf_intel_captions_schema_missing_label')}
            value={prompt.advanced.placeholderValidation ?? PlaceholderValidation.Strict}
            disabled={off}
            options={[
              { value: PlaceholderValidation.Strict, label: $t('frameleaf_intel_captions_schema_strict') },
              { value: PlaceholderValidation.Warn, label: $t('frameleaf_intel_captions_schema_warn') },
            ]}
            onChange={(value) => (prompt.advanced!.placeholderValidation = value as PlaceholderValidation)}
          />
        </Row>
      {/if}
    </Advanced>

    <Advanced summary={$t('frameleaf_intel_tags_adv')} open={opened === 'advanced-search-labels'}>
      <Row label={$t('frameleaf_intel_tags_strictness')} help={$t('frameleaf_intel_tags_strictness_help')}>
        <Figure
          label={$t('frameleaf_intel_tags_strictness')}
          unit={$t('frameleaf_intel_unit_score')}
          min={0}
          max={1}
          step={0.01}
          value={zeroShot.minSimilarity}
          disabled={disabled || !zeroShot.enabled}
          onChange={(value) => (zeroShot.minSimilarity = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_tags_most')} help={$t('frameleaf_intel_tags_most_help')}>
        <Amount
          label={$t('frameleaf_intel_tags_most')}
          unit={$t('frameleaf_intel_unit_tags')}
          min={1}
          max={20}
          value={zeroShot.maxTags}
          disabled={disabled || !zeroShot.enabled}
          onChange={(value) => (zeroShot.maxTags = value)}
        />
      </Row>
    </Advanced>
  </Section>
</KitPage>

<EnrichmentWorkbench bind:open={workbenchOpen} draft={imageDescription} {saved} />
