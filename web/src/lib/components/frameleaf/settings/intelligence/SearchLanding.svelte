<script lang="ts">
  /**
   * Search & intelligence, the landing page (FL-366, after the approved prototype
   * `settings-v2/care/search.jsx` `SearchLanding`; it is also the old Search & recognition page).
   * It opens on whether search works and what is still waiting to be read, from what the app
   * already knows: the queues of each feature's work and whether the computer that does it is
   * answering. Then the one switch for everything (`machineLearning.enabled`), where the work runs,
   * one row per feature with its own switch, and the helper program's address and its availability
   * checks under Advanced (`machineLearning.urls`, `machineLearning.availabilityChecks`), in seconds.
   * Computers does not edit those, so they stay editable here.
   *
   * Left for later (server work): how many photos each feature has finished out of the library,
   * with a time estimate, and when the helper program last answered.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Explain from '$lib/components/frameleaf/settings/intelligence/Explain.svelte';
  import Figure from '$lib/components/frameleaf/settings/intelligence/Figure.svelte';
  import { FEATURE_WORK, workWaiting, type FeatureKey } from '$lib/components/frameleaf/settings/intelligence/presets';
  import { aiState } from '$lib/frameleaf/computers';
  import { commandCenterUrl, type SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { queueManager } from '$lib/managers/queue-manager.svelte';
  import { Icon } from '@frameleaf/ui';
  import { getWorkerInventory, type AdminConfigDto, type WorkerInventoryResponseDto } from '@frameleaf/sdk';
  import {
    mdiCommentTextOutline,
    mdiFaceRecognition,
    mdiImageSearchOutline,
    mdiLanDisconnect,
    mdiPower,
    mdiShapeOutline,
    mdiShieldLockOutline,
    mdiTextRecognition,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let { sections }: { sections: SettingsHostSection[] } = $props();

  type Feature = {
    key: FeatureKey;
    icon: string;
    /** The feature's own switch in the settings draft. */
    on: (config: AdminConfigDto) => boolean;
    turn: (config: AdminConfigDto, value: boolean) => void;
  };
  const FEATURES: readonly Feature[] = [
    {
      key: 'smart-search',
      icon: mdiImageSearchOutline,
      on: (config) => config.machineLearning.clip.enabled,
      turn: (config, value) => (config.machineLearning.clip.enabled = value),
    },
    {
      key: 'faces',
      icon: mdiFaceRecognition,
      on: (config) => config.machineLearning.facialRecognition.enabled,
      turn: (config, value) => (config.machineLearning.facialRecognition.enabled = value),
    },
    {
      key: 'documents',
      icon: mdiTextRecognition,
      on: (config) => config.machineLearning.ocr.enabled,
      turn: (config, value) => (config.machineLearning.ocr.enabled = value),
    },
    {
      key: 'descriptions',
      icon: mdiCommentTextOutline,
      on: (config) => config.machineLearning.imageDescription?.enabled ?? false,
      turn: (config, value) => {
        if (config.machineLearning.imageDescription) {
          config.machineLearning.imageDescription.enabled = value;
        }
      },
    },
    {
      key: 'sensitive-detection',
      icon: mdiShieldLockOutline,
      on: (config) => config.machineLearning.nsfwDetection?.enabled ?? false,
      turn: (config, value) => {
        if (config.machineLearning.nsfwDetection) {
          config.machineLearning.nsfwDetection.enabled = value;
        }
      },
    },
    {
      key: 'smart-albums',
      icon: mdiShapeOutline,
      on: (config) => config.smartAlbums?.enabled ?? false,
      turn: (config, value) => {
        if (config.smartAlbums) {
          config.smartAlbums.enabled = value;
        }
      },
    },
  ];

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const ml = $derived(settingsDraft.draft.machineLearning);
  const saved = $derived(settingsDraft.baseline.machineLearning);

  /** Only the features the host has a page for; every one when the host lists none of them. */
  const features = $derived.by(() => {
    const listed = FEATURES.filter((feature) => sections.some((section) => section.key === feature.key));
    return listed.length > 0 ? listed : FEATURES;
  });

  onMount(() => queueManager.listen());
  let inventory = $state<WorkerInventoryResponseDto | null>();
  let checking = $state(false);
  const check = async () => {
    checking = true;
    try {
      inventory = await getWorkerInventory();
    } catch {
      inventory = null;
    } finally {
      checking = false;
    }
  };
  onMount(() => void check());

  const silent = $derived(aiState(inventory) === 'not-answering');
  const waitingFor = (feature: Feature) => workWaiting(queueManager.queues, FEATURE_WORK[feature.key]);
  const waiting = $derived(
    features
      .filter((feature) => feature.on(settingsDraft.draft))
      .reduce((sum, feature) => sum + waitingFor(feature), 0),
  );

  const hero = $derived.by(() => {
    if (!ml.enabled) {
      return {
        tone: 'quiet' as const,
        icon: mdiPower,
        title: $t('frameleaf_intel_landing_off'),
        body: $t('frameleaf_intel_landing_off_body'),
      };
    }
    if (silent) {
      return {
        tone: 'warn' as const,
        icon: mdiLanDisconnect,
        title: $t('frameleaf_intel_landing_paused'),
        body: $t('frameleaf_intel_landing_paused_body', { values: { count: waiting } }),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiImageSearchOutline,
      title: $t('frameleaf_intel_landing_on'),
      body:
        waiting > 0
          ? $t('frameleaf_intel_landing_reading_body', { values: { count: waiting } })
          : $t('frameleaf_intel_landing_on_body'),
    };
  });

  const status = (feature: Feature) => {
    const own = feature.on(settingsDraft.draft);
    const count = waitingFor(feature);
    if (!ml.enabled || !own) {
      return {
        tone: 'off' as const,
        status: $t('frameleaf_intel_feature_off'),
        note: ml.enabled ? $t('frameleaf_intel_feature_off_note') : $t('frameleaf_intel_feature_master_off_note'),
      };
    }
    if (silent) {
      return {
        tone: 'warn' as const,
        status: $t('frameleaf_intel_feature_paused'),
        note: $t('frameleaf_intel_feature_paused_note'),
      };
    }
    if (count > 0) {
      return {
        tone: 'good' as const,
        status: $t('frameleaf_intel_feature_waiting', { values: { count } }),
        note: $t('frameleaf_intel_feature_waiting_note'),
      };
    }
    return { tone: 'good' as const, status: $t('frameleaf_intel_feature_ready'), note: undefined };
  };

  /** Seconds, for the two timings the server keeps in milliseconds. */
  const seconds = (milliseconds: number) => Math.round(milliseconds / 100) / 10;
  const urlsChanged = $derived(JSON.stringify(ml.urls) !== JSON.stringify(saved.urls));
</script>

<KitPage>
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_intel_landing_status')}
  >
    {#snippet actions()}
      {#if !ml.enabled}
        <Button variant="primary" {disabled} onclick={() => (settingsDraft.draft.machineLearning.enabled = true)}>
          {$t('frameleaf_intel_turn_on')}
        </Button>
      {:else if silent}
        <Button variant="primary" onclick={() => goto(commandCenterUrl('processing', 'computers'))}>
          {$t('frameleaf_intel_open_computers')}
        </Button>
        <Button disabled={checking} onclick={check}>{$t('frameleaf_intel_try_again')}</Button>
      {:else if waiting > 0}
        <Button onclick={() => goto(commandCenterUrl('care', 'enrichment-care'))}>
          {$t('frameleaf_intel_see_waiting')}
        </Button>
      {/if}
    {/snippet}
  </Hero>

  <Section title={$t('frameleaf_intel_everything')}>
    <Row label={$t('frameleaf_intel_master')} help={$t('frameleaf_intel_master_help')}>
      <Switch
        label={$t('frameleaf_intel_master')}
        checked={ml.enabled}
        held={disabled}
        onChange={(value) => (settingsDraft.draft.machineLearning.enabled = value)}
      />
    </Row>
    <Row
      label={$t('frameleaf_intel_where')}
      help={silent ? $t('frameleaf_intel_where_silent') : $t('frameleaf_intel_where_help')}
    >
      <Button onclick={() => goto(commandCenterUrl('processing', 'routing'))}>{$t('frameleaf_intel_where_open')}</Button
      >
    </Row>
    <Row label={$t('frameleaf_intel_overnight')} help={$t('frameleaf_intel_landing_overnight_help')}>
      <Button onclick={() => goto(commandCenterUrl('processing', 'nightly-tasks'))}>
        {$t('frameleaf_intel_overnight_open')}
      </Button>
    </Row>
    <Advanced summary={$t('frameleaf_intel_helper_advanced')}>
      <Explain>{$t('frameleaf_intel_helper_explain')}</Explain>
      {#each ml.urls as url, index (index)}
        <Row
          label={index === 0 ? $t('frameleaf_intel_helper_address') : $t('frameleaf_intel_helper_address_more')}
          help={index === 0 ? $t('frameleaf_intel_helper_address_help') : undefined}
        >
          <div class="address">
            <Field
              label={$t('frameleaf_intel_helper_address_n', { values: { number: index + 1 } })}
              type="url"
              wide
              value={url}
              {disabled}
              invalid={index === 0 && !url.trim()}
              onChange={(value) => (settingsDraft.draft.machineLearning.urls[index] = value)}
            />
            {#if ml.urls.length > 1}
              <Button
                label={$t('frameleaf_intel_helper_remove', { values: { number: index + 1 } })}
                {disabled}
                onclick={() => settingsDraft.draft.machineLearning.urls.splice(index, 1)}
              >
                <Icon icon={mdiTrashCanOutline} size="16" aria-hidden />
              </Button>
            {/if}
          </div>
        </Row>
      {/each}
      <Row label={$t('frameleaf_intel_helper_add')} help={$t('frameleaf_intel_helper_add_help')}>
        <Button
          {disabled}
          onclick={() => {
            settingsDraft.draft.machineLearning.urls.push('');
          }}
        >
          {$t('frameleaf_intel_helper_add_button')}
        </Button>
      </Row>
      {#if urlsChanged}
        <Explain>{$t('frameleaf_intel_helper_changed')}</Explain>
      {/if}
      <Row label={$t('frameleaf_intel_checks')} help={$t('frameleaf_intel_checks_help')}>
        <Switch
          label={$t('frameleaf_intel_checks')}
          checked={ml.availabilityChecks.enabled}
          held={disabled}
          onChange={(value) => (settingsDraft.draft.machineLearning.availabilityChecks.enabled = value)}
        />
      </Row>
      <Row label={$t('frameleaf_intel_checks_every')} help={$t('frameleaf_intel_checks_every_help')}>
        <Figure
          label={$t('frameleaf_intel_checks_every')}
          unit={$t('frameleaf_intel_unit_seconds')}
          min={1}
          max={3600}
          step={1}
          value={seconds(ml.availabilityChecks.interval)}
          disabled={disabled || !ml.availabilityChecks.enabled}
          onChange={(value) =>
            (settingsDraft.draft.machineLearning.availabilityChecks.interval = Math.round(value * 1000))}
        />
      </Row>
      <Row label={$t('frameleaf_intel_checks_wait')} help={$t('frameleaf_intel_checks_wait_help')}>
        <Figure
          label={$t('frameleaf_intel_checks_wait')}
          unit={$t('frameleaf_intel_unit_seconds')}
          min={0.1}
          max={600}
          step={0.5}
          value={seconds(ml.availabilityChecks.timeout)}
          disabled={disabled || !ml.availabilityChecks.enabled}
          onChange={(value) =>
            (settingsDraft.draft.machineLearning.availabilityChecks.timeout = Math.round(value * 1000))}
        />
      </Row>
    </Advanced>
  </Section>

  <Section title={$t('frameleaf_intel_features')} description={$t('frameleaf_intel_features_description')}>
    <ItemList>
      {#each features as feature (feature.key)}
        {@const name = $t(`frameleaf_intel_feature_${feature.key}` as Translations)}
        {@const state = status(feature)}
        <Item
          icon={feature.icon}
          off={state.tone === 'off'}
          {name}
          detail={$t(`frameleaf_intel_feature_${feature.key}_detail` as Translations)}
          tone={state.tone}
          status={state.status}
          note={state.note}
        >
          {#snippet measure()}
            {#if ml.enabled}
              <Switch
                label={name}
                checked={feature.on(settingsDraft.draft)}
                held={disabled}
                onChange={(value) => feature.turn(settingsDraft.draft, value)}
              />
            {/if}
          {/snippet}
          {#snippet action()}
            <a
              class="open"
              href={commandCenterUrl('intelligence', feature.key)}
              aria-label={$t('frameleaf_intel_open_named', { values: { name } })}
            >
              {$t('frameleaf_intel_open')}
            </a>
          {/snippet}
        </Item>
      {/each}
    </ItemList>
  </Section>
</KitPage>

<style>
  .address {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
  }
  /* The kit's quiet "Open" button, as a link so each feature page has an address. */
  .open {
    display: inline-flex;
    align-items: center;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    text-decoration: none;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .open:hover {
    border-color: var(--fl-accent);
  }
  .open:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
