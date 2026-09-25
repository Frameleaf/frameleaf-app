import { Injectable } from '@nestjs/common';
import { BinaryField, DefaultReadTaskOptions, ExifTool, ExifToolTask, ReadTaskOptions, Tags } from 'exiftool-vendored';
import geotz from 'geo-tz';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
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

/**
 * FL-54: every tag that places a file. exiftool's family-2 `Location` group holds coordinates and place
 * names (EXIF GPS IFD, XMP `exif:GPS*`, IPTC and XMP place names, QuickTime `UserData`/`Keys`
 * GPSCoordinates); the whole `GPS` group and any tag named `GPS*` or `Location*` (e.g. Apple's
 * `Keys:LocationAccuracyHorizontal`, GPS time stamps, `XMP-iptcExt:LocationShown`) go with it.
 * `-ee` also reads timed GPS tracks and embedded images (MPF, motion-photo trailers) that no write can
 * reach, so a copy that still reports any of them is refused rather than served.
 */
const LOCATION_TAGS = ['-location:all', '-gps:all', '-gps*', '-location*'];
const LOCATION_READ_ARGS = [
  '-api',
  'largefilesupport=1',
  '-a',
  '-G1',
  '-ee',
  ...LOCATION_TAGS,
  '-ExifTool:Error',
  '-ExifTool:Warning',
];
const LOCATION_READ_IGNORED_KEYS = new Set(['SourceFile', 'errors', 'warnings']);
/**
 * A source with a read warning (e.g. a JPEG format error) is never trusted as location-free, since
 * exiftool may have stopped before its location; the copy may keep a benign warning, but not an error.
 */
const LOCATION_COPY_ACCEPTED_KEYS = new Set(['ExifTool:Warning']);
/** how long an unused location-free copy is kept, so a player's range requests reuse one copy */
const LOCATION_FREE_TTL_MS = 10 * 60 * 1000;
/** copies left behind by a crashed process are swept once they are this old */
const LOCATION_FREE_STALE_MS = 24 * 60 * 60 * 1000;

class RemoveLocationTask extends ExifToolTask<void> {
  static for(source: string, destination: string) {
    return new RemoveLocationTask([
      '-charset',
      'filename=utf8',
      '-api',
      'largefilesupport=1',
      ...LOCATION_TAGS.map((tag) => `${tag}=`),
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

    if (!/\b1 image files? created\b/i.test(data)) {
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
  ready: Promise<string>;
  refs: number;
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

  private locationFree = new Map<string, LocationFreeEntry>();
  private locationFreeDir = join(tmpdir(), 'immich-location-free');
  private locationFreeSwept = false;

  async teardown() {
    for (const [key, entry] of this.locationFree) {
      await this.evictLocationFree(key, entry);
    }
    await this.exiftool.end();
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
   * Names of the location tags exiftool finds in `path`, plus `ExifTool:Error`/`ExifTool:Warning` when it
   * could not read the whole file. Empty means location-free. Throws when the file cannot be read at all.
   */
  async readLocationTags(path: string): Promise<string[]> {
    const tags = await this.exiftool.readRaw(path, { readArgs: LOCATION_READ_ARGS, useMWG: false });
    return Object.keys(tags).filter((key) => !LOCATION_READ_IGNORED_KEYS.has(key));
  }

  /** Writes a copy of `source` to `destination` without any location tag; `source` is never modified. */
  async writeLocationFreeCopy(source: string, destination: string): Promise<void> {
    await this.exiftool.enqueueTask(() => RemoveLocationTask.for(source, destination), false);
  }

  /**
   * FL-54: hands out a file with the same bytes as `source` minus its embedded location. A source that
   * carries no location is returned as is; otherwise a verified copy is made once and shared by every
   * caller until it has been idle for `LOCATION_FREE_TTL_MS`. Rejects (fails closed) when exiftool cannot
   * read the file, cannot write the copy, or the copy still reports a location.
   */
  async acquireLocationFreeOriginal(source: string): Promise<LocationFreeLease> {
    const { mtimeMs, size } = await stat(source);
    const key = `${source}\0${mtimeMs}\0${size}`;

    let entry = this.locationFree.get(key);
    if (!entry) {
      const created: LocationFreeEntry = { ready: this.createLocationFreeCopy(source), refs: 0 };
      created.ready.catch(() => {
        if (this.locationFree.get(key) === created) {
          this.locationFree.delete(key);
        }
      });
      this.locationFree.set(key, created);
      entry = created;
    }

    const current = entry;
    current.refs++;
    clearTimeout(current.timer);

    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      current.refs--;
      if (current.refs === 0 && this.locationFree.get(key) === current) {
        current.timer = setTimeout(() => void this.evictLocationFree(key, current), LOCATION_FREE_TTL_MS);
        current.timer.unref?.();
      }
    };

    try {
      return { path: await current.ready, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private async createLocationFreeCopy(source: string): Promise<string> {
    const found = await this.readLocationTags(source);
    if (found.length === 0) {
      return source;
    }

    await this.prepareLocationFreeDir();
    const destination = join(this.locationFreeDir, `${randomUUID()}${extname(source)}`);
    try {
      await this.writeLocationFreeCopy(source, destination);
      const remaining = (await this.readLocationTags(destination)).filter(
        (tag) => !LOCATION_COPY_ACCEPTED_KEYS.has(tag),
      );
      if (remaining.length > 0) {
        throw new Error(`Location tags remain after removal: ${remaining.join(', ')}`);
      }
      return destination;
    } catch (error) {
      await rm(destination, { force: true });
      this.logger.warn(`Unable to remove the location from ${source}: ${error}`);
      throw error;
    }
  }

  private async prepareLocationFreeDir() {
    await mkdir(this.locationFreeDir, { recursive: true, mode: 0o700 });
    if (this.locationFreeSwept) {
      return;
    }
    this.locationFreeSwept = true;

    const now = Date.now();
    for (const name of await readdir(this.locationFreeDir).catch(() => [] as string[])) {
      const path = join(this.locationFreeDir, name);
      const info = await stat(path).catch(() => null);
      if (info && now - info.mtimeMs > LOCATION_FREE_STALE_MS) {
        await rm(path, { force: true });
      }
    }
  }

  private async evictLocationFree(key: string, entry: LocationFreeEntry) {
    clearTimeout(entry.timer);
    if (this.locationFree.get(key) === entry) {
      this.locationFree.delete(key);
    }

    const path = await entry.ready.catch(() => null);
    if (path && path.startsWith(this.locationFreeDir)) {
      await rm(path, { force: true });
    }
  }
}
