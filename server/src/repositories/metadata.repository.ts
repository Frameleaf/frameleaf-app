import { Injectable } from '@nestjs/common';
import { BinaryField, DefaultReadTaskOptions, ExifTool, ExifToolTask, ReadTaskOptions, Tags } from 'exiftool-vendored';
import geotz from 'geo-tz';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath, rm, stat, utimes } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { LOCATION_DELETE_ARGS, LOCATION_TAG_SELECTORS, SAMSUNG_TRAILER_DELETE_ARGS } from 'src/utils/location-tags.js';
import { mimeTypes } from 'src/utils/mime-types.js';

interface ExifDuration {
  Value: number;
  Scale?: number;
}

type StringOrNumber = string | number;

type TagsWithWrongTypes =
  | 'FocalLength'
  | 'Duration'
  | 'Description'
  | 'ImageDescription'
  | 'RegionInfo'
  | 'TagsList'
  | 'Keywords'
  | 'HierarchicalSubject'
  | 'ISO'
  | 'LensModel';

export interface ImmichTags extends Omit<Tags, TagsWithWrongTypes> {
  ContentIdentifier?: string;
  MotionPhoto?: number;
  MotionPhotoVersion?: number;
  MotionPhotoPresentationTimestampUs?: number;
  MediaGroupUUID?: string;
  ImagePixelDepth?: string;
  FocalLength?: number;
  Duration?: number | string | ExifDuration;
  EmbeddedVideoType?: string;
  EmbeddedVideoFile?: BinaryField;
  MotionPhotoVideo?: BinaryField;
  TagsList?: StringOrNumber[];
  HierarchicalSubject?: StringOrNumber[];
  Keywords?: StringOrNumber | StringOrNumber[];
  ISO?: number | number[];

  // Type is wrong, can also be number.
  Description?: StringOrNumber;
  ImageDescription?: StringOrNumber;

  // Apparently LensModel can also be a float: https://github.com/immich-app/immich/issues/30492
  LensModel?: StringOrNumber;

  // Extended properties for image regions, such as faces
  RegionInfo?: {
    AppliedToDimensions: {
      W: number;
      H: number;
      Unit: string;
    };
    RegionList: {
      Area: {
        // (X,Y) // center of the rectangle
        X: number | string;
        Y: number | string;
        W: number | string;
        H: number | string;
        Unit: string;
      };
      Rotation?: number;
      Type?: string;
      Name?: string;
    }[];
  };

  Device?: {
    Manufacturer?: string;
    ModelName?: string;
  };

  AndroidMake?: string;
  AndroidModel?: string;
  DeviceManufacturer?: string;
  DeviceModelName?: string;
}

const LOCATION_READ_ARGS = [
  '-api',
  'largefilesupport=1',
  '-a',
  // family 4 numbers duplicates (`ExifTool:Copy1:Warning`) so no warning is lost to a repeated JSON key
  '-G1:4',
  '-ee',
  ...LOCATION_TAG_SELECTORS,
  '-ExifTool:Error',
  '-ExifTool:Warning',
];
const LOCATION_READ_IGNORED_KEYS = new Set(['SourceFile', 'errors', 'warnings']);
/** how long an unused location-free copy is kept, so a player's range requests reuse one copy */
const LOCATION_FREE_TTL_MS = 10 * 60 * 1000;
/** a lease held this long is treated as lost; an untouched copy this old is swept from disk */
const LOCATION_FREE_STALE_MS = 6 * 60 * 60 * 1000;
const LOCATION_FREE_SWEEP_MS = 60 * 60 * 1000;
/**
 * Removing a location rewrites the whole file, so a large video needs far longer than a metadata read;
 * these tasks get their own small exiftool pool with a long timeout. A strip that still times out is
 * refused (fail closed), never served.
 */
const LOCATION_TASK_TIMEOUT_MS = 30 * 60 * 1000;
const LOCATION_TASK_MAX_PROCS = 2;

export type LocationInspection = {
  /** location tags found, `group:name` */
  locationTags: string[];
  /** read errors and non-minor warnings: exiftool may have stopped before reaching a location */
  problems: string[];
  /** the file carries a Samsung trailer, which can only be removed as a whole */
  samsungTrailer: boolean;
};

const isLocationFree = ({ locationTags, problems }: LocationInspection) =>
  locationTags.length === 0 && problems.length === 0;

class RemoveLocationTask extends ExifToolTask<void> {
  static for(source: string, destination: string, { removeSamsungTrailer }: { removeSamsungTrailer: boolean }) {
    return new RemoveLocationTask([
      '-charset',
      'filename=utf8',
      '-api',
      'largefilesupport=1',
      ...LOCATION_DELETE_ARGS,
      ...(removeSamsungTrailer ? SAMSUNG_TRAILER_DELETE_ARGS : []),
      '-o',
      resolve(destination),
      resolve(source),
    ]);
  }

  protected parse(data: string, error?: Error): void {
    // exiftool reports minor problems on stderr as warnings; only a real error aborts the copy
    if (error && /\berror\b/i.test(String(error)) && !/\bwarning\b/i.test(String(error))) {
      throw error;
    }

    // "copied" means nothing needed changing; the re-read decides whether the copy may be served
    if (!/\b1 image files? (created|copied)\b/i.test(data)) {
      throw new Error(`exiftool did not write a location-free copy: ${data.trim() || String(error)}`);
    }
  }
}

export type LocationFreeLease = {
  /** the file to serve: the original itself when it carries no location, otherwise a stripped copy */
  path: string;
  /** call once the file has been sent; the copy is removed after it has been idle for a while */
  release: () => void;
};

type LocationFreeEntry = {
  ready: Promise<{ path: string; isCopy: boolean }>;
  refs: number;
  lastUsed: number;
  /** set once `ready` has resolved */
  result?: { path: string; isCopy: boolean };
  timer?: NodeJS.Timeout;
};

@Injectable()
export class MetadataRepository {
  private exiftool = new ExifTool({
    defaultVideosToUTC: true,
    backfillTimezones: true,
    inferTimezoneFromDatestamps: true,
    inferTimezoneFromTimeStamp: true,
    useMWG: true,
    numericTags: [...DefaultReadTaskOptions.numericTags, 'FocalLength', 'FileSize', 'Rotation'],
    /* eslint unicorn/no-array-callback-reference: off, unicorn/no-array-method-this-argument: off */
    // eslint-disable-next-line import-x/no-named-as-default-member
    geoTz: (lat, lon) => geotz.find(lat, lon)[0],
    geolocation: true,
    readArgs: [
      // Enable exiftool LFS to parse metadata for files larger than 2GB.
      '-api',
      'largefilesupport=1',
      '--ICC_Profile:DeviceManufacturer',
      '--ICC_Profile:DeviceModelName',
      // Ignore embedded thumbnail dimensions/orientation for the main asset.
      '--IFD1:Orientation',
      '--MWG:Orientation',
      '--IFD1:ImageWidth',
      '--IFD1:ImageHeight',
    ],
    writeArgs: ['-api', 'largefilesupport=1', '-overwrite_original'],
    taskTimeoutMillis: 2 * 60 * 1000,
  });

  constructor(private logger: LoggingRepository) {
    this.logger.setContext(MetadataRepository.name);
  }

  setMaxConcurrency(concurrency: number) {
    this.exiftool.batchCluster.setMaxProcs(concurrency);
  }

  /** FL-54: a separate pool, so a long strip neither times out at 2 minutes nor blocks metadata reads */
  private locationTool = new ExifTool({
    maxProcs: LOCATION_TASK_MAX_PROCS,
    taskTimeoutMillis: LOCATION_TASK_TIMEOUT_MS,
    // batch-cluster requires a process to be allowed to live at least as long as one task
    maxProcAgeMillis: 2 * LOCATION_TASK_TIMEOUT_MS,
    geolocation: false,
  });
  private locationFree = new Map<string, LocationFreeEntry>();
  private locationFreeSweep?: NodeJS.Timeout;
  private locationFreeDirProblemReported = false;

  async teardown() {
    clearInterval(this.locationFreeSweep);
    this.locationFreeSweep = undefined;
    for (const [key, entry] of this.locationFree) {
      await this.evictLocationFree(key, entry);
    }
    await Promise.all([this.exiftool.end(), this.locationTool.end()]);
  }

  readTags(path: string): Promise<ImmichTags> {
    const options: ReadTaskOptions | undefined = mimeTypes.isVideo(path) ? { readArgs: ['-ee'] } : undefined;

    return this.exiftool.read(path, options).catch((error) => {
      this.logger.warn(`Error reading exif data (${path}): ${error}\n${error?.stack}`);
      return {};
    }) as Promise<ImmichTags>;
  }

  extractBinaryTag(path: string, tagName: string): Promise<Buffer> {
    return this.exiftool.extractBinaryTagToBuffer(tagName, path);
  }

  async writeTags(path: string, tags: Partial<Tags>): Promise<void> {
    // If exiftool assigns a field with ^= instead of =, empty values will be written too.
    // Since exiftool-vendored doesn't support an option for this, we append the ^ to the name of the tag instead.
    // https://exiftool.org/exiftool_pod.html#:~:text=is%20used%20to%20write%20an%20empty%20string
    const tagsToWrite = Object.fromEntries(Object.entries(tags).map(([key, value]) => [`${key}^`, value]));
    try {
      await this.exiftool.write(path, tagsToWrite);
    } catch (error) {
      this.logger.warn(`Error writing exif data (${path}): ${error}`);
    }
  }

  /**
   * FL-54: what exiftool finds in `path` that could place it. Throws when the file cannot be read at all.
   * A `[minor]` warning is exiftool noting something it skipped and carrying on; any other warning or an
   * error means it may have stopped early, so the file is not vouched for.
   */
  async inspectLocation(path: string): Promise<LocationInspection> {
    const tags = await this.locationTool.readRaw(path, { readArgs: LOCATION_READ_ARGS, useMWG: false });
    const inspection: LocationInspection = { locationTags: [], problems: [], samsungTrailer: false };

    for (const [key, value] of Object.entries(tags)) {
      if (LOCATION_READ_IGNORED_KEYS.has(key)) {
        continue;
      }

      const group = key.split(':', 1)[0];
      if (group === 'ExifTool') {
        const minor = key.endsWith(':Warning') && /^\[minor\]/i.test(String(value));
        if (!minor) {
          inspection.problems.push(`${key}: ${String(value)}`);
        }
        continue;
      }

      if (group === 'Samsung') {
        inspection.samsungTrailer = true;
      }
      inspection.locationTags.push(key);
    }

    for (const error of (tags as { errors?: unknown[] }).errors ?? []) {
      inspection.problems.push(String(error));
    }

    return inspection;
  }

  /** Writes a copy of `source` to `destination` without any location tag; `source` is never modified. */
  async writeLocationFreeCopy(
    source: string,
    destination: string,
    { removeSamsungTrailer = false }: { removeSamsungTrailer?: boolean } = {},
  ): Promise<void> {
    await this.locationTool.enqueueTask(
      () => RemoveLocationTask.for(source, destination, { removeSamsungTrailer }),
      false,
    );
  }

  /**
   * FL-54: hands out a file with the same bytes as `source` minus its embedded location. A source exiftool
   * reads in full and finds no location in is returned as is; otherwise a verified copy is made once and
   * shared by every caller until it has been idle for `LOCATION_FREE_TTL_MS`. Rejects (fails closed) when
   * exiftool cannot read the file, cannot write the copy, or cannot vouch for the copy. The re-read uses
   * this same exiftool build, an accepted limitation recorded in the conformance audit.
   */
  async acquireLocationFreeOriginal(source: string): Promise<LocationFreeLease> {
    const { mtimeMs, size } = await stat(source);
    const key = `${source}\0${mtimeMs}\0${size}`;

    let entry = this.locationFree.get(key);
    if (!entry) {
      const created: LocationFreeEntry = { ready: this.createLocationFreeCopy(source), refs: 0, lastUsed: Date.now() };
      created.ready
        .then((result) => {
          created.result = result;
        })
        .catch(() => {
          if (this.locationFree.get(key) === created) {
            this.locationFree.delete(key);
          }
        });
      this.locationFree.set(key, created);
      entry = created;
    }

    const current = entry;
    current.refs++;
    current.lastUsed = Date.now();
    clearTimeout(current.timer);

    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      current.refs--;
      if (current.refs === 0 && this.locationFree.get(key) === current) {
        current.timer = setTimeout(
          () => this.runInBackground('evict', this.evictLocationFree(key, current)),
          LOCATION_FREE_TTL_MS,
        );
        current.timer.unref?.();
      }
    };

    try {
      const { path, isCopy } = await current.ready;
      if (isCopy) {
        // keep a copy in use looking fresh to the stale sweep
        const now = new Date();
        await utimes(path, now, now).catch(() => {});
      }
      return { path, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async createLocationFreeCopy(source: string): Promise<{ path: string; isCopy: boolean }> {
    const found = await this.inspectLocation(source);
    if (isLocationFree(found)) {
      return { path: source, isCopy: false };
    }

    const directory = await this.prepareLocationFreeDir();
    const destination = join(directory, `${randomUUID()}${extname(source)}`);
    try {
      await this.writeLocationFreeCopy(source, destination, { removeSamsungTrailer: found.samsungTrailer });
      const remaining = await this.inspectLocation(destination);
      if (!isLocationFree(remaining)) {
        throw new Error(
          `Location tags or unreadable data remain after removal: ${[...remaining.locationTags, ...remaining.problems].join(', ')}`,
        );
      }
      return { path: destination, isCopy: true };
    } catch (error) {
      await this.removeCopy(destination);
      this.logger.warn(`Unable to remove the location from ${source}: ${error}`);
      throw error;
    }
  }

  /**
   * `<media>/tmp/location-free`, created 0700 and checked on every use: a real directory (not a link),
   * owned by this process's user, mode 0700, and resolving inside the media location. Anything else is
   * refused, so copies never land somewhere another user can read or redirect.
   */
  private async prepareLocationFreeDir(): Promise<string> {
    const mediaLocation = StorageCore.getMediaLocation();
    const directory = join(mediaLocation, 'tmp', 'location-free');

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });

      const info = await lstat(directory);
      const uid = process.getuid?.();
      const expected = join(await realpath(mediaLocation), 'tmp', 'location-free');
      const problems = [
        !info.isDirectory() && 'it is not a real directory',
        uid !== undefined && info.uid !== uid && `it is owned by uid ${info.uid}, not the server's uid ${uid}`,
        (info.mode & 0o777) !== 0o700 && `its mode is ${(info.mode & 0o777).toString(8)}, not 700`,
        (await realpath(directory)) !== expected && `it resolves outside ${expected}`,
      ].filter(Boolean);
      if (problems.length > 0) {
        throw new Error(`not a private directory: ${problems.join('; ')}`);
      }
    } catch (error) {
      this.reportLocationFreeDirProblem(directory, error);
      throw new Error(`Refusing to use ${directory} for location-free copies: ${error}`, { cause: error });
    }
    this.locationFreeDirProblemReported = false;

    if (!this.locationFreeSweep) {
      this.locationFreeSweep = setInterval(
        () => this.runInBackground('sweep', this.sweepLocationFree(directory)),
        LOCATION_FREE_SWEEP_MS,
      );
      this.locationFreeSweep.unref?.();
      this.runInBackground('sweep', this.sweepLocationFree(directory));
    }

    return directory;
  }

  /**
   * FL-54 review item 6: every download that needs a location-free copy is refused while the directory is
   * unusable, which on a network mount (NFS/SMB mapping ownership or permissions) can be permanent. Say so
   * once, loudly and with what to change, rather than a warning per request.
   */
  private reportLocationFreeDirProblem(directory: string, error: unknown) {
    if (this.locationFreeDirProblemReported) {
      return;
    }
    this.locationFreeDirProblemReported = true;
    this.logger.error(
      `Location-free copies cannot be made in ${directory} (${error}). Until this is fixed, downloads and ` +
        `video playback of originals for partners who may not see an owner's locations are refused. The ` +
        `directory must be a local directory owned by the user the server runs as, with mode 700; network ` +
        `mounts that remap ownership or permissions fail this check. Fix its owner and mode, or mount the ` +
        `media location's tmp folder on a local volume.`,
    );
  }

  /** a background clean-up must never take the server down: log and carry on */
  private runInBackground(task: string, work: Promise<unknown>) {
    work.catch((error) => this.logger.error(`Location-free copy ${task} failed: ${error}`));
  }

  private async removeCopy(path: string) {
    try {
      await rm(path, { force: true });
    } catch (error) {
      this.logger.error(`Unable to remove location-free copy ${path}: ${error}`);
    }
  }

  /**
   * Runs hourly: drops leases nobody released for `LOCATION_FREE_STALE_MS` (a lost response) and removes
   * copies no entry of this process uses that have not been touched for as long (another process's leftovers
   * or a crash).
   */
  async sweepLocationFree(directory: string) {
    const now = Date.now();
    const active = new Set<string>();
    for (const [key, entry] of this.locationFree) {
      if (now - entry.lastUsed > LOCATION_FREE_STALE_MS) {
        await this.evictLocationFree(key, entry);
        continue;
      }
      if (entry.result?.isCopy) {
        active.add(entry.result.path);
      }
    }

    for (const name of await readdir(directory).catch(() => [] as string[])) {
      const path = join(directory, name);
      const info = await lstat(path).catch(() => null);
      if (info && !active.has(path) && now - info.mtimeMs > LOCATION_FREE_STALE_MS) {
        await this.removeCopy(path);
      }
    }
  }

  private async evictLocationFree(key: string, entry: LocationFreeEntry) {
    clearTimeout(entry.timer);
    if (this.locationFree.get(key) === entry) {
      this.locationFree.delete(key);
    }

    const ready = await entry.ready.catch(() => null);
    if (ready?.isCopy) {
      await this.removeCopy(ready.path);
    }
  }
}
