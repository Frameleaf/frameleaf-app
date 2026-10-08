<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import Button from './Button.svelte';
  import { photographyErrorKey } from './PhotographyStatus.svelte';
  import { watermarkPreview, type Watermark } from '$lib/frameleaf/photography/workflow-api';
  import { loadLogos } from '$lib/frameleaf/photography/api';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';

  let { value = $bindable(), disabled = false }: { value: Watermark; disabled?: boolean } = $props();
  let orientation = $state<'portrait' | 'landscape'>('landscape');
  let background = $state<'light' | 'dark'>('dark');
  let preview = $state('');
  let error = $state('');
  let rendering = $state(false);
  let logos = $state<{ id: string; fileName: string }[]>([]);
  let cursor = $state<string | null>(null);
  let generation = 0;
  let disposed = false;
  const failure = (cause: unknown) => $t(photographyErrorKey(cause));
  const positionLabel = (position: Watermark['position'] | Watermark['logoPosition'] | Watermark['alignment']) =>
    ({
      above: $t('frameleaf_photography_place_above'),
      below: $t('frameleaf_photography_place_below'),
      left: $t('frameleaf_photography_place_left'),
      right: $t('frameleaf_photography_place_right'),
      center: $t('frameleaf_photography_position_centre'),
      'bottom-right': $t('frameleaf_photography_position_bottom_right'),
      'bottom-left': $t('frameleaf_photography_position_bottom_left'),
      'top-right': $t('frameleaf_photography_position_top_right'),
      'top-left': $t('frameleaf_photography_position_top_left'),
    })[position];

  async function refresh() {
    const current = ++generation;
    rendering = true;
    error = '';
    // Never retain an old mark while a new preview is being prepared.
    if (preview) {
      URL.revokeObjectURL(preview);
    }
    preview = '';
    try {
      const blob = await watermarkPreview($state.snapshot(value), orientation, background);
      if (disposed || current !== generation) {
        return;
      }
      preview = URL.createObjectURL(blob);
    } catch (error_) {
      if (!disposed && current === generation) {
        error = failure(error_);
      }
    } finally {
      if (current === generation) {
        rendering = false;
      }
    }
  }
  async function moreLogos() {
    try {
      const page = await loadLogos(cursor);
      if (disposed) {
        return;
      }
      logos = [...logos, ...page.logos.filter((logo) => logos.every((old) => old.id !== logo.id))];
      cursor = page.nextCursor;
    } catch (error_) {
      error = failure(error_);
    }
  }
  async function uploadLogo() {
    try {
      const [id] = await openFileUploadDialog({ multiple: false });
      if (!disposed && id) {
        value.logoAssetId = id;
        value.type = 'both';
        await refresh();
      }
    } catch (error_) {
      error = failure(error_);
    }
  }
  onMount(() => {
    void moreLogos();
    void refresh();
  });
  onDestroy(() => {
    disposed = true;
    generation++;
    if (preview) {
      URL.revokeObjectURL(preview);
    }
  });
</script>

<div class="phd-watermark-editor">
  <fieldset {disabled}>
    <legend>{$t('frameleaf_photography_wm_composition')}</legend>
    <div class="phd-fields">
      <label
        >{$t('frameleaf_photography_wm_content')}<select bind:value={value.type}
          ><option value="text">{$t('frameleaf_photography_wm_text')}</option><option value="logo"
            >{$t('frameleaf_photography_wm_logo')}</option
          ><option value="both">{$t('frameleaf_photography_wm_both')}</option></select
        ></label
      >
      <label>{$t('frameleaf_photography_studio_name')}<input maxlength="200" required bind:value={value.text} /></label>
      <label
        >{$t('frameleaf_photography_wm_second_line')}<input
          maxlength="200"
          bind:value={value.secondLine}
          placeholder={$t('frameleaf_photography_wm_second_line_placeholder')}
        /></label
      >
      <label
        >{$t('frameleaf_photography_wm_font')}<select bind:value={value.font}
          ><option value="script">{$t('frameleaf_photography_wm_font_script')}</option><option value="serif"
            >{$t('frameleaf_photography_wm_font_serif')}</option
          ><option value="sans">{$t('frameleaf_photography_wm_font_sans')}</option></select
        ></label
      >
      <label
        >{$t('frameleaf_photography_wm_logo_field')}<select bind:value={value.logoAssetId}
          ><option value={null}>{$t('frameleaf_photography_wm_choose_logo')}</option
          >{#each logos as logo (logo.id)}<option value={logo.id}>{logo.fileName}</option>{/each}</select
        ></label
      >
      <label
        >{$t('frameleaf_photography_wm_logo_variant')}<select bind:value={value.logoVariant}
          ><option value="original">{$t('frameleaf_photography_wm_variant_original')}</option><option value="light"
            >{$t('frameleaf_photography_light')}</option
          ><option value="dark">{$t('frameleaf_photography_dark')}</option></select
        ></label
      >
      <label
        >{$t('frameleaf_photography_wm_logo_placement')}<select bind:value={value.logoPosition}
          >{#each ['above', 'below', 'left', 'right'] as const as position (position)}<option value={position}
              >{positionLabel(position)}</option
            >{/each}</select
        ></label
      >
      <label
        >{$t('frameleaf_photography_wm_alignment')}<select bind:value={value.alignment}
          >{#each ['left', 'center', 'right'] as const as alignment (alignment)}<option value={alignment}
              >{positionLabel(alignment)}</option
            >{/each}</select
        ></label
      >
    </div>
    <div class="phd-actions">
      <Button onclick={uploadLogo}>{$t('frameleaf_photography_wm_upload_logo')}</Button>{#if cursor}<Button
          onclick={moreLogos}>{$t('frameleaf_photography_wm_more_logos')}</Button
        >{/if}
    </div>
    <div class="phd-fields">
      <label
        >{$t('frameleaf_photography_wm_pattern')}<select bind:value={value.pattern}
          ><option value="signature">{$t('frameleaf_photography_preset_signature_name')}</option><option value="centre"
            >{$t('frameleaf_photography_wm_pattern_centre')}</option
          ><option value="diagonal">{$t('frameleaf_photography_wm_pattern_diagonal')}</option><option value="tile"
            >{$t('frameleaf_photography_wm_pattern_tile')}</option
          ></select
        ></label
      >
      <label
        >{$t('frameleaf_photography_position')}<select bind:value={value.position}
          >{#each ['bottom-right', 'bottom-left', 'top-right', 'top-left', 'center'] as const as position (position)}<option
              value={position}>{positionLabel(position)}</option
            >{/each}</select
        ></label
      >
      <label>{$t('frameleaf_photography_colour')}<input type="color" bind:value={value.color} /></label>
      <label
        >{$t('frameleaf_photography_size_value', { values: { value: value.size } })}<input
          type="range"
          min="1"
          max="30"
          bind:value={value.size}
        /></label
      >
      <label
        >{$t('frameleaf_photography_wm_logo_scale', { values: { value: value.logoScale } })}<input
          type="range"
          min="0.25"
          max="4"
          step="0.25"
          bind:value={value.logoScale}
        /></label
      >
      <label
        >{$t('frameleaf_photography_opacity_value', { values: { value: value.opacity } })}<input
          type="range"
          min="1"
          max="100"
          bind:value={value.opacity}
        /></label
      >
      <label
        >{$t('frameleaf_photography_wm_rotation', { values: { value: value.rotation } })}<input
          type="range"
          min="-180"
          max="180"
          bind:value={value.rotation}
        /></label
      >
      <label
        >{$t('frameleaf_photography_wm_margin', { values: { value: value.margin } })}<input
          type="range"
          min="0"
          max="25"
          bind:value={value.margin}
        /></label
      >
      <label
        >{$t('frameleaf_photography_wm_spacing', { values: { value: value.spacing } })}<input
          type="range"
          min="0"
          max="100"
          bind:value={value.spacing}
        /></label
      >
    </div>
    <div class="phd-actions">
      <label><input type="checkbox" bind:checked={value.outline} />{$t('frameleaf_photography_wm_outline')}</label
      ><label><input type="checkbox" bind:checked={value.backing} />{$t('frameleaf_photography_wm_backing')}</label>
    </div>
  </fieldset>
  <section class="phd-preview" aria-label={$t('frameleaf_photography_wm_preview_label')}>
    <div class="phd-actions">
      <label
        >{$t('frameleaf_photography_wm_preview_shape')}<select bind:value={orientation}
          ><option value="landscape">{$t('frameleaf_photography_landscape')}</option><option value="portrait"
            >{$t('frameleaf_photography_portrait')}</option
          ></select
        ></label
      >
      <label
        >{$t('frameleaf_photography_wm_test_canvas')}<select bind:value={background}
          ><option value="dark">{$t('frameleaf_photography_dark')}</option><option value="light"
            >{$t('frameleaf_photography_light')}</option
          ></select
        ></label
      >
      <Button disabled={disabled || rendering} onclick={refresh}
        >{rendering ? $t('frameleaf_photography_wm_rendering') : $t('frameleaf_photography_wm_refresh')}</Button
      >
    </div>
    {#if error}<p role="alert">{error}</p>{/if}
    {#if preview}<img
        src={preview}
        alt={$t('frameleaf_photography_wm_preview_alt')}
        class:portrait={orientation === 'portrait'}
      />{:else}<p role="status">
        {rendering ? $t('frameleaf_photography_wm_preparing_preview') : $t('frameleaf_photography_wm_refresh_hint')}
      </p>{/if}
  </section>
</div>
