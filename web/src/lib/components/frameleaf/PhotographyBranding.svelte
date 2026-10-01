<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    loadBrand,
    loadLogos,
    logoThumbnailUrl,
    saveBrand,
    type Brand,
    type Branding,
    type LogoPage,
  } from '$lib/frameleaf/photography/api';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';

  let { onSaved }: { onSaved: () => void } = $props();
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
  const failure = (cause: unknown) =>
    cause instanceof Error ? cause.message : 'The request could not be completed. Try again.';
  const fonts = { editorial: 'Georgia, serif', modern: 'system-ui, sans-serif', classic: 'Palatino, Georgia, serif' };

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
    } catch (cause) {
      if (current === generation) {
        error = failure(cause);
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
      const { logoAssetId, ...brand } = draft;
      const value = await saveBrand(stored.revision, logoChanged ? { ...brand, logoAssetId } : brand);
      if (disposed || current !== generation) {
        return;
      }
      stored = value;
      draft = { ...value.brand };
      logoChanged = false;
      message = 'Branding saved on your server';
      onSaved();
    } catch (cause) {
      if (current === generation) {
        error = failure(cause);
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
      logos = [...logos, ...value.logos.filter(({ id }) => !logos.some((logo) => logo.id === id))];
      cursor = value.nextCursor;
    } catch (cause) {
      if (current === generation) {
        logoError = failure(cause);
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

  function preset(position: Brand['watermarkPosition'], opacity: number, size: number) {
    if (!draft || busy) {
      return;
    }
    draft.watermarkPosition = position;
    draft.watermarkOpacity = opacity;
    draft.watermarkSize = size;
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
    {error}<Button disabled={busy} onclick={reload}>Reload branding</Button>
  </div>{/if}
{#if loading}<div class="phw-empty" role="status">Loading studio branding…</div>
{:else if draft && stored}
  <form class="phw-detail-layout phw-brand-layout" onsubmit={persist} aria-busy={busy}>
    <section class="phw-brand-main">
      <div class="phw-brand-intro">
        <h2>Your studio identity</h2>
        <p>Identity and watermark settings are saved privately with your photography workspace.</p>
      </div>
      <div
        class="phw-brand-card"
        style:background={draft.background}
        style:color={draft.textColor}
        style:font-family={fonts[draft.font]}
      >
        <div class="phw-brand-logo" style:background={draft.color}>
          {#if draft.logoAssetId && !logoFailed}<img
              src={logoThumbnailUrl(draft.logoAssetId)}
              alt="Studio logo"
              onerror={() => (logoFailed = true)}
            />{:else}<span
              >{draft.logoInitials ||
                draft.name
                  .split(/\s+/)
                  .map((word) => word[0])
                  .join('')
                  .slice(0, 3)}</span
            >{/if}
        </div>
        <h2>{draft.name}</h2>
        <p>{draft.tagline}</p>
        <div class="phw-brand-contact"><span>{draft.email}</span><span>{draft.phone}</span></div>
      </div>
      {#if stored.logoUnavailable || logoFailed}<p class="phw-small" role="status">
          The saved logo is unavailable. Its private reference is retained until you choose a new logo or use initials.
        </p>{/if}
      <div class="phw-brand-intro">
        <h2>Your watermark</h2>
        <p>
          Placement guide for saved settings. Proof rendering and applying watermarks to exports are not available yet.
        </p>
      </div>
      <div class="phw-watermark-guide" aria-label="Watermark placement guide">
        <span class="phw-guide-label">Placement guide</span><span
          class="phw-guide-mark"
          data-position={draft.watermarkPosition}
          style:color={draft.watermarkColor}
          style:opacity={draft.watermarkOpacity / 100}
          style:font-size={`${draft.watermarkSize * 3}px`}
          style:font-family={fonts[draft.font]}>{draft.logoInitials || draft.name}</span
        >
      </div>
      <div class="phw-brand-intro">
        <h2>Colour palette</h2>
        <div class="phw-brand-swatches">
          {#each [[draft.color, 'Accent'], [draft.background, 'Background'], [draft.textColor, 'Text']] as [color, label]}<div
            >
              <i style:background={color}></i><span>{label}</span><small>{color}</small>
            </div>{/each}
        </div>
      </div>
    </section>
    <aside class="phw-inspector phw-brand-controls">
      <div class="phw-inspector-body">
        <h2>Studio details</h2>
        <fieldset disabled={busy}>
          <label class="phw-field"
            ><span>Studio name</span><input required maxlength="200" bind:value={draft.name} /></label
          >
          <label class="phw-field"><span>Tagline</span><input maxlength="300" bind:value={draft.tagline} /></label>
          <label class="phw-field"
            ><span>Contact email</span><input type="email" maxlength="254" bind:value={draft.email} /></label
          >
          <label class="phw-field"><span>Phone</span><input maxlength="100" bind:value={draft.phone} /></label>
          <label class="phw-field"
            ><span>Logo initials</span><input maxlength="12" bind:value={draft.logoInitials} /></label
          >
          <div class="phw-brand-buttons">
            <Button
              onclick={() => {
                picker = true;
                void candidates();
              }}>Choose library logo</Button
            ><Button onclick={() => choose(null)}>Use initials</Button>
          </div>
          <p class="phw-small">Choose an image you own: PNG, JPEG or WebP, up to 500 KB. Locked images are excluded.</p>
          <h3>Typography and colours</h3>
          <label class="phw-field"
            ><span>Typography</span><select bind:value={draft.font}
              ><option value="editorial">Editorial serif</option><option value="modern">Modern sans serif</option
              ><option value="classic">Classic serif</option></select
            ></label
          >
          <label class="phw-field phw-color-field"
            ><span>Accent</span><input type="color" bind:value={draft.color} /></label
          >
          <label class="phw-field phw-color-field"
            ><span>Background</span><input type="color" bind:value={draft.background} /></label
          >
          <label class="phw-field phw-color-field"
            ><span>Text</span><input type="color" bind:value={draft.textColor} /></label
          >
          <h3>Watermark settings</h3>
          <div class="phw-brand-buttons" aria-label="Watermark presets">
            <Button onclick={() => preset('bottom-right', 35, 4)}>Subtle</Button><Button
              onclick={() => preset('bottom-right', 45, 6)}>Signature</Button
            ><Button onclick={() => preset('center', 20, 8)}>Centre</Button>
          </div>
          <label class="phw-field"
            ><span>Position</span><select bind:value={draft.watermarkPosition}
              ><option value="bottom-right">Bottom right</option><option value="bottom-left">Bottom left</option><option
                value="center">Centre</option
              ><option value="top-right">Top right</option></select
            ></label
          >
          <label class="phw-field phw-color-field"
            ><span>Watermark colour</span><input type="color" bind:value={draft.watermarkColor} /></label
          >
          <label class="phw-field"
            ><span>Opacity · {draft.watermarkOpacity}%</span><input
              type="range"
              min="10"
              max="100"
              step="1"
              bind:value={draft.watermarkOpacity}
            /></label
          >
          <label class="phw-field"
            ><span>Size · {draft.watermarkSize}%</span><input
              type="range"
              min="3"
              max="12"
              step="1"
              bind:value={draft.watermarkSize}
            /></label
          >
        </fieldset>
        <Button type="submit" variant="primary" disabled={busy || !!error}>{busy ? 'Saving…' : 'Save branding'}</Button>
        <p class="phw-small" aria-live="polite">{message}</p>
      </div>
    </aside>
  </form>
{/if}
<Dialog
  title="Choose studio logo"
  closeLabel="Close logo picker"
  bind:open={picker}
  onRequestClose={() => (picker = false)}
>
  <div class="phw-new-shoot">
    <p class="phw-small">Only eligible images you own appear here.</p>
    {#if logoError}<p role="alert">{logoError}</p>
      <Button onclick={() => candidates()}>Retry</Button>{/if}
    <div class="phw-logo-grid">
      {#each logos as logo (logo.id)}<button type="button" onclick={() => choose(logo.id)}
          ><img src={logoThumbnailUrl(logo.id)} alt="" loading="lazy" /><span>{logo.fileName}</span></button
        >{/each}
    </div>
    {#if logoLoading}<p role="status">Loading logos…</p>{:else if !logos.length && !logoError}<p>
        No eligible images on this page. Add a logo to your library, or use initials.
      </p>{/if}{#if cursor}<Button disabled={logoLoading} onclick={() => candidates(true)}>Load more images</Button
      >{/if}
  </div>
</Dialog>
