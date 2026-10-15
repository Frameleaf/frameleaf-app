<script lang="ts">
  /**
   * Search & intelligence › Faces & identity (FL-366, after the approved prototype
   * `settings-v2/care/search.jsx` `Faces`). "How carefully to group" writes the three numbers the
   * server keeps (`machineLearning.facialRecognition` maxDistance, minScore and minFaces); numbers
   * that match none of the choices are "Custom". "Use people tags saved by other apps" is
   * `metadata.faces.import`, moved here from the one-switch Photo details page. The face model and
   * the numbers, each with its range, are under Advanced.
   *
   * "Your corrections always win" is what the server does: a face its owner corrected keeps that
   * correction when faces are grouped again (FL-38/FL-57). Left for later: "Tell my pets apart"
   * (no server setting yet), the named-people counts in the answer and a time estimate for
   * regrouping, which the server does not give.
   */
  import { page } from '$app/state';
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
    FACE_GROUPING,
    FEATURE_WORK,
    workWaiting,
    type FaceGrouping,
  } from '$lib/components/frameleaf/settings/intelligence/presets';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { mdiFaceRecognition, mdiShieldCheckOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  onMount(() => queueManager.listen());

  const FACE_MODELS = ['antelopev2', 'buffalo_l', 'buffalo_m', 'buffalo_s'] as const;

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const ml = $derived(settingsDraft.draft.machineLearning);
  const faces = $derived(settingsDraft.draft.machineLearning.facialRecognition);
  const saved = $derived(settingsDraft.baseline.machineLearning.facialRecognition);
  const importTags = $derived(settingsDraft.draft.metadata.faces.import);
  const savedImportTags = $derived(settingsDraft.baseline.metadata.faces.import);

  const on = $derived(ml.enabled && faces.enabled);
  const waiting = $derived(workWaiting(queueManager.queues, FEATURE_WORK.faces));
  const grouping = $derived<FaceGrouping | 'custom'>(choiceOf(FACE_GROUPING, faces) ?? 'custom');
  const groupingChanged = $derived(
    faces.maxDistance !== saved.maxDistance || faces.minScore !== saved.minScore || faces.minFaces !== saved.minFaces,
  );
  /** An old address of the face-model page opens this one with Advanced already open. */
  const advancedOpen = page.url.searchParams.get('section') === 'advanced-recognition-models';

  const hero = $derived.by(() => {
    if (!on) {
      return {
        tone: 'quiet' as const,
        title: $t('frameleaf_intel_faces_off'),
        body: $t('frameleaf_intel_faces_off_body'),
      };
    }
    return {
      tone: 'good' as const,
      title: $t('frameleaf_intel_faces_on'),
      body:
        waiting > 0
          ? $t('frameleaf_intel_faces_reading_body', { values: { count: waiting } })
          : $t('frameleaf_intel_faces_on_body'),
    };
  });

  const groupingHelp = $derived(
    grouping === 'custom'
      ? $t('frameleaf_intel_faces_grouping_custom_help', { values: { count: faces.minFaces } })
      : $t(`frameleaf_intel_faces_grouping_${grouping}_help` as Translations),
  );

  const modelOptions = $derived([
    ...FACE_MODELS.map((model) => ({
      value: model,
      label: $t(`frameleaf_intel_faces_model_${model}` as Translations),
    })),
    ...((FACE_MODELS as readonly string[]).includes(faces.modelName)
      ? []
      : [{ value: faces.modelName, label: faces.modelName }]),
  ]);

  const undoGrouping = () =>
    applyChoice(settingsDraft.draft.machineLearning.facialRecognition, {
      maxDistance: saved.maxDistance,
      minScore: saved.minScore,
      minFaces: saved.minFaces,
    });
</script>

<KitPage>
  <Hero
    tone={hero.tone}
    icon={mdiFaceRecognition}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_intel_faces_status')}
  />

  {#if !ml.enabled}
    <MasterOff />
  {/if}

  <Section title={$t('frameleaf_intel_faces_people')}>
    <Row label={$t('frameleaf_intel_faces_recognise')} help={$t('frameleaf_intel_faces_recognise_help')}>
      <Switch
        label={$t('frameleaf_intel_faces_recognise')}
        checked={faces.enabled}
        held={disabled}
        onChange={(value) => (settingsDraft.draft.machineLearning.facialRecognition.enabled = value)}
      />
    </Row>
    {#if faces.enabled}
      <Row label={$t('frameleaf_intel_faces_grouping')} help={groupingHelp}>
        <SegmentedControl
          label={$t('frameleaf_intel_faces_grouping_label')}
          value={grouping}
          {disabled}
          options={[
            ...FACE_GROUPING.map((choice) => ({
              value: choice.id,
              label: $t(`frameleaf_intel_faces_grouping_${choice.id}` as Translations),
            })),
            ...(grouping === 'custom' ? [{ value: 'custom', label: $t('frameleaf_intel_custom') }] : []),
          ]}
          onChange={(value) => {
            const choice = FACE_GROUPING.find((item) => item.id === value);
            if (choice) {
              applyChoice(settingsDraft.draft.machineLearning.facialRecognition, choice.values);
            }
          }}
        />
      </Row>
      {#if groupingChanged}
        <Notice tone="warn" title={$t('frameleaf_intel_faces_regroup_title')}>
          {$t('frameleaf_intel_faces_regroup_body')}
          {#snippet action()}
            <Button onclick={() => goto(commandCenterUrl('processing', 'queues'))}>
              {$t('frameleaf_intel_background_work')}
            </Button>
            <Button onclick={undoGrouping}>{$t('frameleaf_intel_undo')}</Button>
          {/snippet}
        </Notice>
      {/if}
      <Row label={$t('frameleaf_intel_faces_import')} help={$t('frameleaf_intel_faces_import_help')}>
        <Switch
          label={$t('frameleaf_intel_faces_import')}
          checked={importTags}
          held={disabled}
          onChange={(value) => (settingsDraft.draft.metadata.faces.import = value)}
        />
      </Row>
      {#if importTags && !savedImportTags}
        <Notice tone="info" title={$t('frameleaf_intel_faces_import_new_title')}>
          {$t('frameleaf_intel_faces_import_new_body')}
          {#snippet action()}
            <Button onclick={() => (settingsDraft.draft.metadata.faces.import = false)}>
              {$t('frameleaf_intel_undo')}
            </Button>
          {/snippet}
        </Notice>
      {/if}
    {/if}
    <Notice icon={mdiShieldCheckOutline} title={$t('frameleaf_intel_faces_pledge')}>
      {$t('frameleaf_intel_faces_pledge_body')}
    </Notice>
    <Advanced summary={$t('frameleaf_intel_faces_advanced')} open={advancedOpen}>
      <Explain>{$t('frameleaf_intel_faces_advanced_explain')}</Explain>
      <Row label={$t('frameleaf_intel_faces_model')} help={$t('frameleaf_intel_faces_model_help')}>
        <Select
          label={$t('frameleaf_intel_faces_model')}
          value={faces.modelName}
          options={modelOptions}
          disabled={disabled || !faces.enabled}
          onChange={(value) => (settingsDraft.draft.machineLearning.facialRecognition.modelName = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_faces_alike')} help={$t('frameleaf_intel_faces_alike_help')}>
        <Figure
          label={$t('frameleaf_intel_faces_alike')}
          unit={$t('frameleaf_intel_unit_distance')}
          min={0.1}
          max={2}
          step={0.05}
          value={faces.maxDistance}
          disabled={disabled || !faces.enabled}
          onChange={(value) => (settingsDraft.draft.machineLearning.facialRecognition.maxDistance = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_faces_clarity')} help={$t('frameleaf_intel_faces_clarity_help')}>
        <Figure
          label={$t('frameleaf_intel_faces_clarity')}
          unit={$t('frameleaf_intel_unit_score')}
          min={0.1}
          max={1}
          step={0.05}
          value={faces.minScore}
          disabled={disabled || !faces.enabled}
          onChange={(value) => (settingsDraft.draft.machineLearning.facialRecognition.minScore = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_faces_photos_needed')} help={$t('frameleaf_intel_faces_photos_needed_help')}>
        <Amount
          label={$t('frameleaf_intel_faces_photos_needed')}
          unit={$t('frameleaf_intel_unit_photos')}
          min={1}
          max={1000}
          value={faces.minFaces}
          disabled={disabled || !faces.enabled}
          onChange={(value) => (settingsDraft.draft.machineLearning.facialRecognition.minFaces = value)}
        />
      </Row>
    </Advanced>
  </Section>
</KitPage>
