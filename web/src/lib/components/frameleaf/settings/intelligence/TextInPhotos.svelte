<script lang="ts">
  /**
   * Search & intelligence › Text, documents & receipts (FL-366, after the approved prototype
   * `settings-v2/care/search.jsx` `TextInPhotos`): reading the words in photos
   * (`machineLearning.ocr`). "Languages to read" picks the text-reading model by the languages it
   * reads, "How much to read" writes the two scores and "Read small print" the detail the text is
   * read at. The model and the numbers are under Advanced. "Suggest receipt details" is
   * `ocr.documentFields` (FL-63).
   *
   * Left for later: the languages the server has no model for (Arabic, Hindi), how many photos have
   * words in them, and a time estimate for reading again, which the server does not give.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Explain from '$lib/components/frameleaf/settings/intelligence/Explain.svelte';
  import Figure from '$lib/components/frameleaf/settings/intelligence/Figure.svelte';
  import MasterOff from '$lib/components/frameleaf/settings/intelligence/MasterOff.svelte';
  import {
    applyChoice,
    choiceOf,
    FEATURE_WORK,
    TEXT_DETAIL_NORMAL,
    TEXT_DETAIL_SMALL_PRINT,
    TEXT_LANGUAGES,
    TEXT_MODELS,
    TEXT_READING,
    textLanguageOf,
    textModelFor,
    workWaiting,
    type TextReading,
  } from '$lib/components/frameleaf/settings/intelligence/presets';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { mdiTextRecognition } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  onMount(() => queueManager.listen());

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const ml = $derived(settingsDraft.draft.machineLearning);
  const ocr = $derived(settingsDraft.draft.machineLearning.ocr);
  const saved = $derived(settingsDraft.baseline.machineLearning.ocr);

  const on = $derived(ml.enabled && ocr.enabled);
  const off = $derived(disabled || !ocr.enabled);
  const waiting = $derived(workWaiting(queueManager.queues, FEATURE_WORK.documents));
  const language = $derived(textLanguageOf(ocr.modelName) ?? 'custom');
  const reading = $derived<TextReading | 'custom'>(choiceOf(TEXT_READING, ocr) ?? 'custom');
  const smallPrint = $derived(ocr.maxResolution >= TEXT_DETAIL_SMALL_PRINT);
  const changed = $derived(
    ocr.modelName !== saved.modelName ||
      ocr.minDetectionScore !== saved.minDetectionScore ||
      ocr.minRecognitionScore !== saved.minRecognitionScore ||
      ocr.maxResolution !== saved.maxResolution,
  );

  const hero = $derived.by(() => {
    if (!on) {
      return {
        tone: 'quiet' as const,
        title: $t('frameleaf_intel_text_off'),
        body: $t('frameleaf_intel_text_off_body'),
      };
    }
    return {
      tone: 'good' as const,
      title: $t('frameleaf_intel_text_on'),
      body:
        waiting > 0
          ? $t('frameleaf_intel_text_reading_body', { values: { count: waiting } })
          : $t('frameleaf_intel_text_on_body'),
    };
  });

  const languageOptions = $derived([
    ...TEXT_LANGUAGES.map((id) => ({ value: id, label: $t(`frameleaf_intel_text_language_${id}` as Translations) })),
    ...(language === 'custom' ? [{ value: 'custom', label: ocr.modelName }] : []),
  ]);
  const modelOptions = $derived([
    ...TEXT_MODELS.map((model) => ({
      value: model.value,
      label: $t(model.large ? 'frameleaf_intel_text_model_large' : 'frameleaf_intel_text_model_small', {
        values: { name: model.value, languages: $t(`frameleaf_intel_text_language_${model.language}` as Translations) },
      }),
    })),
    ...(language === 'custom' ? [{ value: ocr.modelName, label: ocr.modelName }] : []),
  ]);
  const readingHelp = $derived(
    reading === 'custom'
      ? $t('frameleaf_intel_text_reading_custom_help')
      : $t(`frameleaf_intel_text_reading_${reading}_help` as Translations),
  );

  const undo = () =>
    applyChoice(settingsDraft.draft.machineLearning.ocr, {
      modelName: saved.modelName,
      minDetectionScore: saved.minDetectionScore,
      minRecognitionScore: saved.minRecognitionScore,
      maxResolution: saved.maxResolution,
    });
</script>

<KitPage>
  <Hero
    tone={hero.tone}
    icon={mdiTextRecognition}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_intel_text_status')}
  />

  {#if !ml.enabled}
    <MasterOff />
  {/if}

  <Section title={$t('frameleaf_intel_text_section')}>
    <Row label={$t('frameleaf_intel_text_read')} help={$t('frameleaf_intel_text_read_help')}>
      <Switch
        label={$t('frameleaf_intel_text_read')}
        checked={ocr.enabled}
        held={disabled}
        onChange={(value) => (settingsDraft.draft.machineLearning.ocr.enabled = value)}
      />
    </Row>
    {#if ocr.enabled}
      <Row label={$t('frameleaf_intel_text_languages')} help={$t('frameleaf_intel_text_languages_help')}>
        <Select
          label={$t('frameleaf_intel_text_languages')}
          value={language}
          options={languageOptions}
          {disabled}
          onChange={(value) => {
            const id = TEXT_LANGUAGES.find((item) => item === value);
            if (id) {
              settingsDraft.draft.machineLearning.ocr.modelName = textModelFor(id, ocr.modelName);
            }
          }}
        />
      </Row>
      <Row label={$t('frameleaf_intel_text_how_much')} help={readingHelp}>
        <SegmentedControl
          label={$t('frameleaf_intel_text_how_much_label')}
          value={reading}
          {disabled}
          options={[
            ...TEXT_READING.map((choice) => ({
              value: choice.id,
              label: $t(`frameleaf_intel_text_reading_${choice.id}` as Translations),
            })),
            ...(reading === 'custom' ? [{ value: 'custom', label: $t('frameleaf_intel_custom') }] : []),
          ]}
          onChange={(value) => {
            const choice = TEXT_READING.find((item) => item.id === value);
            if (choice) {
              applyChoice(settingsDraft.draft.machineLearning.ocr, choice.values);
            }
          }}
        />
      </Row>
      <Row label={$t('frameleaf_intel_text_small_print')} help={$t('frameleaf_intel_text_small_print_help')}>
        <Switch
          label={$t('frameleaf_intel_text_small_print')}
          checked={smallPrint}
          held={disabled}
          onChange={(value) =>
            (settingsDraft.draft.machineLearning.ocr.maxResolution = value
              ? TEXT_DETAIL_SMALL_PRINT
              : TEXT_DETAIL_NORMAL)}
        />
      </Row>
      {#if changed}
        <Notice tone="warn" title={$t('frameleaf_intel_text_reread_title')}>
          {$t('frameleaf_intel_text_reread_body')}
          {#snippet action()}
            <Button onclick={() => goto(commandCenterUrl('processing', 'queues'))}>
              {$t('frameleaf_intel_background_work')}
            </Button>
            <Button onclick={undo}>{$t('frameleaf_intel_undo')}</Button>
          {/snippet}
        </Notice>
      {/if}
      <Row label={$t('frameleaf_intel_text_receipts')} help={$t('frameleaf_intel_text_receipts_help')}>
        <Switch
          label={$t('frameleaf_intel_text_receipts')}
          checked={!!ocr.documentFields}
          held={disabled}
          onChange={(value) => (settingsDraft.draft.machineLearning.ocr.documentFields = value)}
        />
      </Row>
    {/if}
    <Advanced summary={$t('frameleaf_intel_text_advanced')}>
      <Explain>{$t('frameleaf_intel_text_advanced_explain')}</Explain>
      <Row label={$t('frameleaf_intel_text_model')} help={$t('frameleaf_intel_text_model_help')}>
        <Select
          label={$t('frameleaf_intel_text_model')}
          value={ocr.modelName}
          options={modelOptions}
          disabled={off}
          onChange={(value) => (settingsDraft.draft.machineLearning.ocr.modelName = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_text_noticed')} help={$t('frameleaf_intel_text_noticed_help')}>
        <Figure
          label={$t('frameleaf_intel_text_noticed')}
          unit={$t('frameleaf_intel_unit_score')}
          min={0.1}
          max={1}
          step={0.05}
          value={ocr.minDetectionScore}
          disabled={off}
          onChange={(value) => (settingsDraft.draft.machineLearning.ocr.minDetectionScore = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_text_kept')} help={$t('frameleaf_intel_text_kept_help')}>
        <Figure
          label={$t('frameleaf_intel_text_kept')}
          unit={$t('frameleaf_intel_unit_score')}
          min={0.1}
          max={1}
          step={0.05}
          value={ocr.minRecognitionScore}
          disabled={off}
          onChange={(value) => (settingsDraft.draft.machineLearning.ocr.minRecognitionScore = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_text_detail')} help={$t('frameleaf_intel_text_detail_help')}>
        <Amount
          label={$t('frameleaf_intel_text_detail')}
          unit={$t('frameleaf_intel_unit_pixels')}
          min={1}
          max={4096}
          value={ocr.maxResolution}
          disabled={off}
          onChange={(value) => (settingsDraft.draft.machineLearning.ocr.maxResolution = value)}
        />
      </Row>
    </Advanced>
  </Section>
</KitPage>
