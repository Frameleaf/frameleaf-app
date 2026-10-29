<script lang="ts">
  import {
    ColorTolerance,
    PaletteRepresentative,
    PaletteStatus,
    getAssetPalette,
    retryAssetPalette,
    type AssetPaletteDto,
    type ColorFilter,
  } from '@frameleaf/sdk';
  import { onDestroy, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiProgressClock } from '@mdi/js';

  let {
    assetId,
    canRetry = false,
    onChoose,
  }: { assetId: string; canRetry?: boolean; onChoose?: (color: ColorFilter) => void } = $props();
  const headingId = $props.id();
  let palette = $state<AssetPaletteDto | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let generation = $state(0);
  let reload = $state(0);
  /** What the shown palette belongs to; a refresh of a still-pending palette keeps its message up. */
  let shownFor = '';
  $effect(() => {
    const id = assetId;
    const version = generation;
    void reload;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const key = `${id}:${version}`;
    if (shownFor !== key || untrack(() => palette?.status) !== PaletteStatus.Pending) {
      palette = null;
      loading = true;
    }
    shownFor = key;
    void getAssetPalette({ ...authManager.params, id }, { signal: controller.signal })
      .then((value) => {
        if (controller.signal.aborted || assetId !== id || generation !== version) {
          return;
        }
        palette = value;
        if (value.status === PaletteStatus.Pending) {
          timer = setTimeout(() => {
            if (!controller.signal.aborted && assetId === id && generation === version) {
              reload++;
            }
          }, 3000);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!controller.signal.aborted && assetId === id && generation === version) {
          loading = false;
        }
      });
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  });
  onDestroy(
    onLibraryAccessChange(() => {
      palette = null;
      generation++;
    }),
  );

  const retry = async () => {
    if (!canRetry || busy) {
      return;
    }
    const id = assetId;
    const version = generation;
    busy = true;
    try {
      await retryAssetPalette({ id });
      if (assetId === id && generation === version) {
        reload++;
      }
    } catch {
      if (assetId === id && generation === version) {
        palette = null;
      }
    } finally {
      busy = false;
    }
  };
  const coverage = (weight: number) =>
    weight.toLocaleString($locale ?? undefined, { style: 'percent', maximumFractionDigits: 0 });
</script>

<section class="fl-asset-palette" aria-labelledby={headingId} aria-busy={loading}>
  <h3 id={headingId}>{$t('frameleaf_boards_colours')}</h3>
  {#if palette?.status === PaletteStatus.Ready}
    {#if palette.swatches.length === 0}<p role="status">{$t('frameleaf_palette_empty')}</p>{/if}
    <ul class="fl-palette-swatches">
      {#each palette.swatches as swatch (swatch.hex)}
        {@const label = $t('frameleaf_boards_colour_swatch', {
          values: { hex: swatch.hex.toUpperCase(), coverage: coverage(swatch.weight) },
        })}
        <li>
          {#if onChoose}
            <button
              type="button"
              class="fl-palette-chip"
              style:background-color={swatch.hex}
              aria-label={label}
              title={label}
              onclick={() => onChoose?.({ hex: swatch.hex, tolerance: ColorTolerance.Normal, minWeight: 0.05 })}
            ></button>
          {:else}
            <span class="fl-palette-chip" style:background-color={swatch.hex} role="img" aria-label={label}></span>
          {/if}
          <small aria-hidden="true">{coverage(swatch.weight)}</small>
        </li>
      {/each}
    </ul>
    {#if palette.representative === PaletteRepresentative.Frame || (onChoose && palette.swatches.length > 0)}
      <p>
        {[
          palette.representative === PaletteRepresentative.Frame ? $t('frameleaf_boards_colours_video_frame') : '',
          onChoose && palette.swatches.length > 0 ? $t('frameleaf_boards_colours_choose') : '',
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
    {/if}
  {:else if !loading && palette?.status === PaletteStatus.Pending}
    <p class="fl-palette-reading" role="status">
      <Icon icon={mdiProgressClock} size="16" aria-hidden />
      <span>{$t('frameleaf_boards_colours_reading')}</span>
    </p>
  {:else}
    <p role="status">
      {loading
        ? $t('loading')
        : palette?.status === PaletteStatus.Failed
          ? $t('frameleaf_palette_failed')
          : $t('frameleaf_palette_unavailable')}
    </p>
    {#if canRetry && palette?.status === PaletteStatus.Failed}<Button disabled={busy} onclick={() => void retry()}
        >{$t('frameleaf_palette_retry')}</Button
      >{/if}
  {/if}
</section>

<style>
  .fl-asset-palette {
    display: grid;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  h3 {
    margin: 0;
    color: var(--fl-muted);
    font-size: 12px;
  }
  p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-palette-reading {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-2);
  }
  .fl-palette-reading :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
  }
  .fl-palette-swatches {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    justify-items: center;
    gap: var(--fl-space-1);
  }
  /* The swatch is the control; its edge keeps light and dark colours visible on either theme. */
  .fl-palette-chip {
    display: block;
    width: 2.25rem;
    height: 2.25rem;
    padding: 0;
    border: 1px solid var(--fl-border-strong);
    border-radius: var(--fl-radius-control-compact);
  }
  button.fl-palette-chip {
    cursor: pointer;
    transition: transform var(--fl-motion-fast) var(--fl-ease);
  }
  button.fl-palette-chip:hover {
    transform: translateY(-1px);
  }
  button.fl-palette-chip:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  small {
    color: var(--fl-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
</style>
