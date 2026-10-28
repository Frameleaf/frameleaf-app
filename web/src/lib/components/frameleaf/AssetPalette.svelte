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
  import { onDestroy } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
  import { authManager } from '$lib/managers/auth-manager.svelte';

  let {
    assetId,
    canRetry = false,
    onChoose,
  }: { assetId: string; canRetry?: boolean; onChoose?: (color: ColorFilter) => void } = $props();
  let palette = $state<AssetPaletteDto | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let generation = $state(0);
  let reload = $state(0);
  $effect(() => {
    const id = assetId;
    const version = generation;
    void reload;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    palette = null;
    loading = true;
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

<section class="fl-asset-palette" aria-label={$t('frameleaf_palette_title')} aria-busy={loading}>
  <h3>{$t('frameleaf_palette_title')}</h3>
  {#if palette?.status === PaletteStatus.Ready}
    {#if palette.representative === PaletteRepresentative.Frame}<p>{$t('frameleaf_palette_frame')}</p>{/if}
    {#if palette.swatches.length === 0}<p role="status">{$t('frameleaf_palette_empty')}</p>{/if}
    <ul class="fl-palette-swatches">
      {#each palette.swatches as swatch (swatch.hex)}
        <li>
          {#if onChoose}
            <button
              type="button"
              class="fl-control"
              aria-label={$t('frameleaf_palette_swatch', {
                values: { hex: swatch.hex, coverage: coverage(swatch.weight) },
              })}
              onclick={() => onChoose?.({ hex: swatch.hex, tolerance: ColorTolerance.Normal, minWeight: 0.05 })}
            >
              <span class="fl-palette-chip" style:background-color={swatch.hex} aria-hidden="true"></span><span
                >{swatch.hex}</span
              ><small>{coverage(swatch.weight)}</small>
            </button>
          {:else}
            <span class="fl-palette-readonly"
              ><span class="fl-palette-chip" style:background-color={swatch.hex} aria-hidden="true"
              ></span>{swatch.hex}<small>{coverage(swatch.weight)}</small></span
            >
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <p role="status">
      {loading
        ? $t('loading')
        : palette?.status === PaletteStatus.Pending
          ? $t('frameleaf_palette_pending')
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
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .fl-palette-swatches {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  button,
  .fl-palette-readonly {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    padding: var(--fl-space-2);
    font-variant-numeric: tabular-nums;
  }
  button {
    min-height: 2.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  button:hover {
    border-color: var(--fl-accent);
  }
  .fl-palette-chip {
    width: 1.5rem;
    height: 1.5rem;
    flex-shrink: 0;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  small {
    color: var(--fl-muted);
  }
</style>
