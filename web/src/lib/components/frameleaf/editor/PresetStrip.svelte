<script lang="ts">
  /**
   * The looks row of the Presets panel (FL-113). Each thumbnail previews the look with the CSS
   * approximation over the asset's thumbnail; the chosen preset is rendered for real by the
   * server preview on the stage. A radio group, so arrow keys move between looks.
   */
  import { cssFilterFor, presetsFor, type DevelopLookId, type DevelopValues } from '$lib/frameleaf/develop';
  import { t } from 'svelte-i18n';

  let {
    thumbnailUrl,
    values,
    preset,
    onSelect,
    kind = 'photo',
  }: {
    thumbnailUrl: string;
    values: DevelopValues;
    preset: DevelopLookId;
    onSelect: (preset: DevelopLookId) => void;
    /** Clips also offer the video-only looks (`develop.mjs` presetsFor). */
    kind?: 'photo' | 'video';
  } = $props();
</script>

<div class="ed-presets" role="radiogroup" aria-label={$t('frameleaf_editor_presets_label')}>
  {#each presetsFor(kind) as item (item.id)}
    {@const look = cssFilterFor({ ...values, preset: item.id, presetStrength: 100 })}
    <button
      type="button"
      role="radio"
      class="ed-preset"
      aria-checked={preset === item.id}
      onclick={() => onSelect(item.id)}
    >
      <span class="ed-preset-thumb">
        <img src={thumbnailUrl} alt="" draggable="false" style="filter: {look.filter}" />
        {#each look.layers as layer (layer.id)}
          <span class="ed-layer" style={layer.style}></span>
        {/each}
      </span>
      <span>{$t(item.label)}</span>
    </button>
  {/each}
</div>
