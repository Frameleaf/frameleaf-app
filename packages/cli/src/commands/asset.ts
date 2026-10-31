import {
  AssetBulkUploadCheckItem,
  AssetBulkUploadCheckResult,
  AssetMediaResponseDto,
  AssetMediaStatus,
  AssetUploadAction,
  AssetVisibility,
  Permission,
  addAssetsToAlbum,
  checkBulkUpload,
  createAlbum,
  defaults,
  getAllAlbums,
  getSupportedMediaTypes,
} from '@frameleaf/sdk';
import byteSize from 'byte-size';
import { Matcher, watch as watchFs } from 'chokidar';
import { MultiBar, Presets, SingleBar } from 'cli-progress';
import { chunk } from 'lodash-es';
import micromatch from 'micromatch';
import { Stats, createReadStream, readdirSync, statSync } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import path, { basename } from 'node:path';
import { Queue } from 'src/queue.js';
import { BaseOptions, Batcher, authenticate, crawl, hashFile, requirePermissions, s } from 'src/utils.js';

const UPLOAD_WATCH_BATCH_SIZE = 100;
const UPLOAD_WATCH_DEBOUNCE_TIME_MS = 10_000;

// TODO figure out why `id` is missing
type AssetBulkUploadCheckResults = Array<AssetBulkUploadCheckResult & { id: string }>;
type Asset = { id: string; filepath: string };

export interface UploadOptionsDto {
  recursive?: boolean;
  ignore?: string;
  dryRun?: boolean;
  skipHash?: boolean;
  delete?: boolean;
  deleteDuplicates?: boolean;
  album?: boolean;
  albumName?: string;
  visibility?: AssetVisibility;
  includeHidden?: boolean;
  concurrency: number;
  progress?: boolean;
  watch?: boolean;
  jsonOutput?: boolean;
}

class UploadFile extends File {
  constructor(
    private filepath: string,
    private _size: number,
  ) {
    super([], basename(filepath));
  }

  get size() {
    return this._size;
  }

  stream() {
    return createReadStream(this.filepath) as any;
  }
}

const uploadBatch = async (files: string[], options: UploadOptionsDto) => {
  const { newFiles, duplicates } = await checkForDuplicates(files, options);
  const newAssets = await uploadFiles(newFiles, options);
  if (options.jsonOutput) {
    console.log(JSON.stringify({ newFiles, duplicates, newAssets }, undefined, 4));
  }
  await updateAlbums([...newAssets, ...duplicates], options);

  await deleteFiles(newAssets, duplicates, options);
};

export const startWatch = async (
  paths: string[],
  options: UploadOptionsDto,
  {
    batchSize = UPLOAD_WATCH_BATCH_SIZE,
    debounceTimeMs = UPLOAD_WATCH_DEBOUNCE_TIME_MS,
  }: { batchSize?: number; debounceTimeMs?: number } = {},
) => {
  const watcherIgnored: Matcher[] = [];
  const { image, video } = await getSupportedMediaTypes();
  const extensions = new Set([...image, ...video]);

  if (options.ignore) {
    watcherIgnored.push((path) => micromatch.contains(path, `**/${options.ignore}`));
  }

  const pathsBatcher = new Batcher<string>({
    batchSize,
    debounceTimeMs,
    onBatch: async (paths: string[]) => {
      const uniquePaths = [...new Set(paths)];
      await uploadBatch(uniquePaths, options);
    },
  });

  const onFile = (path: string, stats?: Stats) => {
    if (stats?.isDirectory()) {
      return;
    }
    const ext = '.' + path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    if (!extensions.has(ext)) {
      return;
    }

    if (!options.progress) {
      // logging when progress is disabled as it can cause issues with the progress bar rendering
      console.log(`Change detected: ${path}`);
    }
    pathsBatcher.add(path);
  };
  const fsWatcher = watchFs(paths, {
    ignoreInitial: true,
    ignored: watcherIgnored,
    alwaysStat: true,
    awaitWriteFinish: true,
    depth: options.recursive ? undefined : 0,
    persistent: true,
  })
    .on('add', onFile)
    .on('change', onFile)
    .on('error', (error) => console.error(`Watcher error: ${error}`));

  process.on('SIGINT', async () => {
    console.log('Exiting...');
    await fsWatcher.close();
    process.exit();
  });
};

export const upload = async (paths: string[], baseOptions: BaseOptions, options: UploadOptionsDto) => {
  await authenticate(baseOptions);
  await requirePermissions([Permission.AssetUpload]);

  const scanFiles = await scan(paths, options);

  if (scanFiles.length === 0) {
    if (options.watch) {
      console.log('No files found initially.');
    } else {
      console.log('No files found, exiting');
      return;
    }
  }

  if (options.watch) {
    console.log('Watching for changes...');
    await startWatch(paths, options);
    // watcher does not handle the initial scan
    // as the scan() is a more efficient quick start with batched results
  }

  await uploadBatch(scanFiles, options);
};

const scan = async (pathsToCrawl: string[], options: UploadOptionsDto) => {
  const { image, video } = await getSupportedMediaTypes();

  console.log('Crawling for assets...');
  const files = await crawl({
    pathsToCrawl,
    recursive: options.recursive,
    exclusionPattern: options.ignore,
    includeHidden: options.includeHidden,
    extensions: [...image, ...video],
  });

  return files;
};

export const checkForDuplicates = async (files: string[], { concurrency, skipHash, progress }: UploadOptionsDto) => {
  if (skipHash) {
    console.log('Skipping hash check, assuming all files are new');
    return { newFiles: files, duplicates: [] };
  }

  let multiBar: MultiBar | undefined;
  const onInterrupt = () => {
    multiBar?.stop();
    process.exit(0);
  };
  let totalSize = 0;
  const statsMap = new Map<string, Stats>();

  // Calculate total size first
  for (const batch of chunk(files, concurrency)) {
    const stats = await Promise.all(batch.map((filepath) => stat(filepath)));
    for (const [index, filepath] of batch.entries()) {
      statsMap.set(filepath, stats[index]);
      totalSize += stats[index].size;
    }
  }

  try {
    if (progress) {
      multiBar = new MultiBar(
        {
          format: '{message} | {bar} | {percentage}% | ETA: {eta_formatted} | {value}/{total}',
          formatValue: (v: number, options, type) => {
            // Don't format percentage
            if (type === 'percentage') {
              return v.toString();
            }
            return byteSize(v).toString();
          },
          etaBuffer: 100, // Increase samples for ETA calculation
        },
        Presets.shades_classic,
      );

      // Ensure we restore cursor on interrupt
      process.once('SIGINT', onInterrupt);
    } else {
      console.log(`Received ${files.length} files (${byteSize(totalSize)}), hashing...`);
    }

    const hashProgressBar = multiBar?.create(totalSize, 0, {
      message: 'Hashing files          ',
    });
    const checkProgressBar = multiBar?.create(totalSize, 0, {
      message: 'Checking for duplicates',
    });

    const newFiles: string[] = [];
    const duplicates: Asset[] = [];

    const checkBulkUploadQueue = new Queue<AssetBulkUploadCheckItem[], void>(
      async (assets: AssetBulkUploadCheckItem[]) => {
        const response = await checkBulkUpload({ assetBulkUploadCheckDto: { assets } });

        const results = response.results as AssetBulkUploadCheckResults;

        // Every file is submitted once per digest (see below), so results are
        // aggregated by `id` (the file path): a reject on any digest means the
        // server already has the file.
        const checkedFiles = new Set<string>();
        const duplicateAssetIds = new Map<string, string>();
        for (const { id: filepath, assetId, action } of results) {
          checkedFiles.add(filepath);
          if (action !== AssetUploadAction.Accept) {
            // rejects are always duplicates
            duplicateAssetIds.set(filepath, assetId as string);
          }
        }

        // Update progress based on total size of processed files
        let processedSize = 0;
        for (const filepath of checkedFiles) {
          const duplicateAssetId = duplicateAssetIds.get(filepath);
          if (duplicateAssetId === undefined) {
            newFiles.push(filepath);
          } else {
            duplicates.push({ id: duplicateAssetId, filepath });
          }

          const stats = statsMap.get(filepath);
          processedSize += stats?.size || 0;
        }
        checkProgressBar?.increment(processedSize);
      },
      { concurrency, retry: 3 },
    );

    let checkBulkUploadRequests: AssetBulkUploadCheckItem[] = [];

    const queue = new Queue<string, void>(
      async (filepath: string) => {
        const stats = statsMap.get(filepath);
        if (!stats) {
          throw new Error(`Stats not found for ${filepath}`);
        }
        // The server persists SHA-256 for assets uploaded after the SHA-256
        // transition and SHA-1 for legacy rows, and matches the supplied digest
        // byte-for-byte. Submit both digests for each file so duplicates are found
        // against either kind of row; the two items share the same `id` and are
        // always sent in the same batch, so the check queue can aggregate them.
        const { sha1, sha256 } = await hashFile(filepath);
        const dtos = [
          { id: filepath, checksum: sha256 },
          { id: filepath, checksum: sha1 },
        ];

        checkBulkUploadRequests.push(...dtos);
        if (checkBulkUploadRequests.length >= 5000) {
          const batch = checkBulkUploadRequests;
          checkBulkUploadRequests = [];
          void checkBulkUploadQueue.push(batch);
        }

        hashProgressBar?.increment(stats.size);
      },
      { concurrency, retry: 3 },
    );

    for (const item of files) {
      void queue.push(item);
    }

    await queue.drained();

    if (checkBulkUploadRequests.length > 0) {
      void checkBulkUploadQueue.push(checkBulkUploadRequests);
    }

    await checkBulkUploadQueue.drained();

    multiBar?.stop();
    multiBar = undefined;

    console.log(`Found ${newFiles.length} new files and ${duplicates.length} duplicate${s(duplicates.length)}`);

    // Report failures
    const failedTasks = queue.tasks.filter((task) => task.status === 'failed');
    if (failedTasks.length > 0) {
      console.log(`Failed to verify ${failedTasks.length} file${s(failedTasks.length)}:`);
      for (const task of failedTasks) {
        console.log(`- ${task.data} - ${task.error}`);
      }
    }
    // A failed duplicate-check batch leaves its files neither new nor duplicate, so they are skipped.
    const failedChecks = checkBulkUploadQueue.tasks.filter((task) => task.status === 'failed');
    if (failedChecks.length > 0) {
      const failedFiles = new Set(failedChecks.flatMap((task) => task.data.map(({ id }) => id)));
      console.log(`Failed to check ${failedFiles.size} file${s(failedFiles.size)} for duplicates:`);
      for (const task of failedChecks) {
        for (const filepath of new Set(task.data.map(({ id }) => id))) {
          console.log(`- ${filepath} - ${task.error}`);
        }
      }
    }
    if (failedTasks.length > 0 || failedChecks.length > 0) {
      process.exitCode = 1;
    }

    return { newFiles, duplicates };
  } finally {
    process.off('SIGINT', onInterrupt);
    multiBar?.stop();
  }
};

export const uploadFiles = async (files: string[], options: UploadOptionsDto): Promise<Asset[]> => {
  const { dryRun, concurrency, progress } = options;
  if (files.length === 0) {
    console.log('All assets were already uploaded, nothing to do.');
    return [];
  }

  // Compute total size first
  let totalSize = 0;
  const statsMap = new Map<string, Stats>();
  for (const batch of chunk(files, concurrency)) {
    const stats = await Promise.all(batch.map((filepath) => stat(filepath)));
    for (const [index, filepath] of batch.entries()) {
      statsMap.set(filepath, stats[index]);
      totalSize += stats[index].size;
    }
  }

  if (dryRun) {
    console.log(`Would have uploaded ${files.length} asset${s(files.length)} (${byteSize(totalSize)})`);
    return files.map((filepath) => ({ id: '', filepath }));
  }

  let uploadProgress: SingleBar | undefined;

  if (progress) {
    uploadProgress = new SingleBar(
      {
        format: 'Uploading assets | {bar} | {percentage}% | ETA: {eta_formatted} | {value_formatted}/{total_formatted}',
      },
      Presets.shades_classic,
    );
  } else {
    console.log(`Uploading ${files.length} asset${s(files.length)} (${byteSize(totalSize)})`);
  }
  uploadProgress?.start(totalSize, 0);
  uploadProgress?.update({ value_formatted: 0, total_formatted: byteSize(totalSize) });

  let duplicateCount = 0;
  let duplicateSize = 0;
  let successCount = 0;
  let successSize = 0;

  const newAssets: Asset[] = [];

  const queue = new Queue<string, AssetMediaResponseDto>(
    async (filepath: string) => {
      const stats = statsMap.get(filepath);
      if (!stats) {
        throw new Error(`Stats not found for ${filepath}`);
      }

      const response = await uploadFile(filepath, stats, options);
      newAssets.push({ id: response.id, filepath });
      if (response.status === AssetMediaStatus.Duplicate) {
        duplicateCount++;
        duplicateSize += stats.size ?? 0;
      } else {
        successCount++;
        successSize += stats.size ?? 0;
      }

      uploadProgress?.update(successSize + duplicateSize, { value_formatted: byteSize(successSize + duplicateSize) });

      return response;
    },
    { concurrency, retry: 3 },
  );

  for (const item of files) {
    void queue.push(item);
  }

  await queue.drained();

  uploadProgress?.stop();

  console.log(`Successfully uploaded ${successCount} new asset${s(successCount)} (${byteSize(successSize)})`);
  if (duplicateCount > 0) {
    console.log(`Skipped ${duplicateCount} duplicate asset${s(duplicateCount)} (${byteSize(duplicateSize)})`);
  }

  // Report failures
  const failedTasks = queue.tasks.filter((task) => task.status === 'failed');
  if (failedTasks.length > 0) {
    console.log(`Failed to upload ${failedTasks.length} asset${s(failedTasks.length)}:`);
    for (const task of failedTasks) {
      console.log(`- ${task.data} - ${task.error}`);
    }
  }

  return newAssets;
};

const uploadFile = async (
  input: string,
  stats: Stats,
  { visibility }: UploadOptionsDto,
): Promise<AssetMediaResponseDto> => {
  const { baseUrl, headers } = defaults;

  const formData = new FormData();
  const modifiedAt = stats.mtime.toISOString();
  formData.append('fileCreatedAt', modifiedAt);
  formData.append('fileModifiedAt', modifiedAt);
  formData.append('fileSize', String(stats.size));
  formData.append('isFavorite', 'false');
  formData.append('assetData', new UploadFile(input, stats.size));
  if (visibility) {
    formData.append('visibility', visibility);
  }

  const sidecarPath = findSidecar(input);
  if (sidecarPath) {
    try {
      const stats = await stat(sidecarPath);
      const sidecarData = new UploadFile(sidecarPath, stats.size);
      formData.append('sidecarData', sidecarData);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw error;
      }
    }
  }

  const response = await fetch(`${baseUrl}/assets`, {
    method: 'post',
    redirect: 'error',
    headers: headers as Record<string, string>,
    body: formData,
    // eslint-disable-next-line unicorn/no-null
    window: null,
  });
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(await response.text());
  }

  return response.json() as Promise<AssetMediaResponseDto>;
};

export const findSidecar = (filepath: string): string | undefined => {
  const assetPath = path.parse(filepath);
  const noExtension = path.join(assetPath.dir, assetPath.name);

  // XMP sidecars can come in two filename formats. For a photo named photo.ext, the filenames are photo.ext.xmp and photo.xmp
  for (const sidecarPath of [`${noExtension}.xmp`, `${filepath}.xmp`]) {
    try {
      statSync(sidecarPath);
      return sidecarPath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
        throw error;
      }
    }
  }
};

// A sidecar named photo.xmp is shared by every original with the stem `photo`; keep it while one stays on disk.
// Paths are lower-cased so a case-only difference counts as "in use": on a case-insensitive filesystem it is the
// same file, and on a case-sensitive one the worst case is keeping a sidecar that could have been removed.
const sidecarsInUse = (dir: string, selected: Set<string>): Set<string> => {
  const inUse = new Set<string>();
  for (const entry of readdirSync(dir)) {
    const filepath = path.join(dir, entry);
    if (selected.has(filepath) || path.extname(entry).toLowerCase() === '.xmp') {
      continue;
    }
    inUse.add(path.join(dir, `${path.parse(entry).name}.xmp`).toLowerCase());
    inUse.add(`${filepath}.xmp`.toLowerCase());
  }
  return inUse;
};

export const deleteFiles = async (uploaded: Asset[], duplicates: Asset[], options: UploadOptionsDto): Promise<void> => {
  const files = new Set(
    [...(options.delete ? uploaded : []), ...(options.deleteDuplicates ? duplicates : [])].map(
      ({ filepath }) => filepath,
    ),
  );
  const fileCount = files.size;

  if (options.dryRun) {
    console.log(`Would have deleted ${fileCount} local asset${s(fileCount)}`);
    return;
  }

  if (fileCount === 0) {
    return;
  }

  console.log('Deleting assets that have been uploaded...');
  const deletionProgress = new SingleBar(
    { format: 'Deleting local assets | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} assets' },
    Presets.shades_classic,
  );
  deletionProgress.start(fileCount, 0);

  try {
    const sidecars = new Set<string>();
    const selected = new Set(files.values().map((filepath) => path.resolve(filepath)));
    // Each directory is listed once, however many selected files it holds.
    const inUseByDir = new Map<string, Set<string>>();
    for (const filepath of files) {
      const sidecar = findSidecar(filepath);
      if (!sidecar || files.has(sidecar)) {
        continue;
      }
      const sidecarPath = path.resolve(sidecar);
      const dir = path.dirname(sidecarPath);
      let inUse = inUseByDir.get(dir);
      if (!inUse) {
        inUse = sidecarsInUse(dir, selected);
        inUseByDir.set(dir, inUse);
      }
      if (!inUse.has(sidecarPath.toLowerCase())) {
        sidecars.add(sidecar);
      }
    }
    for (const batch of chunk(files.values().toArray(), options.concurrency)) {
      await Promise.all(batch.map((filepath) => unlink(filepath)));
      deletionProgress.increment(batch.length);
    }
    // Shared sidecars are removed once, after all selected originals were removed.
    for (const batch of chunk(sidecars.values().toArray(), options.concurrency)) {
      await Promise.all(batch.map((filepath) => unlink(filepath)));
    }
  } finally {
    deletionProgress.stop();
  }
};

export const updateAlbums = async (assets: Asset[], options: UploadOptionsDto) => {
  if (!options.album && !options.albumName) {
    return;
  }
  const { dryRun, concurrency } = options;

  const albums = await getAllAlbums({});
  const existingAlbums = new Map(albums.map((album) => [album.albumName, album.id]));
  const assetsByName = new Map<string, string[]>();
  for (const { filepath, id } of assets) {
    const name = getAlbumName(filepath, options);
    if (name) {
      const ids = assetsByName.get(name);
      if (ids) {
        ids.push(id);
      } else {
        assetsByName.set(name, [id]);
      }
    }
  }
  const newAlbums = assetsByName
    .keys()
    .filter((name) => !existingAlbums.has(name))
    .toArray();

  if (dryRun) {
    // TODO print asset counts for new albums
    console.log(`Would have created ${newAlbums.length} new album${s(newAlbums.length)}`);
    console.log(`Would have updated albums of ${assets.length} asset${s(assets.length)}`);
    return;
  }

  const progressBar = new SingleBar(
    { format: 'Creating albums | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} albums' },
    Presets.shades_classic,
  );
  progressBar.start(newAlbums.length, 0);

  try {
    for (const albumNames of chunk(newAlbums, concurrency)) {
      const items = await Promise.all(
        albumNames.map((albumName: string) => createAlbum({ createAlbumDto: { albumName } })),
      );
      for (const { id, albumName } of items) {
        existingAlbums.set(albumName, id);
      }
      progressBar.increment(albumNames.length);
    }
  } finally {
    progressBar.stop();
  }

  console.log(`Successfully created ${newAlbums.length} new album${s(newAlbums.length)}`);
  console.log(`Successfully updated ${assets.length} asset${s(assets.length)}`);

  const albumToAssets = new Map<string, string[]>();
  for (const [name, ids] of assetsByName) {
    const albumId = existingAlbums.get(name);
    if (albumId) {
      const existing = albumToAssets.get(albumId);
      if (existing) {
        for (const id of ids) {
          existing.push(id);
        }
      } else {
        albumToAssets.set(albumId, ids);
      }
    }
  }

  const albumUpdateProgress = new SingleBar(
    { format: 'Adding assets to albums | {bar} | {percentage}% | ETA: {eta}s | {value}/{total} assets' },
    Presets.shades_classic,
  );
  albumUpdateProgress.start(assets.length, 0);

  try {
    for (const [albumId, assets] of albumToAssets) {
      for (const assetBatch of chunk(assets, Math.min(1000 * concurrency, 65_000))) {
        await addAssetsToAlbum({ id: albumId, bulkIdsDto: { ids: assetBatch } });
        albumUpdateProgress.increment(assetBatch.length);
      }
    }
  } finally {
    albumUpdateProgress.stop();
  }
};

// `filepath` valid format:
// - Windows: `D:\\test\\Filename.txt` or `D:/test/Filename.txt`
// - Unix: `/test/Filename.txt`
export const getAlbumName = (filepath: string, options: UploadOptionsDto) => {
  return options.albumName ?? path.basename(path.dirname(filepath));
};
