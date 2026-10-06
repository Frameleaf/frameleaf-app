<script lang="ts">
  import { onDestroy } from 'svelte';
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
  const labels: Record<NativeSyncField, string> = {
    exposureEV: 'Exposure',
    whiteBalance: 'White balance',
    shadows: 'Shadows',
    highlights: 'Highlights',
    saturation: 'Saturation',
    contrast: 'Contrast',
    curve: 'Curve',
    noiseThreshold: 'Noise reduction',
    sharpen: 'Sharpening',
    lensCorrection: 'Lens correction',
    masks: 'Shape & AI masks',
    crop: 'Crop',
    rotation: 'Rotation',
    straighten: 'Straightening',
    flipHorizontal: 'Horizontal flip',
    flipVertical: 'Vertical flip',
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
        throw new Error('Open this photograph in RAW development and save a version first.');
      }
      source = revision.recipe;
    } catch (error_) {
      if (!disposed) {
        error = error_ instanceof Error ? error_.message : 'Could not load the source settings.';
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
    } catch (error_) {
      if (!disposed) {
        error = error_ instanceof Error ? error_.message : 'The batch could not be started.';
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
          : { status: 'unavailable', progress: 0, error: 'Version unavailable' };
      } catch (error_) {
        if (!disposed) {
          error = error_ instanceof Error ? error_.message : 'Could not refresh the batch.';
        }
      }
    }
  }
  onDestroy(() => {
    disposed = true;
    controller?.abort();
  });
</script>

<section class="phd-card phd" aria-label="Batch RAW development" aria-busy={busy}>
  <div class="phd-row">
    <div>
      <h3>Batch RAW development</h3>
      <p>
        Sync selected adjustments from a saved native RAW version. AI masks are recalculated for each photograph; brush
        strokes stay with their photograph.
      </p>
    </div>
    <a href={Route.queues()}>Open Activity</a>
  </div>
  {#if error}<p role="alert">{error}</p>{/if}<label
    >Source photograph<select
      value={sourceId}
      disabled={busy || results.length > 0}
      onchange={(event) => loadSource(event.currentTarget.value)}
      ><option value="">Choose a saved RAW edit</option
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
        />{labels[field]}</label
      >{/each}
  </div>
  <div class="phd-actions">
    <Button
      variant="primary"
      disabled={busy || !source || fields.length === 0 || assetIds.filter((id) => id !== sourceId).length === 0}
      onclick={start}>{results.length > 0 ? 'Retry failed photos' : 'Queue selected photos'}</Button
    ><Button disabled={!busy && results.every((row) => row.status !== 'queued')} onclick={cancel}>Cancel batch</Button
    ><Button disabled={busy || results.length === 0} onclick={refresh}>Refresh render progress</Button>
    {#if results.length}<Button
        disabled={busy}
        onclick={() => {
          results = [];
          states = {};
          error = '';
        }}>Start another batch</Button
      >{/if}
  </div>
  {#each results as row (row.assetId)}<div class="phd-row">
      <span>{photos.find((photo) => photo.id === row.assetId)?.fileName ?? 'Photograph'}</span><span
        >{states[row.assetId]?.status ?? row.status} {states[row.assetId]?.progress ?? 0}%</span
      >{#if row.error || states[row.assetId]?.error}<p role="alert">{states[row.assetId]?.error ?? row.error}</p>{/if}
    </div>{/each}
</section>
