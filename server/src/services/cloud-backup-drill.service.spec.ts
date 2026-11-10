import { generateKeyPairSync, sign } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { gzipSync } from 'node:zlib';
import type { CloudBackupBucket } from 'src/services/cloud-backup-maintenance.js';
import type { FrameleafKeySigner } from 'src/utils/frameleaf-dpop.js';
import { CloudBackupStoreError } from 'src/repositories/cloud-backup-store.repository.js';
import {
  DRILL_SAMPLE_SIZE,
  type DrillDeps,
  DrillStepError,
  drillOutcomeOf,
  drillSample,
  runRestoreDrill,
} from 'src/services/cloud-backup-drill.js';
import { DRILL_DATABASE_NAME, createSqlCommandGuard } from 'src/services/database-backup.service.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';
import { canonicalJson, drillReportOf, signDrillReport, verifyDrillReport } from 'src/utils/restore-drill-report.js';

const STARTED = '2026-11-08T02:00:00.000Z';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = (n: number) => n.toString(16).padStart(64, '0');

const manifestOf = (assets = 3) => ({
  format: 'frameleaf-backup-manifest',
  version: 2,
  instanceId: id(999),
  createdAt: STARTED,
  database: { key: 'db/v1/vault/1/hmac/frameleaf-db-backup.sql.gz', sha256: sha(9999), size: 10 },
  assets: Object.fromEntries(
    Array.from({ length: assets }, (_, index) => [
      id(index + 1),
      {
        owner: id(500),
        type: index === 0 ? 'VIDEO' : 'IMAGE',
        originalFileName: `a${index}.jpg`,
        fileCreatedAt: STARTED,
        fileModifiedAt: STARTED,
        localDateTime: STARTED,
        duration: null,
        files: [{ role: 'original', path: `a${index}.jpg`, sha256: sha(index + 1), size: 1, mtime: null }],
      },
    ]),
  ),
  profiles: {},
  albums: {
    [id(700)]: { name: 'Trip', description: '', ownerId: id(500), coverAssetId: null, order: 'desc', sharedUsers: [] },
  },
  people: {},
});

const bucket = (head: string | undefined = 'm/v1/vault/1/2026-11-08.json.gz') =>
  ({
    bucketRef: 'ref',
    bucketKey: Buffer.alloc(32),
    connection: { trustedManifestHead: head },
  }) as unknown as CloudBackupBucket;

const setup = (overrides: Partial<DrillDeps> = {}, manifest: object = manifestOf()) => {
  const removed: string[] = [];
  const deps: DrillDeps = {
    store: {
      exportObject: vi.fn().mockResolvedValue({ path: '/scratch/manifest/x' }),
      get: vi.fn().mockResolvedValue(gzipSync(JSON.stringify(manifest))),
      download: vi.fn().mockResolvedValue({ size: 1, sha256: '' }),
    } as never,
    makeDirectory: vi.fn().mockResolvedValue(undefined),
    removeDirectory: vi.fn((path: string) => {
      removed.push(path);
      return Promise.resolve();
    }),
    rehearse: vi.fn((_path: string, ids: string[]) =>
      Promise.resolve({ counts: { asset: 3, user: 1, album: 1 }, presentAssetIds: ids }),
    ),
    addedAt: vi.fn().mockResolvedValue(new Map()),
    progress: vi.fn().mockResolvedValue(true),
    random: () => 0,
    ...overrides,
  };
  return { deps, removed };
};

const failure = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(() => null).catch((error_: unknown) => error_);
  expect(error).toBeInstanceOf(DrillStepError);
  return drillOutcomeOf(error)!;
};

describe('restore drill (FL-879)', () => {
  it('passes when the backup unlocks, its library data rebuilds and every sampled original matches', async () => {
    const { deps, removed } = setup();
    const outcome = await runRestoreDrill(bucket(), '/scratch', deps);
    expect(outcome).toMatchObject({
      result: 'passed',
      failedStep: null,
      backupFrom: STARTED,
      library: { items: 3, photos: 2, videos: 1, albums: 1 },
      restored: { asset: 3, user: 1, album: 1 },
      sampleSize: 3,
      checked: 3,
      matched: 3,
      mismatches: [],
    });
    // the dump and each original are checked against the SHA-256 the backup recorded
    expect(deps.store.download).toHaveBeenCalledWith(
      expect.anything(),
      'db/v1/vault/1/hmac/frameleaf-db-backup.sql.gz',
      expect.anything(),
      '/scratch/library-data.sql.gz',
      sha(9999),
    );
    expect(deps.store.download).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.anything(),
      '/scratch/original',
      sha(1),
    );
    expect(removed.at(-1)).toBe('/scratch');
  });

  it('fails at fetch when the newest backup does not match its signed history (a tampered manifest)', async () => {
    const { deps, removed } = setup({
      store: {
        exportObject: vi
          .fn()
          .mockRejectedValue(
            new CloudBackupStoreError('Export snapshot ciphertext mismatch', null, 'ChecksumMismatch'),
          ),
        get: vi.fn(),
        download: vi.fn(),
      } as never,
    });
    const outcome = await failure(runRestoreDrill(bucket(), '/scratch', deps));
    expect(outcome).toMatchObject({ result: 'failed', failedStep: 'fetch' });
    expect(deps.rehearse).not.toHaveBeenCalled();
    expect(removed.at(-1)).toBe('/scratch');
  });

  it('fails at fetch when there is no signed backup to take back', async () => {
    const { deps } = setup();
    expect(await failure(runRestoreDrill(bucket(''), '/scratch', deps))).toMatchObject({ failedStep: 'fetch' });
  });

  it('fails at unlock when the recovery key does not decrypt the backup (a wrong key)', async () => {
    const { deps } = setup({
      store: {
        exportObject: vi.fn().mockResolvedValue({}),
        get: vi
          .fn()
          .mockRejectedValue(
            new CloudBackupStoreError('Encrypted backup authentication failed', null, 'ChecksumMismatch'),
          ),
        download: vi.fn(),
      } as never,
    });
    expect(await failure(runRestoreDrill(bucket(), '/scratch', deps))).toMatchObject({ failedStep: 'unlock' });
  });

  it('fails at rebuild when the library data does not rebuild, and when an older item is missing from it', async () => {
    const broken = setup({ rehearse: vi.fn().mockRejectedValue(new Error('psql exited 3')) });
    expect(await failure(runRestoreDrill(bucket(), '/scratch', broken.deps))).toMatchObject({ failedStep: 'rebuild' });

    const missing = setup({
      rehearse: vi.fn().mockResolvedValue({ counts: { asset: 2, user: 1, album: 1 }, presentAssetIds: [id(2), id(3)] }),
      addedAt: vi.fn().mockResolvedValue(new Map([[id(1), new Date('2026-01-01T00:00:00Z')]])),
    });
    expect(await failure(runRestoreDrill(bucket(), '/scratch', missing.deps))).toMatchObject({
      failedStep: 'rebuild',
      mismatches: [{ assetId: id(1), problem: 'not-in-library-data' }],
    });
  });

  it('accepts an item added after the backup started that its library data does not hold yet', async () => {
    const { deps } = setup({
      rehearse: vi.fn().mockResolvedValue({ counts: { asset: 2, user: 1, album: 1 }, presentAssetIds: [id(2), id(3)] }),
      addedAt: vi.fn().mockResolvedValue(new Map([[id(1), new Date('2026-11-08T02:30:00Z')]])),
    });
    expect(await runRestoreDrill(bucket(), '/scratch', deps)).toMatchObject({ result: 'passed' });
  });

  it('fails at compare when a sampled original is corrupted or missing, never a pass', async () => {
    const download = vi
      .fn()
      .mockResolvedValueOnce({}) // the library data
      .mockRejectedValueOnce(new CloudBackupStoreError('damaged', null, 'ChecksumMismatch'))
      .mockRejectedValueOnce(new CloudBackupStoreError('gone', 404, 'NoSuchKey'))
      .mockResolvedValueOnce({});
    const { deps } = setup({
      store: {
        exportObject: vi.fn().mockResolvedValue({}),
        get: vi.fn().mockResolvedValue(gzipSync(JSON.stringify(manifestOf()))),
        download,
      } as never,
    });
    const outcome = await failure(runRestoreDrill(bucket(), '/scratch', deps));
    expect(outcome).toMatchObject({ result: 'failed', failedStep: 'compare', checked: 3, matched: 1 });
    expect(outcome.mismatches.map(({ problem }) => problem).toSorted()).toEqual(['different', 'missing']);
  });

  it('stops without a report, and removes its scratch folder, when cancelled', async () => {
    const { deps, removed } = setup({ progress: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false) });
    expect(await runRestoreDrill(bucket(), '/scratch', deps)).toBeNull();
    expect(removed.at(-1)).toBe('/scratch');
  });

  it('takes back only items the licence covers', async () => {
    const { deps } = setup({ eligible: () => false });
    expect(await failure(runRestoreDrill(bucket(), '/scratch', deps))).toMatchObject({ failedStep: 'fetch' });
  });

  it('samples at most 500, without repeats', () => {
    const items = Array.from({ length: 2000 }, (_, index) => index);
    const sample = drillSample(items, DRILL_SAMPLE_SIZE);
    expect(sample).toHaveLength(500);
    expect(new Set(sample).size).toBe(500);
    expect(drillSample([1, 2], DRILL_SAMPLE_SIZE)).toHaveLength(2);
  });
});

describe('restore drill report (FL-879)', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string };
  const signer = {
    kid: ed25519Thumbprint(jwk),
    publicJwk: jwk,
    sign: () => '',
    signBytes: (data: Buffer) => sign(null, data, privateKey),
  } as unknown as FrameleafKeySigner;
  const report = drillReportOf(
    {
      result: 'failed',
      failedStep: 'unlock',
      manifestKey: 'm/key',
      backupFrom: STARTED,
      library: { items: 3, photos: 2, videos: 1, albums: 1 },
      restored: null,
      sampleSize: 0,
      checked: 0,
      matched: 0,
      mismatches: [],
    },
    {
      id: id(1),
      server: id(999),
      target: 'byo-s3',
      trigger: 'scheduled',
      startedAt: new Date(STARTED),
      finishedAt: new Date('2026-11-08T02:06:12.000Z'),
    },
  );

  it('names the failed step and the steps it never reached', () => {
    expect(report.steps).toEqual([
      { step: 'fetch', state: 'passed' },
      { step: 'unlock', state: 'failed' },
      { step: 'rebuild', state: 'not-reached' },
      { step: 'compare', state: 'not-reached' },
    ]);
    expect(report.failure).toBe('The recovery key on this server didn’t unlock the backup.');
    expect(report.durationSeconds).toBe(372);
  });

  it('verifies with the key it names, and not once changed', () => {
    const signed = signDrillReport(report, signer);
    expect(signed.signature.keyFingerprint).toBe(signer.kid);
    expect(verifyDrillReport(JSON.parse(JSON.stringify(signed)))).toBe(true);
    expect(verifyDrillReport({ ...signed, report: { ...signed.report, result: 'passed' } })).toBe(false);
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' });
    expect(verifyDrillReport({ ...signed, signature: { ...signed.signature, publicKey: other as never } })).toBe(false);
  });

  it('writes canonical JSON with sorted keys', () => {
    expect(canonicalJson({ b: 1, a: [{ d: null, c: 'x' }] })).toBe('{"a":[{"c":"x","d":null}],"b":1}');
  });
});

describe('scratch database guard (FL-879)', () => {
  const run = (sql: string) =>
    pipeline(
      Readable.from([Buffer.from(sql)]),
      createSqlCommandGuard(),
      new Writable({ write: (_c, _e, done) => done() }),
    );

  it('lets SQL, COPY data and the dump’s own restrict lines through', async () => {
    await expect(
      run('\\restrict abc\nCREATE TABLE a (b text);\nCOPY public.a (b) FROM stdin;\n\\N\n\\.\n\\unrestrict abc\n'),
    ).resolves.toBeUndefined();
  });

  it('refuses any other psql command', async () => {
    await expect(run('SELECT 1;\n\\connect immich\n')).rejects.toThrow('not library data');
    await expect(run('\\! rm -rf /\n')).rejects.toThrow('not library data');
  });

  it('only names scratch databases', () => {
    expect(DRILL_DATABASE_NAME.test(`frameleaf_drill_${'a'.repeat(32)}`)).toBe(true);
    expect(DRILL_DATABASE_NAME.test('immich')).toBe(false);
  });
});
