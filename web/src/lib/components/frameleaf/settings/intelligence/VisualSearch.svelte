<script lang="ts">
  /**
   * Search & intelligence › Visual search (FL-366, after the approved prototype
   * `settings-v2/care/search.jsx` `VisualSearch`): finding photos by describing them. "Search
   * quality" is the model slider over the published search models (`machineLearning.clip.modelName`);
   * a model saved outside them selects no stop and stays until one replaces it, and the name itself
   * is under Advanced. "Ask
   * about your photos" is `localFeatures.askSearch`; the Library Assistant (FL-885) is
   * `localFeatures.assistant`.
   *
   * What the app does today is said, not what the prototype hoped for: a new search model empties
   * the old search results when it is saved, and the photos are read again only when that work is
   * started again. FL-521: changing the model says how long reading every photo again takes (at the
   * recent rate) and offers "Save and start tonight / now". Left for later: the try-out on a few photos
   * first.
   */
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
  } from '$lib/components/frameleaf/settings/intelligence/presets';
  import ServerModelSlider from '$lib/components/frameleaf/settings/intelligence/ServerModelSlider.svelte';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
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
  import { mdiImageSearchOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  onMount(() => queueManager.listen());

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const ml = $derived(settingsDraft.draft.machineLearning);
  const saved = $derived(settingsDraft.baseline.machineLearning);
  const askSearch = $derived(settingsDraft.draft.localFeatures?.askSearch);
  const assistant = $derived(settingsDraft.draft.localFeatures?.assistant);

  const on = $derived(ml.enabled && ml.clip.enabled);
  const waiting = $derived(workWaiting(queueManager.queues, FEATURE_WORK['smart-search']));
  const custom = $derived(!choiceOf(SEARCH_QUALITY, ml.clip));
  const modelChanged = $derived(ml.clip.modelName !== saved.clip.modelName);

  // The box under Advanced holds only a model of the person's own; emptying it goes back to a published one.
  const isPublished = (name: string) => !!choiceOf(SEARCH_QUALITY, { modelName: name });
  const ownModel = $derived(custom ? ml.clip.modelName : '');
  const setOwnModel = (value: string) => {
    settingsDraft.draft.machineLearning.clip.modelName =
      value.trim() || (isPublished(saved.clip.modelName) ? saved.clip.modelName : SEARCH_QUALITY[1].values.modelName);
  };

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
      <ServerModelSlider
        workload="search"
        value={ml.clip.modelName}
        saved={saved.clip.modelName}
        label={$t('frameleaf_intel_search_quality')}
        {disabled}
        customNote={custom ? $t('frameleaf_intel_own_model_note', { values: { model: ml.clip.modelName } }) : undefined}
        onChange={(model) => (settingsDraft.draft.machineLearning.clip.modelName = model)}
        onNeedsCloud={(setup) => getCloudManager.open('processing', setup)}
      />
      {#if modelChanged}
        <Reread
          title={rereadTitle}
          body={$t('frameleaf_intel_search_reread_body')}
          {disabled}
          choices={[
            { label: $t('frameleaf_intel_save_tonight'), run: () => saveAndRead(LibraryRedoWhen.Tonight) },
            { label: $t('frameleaf_intel_save_now'), run: () => saveAndRead(LibraryRedoWhen.Now) },
          ]}
          onUndo={() => {
            settingsDraft.draft.machineLearning.clip.modelName = saved.clip.modelName;
          }}
        />
      {:else}
        <Notice tone="warn" title={$t('frameleaf_intel_search_model_warning')}>
          {$t('frameleaf_intel_search_model_warning_body')}
        </Notice>
      {/if}
    {/if}
    <Advanced summary={$t('frameleaf_intel_search_advanced')}>
      <Explain>{$t('frameleaf_intel_search_model_explain')}</Explain>
      <Row label={$t('frameleaf_intel_search_model')} help={$t('frameleaf_intel_search_model_help')}>
        <Field
          label={$t('frameleaf_intel_search_model')}
          wide
          value={ownModel}
          disabled={disabled || !ml.clip.enabled}
          onChange={setOwnModel}
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

  {#if assistant}
    <Section title={$t('frameleaf_assistant_name')}>
      <Row
        label={$t('frameleaf_intel_assistant', { values: { name: $t('frameleaf_assistant_name') } })}
        help={$t('frameleaf_intel_assistant_help')}
      >
        <Switch
          label={$t('frameleaf_intel_assistant', { values: { name: $t('frameleaf_assistant_name') } })}
          checked={assistant.enabled}
          held={disabled}
          onChange={(value) => (assistant.enabled = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_assistant_planner')} help={$t('frameleaf_intel_assistant_planner_help')}>
        <Switch
          label={$t('frameleaf_intel_assistant_planner')}
          checked={assistant.planner}
          held={disabled || !assistant.enabled}
          onChange={(value) => (assistant.planner = value)}
        />
      </Row>
      <Advanced summary={$t('frameleaf_intel_ask_advanced')}>
        <Row label={$t('frameleaf_intel_ask_most')} help={$t('frameleaf_intel_assistant_most_help')}>
          <Amount
            label={$t('frameleaf_intel_ask_most')}
            unit={$t('frameleaf_intel_unit_photos')}
            min={1}
            max={500}
            value={assistant.maxResults}
            disabled={disabled || !assistant.enabled}
            onChange={(value) => (assistant.maxResults = value)}
          />
        </Row>
      </Advanced>
    </Section>
  {/if}
</KitPage>
