<script lang="ts">
  import { onDestroy } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import { getAssetDevelop } from '@frameleaf/sdk';
  import { isNativeRecipe, type NativeRecipe } from '$lib/frameleaf/native-develop';
  import {
    syncNativeRecipes,
    cancelNativeSync,
    NATIVE_SYNC_FIELDS,
    type NativeSyncField,
    type NativeSyncResult,
  } from '$lib/frameleaf/native-sync';
  import { type Photo } from '$lib/frameleaf/photography/api';
  import { Route } from '$lib/route';
  import Button from './Button.svelte';
  let { photos, assetIds }: { photos: Photo[]; assetIds: string[] } = $props();
  let sourceId = $state('');
  let source = $state<NativeRecipe | null>(null);
  let fields = $state<NativeSyncField[]>([
    'exposureEV',
    'whiteBalance',
    'shadows',
    'highlights',
    'saturation',
    'contrast',
    'curve',
    'noiseThreshold',
    'sharpen',
    'lensCorrection',
  ]);
  let results = $state<NativeSyncResult[]>([]);
  let states = $state<Record<string, { status: string; progress: number; error: string | null }>>({});
  let busy = $state(false);
  let error = $state('');
  let controller: AbortController | undefined;
  let disposed = false;
  const labels: Record<NativeSyncField, Translations> = {
    exposureEV: 'frameleaf_photography_sync_exposure',
    whiteBalance: 'frameleaf_photography_sync_white_balance',
    shadows: 'frameleaf_photography_sync_shadows',
    highlights: 'frameleaf_photography_sync_highlights',
    saturation: 'frameleaf_photography_sync_saturation',
    contrast: 'frameleaf_photography_sync_contrast',
    curve: 'frameleaf_photography_sync_curve',
    noiseThreshold: 'frameleaf_photography_sync_noise',
    sharpen: 'frameleaf_photography_sync_sharpen',
    lensCorrection: 'frameleaf_photography_sync_lens',
    masks: 'frameleaf_photography_sync_masks',
    crop: 'frameleaf_photography_sync_crop',
    rotation: 'frameleaf_photography_sync_rotation',
    straighten: 'frameleaf_photography_sync_straighten',
    flipHorizontal: 'frameleaf_photography_sync_flip_horizontal',
    flipVertical: 'frameleaf_photography_sync_flip_vertical',
  };
  const statusKeys: Record<string, Translations> = {
    queued: 'frameleaf_photography_sync_status_queued',
    rendering: 'frameleaf_photography_sync_status_rendering',
    rendered: 'frameleaf_photography_sync_status_rendered',
    failed: 'frameleaf_photography_sync_status_failed',
    cancelled: 'frameleaf_photography_sync_status_cancelled',
    unavailable: 'frameleaf_photography_unavailable',
  };
  const statusLabel = (status: string) => {
    const key = Object.hasOwn(statusKeys, status) ? statusKeys[status] : undefined;
    return key ? $t(key) : status;
  };

  async function loadSource(id: string) {
    sourceId = id;
    source = null;
    error = '';
    if (!id) {
      return;
    }
    try {
      const value = await getAssetDevelop({ id });
      if (disposed || id !== sourceId) {
        return;
      }
      const revision = value.revisions.find((row) => row.isCurrent);
      if (!revision || !isNativeRecipe(revision.recipe)) {
        // Nothing to copy from yet: say what to do, in its own words.
        error = $t('frameleaf_photography_sync_no_source');
        return;
      }
      source = revision.recipe;
    } catch {
      if (!disposed) {
        error = $t('frameleaf_photography_sync_source_failed');
      }
    }
  }
  async function start() {
    if (!source || busy) {
      return;
    }
    busy = true;
    error = '';
    controller = new AbortController();
    try {
      const value = await syncNativeRecipes(
        assetIds.filter((id) => id !== sourceId),
        $state.snapshot(source),
        fields,
        {
          signal: controller.signal,
          completed: results.filter((row) => states[row.assetId]?.status !== 'failed'),
          onUpdate: (result) => {
            if (disposed) {
              return;
            }

            delete states[result.assetId];
            results = [...results.filter((row) => row.assetId !== result.assetId), result];
          },
        },
      );
      if (disposed) {
        return;
      }
      results = value;
      if (controller.signal.aborted) {
        await cancel();
      }
    } catch {
      if (!disposed) {
        error = $t('frameleaf_photography_sync_start_failed');
      }
    } finally {
      if (!disposed) {
        busy = false;
      }
    }
  }
  async function cancel() {
    controller?.abort();
    const pending = results.filter(
      (row) =>
        row.status === 'queued' &&
        !['rendered', 'failed', 'cancelled', 'unavailable'].includes(states[row.assetId]?.status),
    );
    const value = await cancelNativeSync($state.snapshot(pending));
    if (!disposed) {
      results = results.map((row) => value.find((item) => item.assetId === row.assetId) ?? row);
      for (const row of value) {
        if (row.status === 'cancelled') {
          delete states[row.assetId];
        }
      }
    }
  }
  async function refresh() {
    error = '';
    for (const row of results) {
      if (!row.revisionId) {
        continue;
      }
      try {
        const value = await getAssetDevelop({ id: row.assetId });
        if (disposed) {
          return;
        }
        const revision = value.revisions.find((item) => item.id === row.revisionId);
        states[row.assetId] = revision
          ? { status: revision.status, progress: revision.progress, error: revision.error }
          : { status: 'unavailable', progress: 0, error: $t('frameleaf_photography_sync_version_unavailable') };
      } catch {
        if (!disposed) {
          error = $t('frameleaf_photography_sync_refresh_failed');
        }
      }
    }
  }
  onDestroy(() => {
    disposed = true;
    controller?.abort();
  });
</script>

<section class="phd-card phd" aria-label={$t('frameleaf_photography_batch_raw')} aria-busy={busy}>
  <div class="phd-row">
    <div>
      <h3>{$t('frameleaf_photography_batch_raw')}</h3>
      <p>
        {$t('frameleaf_photography_sync_body')}
      </p>
    </div>
    <a href={Route.queues()}>{$t('frameleaf_photography_sync_open_activity')}</a>
  </div>
  {#if error}<p role="alert">{error}</p>{/if}<label
    >{$t('frameleaf_photography_sync_source')}<select
      value={sourceId}
      disabled={busy || results.length > 0}
      onchange={(event) => loadSource(event.currentTarget.value)}
      ><option value="">{$t('frameleaf_photography_sync_choose_source')}</option
      >{#each photos.filter((photo) => assetIds.includes(photo.id)) as photo (photo.id)}<option value={photo.id}
          >{photo.fileName}</option
        >{/each}</select
    ></label
  >
  <div class="phd-fields">
    {#each NATIVE_SYNC_FIELDS as field (field)}<label
        ><input
          type="checkbox"
          disabled={busy || results.length > 0}
          checked={fields.includes(field)}
          onchange={(event) =>
            (fields = event.currentTarget.checked ? [...fields, field] : fields.filter((item) => item !== field))}
        />{$t(labels[field])}</label
      >{/each}
  </div>
  <div class="phd-actions">
    <Button
      variant="primary"
      disabled={busy || !source || fields.length === 0 || assetIds.filter((id) => id !== sourceId).length === 0}
      onclick={start}
      >{results.length > 0
        ? $t('frameleaf_photography_sync_retry_failed')
        : $t('frameleaf_photography_sync_queue')}</Button
    ><Button disabled={!busy && results.every((row) => row.status !== 'queued')} onclick={cancel}
      >{$t('frameleaf_photography_sync_cancel')}</Button
    ><Button disabled={busy || results.length === 0} onclick={refresh}
      >{$t('frameleaf_photography_sync_refresh')}</Button
    >
    {#if results.length}<Button
        disabled={busy}
        onclick={() => {
          results = [];
          states = {};
          error = '';
        }}>{$t('frameleaf_photography_sync_another')}</Button
      >{/if}
  </div>
  {#each results as row (row.assetId)}<div class="phd-row">
      <span
        >{photos.find((photo) => photo.id === row.assetId)?.fileName ??
          $t('frameleaf_photography_client_photograph')}</span
      ><span>{statusLabel(states[row.assetId]?.status ?? row.status)} · {states[row.assetId]?.progress ?? 0}%</span
      >{#if row.error || states[row.assetId]?.error}<p role="alert">{states[row.assetId]?.error ?? row.error}</p>{/if}
    </div>{/each}
</section>
