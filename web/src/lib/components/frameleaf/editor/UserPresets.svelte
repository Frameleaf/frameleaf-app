<script lang="ts">
  /**
   * "Your presets" in the Presets panel (FL-64). A preset saves the current develop settings —
   * sliders, look, strength and masks, never the crop — under a name, and applies them to any
   * photo in one click. Presets belong to the signed-in account.
   */
  import {
    presetExtras,
    presetMatches,
    presetSettingsFrom,
    toPresetDto,
    type PresetSettings,
  } from '$lib/frameleaf/photo-tools';
  import { getServerErrorMessage, handleError } from '$lib/utils/handle-error';
  import {
    createDevelopPreset,
    deleteDevelopPreset,
    getDevelopPresets,
    updateDevelopPreset,
    type DevelopPresetResponseDto,
  } from '@frameleaf/sdk';
  import { Icon, modalManager, toastManager } from '@frameleaf/ui';
  import { mdiContentSaveOutline, mdiDeleteOutline, mdiPlus } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    current,
    carried = {},
    onApply,
  }: {
    current: PresetSettings;
    /** The recipe as the server holds it: where settings this editor has no control for live. */
    carried?: Record<string, unknown>;
    onApply: (settings: PresetSettings, extras: Record<string, unknown>) => void;
  } = $props();

  let presets = $state<DevelopPresetResponseDto[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let name = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  onMount(async () => {
    try {
      presets = await getDevelopPresets();
    } catch (error) {
      loadError = $t('frameleaf_editor_presets_load_error');
      handleError(error, loadError);
    } finally {
      loading = false;
    }
  });

  const sorted = (items: DevelopPresetResponseDto[]) => [...items].sort((a, b) => a.name.localeCompare(b.name));
  const trimmed = $derived(name.trim());

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!trimmed || saving) {
      return;
    }
    saving = true;
    saveError = null;
    try {
      const created = await createDevelopPreset({
        developPresetCreateDto: { name: trimmed, settings: toPresetDto(current) },
      });
      presets = sorted([...presets, created]);
      name = '';
      toastManager.primary($t('frameleaf_editor_preset_saved', { values: { name: created.name } }));
    } catch (error) {
      saveError = getServerErrorMessage(error) ?? $t('frameleaf_editor_preset_save_error');
    } finally {
      saving = false;
    }
  };

  // a setting the photo does not carry is at its neutral 0
  const applied = (preset: DevelopPresetResponseDto) =>
    presetMatches(presetSettingsFrom(preset.settings), current) &&
    Object.entries(presetExtras(preset.settings)).every(
      ([key, value]) => JSON.stringify(carried[key] ?? 0) === JSON.stringify(value),
    );

  const apply = (preset: DevelopPresetResponseDto) => {
    onApply(presetSettingsFrom(preset.settings), presetExtras(preset.settings));
    toastManager.primary($t('frameleaf_editor_preset_applied', { values: { name: preset.name } }));
  };

  const overwrite = async (preset: DevelopPresetResponseDto) => {
    try {
      const updated = await updateDevelopPreset({
        id: preset.id,
        developPresetUpdateDto: { settings: toPresetDto(current) },
      });
      presets = presets.map((item) => (item.id === updated.id ? updated : item));
      toastManager.primary($t('frameleaf_editor_preset_updated', { values: { name: updated.name } }));
    } catch (error) {
      handleError(error, $t('frameleaf_editor_preset_save_error'));
    }
  };

  const remove = async (preset: DevelopPresetResponseDto) => {
    const confirmed = await modalManager.showDialog({
      title: $t('frameleaf_editor_preset_delete_title'),
      prompt: $t('frameleaf_editor_preset_delete_prompt', { values: { name: preset.name } }),
      confirmText: $t('delete'),
    });
    if (!confirmed) {
      return;
    }
    try {
      await deleteDevelopPreset({ id: preset.id });
      presets = presets.filter((item) => item.id !== preset.id);
    } catch (error) {
      handleError(error, $t('frameleaf_editor_preset_delete_error'));
    }
  };
</script>

<h3>{$t('frameleaf_editor_your_presets')}</h3>
{#if loading}
  <p aria-busy="true">{$t('loading')}</p>
{:else if loadError}
  <p class="ed-empty">{loadError}</p>
{:else if presets.length === 0}
  <p class="ed-empty">{$t('frameleaf_editor_your_presets_empty')}</p>
{:else}
  <ul class="ed-preset-list" aria-label={$t('frameleaf_editor_your_presets')}>
    {#each presets as preset (preset.id)}
      <li class="ed-preset-item">
        <button
          type="button"
          class="ed-chip"
          aria-pressed={applied(preset)}
          title={$t('frameleaf_editor_preset_apply', { values: { name: preset.name } })}
          onclick={() => apply(preset)}
        >
          {preset.name}
        </button>
        <button
          type="button"
          class="ed-icon"
          aria-label={$t('frameleaf_editor_preset_update', { values: { name: preset.name } })}
          title={$t('frameleaf_editor_preset_update', { values: { name: preset.name } })}
          onclick={() => overwrite(preset)}
        >
          <Icon icon={mdiContentSaveOutline} size="18" />
        </button>
        <button
          type="button"
          class="ed-icon"
          aria-label={$t('frameleaf_editor_preset_delete', { values: { name: preset.name } })}
          title={$t('frameleaf_editor_preset_delete', { values: { name: preset.name } })}
          onclick={() => remove(preset)}
        >
          <Icon icon={mdiDeleteOutline} size="18" />
        </button>
      </li>
    {/each}
  </ul>
{/if}
<form class="ed-form" onsubmit={save}>
  <label class="rs-field">
    <span>{$t('frameleaf_editor_preset_name')}</span>
    <input class="ed-text" type="text" maxlength="80" bind:value={name} disabled={saving} />
  </label>
  {#if saveError}
    <p class="ed-error" role="alert">{saveError}</p>
  {/if}
  <button type="submit" class="ed-button" disabled={!trimmed || saving}>
    <Icon icon={mdiPlus} size="18" />
    {saving ? $t('frameleaf_editor_saving') : $t('frameleaf_editor_preset_save')}
  </button>
  <p class="ed-note">{$t('frameleaf_editor_preset_help')}</p>
</form>
