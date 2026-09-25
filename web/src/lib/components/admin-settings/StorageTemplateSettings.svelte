<script lang="ts">
  import SupportedDatetimePanel from '$lib/components/admin-settings/SupportedDatetimePanel.svelte';
  import SupportedVariablesPanel from '$lib/components/admin-settings/SupportedVariablesPanel.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { helpLinks } from '$lib/frameleaf/help-links.svelte';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { Route } from '$lib/route';
  import { handleSystemConfigSave } from '$lib/services/system-config.service';
  import {
    getStorageTemplateOptions,
    searchUsersAdmin,
    type SystemConfigTemplateStorageOptionDto,
    type UserAdminResponseDto,
  } from '@immich/sdk';
  import { Heading, Link, LoadingSpinner, Text } from '@immich/ui';
  import handlebar from 'handlebars';
  import * as luxon from 'luxon';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { createBubbler, preventDefault } from 'svelte/legacy';
  import { fade } from 'svelte/transition';

  type Props = {
    minified?: boolean;
    duration?: number;
    saveOnClose?: boolean;
  };

  const { minified = false, duration = 500, saveOnClose = false }: Props = $props();

  const disabled = $derived(featureFlagsManager.value.configFile);
  // On the settings page this form edits the one settings draft (FL-66). Onboarding uses it on
  // its own, with a local copy that is saved when the step closes.
  const settingsDraft = getSystemConfigDraft();
  const standalone = $state(settingsDraft ? undefined : systemConfigManager.cloneValue());
  const configToEdit = $derived(settingsDraft ? settingsDraft.draft : standalone!);
  const config = $derived(settingsDraft ? settingsDraft.baseline : systemConfigManager.value);
  const physicalDeduplication = $derived(configToEdit.physicalDeduplication ?? { enabled: false, masterUserId: null });
  const savedPhysicalDeduplication = $derived(config.physicalDeduplication ?? { enabled: false, masterUserId: null });

  const setPhysicalDeduplication = (patch: Partial<typeof physicalDeduplication>) => {
    configToEdit.physicalDeduplication = { ...physicalDeduplication, ...patch };
  };

  const bubble = createBubbler();
  let templateOptions: SystemConfigTemplateStorageOptionDto | undefined = $state();
  let selectedPreset = $state('');
  let users = $state<UserAdminResponseDto[]>([]);

  const getTemplateOptions = async () => {
    templateOptions = await getStorageTemplateOptions();
    selectedPreset = config.storageTemplate.template;
  };

  const getSupportDateTimeFormat = () => getStorageTemplateOptions();

  const renderTemplate = (templateString: string) => {
    if (!templateOptions) {
      return '';
    }

    const template = handlebar.compile(templateString, {
      knownHelpers: undefined,
    });

    const substitutions: Record<string, string> = {
      filename: 'IMAGE_56437',
      ext: 'jpg',
      filetype: 'IMG',
      filetypefull: 'IMAGE',
      assetId: 'a8312960-e277-447d-b4ea-56717ccba856',
      assetIdShort: '56717ccba856',
      album: $t('album_name'),
      make: 'FUJIFILM',
      model: 'X-T50',
      lensModel: 'XF27mm F2.8 R WR',
    };

    const dt = luxon.DateTime.fromISO(new Date('2022-02-03T04:56:05.250').toISOString());
    const albumStartTime = luxon.DateTime.fromISO(new Date('2021-12-31T05:32:41.750').toISOString());
    const albumEndTime = luxon.DateTime.fromISO(new Date('2023-05-06T09:15:17.100').toISOString());

    const dateTokens = [
      ...templateOptions.yearOptions,
      ...templateOptions.monthOptions,
      ...templateOptions.weekOptions,
      ...templateOptions.dayOptions,
      ...templateOptions.hourOptions,
      ...templateOptions.minuteOptions,
      ...templateOptions.secondOptions,
    ];

    for (const token of dateTokens) {
      substitutions[token] = dt.toFormat(token);
      substitutions['album-startDate-' + token] = albumStartTime.toFormat(token);
      substitutions['album-endDate-' + token] = albumEndTime.toFormat(token);
    }

    return template(substitutions);
  };

  const handlePresetSelection = () => {
    configToEdit.storageTemplate.template = selectedPreset;
  };

  const getUsers = async () => {
    users = await searchUsersAdmin({ withDeleted: false });
  };

  // The retained account is saved here; previewing and applying a plan live on the
  // Physical deduplication page, which reads this saved value.
  const handlePhysicalDeduplicationMasterSelection = (value: string | number) => {
    setPhysicalDeduplication({ masterUserId: value ? String(value) : null });
  };

  const masterOptions = $derived([
    { value: '', text: $t('admin.physical_deduplication_select_master_user') },
    ...users.map((user) => ({ value: user.id, text: `${user.name} (${user.email})` })),
  ]);

  let parsedTemplate = $derived(() => {
    try {
      return renderTemplate(configToEdit.storageTemplate.template);
    } catch {
      return 'error';
    }
  });

  onDestroy(async () => {
    if (saveOnClose && !settingsDraft) {
      await handleSystemConfigSave({ storageTemplate: configToEdit.storageTemplate });
    }
  });

  // FL-135: this installation's documentation, or no link at all
  const templateDocs = $derived(helpLinks.docs('administration/storage-template'));
  const implicationsDocs = $derived(
    helpLinks.docs('administration/backup-and-restore#asset-types-and-storage-locations'),
  );
</script>

<section class="mt-2 dark:text-immich-dark-fg">
  <div in:fade={{ duration }} class="mx-4 flex flex-col gap-4 py-4">
    {#if templateDocs && implicationsDocs}
      <p class="text-sm dark:text-immich-dark-fg">
        <FormatMessage key="admin.storage_template_more_details">
          {#snippet children({ tag, message })}
            {#if tag === 'template-link'}
              <Link href={templateDocs}>{message}</Link>
            {:else if tag === 'implications-link'}
              <Link href={implicationsDocs}>{message}</Link>
            {/if}
          {/snippet}
        </FormatMessage>
      </p>
    {/if}
  </div>
  {#await getTemplateOptions() then}
    <div id="directory-path-builder" class="flex flex-col gap-4">
      <SettingToggle
        title={$t('admin.storage_template_enable_description')}
        {disabled}
        bind:checked={configToEdit.storageTemplate.enabled}
        isEdited={configToEdit.storageTemplate.enabled !== config.storageTemplate.enabled}
      />

      {#if !minified}
        <SettingToggle
          title={$t('admin.storage_template_hash_verification_enabled')}
          {disabled}
          subtitle={$t('admin.storage_template_hash_verification_enabled_description')}
          bind:checked={configToEdit.storageTemplate.hashVerificationEnabled}
          isEdited={configToEdit.storageTemplate.hashVerificationEnabled !==
            config.storageTemplate.hashVerificationEnabled}
        />
      {/if}

      {#if !minified}
        <hr />

        <div class="flex flex-col gap-4">
          <Heading size="tiny" color="primary">
            {$t('admin.physical_deduplication')}
          </Heading>

          <SettingToggle
            title={$t('admin.physical_deduplication_enable')}
            {disabled}
            subtitle={$t('admin.physical_deduplication_description')}
            checked={physicalDeduplication.enabled}
            onToggle={(enabled) => setPhysicalDeduplication({ enabled })}
            isEdited={physicalDeduplication.enabled !== savedPhysicalDeduplication.enabled}
          />

          {#await getUsers() then}
            <SettingSelect
              label={$t('admin.physical_deduplication_master_user')}
              desc={$t('admin.physical_deduplication_master_user_description')}
              name="physical-deduplication-master-user"
              value={physicalDeduplication.masterUserId ?? ''}
              options={masterOptions}
              disabled={disabled || !physicalDeduplication.enabled}
              isEdited={physicalDeduplication.masterUserId !== savedPhysicalDeduplication.masterUserId}
              onSelect={handlePhysicalDeduplicationMasterSelection}
            />
          {:catch}
            <Text size="small">{$t('errors.unable_to_load_users')}</Text>
          {/await}

          <p class="text-sm">
            <Link href={Route.physicalDeduplication()}>{$t('frameleaf_settings_dedup_link')}</Link>
          </p>
        </div>
      {/if}

      {#if configToEdit.storageTemplate.enabled}
        <hr />

        <Heading size="tiny" color="primary">
          {$t('variables')}
        </Heading>

        <section class="support-date">
          {#await getSupportDateTimeFormat()}
            <LoadingSpinner />
          {:then options}
            <div transition:fade={{ duration: 200 }}>
              <SupportedDatetimePanel {options} />
            </div>
          {/await}
        </section>

        <section class="support-date">
          <SupportedVariablesPanel />
        </section>

        <div class="mt-2 flex flex-col">
          <!-- <h3 class="text-base font-medium text-primary">{$t('template')}</h3> -->
          <Heading size="tiny" color="primary">
            {$t('template')}
          </Heading>

          <div class="my-2">
            <Text size="small">{$t('preview')}</Text>
          </div>

          <p class="text-sm">
            <FormatMessage
              key="admin.storage_template_path_length"
              values={{
                length: parsedTemplate().length + authManager.user.id.length + 'UPLOAD_LOCATION'.length,
                limit: 260,
              }}
            >
              {#snippet children({ message })}
                <span class="font-semibold text-primary">{message}</span>
              {/snippet}
            </FormatMessage>
          </p>

          <p class="text-sm">
            <FormatMessage
              key="admin.storage_template_user_label"
              values={{ label: authManager.user.storageLabel || authManager.user.id }}
            >
              {#snippet children({ message })}
                <code class="text-primary">{message}</code>
              {/snippet}
            </FormatMessage>
          </p>

          <p class="mt-2 rounded-lg bg-gray-200 p-4 py-2 text-xs dark:bg-gray-700 dark:text-immich-dark-fg">
            <span class="text-immich-fg/25 dark:text-immich-dark-fg/50"
              >UPLOAD_LOCATION/library/{authManager.user.storageLabel || authManager.user.id}</span
            >/{parsedTemplate()}.jpg
          </p>

          <form autocomplete="off" class="flex flex-col" onsubmit={preventDefault(bubble('submit'))}>
            <div class="my-2 flex flex-col">
              {#if templateOptions}
                <label class="text-sm font-medium text-primary" for="preset-select">
                  {$t('preset')}
                </label>
                <select
                  class="mt-2 immich-form-input rounded-lg bg-slate-200 p-2 text-sm hover:cursor-pointer dark:bg-gray-600"
                  disabled={disabled || !configToEdit.storageTemplate.enabled}
                  name="presets"
                  id="preset-select"
                  bind:value={selectedPreset}
                  onchange={handlePresetSelection}
                >
                  {#each templateOptions.presetOptions as preset (preset)}
                    <option value={preset}>{renderTemplate(preset)}</option>
                  {/each}
                </select>
              {/if}
            </div>

            <div class="flex gap-2 align-bottom">
              <SettingField
                label={$t('template')}
                disabled={disabled || !configToEdit.storageTemplate.enabled}
                required
                inputType={SettingInputFieldType.TEXT}
                bind:value={configToEdit.storageTemplate.template}
                isEdited={configToEdit.storageTemplate.template !== config.storageTemplate.template}
              />

              <div class="flex-0">
                <SettingField label={$t('extension')} inputType={SettingInputFieldType.TEXT} value=".jpg" disabled />
              </div>
            </div>

            {#if !minified}
              <div id="migration-info" class="mt-2 text-sm">
                <Heading size="tiny" color="primary">
                  {$t('notes')}
                </Heading>
                <section class="flex flex-col gap-2">
                  <p>
                    <FormatMessage
                      key="admin.storage_template_migration_info"
                      values={{ job: $t('admin.storage_template_migration_job') }}
                    >
                      {#snippet children({ message })}
                        <a href={Route.queues()} class="text-primary">{message}</a>
                      {/snippet}
                    </FormatMessage>
                  </p>
                </section>
              </div>
            {/if}
          </form>
        </div>
      {/if}

      {#if !minified}
        <SettingActions keys={['storageTemplate', 'physicalDeduplication']} {disabled} />
      {/if}
    </div>
  {/await}
</section>
