<script lang="ts">
  /**
   * The Presets tab (PhotographyEditor.jsx): the built-in looks with their strength, and the account's
   * own presets saved on the server (`/develop-presets`, the native settings only, never geometry or
   * photo-specific masks).
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck, mdiClose, mdiPlus } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import DevelopSlider from '$lib/components/frameleaf/develop/DevelopSlider.svelte';
  import PhotographyThumb from '$lib/components/frameleaf/PhotographyThumb.svelte';
  import { LOOKS } from '$lib/frameleaf/raw-develop';
  import type { RawDevelopSession } from '$lib/frameleaf/raw-develop-session.svelte';

  let {
    session,
    id,
    image,
    say,
  }: { session: RawDevelopSession; id: string; image: string | null; say: (message: string) => void } = $props();

  const record = $derived(session.record(id));
  let name = $state('');
  let busy = $state(false);

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (!name.trim() || busy) {
      return;
    }
    busy = true;
    try {
      await session.savePreset(id, name);
      name = '';
      say($t('frameleaf_develop_preset_saved'));
    } catch {
      say($t('frameleaf_develop_preset_not_saved'));
    } finally {
      busy = false;
    }
  }

  async function remove(presetId: string) {
    try {
      await session.deletePreset(presetId);
    } catch {
      say($t('frameleaf_develop_preset_not_deleted'));
    }
  }
</script>

<div class="rde-inspector-heading">
  <strong>{$t('frameleaf_develop_looks')}</strong><span>{$t('frameleaf_develop_looks_where')}</span>
</div>
<div class="rde-presets">
  {#each LOOKS as look (look.id)}
    <button
      type="button"
      aria-pressed={record.look?.id === look.id}
      onclick={() => session.look(id, look.id, record.look?.id === look.id ? record.look.strength : 100)}
    >
      <span class="rde-preset-image"><PhotographyThumb src={image} style={`filter: ${look.swatch}`} /></span>
      <span class="rde-preset-name">{$t(`frameleaf_develop_look_${look.id}` as never)}</span>
      {#if record.look?.id === look.id}<Icon icon={mdiCheck} size="15" aria-hidden={true} />{/if}
    </button>
  {/each}
</div>
<DevelopSlider
  label={$t('frameleaf_develop_look_strength')}
  value={record.look?.strength ?? 100}
  min={0}
  max={100}
  disabled={!record.look}
  format={(value) => `${Math.round(value)}%`}
  onChange={(value) => record.look && session.look(id, record.look.id, value)}
/>
<p class="rde-muted">{$t('frameleaf_develop_look_note')}</p>

<form class="rde-preset-save" onsubmit={save}>
  <label
    >{$t('frameleaf_develop_preset_save_label')}<input
      required
      maxlength="50"
      placeholder={$t('frameleaf_develop_preset_placeholder')}
      bind:value={name}
    /></label
  >
  <button type="submit" class="rde-button" disabled={!name.trim() || busy}
    ><Icon icon={mdiPlus} size="15" aria-hidden={true} />{$t('frameleaf_editor_preset_save')}</button
  >
</form>
{#if session.presets.length > 0}
  <div class="rde-saved-presets">
    <h3>{$t('frameleaf_develop_your_presets')}</h3>
    {#each session.presets as preset (preset.id)}
      <div>
        <button type="button" onclick={() => session.applyPreset(id, preset)}>{preset.name}</button>
        <button
          type="button"
          aria-label={$t('frameleaf_develop_preset_delete', { values: { name: preset.name } })}
          onclick={() => void remove(preset.id)}><Icon icon={mdiClose} size="15" aria-hidden={true} /></button
        >
      </div>
    {/each}
  </div>
{/if}
