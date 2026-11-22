<script lang="ts">
  /** FL-923: Information's "From a scan" on a photo cut from a scan, and "Scan" on the scan itself. Owner only. */
  import { Route } from '$lib/route';
  import { openScanSplit, scanSplitChanges } from '$lib/services/scan-split.service.svelte';
  import { getScanSplit, type AssetResponseDto, type ScanSplitInfoResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  const { asset }: { asset: AssetResponseDto } = $props();

  let info = $state<ScanSplitInfoResponseDto>();

  $effect(() => {
    const id = asset.id;
    void scanSplitChanges.revision;
    let cancelled = false;
    info = undefined;
    getScanSplit({ id })
      .then((result) => {
        if (!cancelled) {
          info = result;
        }
      })
      .catch(() => {
        // an optional block: without it the rest of Information is unaffected
      });
    return () => {
      cancelled = true;
    };
  });
</script>

{#if info?.sourceAssetId}
  <section aria-label={$t('frameleaf_scan_split_from_scan')}>
    <h3 class="fl-info-heading">{$t('frameleaf_scan_split_from_scan')}</h3>
    <p class="line">
      <a href={Route.viewAsset({ id: info.sourceAssetId })}>
        {$t('frameleaf_scan_split_from_name', { values: { name: info.sourceFileName ?? '' } })}
      </a>
    </p>
    <p class="muted">{$t('frameleaf_scan_split_kept_in_archive')}</p>
  </section>
{/if}
{#if info && info.cropCount > 0}
  <section aria-label={$t('frameleaf_scan_split_scan_heading')}>
    <h3 class="fl-info-heading">{$t('frameleaf_scan_split_scan_heading')}</h3>
    <p class="line">{$t('frameleaf_scan_split_split_into', { values: { count: info.cropCount } })}</p>
    <p class="muted">
      {$t('frameleaf_scan_split_kept_as_source')} ·
      <button type="button" onclick={() => void openScanSplit(asset.id)}>{$t('frameleaf_scan_split_again')}</button>
    </p>
  </section>
{/if}

<style>
  p {
    margin: 0;
  }
  .line {
    font-size: 0.875rem;
  }
  .muted {
    margin-block-start: 0.25rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  a,
  button {
    padding: 0;
    color: var(--fl-accent);
    background: transparent;
    border: 0;
    text-decoration: underline;
  }
</style>
