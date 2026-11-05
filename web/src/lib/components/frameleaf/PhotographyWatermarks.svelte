<script lang="ts">
  /**
   * Watermarks: the one place to design the watermark (approved design, 2026-11-04). Reusable presets,
   * the default for proofs, web previews and exports, and the branding mark proofs and web previews
   * carry when no preset is chosen. Branding shows the result and leads here.
   */
  import { onMount, onDestroy, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import Button from './Button.svelte';
  import { photographyErrorKey } from './PhotographyStatus.svelte';
  import PhotographyThumb from './PhotographyThumb.svelte';
  import PhotographyWatermarkEditor from './PhotographyWatermarkEditor.svelte';
  import { loadBrand, saveBrand, type Brand, type Branding } from '$lib/frameleaf/photography/api';
  import { defaultWatermark, type Watermark } from '$lib/frameleaf/photography/workflow-api';
  import { watermarkOverlay } from '$lib/frameleaf/photography/watermark-overlay';
  import { getAssetMediaUrl } from '$lib/utils';

  /**
   * `photoId`: one of the photographer's own photos, behind the preview. `onBranding` opens Branding.
   * `headerActions`: the page header's action area; Save moves there, as on Website (approved design).
   */
  let {
    photoId = null,
    onBranding,
    headerActions,
  }: { photoId?: string | null; onBranding?: () => void; headerActions?: HTMLElement } = $props();
  /** Moves the Save button into the page header while this page is open. */
  const inHeader = (node: HTMLElement, target: HTMLElement | undefined) => {
    const home = node.parentElement;
    const place = (to: HTMLElement | undefined) => (to ?? home)?.append(node);
    place(target);
    return {
      update: place,
      destroy: () => node.remove(),
    };
  };
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
      subject = 'proof';
      // The designer shows straight away (prototype): a studio with no preset starts on a repeated proof
      // mark, kept only when it presses Save.
      if (draft.brand.watermarkPresets?.length === 0) {
        add(true);
      }
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
    showPreset(id);
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
    showPreset(active);
  }
  /**
   * "See it on the photograph" (approved design, 2026-11-04): the editor on the left, the mark on one of
   * the photographer's own photographs on the right. The tabs show what each use carries today; a preset
   * that no use carries yet is shown on its own while it is being designed.
   */
  type Use = 'proof' | 'web' | 'clean';
  const roles = {
    proof: 'proofWatermarkPresetId',
    web: 'webWatermarkPresetId',
    clean: 'exportWatermarkPresetId',
  } as const;
  const useLabels = {
    proof: 'frameleaf_photography_selection_proofs',
    web: 'frameleaf_photography_web_previews',
    clean: 'frameleaf_photography_final_exports',
  } as const;
  let subject = $state<Use | 'preset'>('proof');
  let orientation = $state<'landscape' | 'portrait'>('landscape');
  let seen = $state('');
  let seeing = $state(false);
  let seeGeneration = 0;
  /** The use that carries a preset, if any does. */
  const useOf = (id: string) => (['proof', 'web', 'clean'] as const).find((which) => draft?.brand[roles[which]] === id);
  function presetFor(which: Use) {
    return draft?.brand.watermarkPresets?.find((item) => item.id === draft!.brand[roles[which]]);
  }
  function markFor(which: Use): Watermark | null {
    if (!draft) {
      return null;
    }
    const chosen = presetFor(which);
    if (chosen) {
      return chosen.watermark;
    }
    if (which === 'clean') {
      return null;
    }
    // Without a preset, proofs and web previews carry the branding mark.
    const { name, logoInitials, watermarkColor, watermarkOpacity, watermarkPosition, watermarkSize } = draft.brand;
    return {
      ...defaultWatermark(logoInitials || name),
      color: watermarkColor,
      opacity: watermarkOpacity,
      position: watermarkPosition,
      size: watermarkSize,
    };
  }
  const shown = $derived(subject === 'preset' ? (preset?.watermark ?? null) : markFor(subject));
  const shownDetail = $derived.by(() => {
    if (subject === 'preset') {
      return $t('frameleaf_photography_see_preset_detail', { values: { name: preset?.name ?? '' } });
    }
    const chosen = presetFor(subject);
    if (!chosen && subject === 'clean') {
      return $t('frameleaf_photography_see_clean_detail');
    }
    return $t('frameleaf_photography_see_carries', {
      values: {
        use: $t(useLabels[subject]),
        name: chosen ? `${chosen.name} · v${chosen.version}` : $t('frameleaf_photography_branding_mark'),
      },
    });
  });
  /** Choosing or creating a preset shows it: on the use that carries it, or on its own. */
  function showPreset(id: string) {
    subject = (id && useOf(id)) || (id ? 'preset' : 'proof');
  }
  // Editing a preset that the current tab does not show brings it into view.
  let edited = '';
  $effect(() => {
    const key = preset ? `${preset.id}:${JSON.stringify(preset.watermark)}` : '';
    if (edited && key && key !== edited && key.split(':')[0] === edited.split(':')[0]) {
      const which = useOf(preset!.id);
      if (subject === 'preset' ? which : subject !== which) {
        subject = which ?? 'preset';
      }
    }
    edited = key;
  });
  // Redraw a moment after the mark or the shape changes.
  $effect(() => {
    const mark = shown ? $state.snapshot(shown) : null;
    const shape = orientation;
    const current = ++seeGeneration;
    if (!mark) {
      seeing = false;
      untrack(() => {
        if (seen) {
          URL.revokeObjectURL(seen);
          seen = '';
        }
      });
      return;
    }
    seeing = true;
    const timer = setTimeout(() => {
      watermarkOverlay(mark, shape)
        .then((url) => {
          if (disposed || current !== seeGeneration) {
            URL.revokeObjectURL(url);
            return;
          }
          const old = untrack(() => seen);
          if (old) {
            URL.revokeObjectURL(old);
          }
          seen = url;
          error = '';
        })
        .catch((error_) => {
          if (!disposed && current === seeGeneration) {
            error = $t(photographyErrorKey(error_));
          }
        })
        .finally(() => {
          if (current === seeGeneration) {
            seeing = false;
          }
        });
    }, 350);
    return () => clearTimeout(timer);
  });
  onMount(() => reload());
  onDestroy(() => {
    disposed = true;
    if (seen) {
      URL.revokeObjectURL(seen);
    }
  });
</script>

<div class="phd" aria-busy={busy}>
  <!-- The page header names the page and holds Save (approved design, 2026-11-04), so the body opens on the designer. -->
  <div class="phd-toolbar" class:phw-moved={!!headerActions}>
    {#if !headerActions}<p>{$t('frameleaf_photography_watermarks_body')}</p>{/if}
    <div class="phd-actions phw-site-actions" use:inHeader={headerActions}>
      <Button variant="primary" disabled={busy || !draft || missingLogos.length > 0} onclick={save}
        >{$t('frameleaf_photography_save_watermark_presets')}</Button
      >
    </div>
  </div>
  {#if error}<div class="phw-notice" role="alert">{error}</div>{/if}{#if message}<p role="status">{message}</p>{/if}
  {#if missingLogos.length}<p class="phw-notice" role="alert">
      {$t('frameleaf_photography_missing_logos', {
        values: { names: missingLogos.map((item) => item.name).join(', ') },
      })}
    </p>{/if}
  {#if draft}<div class="phw-wm-layout">
      <!-- PhotographyWorkflow.jsx watermarks: the editor on the left, the photograph on the right. -->
      <section class="phd-card phw-wm-editor">
        <span class="phx-eyebrow">{$t('frameleaf_photography_wm_studio_eyebrow')}</span>
        <h3>{$t('frameleaf_photography_wm_studio_title')}</h3>
        <label
          >{$t('frameleaf_photography_preset')}<select bind:value={active} onchange={() => showPreset(active)}
            ><option value="">{$t('frameleaf_photography_choose_preset')}</option
            >{#each draft.brand.watermarkPresets ?? [] as item (item.id)}<option value={item.id}
                >{item.name} · v{item.version}</option
              >{/each}</select
          ></label
        >
        {#if preset}<label
            >{$t('frameleaf_photography_preset_name')}<input maxlength="100" required bind:value={preset.name} /></label
          >{#key preset.id}<PhotographyWatermarkEditor
              bind:value={preset.watermark}
              disabled={busy}
              preview={false}
            />{/key}{:else}<p>
            {$t('frameleaf_photography_create_preset_hint')}
          </p>{/if}
        <div class="phd-actions phw-wm-foot">
          {#if onBranding}<Button onclick={onBranding}>{$t('frameleaf_photography_wm_identity')}</Button>{/if}<Button
            variant="quiet"
            disabled={busy || !preset}
            onclick={remove}>{$t('frameleaf_photography_remove_preset')}</Button
          >
        </div>
      </section>
      <div class="phw-wm-side">
        <section class="phd-card phw-see">
          <div class="phd-row">
            <div>
              <h3>{$t('frameleaf_photography_see_on_photo')}</h3>
              <p>{shownDetail}</p>
            </div>
            <select bind:value={orientation} aria-label={$t('frameleaf_photography_see_orientation')}
              ><option value="landscape">{$t('frameleaf_photography_landscape')}</option><option value="portrait"
                >{$t('frameleaf_photography_portrait')}</option
              ></select
            >
          </div>
          <div class="phw-see-tabs" role="group" aria-label={$t('frameleaf_photography_see_on_photo')}>
            {#each [['proof', 'frameleaf_photography_see_proof'], ['web', 'frameleaf_photography_see_web'], ['clean', 'frameleaf_photography_see_clean']] as const as [id, label] (id)}<button
                type="button"
                aria-pressed={subject === id}
                onclick={() => (subject = id)}>{$t(label)}</button
              >{/each}
          </div>
          <div class="phw-see-canvas" class:portrait={orientation === 'portrait'} aria-busy={seeing}>
            {#if photoId}<PhotographyThumb
                src={getAssetMediaUrl({ id: photoId, size: AssetMediaSize.Preview })}
                loading="eager"
              />{/if}{#if seen && shown}<img
                class="phw-see-mark"
                src={seen}
                alt={$t('frameleaf_photography_wm_preview_alt')}
              />{/if}{#if seeing && !seen}<span class="phw-see-status" role="status"
                >{$t('frameleaf_photography_wm_preparing_preview')}</span
              >{/if}
          </div>
          <p class="phw-see-caption">{$t('frameleaf_photography_see_caption')}</p>
        </section>
        <!-- Prototype "Start with a preset": new presets begin here, the editor on the left designs them. -->
        <section class="phd-card">
          <h3>{$t('frameleaf_photography_start_with_preset')}</h3>
          <div class="phw-brand-buttons">
            <Button disabled={busy || (draft.brand.watermarkPresets?.length ?? 0) >= 30} onclick={() => add()}
              >{$t('frameleaf_photography_new_signature')}</Button
            ><Button disabled={busy || (draft.brand.watermarkPresets?.length ?? 0) >= 30} onclick={() => add(true)}
              >{$t('frameleaf_photography_new_proof')}</Button
            >
          </div>
        </section>
        <section class="phd-card">
          <h3>{$t('frameleaf_photography_defaults_title')}</h3>
          <div class="phd-fields">
            {#each [['webWatermarkPresetId', $t('frameleaf_photography_web_previews')], ['proofWatermarkPresetId', $t('frameleaf_photography_selection_proofs')], ['exportWatermarkPresetId', $t('frameleaf_photography_final_exports')]] as [key, label] (key)}<label
                >{label}<select
                  value={draft.brand[key as 'webWatermarkPresetId'] ?? ''}
                  disabled={busy || !draft.brand.watermarkPresets?.length}
                  onchange={(event) => {
                    draft!.brand[key as 'webWatermarkPresetId'] = event.currentTarget.value || null;
                    if (subject === 'preset' && preset && useOf(preset.id)) {
                      subject = useOf(preset.id)!;
                    }
                  }}
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
              <Button onclick={() => quick('bottom-right', 35, 4)}
                >{$t('frameleaf_photography_watermark_subtle')}</Button
              ><Button onclick={() => quick('bottom-right', 45, 6)}
                >{$t('frameleaf_photography_watermark_signature')}</Button
              ><Button onclick={() => quick('center', 20, 8)}>{$t('frameleaf_photography_position_centre')}</Button>
            </div>
            <div class="phd-fields">
              <label
                >{$t('frameleaf_photography_position')}<select bind:value={draft.brand.watermarkPosition}
                  ><option value="bottom-right">{$t('frameleaf_photography_position_bottom_right')}</option><option
                    value="bottom-left">{$t('frameleaf_photography_position_bottom_left')}</option
                  ><option value="center">{$t('frameleaf_photography_position_centre')}</option><option
                    value="top-right">{$t('frameleaf_photography_position_top_right')}</option
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
        </section>
      </div>
    </div>
  {:else}<p role="status">
      {busy ? $t('frameleaf_photography_loading_presets') : $t('frameleaf_photography_reload_to_retry')}
    </p>
    {#if !busy}<Button onclick={reload}>{$t('frameleaf_photography_reload')}</Button>{/if}{/if}
</div>
