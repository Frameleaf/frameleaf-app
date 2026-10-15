<script lang="ts">
  /**
   * Search & intelligence › Locked-content detection (FL-366, after the approved prototype
   * `settings-v2/care/search.jsx` `LockedDetection`): suggesting private photos that may belong in
   * Locked (`machineLearning.nsfwDetection`). "How cautious to be" writes the one number
   * (`threshold`); a number that matches none of the choices is "Custom". Who can open Locked is
   * set in one place, Access & security, which this page links to.
   *
   * The prototype drops the second "hide what was found" switch for that link. No other page edits
   * it yet (`nsfwDetection.hideFromLibrary`), so it is kept under Advanced until Access & security
   * takes it. Left for later: how many photos are suggested, and a time estimate for checking again.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Explain from '$lib/components/frameleaf/settings/intelligence/Explain.svelte';
  import Figure from '$lib/components/frameleaf/settings/intelligence/Figure.svelte';
  import MasterOff from '$lib/components/frameleaf/settings/intelligence/MasterOff.svelte';
  import {
    CAUTION,
    choiceOf,
    FEATURE_WORK,
    workWaiting,
    type Caution,
  } from '$lib/components/frameleaf/settings/intelligence/presets';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { mdiShieldCheckOutline, mdiShieldLockOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  onMount(() => queueManager.listen());

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const ml = $derived(settingsDraft.draft.machineLearning);
  // The server always returns `nsfwDetection`; the DTO marks it optional only because it has a default.
  const nsfwDetection = $derived(settingsDraft.draft.machineLearning.nsfwDetection!);
  const saved = $derived(settingsDraft.baseline.machineLearning.nsfwDetection!);

  const on = $derived(ml.enabled && nsfwDetection.enabled);
  const off = $derived(disabled || !nsfwDetection.enabled);
  const waiting = $derived(workWaiting(queueManager.queues, FEATURE_WORK['sensitive-detection']));
  const caution = $derived<Caution | 'custom'>(choiceOf(CAUTION, nsfwDetection) ?? 'custom');

  const hero = $derived.by(() => {
    if (!on) {
      return {
        tone: 'quiet' as const,
        title: $t('frameleaf_intel_locked_off'),
        body: $t('frameleaf_intel_locked_off_body'),
      };
    }
    return {
      tone: 'good' as const,
      title: $t('frameleaf_intel_locked_on'),
      body:
        waiting > 0
          ? $t('frameleaf_intel_locked_reading_body', { values: { count: waiting } })
          : $t('frameleaf_intel_locked_on_body'),
    };
  });

  const cautionHelp = $derived(
    caution === 'custom'
      ? $t('frameleaf_intel_locked_caution_custom_help', { values: { score: nsfwDetection.threshold } })
      : $t(`frameleaf_intel_locked_caution_${caution}_help` as Translations),
  );
</script>

<KitPage>
  <Hero
    tone={hero.tone}
    icon={mdiShieldLockOutline}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_intel_locked_status')}
  />

  {#if !ml.enabled}
    <MasterOff />
  {/if}

  <Section title={$t('frameleaf_intel_locked_section')}>
    <Row label={$t('frameleaf_intel_locked_suggest')} help={$t('frameleaf_intel_locked_suggest_help')}>
      <Switch
        label={$t('frameleaf_intel_locked_suggest')}
        checked={nsfwDetection.enabled}
        held={disabled}
        onChange={(value) => (nsfwDetection.enabled = value)}
      />
    </Row>
    {#if nsfwDetection.enabled}
      <Row label={$t('frameleaf_intel_locked_caution')} help={cautionHelp}>
        <SegmentedControl
          label={$t('frameleaf_intel_locked_caution')}
          value={caution}
          {disabled}
          options={[
            ...CAUTION.map((choice) => ({
              value: choice.id,
              label: $t(`frameleaf_intel_locked_caution_${choice.id}` as Translations),
            })),
            ...(caution === 'custom' ? [{ value: 'custom', label: $t('frameleaf_intel_custom') }] : []),
          ]}
          onChange={(value) => {
            const choice = CAUTION.find((item) => item.id === value);
            if (choice) {
              nsfwDetection.threshold = choice.values.threshold;
            }
          }}
        />
      </Row>
      {#if nsfwDetection.threshold !== saved.threshold}
        <Notice tone="warn" title={$t('frameleaf_intel_locked_recheck_title')}>
          {$t('frameleaf_intel_locked_recheck_body')}
          {#snippet action()}
            <Button onclick={() => goto(commandCenterUrl('processing', 'queues'))}>
              {$t('frameleaf_intel_background_work')}
            </Button>
            <Button onclick={() => (nsfwDetection.threshold = saved.threshold)}>{$t('frameleaf_intel_undo')}</Button>
          {/snippet}
        </Notice>
      {/if}
    {/if}
    <Row label={$t('frameleaf_intel_locked_what_hides')} help={$t('frameleaf_intel_locked_what_hides_help')}>
      <Button onclick={() => goto(commandCenterUrl('security', 'suppressed-content'))}>
        {$t('frameleaf_intel_locked_open_locked')}
      </Button>
    </Row>
    <Notice icon={mdiShieldCheckOutline} title={$t('frameleaf_intel_locked_pledge')}>
      {$t('frameleaf_intel_locked_pledge_body')}
    </Notice>
    <Advanced summary={$t('frameleaf_intel_locked_advanced')}>
      <Explain>{$t('frameleaf_intel_locked_advanced_explain')}</Explain>
      <Row label={$t('frameleaf_intel_locked_hide')} help={$t('frameleaf_intel_locked_hide_help')}>
        <Switch
          label={$t('frameleaf_intel_locked_hide')}
          checked={nsfwDetection.hideFromLibrary}
          held={disabled}
          onChange={(value) => (nsfwDetection.hideFromLibrary = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_locked_model')} help={$t('frameleaf_intel_locked_model_help')}>
        <Field
          label={$t('frameleaf_intel_locked_model')}
          wide
          value={nsfwDetection.modelName}
          disabled={off}
          invalid={!nsfwDetection.modelName.trim()}
          onChange={(value) => (nsfwDetection.modelName = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_locked_device')} help={$t('frameleaf_intel_locked_device_help')}>
        <Field
          label={$t('frameleaf_intel_locked_device_label')}
          value={nsfwDetection.device}
          disabled={off}
          invalid={!nsfwDetection.device.trim()}
          onChange={(value) => (nsfwDetection.device = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_locked_threshold')} help={$t('frameleaf_intel_locked_threshold_help')}>
        <Figure
          label={$t('frameleaf_intel_locked_threshold')}
          unit={$t('frameleaf_intel_unit_score')}
          min={0.01}
          max={1}
          step={0.01}
          value={nsfwDetection.threshold}
          disabled={off}
          onChange={(value) => (nsfwDetection.threshold = value)}
        />
      </Row>
    </Advanced>
  </Section>
</KitPage>
