import {
  AssetMediaSize,
  AssetVisibility,
  bulkTagAssets,
  deleteAssets,
  deleteStacks,
  downloadArchive as requestArchive,
  downloadAsset as requestAsset,
  getBaseUrl,
  getDownloadInfo,
  getStack,
  untagAssets,
  updateAsset,
  updateAssets,
  type AssetResponseDto,
  type DownloadArchiveInfo,
  type DownloadInfoDto,
  type DownloadResponseDto,
  type StackResponseDto,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { DateTime } from 'luxon';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import {
  downloadManager,
  EmptyDownloadError,
  bufferLimit,
  holdOrStream,
  StreamedDownload,
  type DownloadContext,
  type DownloadTask,
} from '$lib/managers/download-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { downloadUrl, downloadUrlPost, getAssetMediaUrl } from '$lib/utils';
import { getByteUnitString } from '$lib/utils/byte-units';
import { getFormatter } from '$lib/utils/i18n';
import { navigate } from '$lib/utils/navigation';
import { asQueryString } from '$lib/utils/shared-links';
import { toTimelineAsset } from '$lib/utils/timeline-util';
import { handleError } from './handle-error';

export const tagAssets = async ({
  assetIds,
  tagIds,
  showNotification = true,
}: {
  assetIds: string[];
  tagIds: string[];
  showNotification?: boolean;
}) => {
  await bulkTagAssets({ tagBulkAssetsDto: { tagIds, assetIds } });

  if (showNotification) {
    const $t = await getFormatter();
    toastManager.primary($t('tagged_assets', { values: { count: assetIds.length } }));
  }

  return assetIds;
};

export const removeTag = async ({
  assetIds,
  tagIds,
  showNotification = true,
}: {
  assetIds: string[];
  tagIds: string[];
  showNotification?: boolean;
}) => {
  for (const tagId of tagIds) {
    await untagAssets({ id: tagId, bulkIdsDto: { ids: assetIds } });
  }

  if (showNotification) {
    const $t = await getFormatter();
    toastManager.primary($t('removed_tagged_assets', { values: { count: assetIds.length } }));
  }

  return assetIds;
};

/**
 * Hands a failure to the shared error handler without a toast: the download row shows the error
 * (FL-45 D-2), while a public share still gets its revoked-link handling from a 401 (FL-56).
 */
const reportDownloadError = (error: unknown) => {
  if (error instanceof EmptyDownloadError) {
    return;
  }
  handleError(error, get(t)('errors.unable_to_download_files'), { notify: false });
};

const withDownloadErrors =
  (task: DownloadTask): DownloadTask =>
  async (context) => {
    try {
      return await task(context);
    } catch (error) {
      if (!context.signal.aborted) {
        reportDownloadError(error);
      }
      throw error;
    }
  };

/** The surface a new download shows on: the public share strip on a share page, else the panel. */
const downloadGroup = () => (authManager.isSharedLink ? ('share' as const) : undefined);

const abortError = () => new DOMException('The download was cancelled', 'AbortError');

/**
 * For a caller that only fires `downloadArchive` off: a cancel is the user's choice, not an error,
 * so it settles quietly; any other failure is passed on.
 */
export const ignoreCancelledDownload = (error: unknown): void => {
  if ((error as { name?: unknown } | null)?.name === 'AbortError') {
    return;
  }
  throw error;
};

/**
 * Downloads photos and videos as zip archives (FL-45 D-1/D-3). One row appears at once while the
 * server plans the archives; a plan split by the account's archive size limit becomes one row per
 * part. A part up to `bufferLimit()` is fetched into the tab with progress, Cancel and Retry, one
 * part at a time; a larger part is ready at once and Save streams it through the browser.
 *
 * The signature is unchanged from the legacy helper. The promise resolves once every part is ready
 * to save, and rejects when one fails or is cancelled (an `AbortError`), so a caller that reports
 * the outcome reports what actually happened.
 */
export const downloadArchive = (fileName: string, options: Omit<DownloadInfoDto, 'archiveSize'>): Promise<void> => {
  const archiveSize = authManager.authenticated ? authManager.preferences.download.archiveSize : undefined;
  const dto = { ...options, archiveSize };
  const params = authManager.params;
  const group = downloadGroup();
  const stamp = DateTime.now().toFormat('yyyyLLdd_HHmmss');
  const nameOf = (index: number, count: number) => `${fileName}${count > 1 ? `+${index + 1}` : ''}-${stamp}`;
  const streamUrl = () => {
    const query = asQueryString(params);
    return getBaseUrl() + '/download/archive' + (query ? `?${query}` : '');
  };

  // Held parts are fetched one after another, never in parallel (B1). The next part starts once
  // the manager has recorded the one before it, so what the tab holds is counted before it decides.
  let turn: Promise<unknown> = Promise.resolve();
  const inTurn = ({ key, signal }: DownloadContext, run: () => Promise<Blob | StreamedDownload>) => {
    const mine = turn.then(() => {
      if (signal.aborted) {
        throw abortError();
      }
      return run();
    });
    turn = downloadManager.settled(key).catch(() => {});
    return mine;
  };

  const fetchArchive =
    (archive: DownloadArchiveInfo, archiveName: string): DownloadTask =>
    (context) => {
      const stream = new StreamedDownload(() => downloadUrlPost(streamUrl(), archive.assetIds, archiveName));
      // A part that could never be held is ready at once; it does not wait for the parts before it.
      if (archive.size > bufferLimit()) {
        return Promise.resolve(stream);
      }
      // Each held part waits for the one before it, then holds only what the tab can still hold.
      return inTurn(context, () =>
        holdOrStream(context, {
          size: archive.size,
          request: (fetch) =>
            requestArchive(
              { ...params, downloadArchiveDto: { assetIds: archive.assetIds, archiveName, edited: true } },
              { signal: context.signal, fetch },
            ),
          stream,
        }),
      );
    };

  const describeArchive = (archive: DownloadArchiveInfo, archiveName: string) => ({
    name: `${archiveName}.zip`,
    assetIds: archive.assetIds,
    count: archive.assetIds.length,
    total: archive.size,
    group,
  });

  // Kept after the first successful plan so a retry of the first archive does not plan (and add
  // the other archives) again.
  let plan: DownloadResponseDto | undefined;
  let firstPlan = false;
  const partOutcomes: Promise<void>[] = [];

  const firstKey = downloadManager.start(
    { name: `${nameOf(0, 1)}.zip`, assetIds: options.assetIds ?? [], count: options.assetIds?.length ?? 0, group },
    withDownloadErrors(async (context) => {
      if (!plan) {
        const response = await getDownloadInfo({ ...params, downloadInfoDto: dto }, { signal: context.signal });
        if (response.archives.length === 0) {
          throw new EmptyDownloadError();
        }
        // M2: a cancel while the plan was loading starts none of the other parts.
        if (context.signal.aborted) {
          throw abortError();
        }
        plan = response;
        firstPlan = true;
      }
      const count = plan.archives.length;
      const archiveName = nameOf(0, count);
      context.describe(describeArchive(plan.archives[0], archiveName));
      // The first part takes its turn before the parts after it are added behind it.
      const first = fetchArchive(plan.archives[0], archiveName)(context);
      if (firstPlan) {
        firstPlan = false;
        for (const [offset, archive] of plan.archives.slice(1).entries()) {
          const partName = nameOf(offset + 1, count);
          const key = downloadManager.start(
            describeArchive(archive, partName),
            withDownloadErrors(fetchArchive(archive, partName)),
          );
          // Registered now, so a part saved (and removed) before the first part is ready still
          // counts as ready rather than cancelled.
          const settled = downloadManager.settled(key);
          settled.catch(() => {});
          partOutcomes.push(settled);
        }
      }
      return first;
    }),
  );

  // The plan (and so every part's outcome) is known before the first part can be ready.
  return downloadManager
    .settled(firstKey)
    .then(() => Promise.all(partOutcomes))
    .then(() => undefined);
};

/**
 * Downloads one file (an original, its edited version or a Live Photo's motion part) through the
 * download panel, with Cancel and Retry (FL-45 D-3). A file up to `bufferLimit()` (or of unknown
 * size) is fetched with progress; a larger one is ready at once and Save streams it through the
 * browser. Returns the panel row's key.
 */
export const downloadAssetFile = ({
  id,
  filename,
  edited,
  size,
  format,
}: {
  id: string;
  filename: string;
  edited: boolean;
  size?: number;
  format?: 'sdr-jpeg' | 'hdr-jpeg' | 'hdr-heic';
}) =>
  downloadManager.start(
    { name: filename, assetIds: [id], count: 1, total: format ? 0 : (size ?? 0), group: downloadGroup() },
    withDownloadErrors((context) =>
      holdOrStream(context, {
        // An edited file is not the size recorded for the original, so its headers decide.
        size: edited || format || !size ? undefined : size,
        fetcher: async (input, init) => {
          const response = await fetch(input, init);
          if ((edited || format) && response.ok) {
            const extension = (
              {
                'image/jpeg': 'jpeg',
                'image/png': 'png',
                'image/webp': 'webp',
                'image/avif': 'avif',
                'image/heic': 'heic',
                'image/heif': 'heif',
              } as Record<string, string>
            )[response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? ''];
            if (extension) {
              context.describe({ name: `${filename.replace(/\.[^.]+$/, '')}.${extension}` });
            }
          }
          return response;
        },
        request: (fetch) =>
          requestAsset(
            { ...authManager.params, id, edited, ...(format && { format }) },
            { signal: context.signal, fetch },
          ),
        stream: new StreamedDownload((name) =>
          downloadUrl(getAssetMediaUrl({ id, size: AssetMediaSize.Original, edited, format }), name),
        ),
      }),
    ),
  );

function isRotated90CW(orientation: number) {
  return [5, 6, 90].includes(orientation);
}

function isRotated270CW(orientation: number) {
  return [7, 8, -90].includes(orientation);
}

export function isFlipped(orientation?: string | null) {
  const value = Number(orientation);
  return value && (isRotated270CW(value) || isRotated90CW(value));
}

export function getFileSize(asset: AssetResponseDto, maxPrecision = 4): string {
  const size = asset.exifInfo?.fileSizeInByte || 0;
  return size > 0 ? getByteUnitString(size, undefined, maxPrecision) : 'Invalid Data';
}

export function getAssetResolution(asset: AssetResponseDto): string {
  if (!asset.width || !asset.height) {
    return 'Invalid Data';
  }

  return `${asset.width} x ${asset.height}`;
}

/**
 * Returns aspect ratio for the asset
 */
export function getAssetRatio(asset: AssetResponseDto) {
  return asset.width && asset.height ? asset.width / asset.height : null;
}

// list of supported image extensions from https://developer.mozilla.org/en-US/docs/Web/Media/Formats/Image_types excluding svg
const supportedImageMimeTypes = new Set([
  'image/apng',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

export const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');

async function addSupportedMimeTypes(): Promise<void> {
  const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent); // https://stackoverflow.com/a/23522755
  if (isSafari) {
    const match = navigator.userAgent.match(/Version\/(\d+)/);

    if (!match) {
      return;
    }

    const majorVersion = Number.parseInt(match[1]);
    const MIN_REQUIRED_VERSION = 17;

    if (majorVersion >= MIN_REQUIRED_VERSION) {
      supportedImageMimeTypes.add('image/jxl').add('image/heic').add('image/heif');
    }

    return;
  }

  const probes = [
    { type: 'image/jxl', aliases: [], sample: 'data:image/jxl;base64,/woIAAAMABKIAgC4AF3lEgA=' },
    {
      type: 'image/heic',
      aliases: ['image/heif'],
      sample:
        'data:image/heic;base64,AAAAGGZ0eXBoZWljAAAAAG1pZjFoZWljAAABrW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAHBpY3QAAAAAAAAAAAAAAAAAAAAADnBpdG0AAAAAAAIAAAAQaWRhdAAAAAAAAQABAAAAOGlsb2MBAAAAREAAAgABAAAAAAAAAc0AAQAAAAAAAAAsAAIAAQAAAAAAAAABAAAAAAAAAAgAAAA4aWluZgAAAAAAAgAAABVpbmZlAgAAAQABAABodmMxAAAAABVpbmZlAgAAAAACAABncmlkAAAAANhpcHJwAAAAtmlwY28AAAB2aHZjQwEDcAAAAAAAAAAAAB7wAPz9+PgAAA8DIAABABhAAQwB//8DcAAAAwCQAAADAAADAB66AkAhAAEAKkIBAQNwAAADAJAAAAMAAAMAHqAggQWW6q6a5uBAQMCAAAADAIAAAAMAhCIAAQAGRAHBc8GJAAAAFGlzcGUAAAAAAAAAAQAAAAEAAAAUaXNwZQAAAAAAAABAAAAAQAAAABBwaXhpAAAAAAMICAgAAAAaaXBtYQAAAAAAAAACAAECgQMAAgIChAAAABppcmVmAAAAAAAAAA5kaW1nAAIAAQABAAAANG1kYXQAAAAoKAGvCchMZYA50NoPIfzz81Qfsm577GJt3lf8kLAr+NbNIoeRR7JeYA==',
    },
  ];
  await Promise.all(
    probes.map(async ({ type, aliases, sample }) => {
      const enable = () => {
        for (const mime of [type, ...aliases]) {
          supportedImageMimeTypes.add(mime);
        }
      };
      if (globalThis.isSecureContext && typeof ImageDecoder !== 'undefined') {
        try {
          if (await ImageDecoder.isTypeSupported(type)) {
            enable();
          }
          return;
        } catch {
          // A failed capability query can still use the browser's image decoder.
        }
      }
      const image = new Image();
      image.addEventListener('load', enable, { once: true });
      image.src = sample;
    }),
  );
}
// eslint-disable-next-line unicorn/no-top-level-side-effects
void addSupportedMimeTypes();

/**
 * Returns true if the asset is an image supported by web browsers, false otherwise
 */
export function isWebCompatibleImage(asset: AssetResponseDto): boolean {
  if (!asset.originalMimeType) {
    return false;
  }

  return supportedImageMimeTypes.has(asset.originalMimeType);
}

export type StackResponse = {
  stack?: StackResponseDto;
  toDeleteIds: string[];
};

export const deleteStack = async (stackIds: string[]) => {
  const ids = [...new Set(stackIds)];
  if (ids.length === 0) {
    return;
  }

  const $t = get(t);

  try {
    const stacks = await Promise.all(ids.map((id) => getStack({ id })));
    const count = stacks.reduce((sum, stack) => sum + stack.assets.length, 0);

    await deleteStacks({ bulkIdsDto: { ids: [...ids] } });

    toastManager.primary($t('unstacked_assets_count', { values: { count } }));

    const assets = stacks.flatMap((stack) => stack.assets);
    for (const asset of assets) {
      asset.stack = null;
    }

    return assets;
  } catch (error) {
    handleError(error, $t('errors.failed_to_unstack_assets'));
  }
};

export const keepThisDeleteOthers = async (keepAsset: AssetResponseDto, stack: StackResponseDto) => {
  const $t = get(t);

  try {
    const assetsToDeleteIds = stack.assets.filter((asset) => asset.id !== keepAsset.id).map((asset) => asset.id);
    await deleteAssets({ assetBulkDeleteDto: { ids: assetsToDeleteIds } });
    await deleteStacks({ bulkIdsDto: { ids: [stack.id] } });

    toastManager.primary($t('kept_this_deleted_others', { values: { count: assetsToDeleteIds.length } }));

    keepAsset.stack = null;
    return keepAsset;
  } catch (error) {
    handleError(error, $t('errors.failed_to_keep_this_delete_others'));
  }
};

export const toggleArchive = async (asset: AssetResponseDto) => {
  const $t = get(t);
  try {
    const data = await updateAsset({
      id: asset.id,
      updateAssetDto: {
        visibility: asset.isArchived ? AssetVisibility.Timeline : AssetVisibility.Archive,
      },
    });

    asset.isArchived = data.isArchived;
    asset.visibility = data.visibility;
    if (asset.isArchived) {
      const timelineAsset = toTimelineAsset(asset);
      showUndoArchiveToast($t('added_to_archive'), [timelineAsset]);
    } else {
      toastManager.primary($t('removed_from_archive'));
    }
    return asset;
  } catch (error) {
    handleError(error, $t('errors.unable_to_add_remove_archive', { values: { archived: asset.isArchived } }));
  }
};

const showUndoArchiveToast = (description: string, assets: TimelineAsset[]) => {
  const $t = get(t);
  toastManager.primary({
    description,
    button: (close) => ({
      label: $t('undo'),
      onclick: () => {
        close();
        void undoArchiveAssets(assets);
      },
    }),
  });
};

const undoArchiveAssets = async (assets: TimelineAsset[]) => {
  const $t = get(t);
  try {
    const ids = assets.map((a) => a.id);
    if (ids.length > 0) {
      await updateAssets({
        assetBulkUpdateDto: {
          ids,
          visibility: AssetVisibility.Timeline,
        },
      });
    }

    for (const asset of assets) {
      asset.visibility = AssetVisibility.Timeline;
    }
    eventManager.emit('AssetsUnarchive', assets);
    eventManager.emit('AssetsUndoArchive', assets);
    toastManager.success($t('unarchived_count', { values: { count: assets.length } }));
  } catch (error) {
    handleError(error, $t('errors.unable_to_archive_unarchive', { values: { archived: false } }));
  }
};

export const delay = async (ms: number) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const getNextAsset = (assets: AssetResponseDto[], currentAsset: AssetResponseDto | undefined) => {
  const index = currentAsset ? assets.findIndex((a) => a.id === currentAsset.id) : -1;
  return index >= 0 ? assets[index + 1] : undefined;
};

export const getPreviousAsset = (assets: AssetResponseDto[], currentAsset: AssetResponseDto | undefined) => {
  const index = currentAsset ? assets.findIndex((a) => a.id === currentAsset.id) : -1;
  return index >= 0 ? assets[index - 1] : undefined;
};

export const canCopyImageToClipboard = (): boolean => {
  return !!(navigator.clipboard && globalThis.ClipboardItem);
};

const imgToBlob = async (imageElement: HTMLImageElement) => {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');

  canvas.width = imageElement.naturalWidth;
  canvas.height = imageElement.naturalHeight;

  if (context) {
    context.drawImage(imageElement, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Canvas conversion to Blob failed'));
        }
      });
    });
  }

  throw new Error('Canvas context is null');
};

export const copyImageToClipboard = async (source: HTMLImageElement) => {
  // do not await, so the Safari clipboard write happens in the context of the user gesture
  await navigator.clipboard.write([new ClipboardItem({ ['image/png']: imgToBlob(source) })]);
};

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.addEventListener('load', () => resolve(image), { once: true });
    image.addEventListener('error', () => reject(new Error('The image could not be loaded')), { once: true });
    image.src = src;
  });

/**
 * Copies an item's image to the clipboard without it being on screen, for the share sheet's
 * "Copy image" (FL-83 AL-31, `SharedLinks.jsx:598-604`). The preview is loaded inside the clipboard
 * item, so the write still starts within the user's click (Safari).
 */
export const copyAssetImageToClipboard = async (id: string) => {
  const blob = loadImage(getAssetMediaUrl({ id, size: AssetMediaSize.Preview })).then((image) => imgToBlob(image));
  await navigator.clipboard.write([new ClipboardItem({ ['image/png']: blob })]);
};

export const navigateToAsset = async (targetAsset: Pick<AssetResponseDto, 'id'> | undefined | null) => {
  if (!targetAsset) {
    return false;
  }

  await navigate({ targetRoute: 'current', assetId: targetAsset.id });
  return true;
};
