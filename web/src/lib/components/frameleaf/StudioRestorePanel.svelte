<script lang="ts" module>
  export type StudioRestoreFocus = 'restore' | 'smooth-motion';
</script>

<script lang="ts">
  /**
   * Studio's Restore tab (FL-115, FL-162; prototype `Studio.jsx` TABS "Restore", `RestorePanel` and
   * `FrameMethod`).
   *
   * One of the project's photos or videos is chosen as the source, and the same restoration panel the
   * quick editor uses does the rest: restoration or Smooth motion, preview first on an explicit
   * destination, the before-and-after comparison, then the full render saved as a new version of the
   * original. Frameleaf Cloud is only ever a job the person confirms with its estimate and model slider.
   *
   * Use in Studio puts a finished version in this project's bin as its own entry beside the original;
   * choosing a playback version never does, and the original is never replaced.
   */
  import './editor/editor.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import RestorationCompare from '$lib/components/frameleaf/editor/RestorationCompare.svelte';
  import RestorationPanel, {
    type RestorationCompareRequest,
  } from '$lib/components/frameleaf/editor/RestorationPanel.svelte';
  import type { StudioAssetRef } from '$lib/frameleaf/studio/host-contract';
  import { restorationIdOfMedia } from '$lib/frameleaf/studio/assets';
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetInfo, type AssetResponseDto, type AssetRestorationResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import { tick, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    assets,
    assetId = null,
    focus = 'restore',
    theme = 'dark',
    onUseInStudio,
    onClose,
  }: {
    /** The project's media; restored versions are listed as sources of nothing, only their originals are. */
    assets: readonly StudioAssetRef[];
    /** The source to start with, when a command or a clip asked for one. */
    assetId?: string | null;
    focus?: StudioRestoreFocus;
    theme?: 'dark' | 'light';
    /** A finished version the person chose for this project. */
    onUseInStudio: (restoration: AssetRestorationResponseDto) => void;
    onClose: () => void;
  } = $props();

  const sources = $derived(assets.filter((asset) => !restorationIdOfMedia(asset.id) && !asset.isOffline));
  let chosenId = $state<string | null>(untrack(() => assetId));
  let asset = $state<AssetResponseDto | null>(null);
  let loadFailed = $state(false);
  let compare = $state<RestorationCompareRequest | null>(null);
  let loupe = $state(false);
  let body = $state<HTMLElement>();
  const fieldId = $props.id();

  // A later request (another clip, another command) moves the panel to that source.
  $effect(() => {
    const next = assetId;
    if (next) {
      untrack(() => {
        chosenId = next;
      });
    }
  });

  $effect(() => {
    const id = chosenId ?? sources[0]?.id ?? null;
    untrack(() => {
      compare = null;
      if (!id) {
        asset = null;
        return;
      }
      if (asset?.id === id) {
        return;
      }
      loadFailed = false;
      asset = null;
      void getAssetInfo({ id })
        .then(async (loaded) => {
          if ((chosenId ?? sources[0]?.id) !== id) {
            return;
          }
          asset = loaded;
          if (focus === 'smooth-motion') {
            await tick();
            body?.querySelector('[data-testid="restoration-smooth-motion"]')?.scrollIntoView({ block: 'nearest' });
          }
        })
        .catch((error) => {
          loadFailed = true;
          handleError(error, $t('frameleaf_restoration_load_error'));
        });
    });
  });
</script>

<aside
  class="fl-editor fl-studio-restore"
  data-theme={theme}
  aria-label={$t('frameleaf_studio_restore_title')}
  data-testid="studio-restore-panel"
>
  <header>
    <h2>{$t('frameleaf_studio_restore_title')}</h2>
    <Button variant="quiet" label={$t('close')} onclick={onClose}>
      <Icon icon={mdiClose} size="18" aria-hidden={true} />
    </Button>
  </header>

  {#if sources.length === 0}
    <p class="ed-empty">{$t('frameleaf_studio_restore_no_sources')}</p>
  {:else}
    <label class="rs-field" for="{fieldId}-source">
      <span>{$t('frameleaf_studio_restore_source')}</span>
      <select
        id="{fieldId}-source"
        value={chosenId ?? sources[0]?.id}
        onchange={(event) => (chosenId = event.currentTarget.value)}
      >
        {#each sources as source (source.id)}
          <option value={source.id}>{source.name}</option>
        {/each}
      </select>
    </label>

    {#if compare && asset}
      <div class="fl-studio-restore-compare">
        <RestorationCompare {...compare} alt={asset.originalFileName} {loupe} />
      </div>
    {/if}

    <div class="fl-studio-restore-body" bind:this={body}>
      {#if asset}
        {#key asset.id}
          <RestorationPanel
            {asset}
            onCompare={(next) => (compare = next)}
            {loupe}
            onLoupeChange={(next) => (loupe = next)}
            {onUseInStudio}
          />
        {/key}
      {:else if loadFailed}
        <p class="ed-empty">{$t('frameleaf_restoration_load_error')}</p>
      {:else}
        <p class="rs-help" aria-busy="true">{$t('loading')}</p>
      {/if}
    </div>
  {/if}
</aside>

<style>
  /* The quick editor's panel styles, docked in Studio's drawer instead of filling the screen. */
  :global(.fl-editor.fl-studio-restore) {
    position: relative;
    inset: auto;
    z-index: auto;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    width: min(24rem, 100vw);
    height: 100%;
    padding: 0.75rem;
    overflow: auto;
    background: var(--fl-panel);
    border-left: 1px solid var(--fl-border);
    color: var(--fl-text);
    --fl-viewer-text: var(--fl-text);
    --fl-viewer-muted: var(--fl-muted);
    --fl-viewer-border: var(--fl-border);
    --fl-viewer-raised: var(--fl-raised);
    --fl-viewer-canvas: var(--fl-canvas);
    --ed-ink: var(--fl-text);
    --ed-text: var(--fl-text);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }
  h2 {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 600;
  }
  .fl-studio-restore-compare {
    position: relative;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: var(--fl-radius-control);
    background: #000;
  }
</style>
