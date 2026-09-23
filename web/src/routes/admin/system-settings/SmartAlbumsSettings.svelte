<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingTextarea from '$lib/components/frameleaf/settings/SettingTextarea.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import SmartAlbumReevaluateModal from '$lib/modals/SmartAlbumReevaluateModal.svelte';
  import { Button, modalManager, toastManager } from '@immich/ui';
  import { mdiRefresh } from '@mdi/js';
  import {
    ClassificationRuleAction,
    SmartAlbumBuiltInKind as SmartAlbumKind,
    type AdminConfigSmartAlbumKindDto,
  } from '@immich/sdk';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);

  const smartAlbums = $derived(configToEdit.smartAlbums!);
  const savedSmartAlbums = $derived(config.smartAlbums!);
  const rules = $derived(smartAlbums.rules!);
  const savedRules = $derived(savedSmartAlbums.rules!);

  // List-type fields are displayed as newline-joined text and parsed back on input.
  // Using $derived ensures textareas always reflect the live config — including after a Reset.
  const parseLines = (text: string): string[] =>
    text
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);

  const kindKeys = [
    SmartAlbumKind.Travel,
    SmartAlbumKind.Documents,
    SmartAlbumKind.Screenshots,
    SmartAlbumKind.Food,
    SmartAlbumKind.Pets,
    SmartAlbumKind.Nature,
  ] as const;
  type KindKey = (typeof kindKeys)[number];

  const kindTitle = (kind: KindKey): string => {
    const key = `admin.smart_albums_kind_${kind}` as const;
    return $t(key);
  };

  const getKind = (kind: KindKey): AdminConfigSmartAlbumKindDto => smartAlbums.builtIn[kind];
  const getSavedKind = (kind: KindKey): AdminConfigSmartAlbumKindDto => savedSmartAlbums.builtIn[kind];

  const tagTriggersText = $derived(
    Object.fromEntries(kindKeys.map((k) => [k, getKind(k).tagTriggers.join('\n')])) as Record<KindKey, string>,
  );

  const clipQueriesText = $derived(
    Object.fromEntries(kindKeys.map((k) => [k, getKind(k).clipQueries.join('\n')])) as Record<KindKey, string>,
  );

  const handleReevaluateClick = async (kind?: KindKey) => {
    const props = kind ? { kind, kindLabel: kindTitle(kind) } : {};
    const result = await modalManager.show(SmartAlbumReevaluateModal, props);
    if (result?.queued) {
      if (kind) {
        toastManager.primary($t('admin.smart_albums_kind_reevaluate_started', { values: { kind: kindTitle(kind) } }));
      } else {
        toastManager.primary($t('admin.smart_albums_reevaluate_started'));
      }
    } else if (result) {
      toastManager.primary($t('admin.smart_albums_reevaluate_already_in_flight'));
    }
  };
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(event) => event.preventDefault()}>
      <div class="flex flex-col gap-4">
        <SettingToggle
          title={$t('admin.smart_albums_enabled')}
          subtitle={$t('admin.smart_albums_enabled_description')}
          {disabled}
          bind:checked={smartAlbums.enabled}
          isEdited={smartAlbums.enabled !== savedSmartAlbums.enabled}
        />

        <!--
          The design's "Categories & smart albums" section (settings-catalog.mjs): curated smart albums,
          custom visual categories, then the default rule action. Archiving is never a default (FL-60).
        -->
        <SettingToggle
          title={$t('admin.smart_albums_rules_visual')}
          subtitle={$t('admin.smart_albums_rules_visual_description')}
          {disabled}
          bind:checked={rules.visualCategories}
          isEdited={rules.visualCategories !== savedRules.visualCategories}
        />
        <SettingSelect
          label={$t('admin.smart_albums_rules_default_action')}
          desc={$t('admin.smart_albums_rules_default_action_description')}
          {disabled}
          options={[
            { value: ClassificationRuleAction.Review, text: $t('frameleaf_rules_action_review') },
            { value: ClassificationRuleAction.Tag, text: $t('frameleaf_rules_action_tag') },
          ]}
          bind:value={rules.defaultAction}
          isEdited={rules.defaultAction !== savedRules.defaultAction}
        />

        <hr />

        {#each kindKeys as kind (kind)}
          {@const kindConfig = getKind(kind)}
          {@const savedKindConfig = getSavedKind(kind)}
          {@const kindToggleDisabled = disabled || !smartAlbums.enabled}
          {@const kindFieldsDisabled = disabled || !smartAlbums.enabled || !kindConfig.enabled}
          <SettingGroup key={`smart-albums-${kind}`} title={kindTitle(kind)} subtitle="">
            <div class="flex flex-col gap-4">
              <SettingToggle
                title={$t('admin.smart_albums_kind_enabled')}
                disabled={kindToggleDisabled}
                bind:checked={kindConfig.enabled}
                isEdited={kindConfig.enabled !== savedKindConfig.enabled}
              />

              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label={$t('admin.smart_albums_kind_name')}
                description={$t('admin.smart_albums_kind_name_description')}
                bind:value={kindConfig.name}
                disabled={kindFieldsDisabled}
                isEdited={kindConfig.name !== savedKindConfig.name}
              />

              <SettingTextarea
                label={$t('admin.smart_albums_kind_tag_triggers')}
                description={$t('admin.smart_albums_kind_tag_triggers_description')}
                value={tagTriggersText[kind]}
                disabled={kindFieldsDisabled}
                isEdited={kindConfig.tagTriggers.join('\n') !== savedKindConfig.tagTriggers.join('\n')}
                onChange={(text) => (kindConfig.tagTriggers = parseLines(text))}
              />

              <SettingTextarea
                label={$t('admin.smart_albums_kind_clip_queries')}
                description={$t('admin.smart_albums_kind_clip_queries_description')}
                value={clipQueriesText[kind]}
                disabled={kindFieldsDisabled}
                isEdited={kindConfig.clipQueries.join('\n') !== savedKindConfig.clipQueries.join('\n')}
                onChange={(text) => (kindConfig.clipQueries = parseLines(text))}
              />

              <SettingField
                inputType={SettingInputFieldType.NUMBER}
                label={$t('admin.smart_albums_kind_threshold')}
                description={$t('admin.smart_albums_kind_threshold_description')}
                bind:value={kindConfig.threshold}
                step="0.01"
                min={0.2}
                max={0.4}
                disabled={kindFieldsDisabled}
                isEdited={kindConfig.threshold !== savedKindConfig.threshold}
              />

              <div class="flex justify-end">
                <Button
                  size="small"
                  shape="round"
                  color="secondary"
                  leadingIcon={mdiRefresh}
                  onclick={() => handleReevaluateClick(kind)}
                  disabled={kindFieldsDisabled}
                >
                  {$t('admin.smart_albums_kind_reevaluate_button')}
                </Button>
              </div>
            </div>
          </SettingGroup>
        {/each}

        <hr />

        <div class="flex justify-end">
          <Button
            size="small"
            shape="round"
            color="secondary"
            leadingIcon={mdiRefresh}
            onclick={() => handleReevaluateClick()}
            disabled={disabled || !smartAlbums.enabled}
          >
            {$t('admin.smart_albums_reevaluate_button')}
          </Button>
        </div>

        <SettingActions keys={['smartAlbums']} {disabled} />
      </div>
    </form>
  </div>
</div>
