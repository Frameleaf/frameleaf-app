<script lang="ts">
  /**
   * Watermarks: the one place to design the watermark (approved design, 2026-11-04). Reusable presets,
   * the default for proofs, web previews and exports, and the branding mark proofs and web previews
   * carry when no preset is chosen. Branding shows the result and leads here.
   */
  import { onMount, onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import Button from './Button.svelte';
  import { photographyErrorKey } from './PhotographyStatus.svelte';
  import PhotographyThumb from './PhotographyThumb.svelte';
  import PhotographyWatermarkEditor from './PhotographyWatermarkEditor.svelte';
  import { brandFonts, loadBrand, saveBrand, type Brand, type Branding } from '$lib/frameleaf/photography/api';
  import { defaultWatermark } from '$lib/frameleaf/photography/workflow-api';
  import { getAssetMediaUrl } from '$lib/utils';

  /** `photoId`: one of the photographer's own photos, behind the branding mark's preview. */
  let { photoId = null }: { photoId?: string | null } = $props();
  let draft = $state<Branding | null>(null);
  let active = $state('');
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let disposed = false;
  const preset = $derived(draft?.brand.watermarkPresets?.find((item) => item.id === active));
  const missingLogos = $derived(
    draft?.brand.watermarkPresets?.filter((item) => item.watermark.type !== 'text' && !item.watermark.logoAssetId) ??
      [],
  );
  async function reload() {
    busy = true;
    error = '';
    try {
      const result = await loadBrand();
      if (disposed) {
        return;
      }
      draft = { ...result, brand: { ...result.brand, watermarkPresets: result.brand.watermarkPresets ?? [] } };
      active = draft.brand.watermarkPresets?.[0]?.id ?? '';
    } catch (error_) {
      if (!disposed) {
        error = $t(photographyErrorKey(error_));
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }
  function add(proof = false) {
    if (!draft || (draft.brand.watermarkPresets?.length ?? 0) >= 30) {
      return;
    }
    const id = crypto.randomUUID();
    draft.brand.watermarkPresets!.push({
      id,
      name: proof ? $t('frameleaf_photography_preset_proof_name') : $t('frameleaf_photography_preset_signature_name'),
      version: 1,
      watermark: defaultWatermark(draft.brand.name, proof),
    });
    active = id;
    message = '';
  }
  async function save() {
    if (!draft || busy) {
      return;
    }
    busy = true;
    error = '';
    message = '';
    try {
      const result = await saveBrand(draft.revision, $state.snapshot(draft.brand));
      if (disposed) {
        return;
      }
      draft = result;
      message = $t('frameleaf_photography_watermark_presets_saved');
    } catch (error_) {
      if (!disposed) {
        error = $t(photographyErrorKey(error_));
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }
  /** Quick settings for the branding mark. */
  function quick(position: Brand['watermarkPosition'], opacity: number, size: number) {
    if (!draft || busy) {
      return;
    }
    draft.brand.watermarkPosition = position;
    draft.brand.watermarkOpacity = opacity;
    draft.brand.watermarkSize = size;
  }
  function remove() {
    if (!draft || !preset) {
      return;
    }
    for (const role of ['webWatermarkPresetId', 'proofWatermarkPresetId', 'exportWatermarkPresetId'] as const) {
      if (draft.brand[role] === active) {
        draft.brand[role] = null;
      }
    }
    draft.brand.watermarkPresets = draft.brand.watermarkPresets!.filter((item) => item.id !== active);
    active = draft.brand.watermarkPresets[0]?.id ?? '';
  }
  onMount(() => {
    void reload();
  });
  onDestroy(() => {
    disposed = true;
  });
</script>

<div class="phd" aria-busy={busy}>
  <!-- The page header names the page; this row says what it holds and saves it. -->
  <div class="phd-toolbar">
    <p>{$t('frameleaf_photography_watermarks_body')}</p>
    <div class="phd-actions">
      <Button disabled={busy} onclick={reload}>{$t('frameleaf_photography_reload')}</Button><Button
        variant="primary"
        disabled={busy || !draft || missingLogos.length > 0}
        onclick={save}>{$t('frameleaf_photography_save_watermark_presets')}</Button
      >
    </div>
  </div>
  {#if error}<div class="phw-notice" role="alert">{error}</div>{/if}{#if message}<p role="status">{message}</p>{/if}
  {#if missingLogos.length}<p class="phw-notice" role="alert">
      {$t('frameleaf_photography_missing_logos', {
        values: { names: missingLogos.map((item) => item.name).join(', ') },
      })}
    </p>{/if}
  {#if draft}<section class="phd-card">
      <div class="phd-row">
        <label
          >{$t('frameleaf_photography_preset')}<select bind:value={active}
            ><option value="">{$t('frameleaf_photography_choose_preset')}</option
            >{#each draft.brand.watermarkPresets ?? [] as item (item.id)}<option value={item.id}
                >{item.name} · v{item.version}</option
              >{/each}</select
          ></label
        >
        <div class="phd-actions">
          <Button disabled={busy || (draft.brand.watermarkPresets?.length ?? 0) >= 30} onclick={() => add()}
            >{$t('frameleaf_photography_new_signature')}</Button
          ><Button disabled={busy || (draft.brand.watermarkPresets?.length ?? 0) >= 30} onclick={() => add(true)}
            >{$t('frameleaf_photography_new_proof')}</Button
          ><Button disabled={busy || !preset} onclick={remove}>{$t('frameleaf_photography_remove_preset')}</Button>
        </div>
      </div>
      {#if preset}<label
          >{$t('frameleaf_photography_preset_name')}<input maxlength="100" required bind:value={preset.name} /></label
        >{#key preset.id}<PhotographyWatermarkEditor bind:value={preset.watermark} disabled={busy} />{/key}{:else}<p>
          {$t('frameleaf_photography_create_preset_hint')}
        </p>{/if}
    </section>
    <section class="phd-card">
      <h3>{$t('frameleaf_photography_defaults_title')}</h3>
      <div class="phd-fields">
        {#each [['webWatermarkPresetId', $t('frameleaf_photography_web_previews')], ['proofWatermarkPresetId', $t('frameleaf_photography_selection_proofs')], ['exportWatermarkPresetId', $t('frameleaf_photography_final_exports')]] as [key, label] (key)}<label
            >{label}<select
              value={draft.brand[key as 'webWatermarkPresetId'] ?? ''}
              disabled={busy || !draft.brand.watermarkPresets?.length}
              onchange={(event) => (draft!.brand[key as 'webWatermarkPresetId'] = event.currentTarget.value || null)}
              ><!-- Without a preset, exports stay clean and proofs and web previews use the Branding mark. --><option
                value=""
                >{key === 'exportWatermarkPresetId'
                  ? $t('frameleaf_photography_no_watermark')
                  : $t('frameleaf_photography_branding_mark')}</option
              >{#each draft.brand.watermarkPresets ?? [] as item (item.id)}<option value={item.id}
                  >{item.name} · v{item.version}</option
                >{/each}</select
            ></label
          >{/each}
      </div>
      <p>
        {$t('frameleaf_photography_defaults_note')}
      </p>
    </section>
    <section class="phd-card phw-branding-mark" aria-busy={busy}>
      <h3>{$t('frameleaf_photography_branding_mark')}</h3>
      <p>{$t('frameleaf_photography_branding_mark_body')}</p>
      <fieldset disabled={busy}>
        <div class="phw-brand-buttons" role="group" aria-label={$t('frameleaf_photography_watermark_quick')}>
          <Button onclick={() => quick('bottom-right', 35, 4)}>{$t('frameleaf_photography_watermark_subtle')}</Button
          ><Button onclick={() => quick('bottom-right', 45, 6)}
            >{$t('frameleaf_photography_watermark_signature')}</Button
          ><Button onclick={() => quick('center', 20, 8)}>{$t('frameleaf_photography_position_centre')}</Button>
        </div>
        <div class="phd-fields">
          <label
            >{$t('frameleaf_photography_position')}<select bind:value={draft.brand.watermarkPosition}
              ><option value="bottom-right">{$t('frameleaf_photography_position_bottom_right')}</option><option
                value="bottom-left">{$t('frameleaf_photography_position_bottom_left')}</option
              ><option value="center">{$t('frameleaf_photography_position_centre')}</option><option value="top-right"
                >{$t('frameleaf_photography_position_top_right')}</option
              ></select
            ></label
          >
          <label
            >{$t('frameleaf_photography_watermark_colour')}<input
              type="color"
              bind:value={draft.brand.watermarkColor}
            /></label
          >
          <label
            >{$t('frameleaf_photography_opacity_value', { values: { value: draft.brand.watermarkOpacity } })}<input
              type="range"
              min="10"
              max="100"
              step="1"
              bind:value={draft.brand.watermarkOpacity}
            /></label
          >
          <label
            >{$t('frameleaf_photography_size_value', { values: { value: draft.brand.watermarkSize } })}<input
              type="range"
              min="3"
              max="12"
              step="1"
              bind:value={draft.brand.watermarkSize}
            /></label
          >
        </div>
      </fieldset>
      <div
        class="phw-watermark-guide"
        class:has-photo={!!photoId}
        aria-label={$t('frameleaf_photography_placement_guide_label')}
      >
        {#if photoId}<PhotographyThumb
            src={getAssetMediaUrl({ id: photoId, size: AssetMediaSize.Preview })}
            loading="eager"
          />{:else}<span class="phw-guide-label">{$t('frameleaf_photography_placement_guide')}</span>{/if}<span
          class="phw-guide-mark"
          data-position={draft.brand.watermarkPosition}
          style:color={draft.brand.watermarkColor}
          style:opacity={draft.brand.watermarkOpacity / 100}
          style:font-size={`${draft.brand.watermarkSize * 3}px`}
          style:font-family={brandFonts[draft.brand.font]}>{draft.brand.logoInitials || draft.brand.name}</span
        >
      </div>
    </section>
  {:else}<p role="status">
      {busy ? $t('frameleaf_photography_loading_presets') : $t('frameleaf_photography_reload_to_retry')}
    </p>{/if}
</div>
