<script lang="ts">
  /**
   * Search & intelligence › Visual search (FL-366, after the approved prototype
   * `settings-v2/care/search.jsx` `VisualSearch`): finding photos by describing them. "Search
   * quality" is three search models (`machineLearning.clip.modelName`); a model saved outside them
   * is "Custom" and stays until a choice replaces it, and the name itself is under Advanced. "Ask
   * about your photos" is `localFeatures.askSearch`.
   *
   * What the app does today is said, not what the prototype hoped for: a new search model empties
   * the old search results when it is saved, and the photos are read again only when that work is
   * started again. FL-521: changing the model says how long reading every photo again takes (at the
   * recent rate) and offers "Save and start tonight / now". Left for later: the try-out on a few photos
   * first.
   */
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Reread from '$lib/components/frameleaf/settings/kit/Reread.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Explain from '$lib/components/frameleaf/settings/intelligence/Explain.svelte';
  import MasterOff from '$lib/components/frameleaf/settings/intelligence/MasterOff.svelte';
  import {
    choiceOf,
    FEATURE_WORK,
    SEARCH_QUALITY,
    workWaiting,
    type SearchQuality,
  } from '$lib/components/frameleaf/settings/intelligence/presets';
  import { aboutTime, rereadSeconds, saveAndRedo } from '$lib/frameleaf/library-progress';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getLibraryProgress,
    LibraryProgressFeature,
    LibraryRedoQueue,
    LibraryRedoWhen,
    type LibraryProgressResponseDto,
  } from '@frameleaf/sdk';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { mdiImageSearchOutline, mdiShieldCheckOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  onMount(() => queueManager.listen());

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const ml = $derived(settingsDraft.draft.machineLearning);
  const saved = $derived(settingsDraft.baseline.machineLearning);
  const askSearch = $derived(settingsDraft.draft.localFeatures?.askSearch);

  const on = $derived(ml.enabled && ml.clip.enabled);
  const waiting = $derived(workWaiting(queueManager.queues, FEATURE_WORK['smart-search']));
  const quality = $derived<SearchQuality | 'custom'>(choiceOf(SEARCH_QUALITY, ml.clip) ?? 'custom');
  const modelChanged = $derived(ml.clip.modelName !== saved.clip.modelName);

  // FL-521: how long reading again takes, at the recent rate, and starting it from the save.
  let progress = $state<LibraryProgressResponseDto>();
  let said = $state('');
  onMount(() => {
    void (async () => {
      try {
        progress = await getLibraryProgress();
      } catch {
        // without a rate the notice says what happens, without how long
      }
    })();
  });
  const about = (seconds: number) => {
    const time = aboutTime(seconds);
    return $t(time.key, { values: time.values });
  };
  const failedSave = () => $t('frameleaf_intel_redo_failed');

  const searchProgress = $derived(progress?.features.find((item) => item.feature === LibraryProgressFeature.Search));
  const rereadTime = $derived(rereadSeconds(searchProgress));
  const rereadTitle = $derived(
    searchProgress && rereadTime
      ? $t('frameleaf_intel_search_reread_estimate', {
          values: { count: searchProgress.total, time: about(rereadTime) },
        })
      : $t('frameleaf_intel_search_reread_title'),
  );
  const saveAndRead = async (when: LibraryRedoWhen) => {
    try {
      if (await saveAndRedo(settingsDraft, ['machineLearning'], LibraryRedoQueue.SmartSearch, when)) {
        said =
          when === LibraryRedoWhen.Now ? $t('frameleaf_intel_redo_said_now') : $t('frameleaf_intel_redo_said_tonight');
      }
    } catch (error) {
      handleError(error, failedSave());
    }
  };

  const hero = $derived.by(() => {
    if (!on) {
      return {
        tone: 'quiet' as const,
        title: $t('frameleaf_intel_search_off'),
        body: $t('frameleaf_intel_search_off_body'),
      };
    }
    return {
      tone: 'good' as const,
      title: $t('frameleaf_intel_search_on'),
      body:
        waiting > 0
          ? $t('frameleaf_intel_search_reading_body', { values: { count: waiting } })
          : $t('frameleaf_intel_search_on_body'),
    };
  });

  const qualityHelp = $derived(
    quality === 'custom'
      ? $t('frameleaf_intel_custom_model_help', { values: { model: ml.clip.modelName } })
      : $t(`frameleaf_intel_search_quality_${quality}_help` as Translations),
  );
  /** The chosen quality, which the help starts by saying back (bold, as the prototype). */
  const qualityLead = $derived(
    quality === 'custom'
      ? $t('frameleaf_intel_custom')
      : $t(`frameleaf_intel_search_quality_${quality}` as Translations),
  );
</script>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />
  <Hero
    tone={hero.tone}
    icon={mdiImageSearchOutline}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_intel_search_status')}
  />

  {#if !ml.enabled}
    <MasterOff />
  {/if}

  <Section title={$t('frameleaf_intel_search_section')}>
    <Row label={$t('frameleaf_intel_search_describe')} help={$t('frameleaf_intel_search_describe_help')}>
      <Switch
        label={$t('frameleaf_intel_search_describe')}
        checked={ml.clip.enabled}
        held={disabled}
        onChange={(value) => (settingsDraft.draft.machineLearning.clip.enabled = value)}
      />
    </Row>
    {#if ml.clip.enabled}
      <Row label={$t('frameleaf_intel_search_quality')} help={qualityHelp} lead={qualityLead}>
        <SegmentedControl
          label={$t('frameleaf_intel_search_quality')}
          value={quality}
          {disabled}
          options={[
            ...SEARCH_QUALITY.map((choice) => ({
              value: choice.id,
              label: $t(`frameleaf_intel_search_quality_${choice.id}` as Translations),
            })),
            ...(quality === 'custom' ? [{ value: 'custom', label: $t('frameleaf_intel_custom') }] : []),
          ]}
          onChange={(value) => {
            const choice = SEARCH_QUALITY.find((item) => item.id === value);
            if (choice) {
              settingsDraft.draft.machineLearning.clip.modelName = choice.values.modelName;
            }
          }}
        />
      </Row>
      {#if modelChanged}
        <Reread
          title={rereadTitle}
          body={$t('frameleaf_intel_search_reread_body')}
          {disabled}
          choices={[
            { label: $t('frameleaf_intel_save_tonight'), run: () => saveAndRead(LibraryRedoWhen.Tonight) },
            { label: $t('frameleaf_intel_save_now'), run: () => saveAndRead(LibraryRedoWhen.Now) },
          ]}
          onUndo={() => (settingsDraft.draft.machineLearning.clip.modelName = saved.clip.modelName)}
        />
      {/if}
      <Notice icon={mdiShieldCheckOutline} title={$t('frameleaf_intel_search_pledge')}>
        {$t('frameleaf_intel_search_pledge_body')}
      </Notice>
    {/if}
    <Advanced summary={$t('frameleaf_intel_search_advanced')}>
      <Explain>{$t('frameleaf_intel_search_model_explain')}</Explain>
      <Row label={$t('frameleaf_intel_search_model')} help={$t('frameleaf_intel_search_model_help')}>
        <Field
          label={$t('frameleaf_intel_search_model')}
          wide
          value={ml.clip.modelName}
          disabled={disabled || !ml.clip.enabled}
          invalid={!ml.clip.modelName.trim()}
          onChange={(value) => (settingsDraft.draft.machineLearning.clip.modelName = value)}
        />
      </Row>
    </Advanced>
  </Section>

  {#if askSearch && ml.clip.enabled}
    <Section title={$t('frameleaf_intel_ask_section')}>
      <Row label={$t('frameleaf_intel_ask')} help={$t('frameleaf_intel_ask_help')}>
        <Switch
          label={$t('frameleaf_intel_ask')}
          checked={askSearch.enabled}
          held={disabled}
          onChange={(value) => (askSearch.enabled = value)}
        />
      </Row>
      <Advanced summary={$t('frameleaf_intel_ask_advanced')}>
        <Row label={$t('frameleaf_intel_ask_most')} help={$t('frameleaf_intel_ask_most_help')}>
          <Amount
            label={$t('frameleaf_intel_ask_most')}
            unit={$t('frameleaf_intel_unit_photos')}
            min={1}
            max={1000}
            value={askSearch.maxResults}
            disabled={disabled || !askSearch.enabled}
            onChange={(value) => (askSearch.maxResults = value)}
          />
        </Row>
      </Advanced>
    </Section>
  {/if}
</KitPage>
