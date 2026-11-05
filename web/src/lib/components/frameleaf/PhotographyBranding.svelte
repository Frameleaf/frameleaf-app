<script lang="ts">
  /**
   * Branding: the studio's identity (name, tagline, contact, initials, logo, typography and colours).
   * The watermark is designed in one place, Watermarks; Branding shows the mark proofs carry as a small
   * preview with a one-line summary and leads there (approved design, 2026-11-04).
   */
  import { onDestroy, onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import { Icon } from '@frameleaf/ui';
  import { mdiBrushOutline } from '@mdi/js';
  import { photographyErrorKey } from '$lib/components/frameleaf/PhotographyStatus.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    brandFonts,
    loadBrand,
    loadLogos,
    logoThumbnailUrl,
    saveBrand,
    type Brand,
    type Branding,
    type LogoPage,
  } from '$lib/frameleaf/photography/api';
  import { watermarkPreview, type Watermark } from '$lib/frameleaf/photography/workflow-api';
  import { AssetMediaSize } from '@frameleaf/sdk';
  import PhotographyThumb from '$lib/components/frameleaf/PhotographyThumb.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getAssetMediaUrl } from '$lib/utils';

  let {
    onSaved,
    photoId = null,
    onDesignWatermark,
  }: {
    onSaved: () => void;
    /** One of the photographer's own photos, for the watermark preview. */
    photoId?: string | null;
    /** Opens Watermarks, where the mark is designed. */
    onDesignWatermark?: () => void;
  } = $props();
  let stored = $state<Branding | null>(null);
  let draft = $state<Brand | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let message = $state('');
  let logoChanged = $state(false);
  let logoFailed = $state(false);
  let picker = $state(false);
  let logos = $state<LogoPage['logos']>([]);
  let cursor = $state<string | null>(null);
  let logoLoading = $state(false);
  let logoError = $state('');
  let generation = 0;
  let disposed = false;
  const failure = (cause: unknown) => $t(photographyErrorKey(cause));
  const initials = (brand: Brand) =>
    brand.logoInitials ||
    brand.name
      .split(/\s+/)
      .map((word) => word[0])
      .join('')
      .slice(0, 3);

  /** The preset proofs use by default; without one, proofs carry the branding mark. */
  const proofPreset = $derived(draft?.watermarkPresets?.find(({ id }) => id === draft?.proofWatermarkPresetId));
  const placements: Record<Watermark['pattern'], Translations> = {
    tile: 'frameleaf_photography_wm_summary_tile',
    diagonal: 'frameleaf_photography_wm_summary_diagonal',
    centre: 'frameleaf_photography_wm_summary_centre',
    signature: 'frameleaf_photography_wm_summary_signature',
  };
  const summary = $derived.by(() => {
    if (!draft) {
      return '';
    }
    const mark = proofPreset?.watermark;
    const text = mark ? mark.text || draft.name : initials(draft) || draft.name;
    return $t('frameleaf_photography_wm_summary', {
      values: {
        mark:
          mark?.type === 'logo'
            ? $t('frameleaf_photography_wm_summary_logo')
            : $t(
                mark?.type === 'both'
                  ? 'frameleaf_photography_wm_summary_both'
                  : 'frameleaf_photography_wm_summary_text',
                {
                  values: { text },
                },
              ),
        placement: $t(placements[mark?.pattern ?? (draft.watermarkPosition === 'center' ? 'centre' : 'signature')]),
        opacity: mark?.opacity ?? draft.watermarkOpacity,
      },
    });
  });
  /** A preset is drawn by the server, as Watermarks draws it; the branding mark is drawn here. */
  let presetPreview = $state('');
  $effect(() => {
    const mark = proofPreset?.watermark;
    if (!mark) {
      return;
    }
    let live = true;
    let url = '';
    watermarkPreview($state.snapshot(mark), 'landscape', 'dark')
      .then((blob) => {
        if (live) {
          url = URL.createObjectURL(blob);
          presetPreview = url;
        }
      })
      .catch(() => {});
    return () => {
      live = false;
      presetPreview = '';
      if (url) {
        URL.revokeObjectURL(url);
      }
    };
  });

  async function reload() {
    const current = ++generation;
    loading = true;
    error = '';
    message = '';
    draft = null;
    stored = null;
    logoFailed = false;
    try {
      const value = await loadBrand();
      if (disposed || current !== generation) {
        return;
      }
      stored = value;
      draft = { ...value.brand };
      logoChanged = false;
    } catch (error_) {
      if (current === generation) {
        error = failure(error_);
      }
    } finally {
      if (current === generation) {
        loading = false;
      }
    }
  }

  async function persist(event: SubmitEvent) {
    event.preventDefault();
    if (!draft || !stored || busy) {
      return;
    }
    const current = generation;
    busy = true;
    error = '';
    message = '';
    try {
      // Omission preserves a privately retained unavailable logo; null explicitly switches to initials.
      const { logoAssetId, ...brand } = $state.snapshot(draft);
      delete brand.watermarkPresets;
      delete brand.webWatermarkPresetId;
      delete brand.proofWatermarkPresetId;
      delete brand.exportWatermarkPresetId;
      const value = await saveBrand(stored.revision, logoChanged ? { ...brand, logoAssetId } : brand);
      if (disposed || current !== generation) {
        return;
      }
      stored = value;
      draft = { ...value.brand };
      logoChanged = false;
      message = $t('frameleaf_photography_branding_saved');
      onSaved();
    } catch (error_) {
      if (current === generation) {
        error = failure(error_);
      }
    } finally {
      if (current === generation) {
        busy = false;
      }
    }
  }

  async function candidates(more = false) {
    if (logoLoading) {
      return;
    }
    const current = generation;
    logoLoading = true;
    logoError = '';
    if (!more) {
      logos = [];
      cursor = null;
    }
    try {
      const value = await loadLogos(more ? cursor : null);
      if (disposed || current !== generation) {
        return;
      }
      logos = [...logos, ...value.logos.filter(({ id }) => logos.every((logo) => logo.id !== id))];
      cursor = value.nextCursor;
    } catch (error_) {
      if (current === generation) {
        logoError = failure(error_);
      }
    } finally {
      if (current === generation) {
        logoLoading = false;
      }
    }
  }

  function choose(id: string | null) {
    if (!draft || busy) {
      return;
    }
    draft.logoAssetId = id;
    logoChanged = true;
    logoFailed = false;
    picker = false;
    message = '';
  }

  onMount(() => {
    void reload();
    return onLibraryAccessChange(() => {
      generation++;
      stored = null;
      draft = null;
      logos = [];
      cursor = null;
      picker = false;
      busy = false;
      logoLoading = false;
      logoError = '';
      message = '';
      error = '';
      logoFailed = false;
      if (authManager.authenticated) {
        void reload();
      }
    }, authManager.user.id);
  });
  onDestroy(() => {
    disposed = true;
    generation++;
  });
</script>

{#if error}<div class="phw-notice" role="alert">
    {error}<Button disabled={busy} onclick={reload}>{$t('frameleaf_photography_reload_branding')}</Button>
  </div>{/if}
{#if loading}<div class="phw-empty" role="status">{$t('frameleaf_photography_loading_branding')}</div>
{:else if draft && stored}
  <form class="phw-detail-layout phw-brand-layout" onsubmit={persist} aria-busy={busy}>
    <section class="phw-brand-main">
      <div class="phw-brand-preview" style:font-family={brandFonts[draft.font]}>
        <span class="phw-brand-mark large"
          >{#if draft.logoAssetId && !logoFailed}<img
              src={logoThumbnailUrl(draft.logoAssetId)}
              alt={$t('frameleaf_photography_studio_logo')}
              onerror={() => (logoFailed = true)}
            />{:else}{initials(draft)}{/if}</span
        >
        <h2>{draft.name}</h2>
        {#if draft.tagline}<p>{draft.tagline}</p>{/if}
        {#if draft.email || draft.phone}<span>{[draft.email, draft.phone].filter(Boolean).join(' · ')}</span>{/if}
      </div>
      {#if stored.logoUnavailable || logoFailed}<p class="phw-small" role="status">
          {$t('frameleaf_photography_logo_unavailable')}
        </p>{/if}
      <div class="phw-brand-watermark">
        <div
          class="phw-watermark-guide is-small"
          class:has-photo={!!photoId || !!presetPreview}
          aria-label={$t('frameleaf_photography_placement_guide_label')}
        >
          {#if presetPreview}<img src={presetPreview} alt="" />{:else}{#if photoId}<PhotographyThumb
                src={getAssetMediaUrl({ id: photoId, size: AssetMediaSize.Preview })}
                loading="eager"
              />{/if}{#if !proofPreset}<span
                class="phw-guide-mark"
                data-position={draft.watermarkPosition}
                style:color={draft.watermarkColor}
                style:opacity={draft.watermarkOpacity / 100}
                style:font-size={`${draft.watermarkSize * 2}px`}
                style:font-family={brandFonts[draft.font]}>{draft.logoInitials || draft.name}</span
              >{/if}{/if}
        </div>
        <div>
          <h2>{$t('frameleaf_photography_your_watermark')}</h2>
          <p>{summary}</p>
          {#if onDesignWatermark}<Button onclick={onDesignWatermark}
              ><Icon icon={mdiBrushOutline} size="1rem" aria-hidden={true} />{$t(
                'frameleaf_photography_design_watermark',
              )}</Button
            >{/if}
        </div>
      </div>
      <div class="phw-brand-swatches">
        {#each [[draft.color, $t('frameleaf_photography_accent')], [draft.background, $t('frameleaf_photography_background')], [draft.textColor, $t('frameleaf_photography_text')]] as [color, label] (label)}<span
            role="img"
            aria-label={`${label} ${color}`}
            title={`${label} ${color}`}
            style:background={color}
          ></span>{/each}
        <p>{$t('frameleaf_photography_brand_shared')}</p>
      </div>
    </section>
    <aside class="phw-inspector phw-brand-controls">
      <div class="phw-inspector-body">
        <h2>{$t('frameleaf_photography_studio_identity')}</h2>
        <fieldset disabled={busy}>
          <label class="phw-field"
            ><span>{$t('frameleaf_photography_studio_name')}</span><input
              required
              maxlength="200"
              bind:value={draft.name}
            /></label
          >
          <label class="phw-field"
            ><span>{$t('frameleaf_photography_tagline')}</span><input
              maxlength="300"
              bind:value={draft.tagline}
            /></label
          >
          <label class="phw-field"
            ><span>{$t('frameleaf_photography_contact_email')}</span><input
              type="email"
              maxlength="254"
              bind:value={draft.email}
            /></label
          >
          <label class="phw-field"
            ><span>{$t('frameleaf_photography_phone')}</span><input maxlength="100" bind:value={draft.phone} /></label
          >
          <label class="phw-field"
            ><span>{$t('frameleaf_photography_logo_initials')}</span><input
              maxlength="12"
              bind:value={draft.logoInitials}
            /></label
          >
          <div class="phw-brand-buttons">
            <Button
              onclick={() => {
                picker = true;
                void candidates();
              }}>{$t('frameleaf_photography_choose_logo')}</Button
            ><Button onclick={() => choose(null)}>{$t('frameleaf_photography_use_initials')}</Button>
          </div>
          <p class="phw-small">
            {$t('frameleaf_photography_logo_rules')}
          </p>
          <h3>{$t('frameleaf_photography_typography_colours')}</h3>
          <label class="phw-field"
            ><span>{$t('frameleaf_photography_typography')}</span><select bind:value={draft.font}
              ><option value="editorial">{$t('frameleaf_photography_font_editorial')}</option><option value="modern"
                >{$t('frameleaf_photography_font_modern_serif')}</option
              ><option value="classic">{$t('frameleaf_photography_font_classic')}</option></select
            ></label
          >
          <label class="phw-field phw-color-field"
            ><span>{$t('frameleaf_photography_accent')}</span><input type="color" bind:value={draft.color} /></label
          >
          <label class="phw-field phw-color-field"
            ><span>{$t('frameleaf_photography_background')}</span><input
              type="color"
              bind:value={draft.background}
            /></label
          >
          <label class="phw-field phw-color-field"
            ><span>{$t('frameleaf_photography_text')}</span><input type="color" bind:value={draft.textColor} /></label
          >
        </fieldset>
        <Button type="submit" variant="primary" disabled={busy || !!error}
          >{busy ? $t('frameleaf_photography_saving') : $t('frameleaf_photography_save_branding')}</Button
        >
        <p class="phw-small" aria-live="polite">{message}</p>
      </div>
    </aside>
  </form>
{/if}
<Dialog
  title={$t('frameleaf_photography_choose_logo_title')}
  closeLabel={$t('close')}
  bind:open={picker}
  onRequestClose={() => (picker = false)}
>
  <div class="phw-new-shoot">
    <p class="phw-small">{$t('frameleaf_photography_logo_picker_note')}</p>
    {#if logoError}<p role="alert">{logoError}</p>
      <Button onclick={() => candidates()}>{$t('frameleaf_error_retry')}</Button>{/if}
    <div class="phw-logo-grid">
      {#each logos as logo (logo.id)}<button type="button" onclick={() => choose(logo.id)}
          ><img src={logoThumbnailUrl(logo.id)} alt="" loading="lazy" /><span>{logo.fileName}</span></button
        >{/each}
    </div>
    {#if logoLoading}<p role="status">
        {$t('frameleaf_photography_loading_logos')}
      </p>{:else if logos.length === 0 && !logoError}<p>
        {$t('frameleaf_photography_no_logos')}
      </p>{/if}{#if cursor}<Button disabled={logoLoading} onclick={() => candidates(true)}
        >{$t('frameleaf_photography_load_more_images')}</Button
      >{/if}
  </div>
</Dialog>
