<script lang="ts">
  /**
   * Onboarding → Storage template (FL-80 ON-1, O-10): the prototype's step
   * (`AuthScreens.jsx:1005-1072`) — "Organise originals into folders", preset chips, the pattern with
   * variables inserted at the cursor, and a live example — in place of the embedded legacy
   * `StorageTemplateSettings`. It starts from the server's current template and, when the step
   * closes, saves the switch and the pattern to the storage template settings, as the old step did.
   * The server validates the pattern: the example only covers the sample's variables, so a token it
   * cannot fill says so instead of blocking the save, and a pattern the server rejects is reported by
   * the save's error message and left unchanged.
   */
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import {
    insertStorageToken,
    renderStorageTemplate,
    STORAGE_TEMPLATE_MAX_LENGTH,
    STORAGE_TEMPLATE_PRESETS,
    STORAGE_TEMPLATE_VARIABLES,
  } from '$lib/frameleaf/onboarding';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import { handleSystemConfigSave } from '$lib/services/system-config.service';
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  const initial = systemConfigManager.cloneValue().storageTemplate;
  let enabled = $state(initial.enabled);
  let pattern = $state(initial.template);
  let field = $state<HTMLInputElement>();
  const id = $props.id();

  const preview = $derived(renderStorageTemplate(pattern, authManager.user.storageLabel || authManager.user.id));

  const insert = async (token: string) => {
    const next = insertStorageToken(
      pattern,
      token,
      field?.selectionStart ?? undefined,
      field?.selectionEnd ?? undefined,
    );
    pattern = next.pattern;
    await tick();
    field?.focus();
    field?.setSelectionRange(next.caret, next.caret);
  };

  onDestroy(async () => {
    const template = pattern.trim() || initial.template;
    if (enabled === initial.enabled && template === initial.template) {
      return;
    }
    await handleSystemConfigSave({ storageTemplate: { ...initial, enabled, template } });
  });
</script>

<div class="ob-template">
  <SettingToggle
    title={$t('frameleaf_onboarding_storage_toggle')}
    subtitle={$t('frameleaf_onboarding_storage_toggle_description')}
    bind:checked={enabled}
  />
  {#if enabled}
    <div class="ob-chips" role="group" aria-label={$t('frameleaf_onboarding_storage_presets')}>
      {#each STORAGE_TEMPLATE_PRESETS as preset (preset.id)}
        <button type="button" aria-pressed={pattern === preset.pattern} onclick={() => (pattern = preset.pattern)}>
          {$t(preset.label)}
        </button>
      {/each}
    </div>
    <div class="auth-field">
      <label for={id}>{$t('frameleaf_onboarding_storage_pattern')}</label>
      <input
        {id}
        bind:this={field}
        bind:value={pattern}
        maxlength={STORAGE_TEMPLATE_MAX_LENGTH}
        spellcheck="false"
        autocomplete="off"
        aria-describedby="{id}-hint"
      />
      <span class="auth-note" id="{id}-hint">{$t('frameleaf_onboarding_storage_pattern_hint')}</span>
    </div>
    <div class="ob-chips" role="group" aria-label={$t('frameleaf_onboarding_storage_variables')}>
      {#each STORAGE_TEMPLATE_VARIABLES as variable (variable.token)}
        <button
          type="button"
          aria-label={$t('frameleaf_onboarding_storage_insert', { values: { variable: $t(variable.label) } })}
          onclick={() => insert(variable.token)}
        >
          {$t(variable.label)}
          <code aria-hidden="true">{variable.token}</code>
        </button>
      {/each}
    </div>
    <div class="ob-template-preview" aria-live="polite">
      <span>{$t('frameleaf_onboarding_storage_example')}</span>
      <code>{preview.path}</code>
      {#if preview.unknown.length > 0}
        <span>
          {$t('frameleaf_onboarding_storage_no_preview', {
            values: { count: preview.unknown.length, variables: preview.unknown.join(', ') },
          })}
        </span>
      {/if}
    </div>
  {/if}
</div>
