<script lang="ts">
  /**
   * The Develop tab (PhotographyEditor.jsx): Light, White balance, Tone curve, Colour, Detail & lens
   * and Crop geometry, each a native RAW control the server develops with.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiCropRotate } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import DevelopSlider from '$lib/components/frameleaf/develop/DevelopSlider.svelte';
  import { initialNativeRecipe } from '$lib/frameleaf/native-develop';
  import {
    CURVE_PRESETS,
    EXPOSURE_RANGE,
    FULL_FRAME,
    contrastSlider,
    contrastValue,
    curveLevels,
    curveValue,
    denoiseSlider,
    denoiseValue,
    normalizeCrop,
    saturationSlider,
    saturationValue,
    sharpnessSlider,
    sharpnessValue,
    whiteBalanceSliders,
    whiteBalanceValue,
    type CurvePreset,
  } from '$lib/frameleaf/raw-develop';
  import type { RawDevelopSession } from '$lib/frameleaf/raw-develop-session.svelte';

  let {
    session,
    id,
    onCrop,
    say,
  }: { session: RawDevelopSession; id: string; onCrop: () => void; say: (message: string) => void } = $props();

  const recipe = $derived(session.record(id).recipe);
  const balance = $derived(whiteBalanceSliders(recipe.whiteBalance));
  const levels = $derived(curveLevels(recipe.curve));
  const crop = $derived(recipe.crop ?? FULL_FRAME);
  const signed = (value: number) => `${value > 0 ? '+' : ''}${Math.round(value)}`;
  const curvePresets: [CurvePreset, string][] = [
    ['linear', 'frameleaf_develop_curve_linear'],
    ['soft', 'frameleaf_develop_curve_soft'],
    ['lifted', 'frameleaf_develop_curve_lifted'],
  ];
</script>

<div class="rde-inspector-heading">
  <strong>{$t('frameleaf_develop_tab_develop')}</strong>
  <button
    type="button"
    class="rde-link"
    onclick={() => {
      session.change(id, initialNativeRecipe());
      say($t('frameleaf_develop_reset_done'));
    }}>{$t('reset')}</button
  >
</div>

<details class="rde-section" open>
  <summary>{$t('frameleaf_develop_light')}</summary>
  <DevelopSlider
    label={$t('frameleaf_editor_param_exposure')}
    value={recipe.exposureEV}
    {...EXPOSURE_RANGE}
    format={(value) => `${value > 0 ? '+' : ''}${value.toFixed(2)} EV`}
    onChange={(value) => session.patch(id, { exposureEV: value }, 'exposure')}
  />
  <DevelopSlider
    label={$t('frameleaf_editor_param_contrast')}
    value={contrastSlider(recipe.contrast)}
    onChange={(value) => session.patch(id, { contrast: contrastValue(value) }, 'contrast')}
  />
  <DevelopSlider
    label={$t('frameleaf_editor_param_highlights')}
    value={recipe.highlights ?? 0}
    onChange={(value) => session.patch(id, { highlights: value === 0 ? undefined : value }, 'highlights')}
  />
  <DevelopSlider
    label={$t('frameleaf_editor_param_shadows')}
    value={recipe.shadows ?? 0}
    onChange={(value) => session.patch(id, { shadows: value === 0 ? undefined : value }, 'shadows')}
  />
</details>

<details class="rde-section" open>
  <summary>{$t('frameleaf_develop_white_balance')}</summary>
  <DevelopSlider
    label={$t('frameleaf_editor_param_temperature')}
    value={balance.temperature}
    format={signed}
    onChange={(value) => session.patch(id, { whiteBalance: whiteBalanceValue(value, balance.tint) }, 'temperature')}
  />
  <DevelopSlider
    label={$t('frameleaf_editor_param_tint')}
    value={balance.tint}
    format={signed}
    onChange={(value) => session.patch(id, { whiteBalance: whiteBalanceValue(balance.temperature, value) }, 'tint')}
  />
  <div class="rde-wb-actions">
    <button type="button" disabled={!recipe.whiteBalance} onclick={() => session.patch(id, { whiteBalance: undefined })}
      >{$t('frameleaf_develop_as_shot')}</button
    >
  </div>
</details>

<details class="rde-section" open>
  <summary>{$t('frameleaf_develop_tone_curve')}</summary>
  <svg class="rde-curve" viewBox="0 0 240 110" role="img" aria-label={$t('frameleaf_develop_curve_label')}>
    {#each [27, 55, 82] as y (y)}<path d={`M0 ${y}H240`} class="rde-grid-line" />{/each}
    {#each [60, 120, 180] as x (x)}<path d={`M${x} 0V110`} class="rde-grid-line" />{/each}
    <path d="M0 110L240 0" class="rde-curve-reference" />
    <polyline points={levels.map((y, index) => `${index * 60},${110 - y * 110}`).join(' ')} class="rde-curve-line" />
    {#each levels as y, index (index)}<circle cx={index * 60} cy={110 - y * 110} r="3" class="rde-curve-dot" />{/each}
  </svg>
  <label class="rde-select"
    >{$t('frameleaf_develop_curve_preset')}<select
      value=""
      onchange={(event) => {
        const preset = event.currentTarget.value as CurvePreset | '';
        if (preset) {
          session.patch(id, { curve: curveValue(CURVE_PRESETS[preset]) });
        }
        event.currentTarget.value = '';
      }}
      ><option value="">{$t('frameleaf_develop_curve_choose')}</option
      >{#each curvePresets as [preset, label] (preset)}<option value={preset}>{$t(label as never)}</option
        >{/each}</select
    ></label
  >
  {#each ['frameleaf_develop_curve_shadows', 'frameleaf_develop_curve_midtones', 'frameleaf_develop_curve_highlights'] as label, index (label)}
    <DevelopSlider
      label={$t(label as never)}
      value={Math.round(levels[index + 1] * 100)}
      min={0}
      max={100}
      onChange={(value) =>
        session.patch(
          id,
          { curve: curveValue(levels.map((y, at) => (at === index + 1 ? value / 100 : y))) },
          `curve-${index}`,
        )}
    />
  {/each}
</details>

<details class="rde-section">
  <summary>{$t('frameleaf_develop_colour')}</summary>
  <DevelopSlider
    label={$t('frameleaf_editor_param_saturation')}
    value={saturationSlider(recipe.saturation)}
    onChange={(value) => session.patch(id, { saturation: saturationValue(value) }, 'saturation')}
  />
</details>

<details class="rde-section">
  <summary>{$t('frameleaf_develop_detail_lens')}</summary>
  <DevelopSlider
    label={$t('frameleaf_develop_sharpness')}
    value={sharpnessSlider(recipe.sharpen)}
    min={0}
    onChange={(value) => session.patch(id, { sharpen: sharpnessValue(value, recipe.sharpen) }, 'sharpness')}
  />
  <DevelopSlider
    label={$t('frameleaf_develop_denoise')}
    value={denoiseSlider(recipe.noiseThreshold)}
    min={0}
    onChange={(value) => session.patch(id, { noiseThreshold: denoiseValue(value) }, 'denoise')}
  />
  <label class="rde-check"
    ><input
      type="checkbox"
      checked={!!recipe.lensCorrection}
      onchange={(event) => session.patch(id, { lensCorrection: event.currentTarget.checked || undefined })}
    />{$t('frameleaf_develop_lens_profile')}</label
  >
  <p class="rde-muted">{$t('frameleaf_develop_lens_note')}</p>
</details>

<details class="rde-section">
  <summary>{$t('frameleaf_develop_crop_geometry')}</summary>
  {#each [['x', 'frameleaf_develop_crop_left'], ['y', 'frameleaf_develop_crop_top'], ['w', 'frameleaf_develop_crop_width'], ['h', 'frameleaf_develop_crop_height']] as const as [key, label] (key)}
    <DevelopSlider
      label={$t(label)}
      value={Math.round(crop[key] * 100)}
      min={key === 'w' || key === 'h' ? 5 : 0}
      max={100}
      format={(value) => `${Math.round(value)}%`}
      onChange={(value) => {
        session.setAspect(id, 'Free');
        session.patch(id, { crop: normalizeCrop({ ...crop, [key]: value / 100 }) }, `crop-${key}`);
      }}
    />
  {/each}
  <button type="button" class="rde-button" onclick={onCrop}
    ><Icon icon={mdiCropRotate} size="15" aria-hidden={true} />{$t('frameleaf_develop_crop_rotate')}</button
  >
</details>
