<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import {
    getAssetInfo,
    getEnrichmentOptions,
    previewEnrichment,
    updateAsset,
    MlDestinationKind,
    EnrichmentPreviewStatus,
    type AssetResponseDto,
  } from '@frameleaf/sdk';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    asset,
    onAssetRefresh,
  }: {
    asset: AssetResponseDto;
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  } = $props();

  let draft = $state<{ id: string; before: string; checksum: string; model: string; current: () => boolean } | null>(
    null,
  );
  let text = $state('');
  let busy = $state(false);
  let failure = $state('');
  let alive = true;
  let generation = 0;
  let previousId: string;
  onDestroy(() => {
    alive = false;
  });
  $effect.pre(() => {
    if (asset.id !== previousId) {
      previousId = asset.id;
      generation++;
      draft = null;
      failure = '';
      busy = false;
    }
  });

  async function generate() {
    if (busy) {
      return;
    }
    const id = asset.id;
    const before = asset.exifInfo?.description ?? '';
    const checksum = asset.checksum;
    const revision = generation;
    const session = authManager.captureSession();
    const current = () => alive && revision === generation && session();
    busy = true;
    failure = '';
    draft = null;
    try {
      const options = await getEnrichmentOptions();
      if (!current()) {
        return;
      }
      const destinations = options.destinations.filter(
        (item) => item.kind === MlDestinationKind.Local && item.enrichment.admitted,
      );
      if (destinations.length !== 1) {
        failure = $t('frameleaf_local_description_destination');
        return;
      }
      const result = await previewEnrichment({
        enrichmentPreviewRequestDto: {
          assetIds: [id],
          destinationId: destinations[0]!.id,
          localOnly: true,
          fallbackModelName: '',
        },
      });
      if (!current()) {
        return;
      }
      const sample = result.samples.find((item) => item.assetId === id);
      if (
        result.cloud ||
        result.destinationId !== destinations[0]!.id ||
        sample?.status !== EnrichmentPreviewStatus.Success ||
        !sample.candidate
      ) {
        failure = $t('frameleaf_local_description_prepare_error');
        return;
      }
      text = sample.candidate;
      draft = { id, before, checksum, model: result.modelName, current };
    } catch {
      if (current()) {
        failure = $t('frameleaf_local_description_prepare_error');
      }
    } finally {
      if (current()) {
        busy = false;
      }
    }
  }

  async function apply() {
    const snapshot = draft;
    if (!snapshot || busy || snapshot.id !== asset.id || !snapshot.current()) {
      return;
    }
    const revision = generation;
    const session = authManager.captureSession();
    const current = () => alive && revision === generation && session();
    const description = text.trim();
    if (!description) {
      return;
    }
    busy = true;
    failure = '';
    try {
      const latest = await getAssetInfo({ id: snapshot.id });
      if (!current()) {
        return;
      }
      if ((latest.exifInfo?.description ?? '') !== snapshot.before || latest.checksum !== snapshot.checksum) {
        draft = null;
        onAssetRefresh?.(latest);
        failure = $t('frameleaf_local_description_stale');
        return;
      }
      await updateAsset({ id: snapshot.id, updateAssetDto: { description } });
      if (!current()) {
        return;
      }
      onAssetRefresh?.({ ...latest, exifInfo: { ...latest.exifInfo, description } });
      draft = null;
    } catch {
      if (current()) {
        failure = $t('frameleaf_local_description_apply_error');
      }
    } finally {
      if (current()) {
        busy = false;
      }
    }
  }
</script>

<section aria-label={$t('frameleaf_local_description_title')} class="local-description">
  <button type="button" disabled={busy} onclick={generate}>
    {busy && !draft ? $t('frameleaf_local_description_preparing') : $t('frameleaf_local_description_preview')}
  </button>
  {#if draft}
    <p>{$t('frameleaf_local_description_model', { values: { model: draft.model } })}</p>
    <label>
      {$t('frameleaf_local_description_review')}
      <textarea bind:value={text} disabled={busy} rows="4"></textarea>
    </label>
    <div>
      <button
        type="button"
        disabled={busy}
        onclick={() => {
          draft = null;
          failure = '';
        }}>{$t('frameleaf_local_description_discard')}</button
      >
      <button type="button" disabled={busy || !text.trim()} onclick={apply}
        >{$t('frameleaf_local_description_apply')}</button
      >
    </div>
  {/if}
  {#if failure}<p role="alert">{failure}</p>{/if}
</section>

<style>
  .local-description {
    margin-top: 12px;
    font-size: 12px;
  }
  label {
    display: block;
    margin: 8px 0;
  }
  textarea {
    display: block;
    width: 100%;
    margin-top: 4px;
    padding: 8px;
    color: inherit;
    background: var(--fl-viewer-surface);
    border: 1px solid currentColor;
    border-radius: 6px;
  }
  button {
    padding: 4px 8px;
    border: 1px solid currentColor;
    border-radius: 6px;
  }
  button:disabled {
    opacity: 0.5;
  }
  .local-description > div {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
