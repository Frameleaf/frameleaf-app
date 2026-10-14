import { derived, writable } from 'svelte/store';
import { UploadState, type UploadAsset } from '$lib/types';

function createUploadStore() {
  const uploadAssets = writable<Array<UploadAsset>>([]);
  const stats = writable<{ errors: number; duplicates: number; success: number; total: number }>({
    errors: 0,
    duplicates: 0,
    success: 0,
    total: 0,
  });

  const { subscribe } = uploadAssets;

  const isUploading = derived(uploadAssets, (items) => items.length > 0);
  const remainingUploads = derived(uploadAssets, (values) =>
    values.reduce(
      (count, asset) => count + (asset.state === UploadState.PENDING || asset.state === UploadState.STARTED ? 1 : 0),
      0,
    ),
  );

  const addItem = (newAsset: UploadAsset) => {
    uploadAssets.update(($assets) => {
      const duplicate = $assets.some((asset) => asset.id === newAsset.id);
      if (duplicate) {
        return $assets.map((asset) => (asset.id === newAsset.id ? newAsset : asset));
      }

      stats.update((stats) => {
        stats.total++;
        return stats;
      });

      $assets.push({
        ...newAsset,
        speed: 0,
        state: UploadState.PENDING,
        progress: 0,
        eta: 0,
      });

      return $assets;
    });
  };

  const updateProgress = (id: string, loaded: number, total: number) => {
    const transferred = Number.isFinite(loaded) ? Math.max(0, loaded) : 0;
    const size = Number.isFinite(total) ? Math.max(0, total) : 0;
    updateAssetMap(id, (v) => {
      const elapsed = v.startDate === undefined ? 0 : (Date.now() - v.startDate) / 1000;
      const measuredSpeed = elapsed > 0 ? transferred / elapsed : 0;
      const speed = Number.isFinite(measuredSpeed) ? measuredSpeed : 0;
      const eta = speed > 0 ? Math.ceil(Math.max(0, size - transferred) / speed) : 0;
      return {
        ...v,
        progress: size > 0 ? Math.min(100, Math.floor((transferred / size) * 100)) : 0,
        speed,
        eta: Number.isFinite(eta) ? eta : 0,
      };
    });
  };

  const markStarted = (id: string) => {
    updateItem(id, {
      state: UploadState.STARTED,
      startDate: Date.now(),
    });
  };

  const updateAssetMap = (id: string, mapper: (assets: UploadAsset) => UploadAsset) => {
    uploadAssets.update((uploadingAssets) => {
      return uploadingAssets.map((asset) => {
        if (asset.id === id) {
          return mapper(asset);
        }
        return asset;
      });
    });
  };

  const updateItem = (id: string, partialObject: Partial<UploadAsset>) => {
    updateAssetMap(id, (v) => ({ ...v, ...partialObject }));
  };

  const removeItem = (id: string) => {
    uploadAssets.update((uploadingAsset) => {
      const assetToRemove = uploadingAsset.find((a) => a.id === id);
      if (assetToRemove) {
        stats.update((stats) => {
          switch (assetToRemove.state) {
            case UploadState.DUPLICATED: {
              stats.duplicates--;
              break;
            }

            case UploadState.ERROR: {
              stats.errors--;
              break;
            }

            case UploadState.DONE: {
              break;
            }

            case UploadState.PENDING:
            case UploadState.STARTED:
            case undefined: {
              console.error('Cannot remove uploads in progress');
              break;
            }
          }

          return stats;
        });
      }

      return uploadingAsset.filter((a) => a.id !== id);
    });
  };

  /**
   * "Dismiss errors" (FL-45 U-1, UploadPanel.jsx `dismissUploadErrors`): drops the failed uploads
   * only; duplicates stay listed until "Clear finished" or Done.
   */
  const dismissErrors = () =>
    uploadAssets.update((value) => {
      const errors = value.reduce((count, item) => count + (item.state === UploadState.ERROR ? 1 : 0), 0);
      if (errors > 0) {
        // The dismissed files leave the batch, so "Uploading N of M" counts only what remains.
        stats.update((current) => ({ ...current, errors: current.errors - errors, total: current.total - errors }));
      }
      return value.filter((item) => item.state !== UploadState.ERROR);
    });

  /**
   * "Clear finished" (FL-45, UploadPanel.jsx `clearFinishedUploads`): drops the uploads that are
   * done or turned out to be duplicates while the rest keep going. Failed ones stay for a retry.
   */
  const clearFinished = () =>
    uploadAssets.update((value) => {
      const duplicates = value.reduce((count, item) => count + (item.state === UploadState.DUPLICATED ? 1 : 0), 0);
      if (duplicates > 0) {
        stats.update((current) => ({ ...current, duplicates: current.duplicates - duplicates }));
      }
      return value.filter((item) => item.state !== UploadState.DONE && item.state !== UploadState.DUPLICATED);
    });

  const reset = () => {
    uploadAssets.set([]);
    stats.set({ errors: 0, duplicates: 0, success: 0, total: 0 });
  };

  const track = (value: 'success' | 'duplicate' | 'error') => {
    stats.update((stats) => {
      switch (value) {
        case 'success': {
          stats.success++;
          break;
        }

        case 'duplicate': {
          stats.duplicates++;
          break;
        }

        case 'error': {
          stats.errors++;
          break;
        }
      }

      return stats;
    });
  };

  return {
    stats,
    remainingUploads,
    isUploading,
    track,
    dismissErrors,
    clearFinished,
    reset,
    markStarted,
    addItem,
    updateItem,
    removeItem,
    updateProgress,
    subscribe,
  };
}

export const uploadAssetsStore = createUploadStore();
