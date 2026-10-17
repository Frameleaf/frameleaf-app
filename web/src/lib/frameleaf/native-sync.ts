import { cancelAssetDevelopRender, getAssetDevelop, saveAssetDevelop } from '@frameleaf/sdk';
import { initialNativeRecipe, isNativeRecipe, proposeNativeMask, type NativeRecipe } from './native-develop';

export const NATIVE_SYNC_FIELDS = [
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
  'masks',
  'crop',
  'rotation',
  'straighten',
  'flipHorizontal',
  'flipVertical',
] as const;
export type NativeSyncField = (typeof NATIVE_SYNC_FIELDS)[number];
export type NativeSyncResult = {
  assetId: string;
  status: 'queued' | 'failed' | 'cancelled';
  revisionId?: string;
  error?: string;
};
const clone = <T>(value: T): T => structuredClone(value);

/** Per-photo jobs remain durable in Activity; successful admissions can be omitted on retry. */
export async function syncNativeRecipes(
  assetIds: string[],
  source: NativeRecipe,
  fields: readonly NativeSyncField[],
  options: {
    signal?: AbortSignal;
    onUpdate?: (result: NativeSyncResult) => void;
    completed?: readonly NativeSyncResult[];
  } = {},
): Promise<NativeSyncResult[]> {
  if (fields.length === 0 || fields.some((field) => !NATIVE_SYNC_FIELDS.includes(field))) {
    throw new Error('Choose the native settings to sync');
  }
  const completed = new Map(
    options.completed?.filter((result) => result.status === 'queued').map((result) => [result.assetId, result]),
  );
  const results: NativeSyncResult[] = [];
  for (const assetId of new Set(assetIds)) {
    if (completed.has(assetId)) {
      results.push(completed.get(assetId)!);
      continue;
    }
    let result: NativeSyncResult;
    try {
      options.signal?.throwIfAborted();
      const develop = await getAssetDevelop({ id: assetId }, { signal: options.signal });
      const current = develop.revisions.find((revision) => revision.isCurrent);
      if (current && !isNativeRecipe(current.recipe)) {
        throw new Error('This photo has a quick edit or external version; open RAW development before syncing');
      }
      const recipe = current && isNativeRecipe(current.recipe) ? clone(current.recipe) : initialNativeRecipe();
      delete recipe.sensorCanvas;
      for (const field of fields) {
        if (field !== 'masks') {
          const value = source[field];
          if (value === undefined) {
            delete recipe[field];
          } else {
            Object.assign(recipe, { [field]: clone(value) });
          }
          continue;
        }
        // Sensor-specific painted strokes never transfer to another photo. Shape masks are normalized.
        const masks = [];
        for (const original of source.masks ?? []) {
          options.signal?.throwIfAborted();
          if (original.kind === 'brush') {
            throw new Error('Brush masks are photo-specific; sync other settings or use shape/semantic masks');
          }
          const mask = clone(original);
          mask.id = crypto.randomUUID();
          if (['subject', 'sky', 'background'].includes(mask.kind)) {
            const artifact = await proposeNativeMask(assetId, mask.kind === 'sky' ? 'sky' : 'subject', options.signal);
            mask.artifact = artifact.id;
            if (mask.kind === 'background') {
              mask.kind = 'subject';
              mask.invert = !mask.invert;
            }
            delete mask.strokes;
          }
          masks.push(mask);
        }
        recipe.masks = masks;
      }
      options.signal?.throwIfAborted();
      // Once admitted, retain the result even if cancellation arrives during the HTTP response.
      const revision = await saveAssetDevelop({
        id: assetId,
        assetDevelopSaveDto: { recipe, replaceRecipe: true, render: true, label: 'Synced RAW settings' },
      });
      result = { assetId, status: 'queued', revisionId: revision.id };
    } catch (error) {
      result = {
        assetId,
        status: options.signal?.aborted ? 'cancelled' : 'failed',
        error: error instanceof Error ? error.message : 'Settings could not be synced',
      };
    }
    results.push(result);
    options.onUpdate?.(result);
  }
  return results;
}

/** Stop new admissions with the sync AbortController, then cancel these exact revision jobs. */
export async function cancelNativeSync(results: readonly NativeSyncResult[]) {
  return Promise.all(
    results
      .filter((result) => result.status === 'queued' && result.revisionId)
      .map(async (result) => {
        try {
          await cancelAssetDevelopRender({ id: result.assetId, revisionId: result.revisionId! });
          return { ...result, status: 'cancelled' as const };
        } catch {
          return { ...result, error: 'Cancellation failed; check the photo’s render in Activity' };
        }
      }),
  );
}
