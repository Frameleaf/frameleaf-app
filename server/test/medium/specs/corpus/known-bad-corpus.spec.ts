/**
 * FL-883: the known-bad file corpus. Every file in test/fixtures/known-bad-corpus.json goes through metadata
 * extraction, thumbnail generation and, for videos, the playback encode, with the server's own services and
 * native tools, and what happened is compared with the manifest. A step that fails is retried the way the queue
 * retries it, and FL-845 decides whether the file is set aside.
 *
 * Runs as its own medium suite (`FRAMELEAF_MEDIUM_SUITE=corpus`, `mise run //server:corpus`), in CI before an
 * upstream sync merges (.github/workflows/known-bad-corpus.yml). It writes two reports to
 * `FRAMELEAF_CORPUS_REPORT_DIR` (default: a folder in the system temp directory): known-bad-corpus-diff.md,
 * every difference from the manifest, and known-bad-corpus-actual.json, what each step did for every file.
 */
import { Kysely } from 'kysely';
import { existsSync, mkdirSync, readFileSync, Stats, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import sharp from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetFileType, AssetType, JobName, JobStatus } from 'src/enum.js';
import { recordProcessingFailure } from 'src/queue/processing-failure.js';
import { sharpProcessPool } from 'src/queue/sharp-pool.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetFileRepository } from 'src/repositories/asset-file.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MetadataRepository } from 'src/repositories/metadata.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { BASE_SERVICE_DEPENDENCIES } from 'src/services/base.service.js';
import { MediaService } from 'src/services/media.service.js';
import { MetadataService } from 'src/services/metadata.service.js';
import { MediumTestContext, testAssetsDir } from 'test/medium.factory.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getKyselyDB } from 'test/utils.js';

type Step = 'metadata' | 'thumbnail' | 'encode';
type Facts = Record<string, string | number | null>;
type Entry = {
  file: string;
  root: 'test-assets' | 'fixtures';
  type: 'image' | 'video';
  note: string;
  source: string;
  licence: string;
  reproduces: string[];
  expect: Partial<Record<Step, Facts>>;
};
type Dependency = (typeof BASE_SERVICE_DEPENDENCIES)[number];

const fixturesDir = resolve(import.meta.dirname, '../../../fixtures');
const manifest: { files: Entry[] } = JSON.parse(readFileSync(join(fixturesDir, 'known-bad-corpus.json'), 'utf8'));
const reportDir = process.env.FRAMELEAF_CORPUS_REPORT_DIR || join(tmpdir(), 'frameleaf-known-bad-corpus');
const OUTCOMES = new Set(['ok', 'skipped', 'library-care', 'set-aside', 'failed']);
const stepsOf = (entry: Entry): Step[] =>
  entry.type === 'video' ? ['metadata', 'thumbnail', 'encode'] : ['metadata', 'thumbnail'];
const pathOf = (entry: Entry) => resolve(entry.root === 'test-assets' ? testAssetsDir : fixturesDir, entry.file);

// The queue runs a job three times before giving up (`attempt < retryBaseAttempt + 2`, src/queue/store.ts).
const ATTEMPTS = 3;
// A fixed file date, so a photo without a capture date gets the same fallback date on every checkout.
const FILE_DATE = new Date('2001-02-03T04:05:06.000Z');

const REAL: Dependency[] = [
  AssetRepository,
  AssetEditRepository,
  AssetFileRepository,
  AssetJobRepository,
  CryptoRepository,
  MediaRepository,
  MetadataRepository,
  PartnerOriginRepository,
  PersonRepository,
  PhysicalFileRepository,
  StorageRepository,
  SystemMetadataRepository,
  TagRepository,
];

// What the services touch beyond the database and the file system (the medium factory can mock these).
const MOCK: Dependency[] = [
  ConfigRepository,
  DatabaseRepository,
  EventRepository,
  JobRepository,
  LoggingRepository,
  MachineLearningRepository,
  MapRepository,
  MlDestinationRepository,
  WebsocketRepository,
];

let db: Kysely<DB>;
let mediaLocation: string;
let ownerId: string;
type Observed = Omit<Entry, 'expect'> & { actual: Partial<Record<Step, Facts>>; errors: Record<string, string> };
const observed: Observed[] = [];
const differences: Array<{ file: string; lines: string[] }> = [];

/** A service on the real database and native tools; everything that talks to the outside world is a mock. */
const newCorpusContext = <S extends typeof MetadataService | typeof MediaService>(Service: S) => {
  const ctx = new MediumTestContext(Service, {
    database: db,
    real: REAL,
    mock: MOCK,
  });
  ctx.getMock(ConfigRepository).getEnv.mockReturnValue(mockEnvData({}));
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  ctx.getMock(MapRepository).reverseGeocode.mockResolvedValue({ country: null, state: null, city: null });
  const storage = ctx.get(StorageRepository);
  const stat = storage.stat.bind(storage);
  vi.spyOn(storage, 'stat').mockImplementation(async (path) => {
    const stats = await stat(path);
    const ms = FILE_DATE.getTime();
    return Object.assign(stats, {
      mtime: FILE_DATE,
      ctime: FILE_DATE,
      atime: FILE_DATE,
      birthtime: FILE_DATE,
      mtimeMs: ms,
      ctimeMs: ms,
      atimeMs: ms,
      birthtimeMs: ms,
    }) as Stats;
  });
  return ctx;
};

let metadata: MediumTestContext<typeof MetadataService>;
let media: MediumTestContext<typeof MediaService>;

const size = async (path: string | undefined) => {
  if (!path || !existsSync(path)) {
    return null;
  }
  const { width, height } = await sharp(path).metadata();
  return `${width}x${height}`;
};

const filePath = async (assetId: string, type: AssetFileType) => {
  const row = await db
    .selectFrom('asset_file')
    .select('path')
    .where('assetId', '=', assetId)
    .where('type', '=', type)
    .where('isEdited', '=', false)
    .executeTakeFirst();
  return row?.path;
};

/** One step as the queue runs it: retried until it succeeds, or until FL-845 sets the file aside. */
const runStep = async (
  ctx: MediumTestContext<typeof MetadataService> | MediumTestContext<typeof MediaService>,
  assetId: string,
  name: JobName,
  run: () => Promise<JobStatus>,
): Promise<{ facts: Facts; error?: string }> => {
  const jobs = ctx.getMock(JobRepository);
  let reason = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    jobs.queue.mockClear();
    try {
      const status = await run();
      // Metadata extraction returns nothing when it is done; only Failed and a throw are failures.
      if (status !== JobStatus.Failed) {
        const handedToCare = jobs.queue.mock.calls.some(
          ([item]) => item.name === JobName.MediaHealthFixAsset && (item.data as { id?: string }).id === assetId,
        );
        return { facts: { outcome: handedToCare ? 'library-care' : status === JobStatus.Skipped ? 'skipped' : 'ok' } };
      }
      reason = 'The job reported a failure';
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error);
    }
    if (await recordProcessingFailure(db, { name, assetId }, reason)) {
      break;
    }
  }
  const failure = await db
    .selectFrom('asset_processing_failure')
    .select(['lastError', 'quarantinedAt'])
    .where('assetId', '=', assetId)
    .where('step', '=', name)
    .executeTakeFirst();
  return {
    facts: { outcome: failure?.quarantinedAt ? 'set-aside' : 'failed', cause: failure?.lastError ?? null },
    error: reason.split('\n', 1)[0],
  };
};

const readMetadata = async (assetId: string, type: Entry['type']): Promise<Facts> => {
  const row = await db
    .selectFrom('asset')
    .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
    .leftJoin('asset_video', 'asset.id', 'asset_video.assetId')
    .select([
      'asset.localDateTime',
      'asset_exif.dateTimeOriginal',
      'asset_exif.timeZone',
      'asset_exif.exifImageWidth',
      'asset_exif.exifImageHeight',
      'asset_exif.orientation',
      'asset_video.codecName',
    ])
    .where('asset.id', '=', assetId)
    .executeTakeFirstOrThrow();
  return {
    dateTimeOriginal: row.dateTimeOriginal ? new Date(row.dateTimeOriginal).toISOString() : null,
    localDateTime: row.localDateTime ? new Date(row.localDateTime).toISOString() : null,
    timeZone: row.timeZone,
    width: row.exifImageWidth,
    height: row.exifImageHeight,
    orientation: row.orientation,
    ...(type === 'video' && { videoCodec: row.codecName ?? null }),
  };
};

const readEncode = async (assetId: string): Promise<Facts> => {
  const path = await filePath(assetId, AssetFileType.EncodedVideo);
  if (!path || !existsSync(path)) {
    return { videoCodec: null, size: null };
  }
  const { videoStreams } = await media.get(MediaRepository).probe(path);
  const [stream] = videoStreams;
  return { videoCodec: stream?.codecName ?? null, size: stream ? `${stream.width}x${stream.height}` : null };
};

const show = (value: unknown) => (value === undefined ? 'nothing' : JSON.stringify(value));

/** Every key the manifest pins, compared one by one, so a failure reads as a list of what changed. */
const compare = (entry: Entry, got: Partial<Record<Step, Facts>>) => {
  const lines: string[] = [];
  for (const step of stepsOf(entry)) {
    const expected = entry.expect[step];
    if (!expected) {
      lines.push(`${step}: the manifest has no expectation for this step`);
      continue;
    }
    for (const [key, value] of Object.entries(expected)) {
      const was = got[step]?.[key];
      if (was !== value) {
        lines.push(`${step}.${key}: expected ${show(value)}, got ${show(was)}`);
      }
    }
  }
  return lines;
};

const writeReports = () => {
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'known-bad-corpus-actual.json'), `${JSON.stringify({ files: observed }, null, 2)}\n`);
  const body =
    differences.length === 0
      ? `Every file matched the manifest (${observed.length} of ${manifest.files.length} files ran).\n`
      : [
          `${differences.length} of ${observed.length} files differ from server/test/fixtures/known-bad-corpus.json.`,
          '',
          ...differences.flatMap(({ file, lines }) => [`- \`${file}\``, ...lines.map((line) => `  - ${line}`)]),
          '',
        ].join('\n');
  writeFileSync(join(reportDir, 'known-bad-corpus-diff.md'), `# Known-bad file corpus\n\n${body}`);
};

beforeAll(async () => {
  db = await getKyselyDB();
  mediaLocation = await mkdtemp(join(tmpdir(), 'known-bad-corpus-media-'));
  StorageCore.setMediaLocation(mediaLocation);
  metadata = newCorpusContext(MetadataService);
  media = newCorpusContext(MediaService);
  const { user } = await metadata.newUser();
  ownerId = user.id;
});

afterAll(async () => {
  writeReports();
  await sharpProcessPool.close();
  StorageCore.reset();
  await rm(mediaLocation, { recursive: true, force: true });
});

describe('known-bad corpus manifest', () => {
  it('names a licence, a source, an issue and an outcome for every step of every file', () => {
    expect(manifest.files.length).toBeGreaterThanOrEqual(30);
    const problems = manifest.files.flatMap((entry) => {
      const missing: string[] = (['file', 'note', 'source', 'licence'] as const).filter((key) => !entry[key]?.trim());
      if (!Array.isArray(entry.reproduces) || entry.reproduces.length === 0) {
        missing.push('reproduces');
      }
      if (!['test-assets', 'fixtures'].includes(entry.root)) {
        missing.push('root');
      }
      if (!['image', 'video'].includes(entry.type)) {
        missing.push('type');
      }
      for (const step of stepsOf(entry)) {
        if (!OUTCOMES.has(String(entry.expect?.[step]?.outcome))) {
          missing.push(`expect.${step}.outcome`);
        }
      }
      if (entry.type === 'image' && entry.expect?.encode) {
        missing.push('an image has no encode step');
      }
      return missing.length > 0 ? [`${entry.file}: ${missing.join(', ')}`] : [];
    });
    expect(problems).toEqual([]);
    const files = manifest.files.map(({ root, file }) => `${root}:${file}`);
    expect(files.filter((file, index) => files.indexOf(file) !== index)).toEqual([]);
  });
});

describe('known-bad corpus', () => {
  it.each(manifest.files.map((entry) => [entry.file, entry] as const))(
    '%s',
    async (_file, entry) => {
      const originalPath = pathOf(entry);
      expect(existsSync(originalPath), `${originalPath} is missing: run scripts/checkout-test-assets.sh`).toBe(true);
      const { asset } = await metadata.newAsset({
        ownerId,
        originalPath,
        originalFileName: basename(entry.file),
        type: entry.type === 'video' ? AssetType.Video : AssetType.Image,
        fileCreatedAt: FILE_DATE,
        fileModifiedAt: FILE_DATE,
        localDateTime: FILE_DATE,
      });
      const got: Partial<Record<Step, Facts>> = {};
      const errors: Record<string, string> = {};
      const keep = (step: Step, { facts, error }: { facts: Facts; error?: string }) => {
        if (error) {
          errors[step] = error;
        }
        return facts;
      };

      const extracted = await runStep(metadata, asset.id, JobName.AssetExtractMetadata, () =>
        metadata.sut.handleMetadataExtraction({ id: asset.id }),
      );
      got.metadata = { ...keep('metadata', extracted), ...(await readMetadata(asset.id, entry.type)) };

      const thumbnails = await runStep(media, asset.id, JobName.AssetGenerateThumbnails, () =>
        media.sut.handleGenerateThumbnails({ id: asset.id }),
      );
      got.thumbnail = {
        ...keep('thumbnail', thumbnails),
        preview: await size(await filePath(asset.id, AssetFileType.Preview)),
        thumbnail: await size(await filePath(asset.id, AssetFileType.Thumbnail)),
      };

      if (entry.type === 'video') {
        const encoded = await runStep(media, asset.id, JobName.AssetEncodeVideo, () =>
          media.sut.handleVideoConversion({ id: asset.id }),
        );
        got.encode = { ...keep('encode', encoded), ...(await readEncode(asset.id)) };
      }

      const { expect: _expected, ...described } = entry;
      observed.push({ ...described, actual: got, errors });
      const lines = compare(entry, got);
      if (lines.length > 0) {
        differences.push({ file: entry.file, lines });
        const why = Object.entries(errors).map(([step, error]) => `(${step} error: ${error})`);
        expect.fail(
          `${entry.file} no longer matches the corpus manifest:\n${[...lines, ...why].map((line) => `  ${line}`).join('\n')}`,
        );
      }
    },
    180_000,
  );
});
