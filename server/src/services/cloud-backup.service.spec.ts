import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { LookupAddress } from 'node:dns';
import type { RequestOptions } from 'node:https';
import type { LookupFunction } from 'node:net';
import type { CloudBackupEntry } from 'src/repositories/cloud-backup-index.repository.js';
import type { CloudBackupRestoreSnapshot } from 'src/services/cloud-backup-restore.js';
import type { FrameleafCloudBackup } from 'src/types.js';
import type { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import type { ConfigHistory } from 'src/utils/config-history.js';
import type { PushNotice } from 'src/utils/frameleaf-push.js';
import {
  DatabaseLock,
  JobStatus,
  MediaOperationKind,
  MediaOperationStatus,
  MlAdmissionRefusal,
  PushEventType,
  SystemMetadataKey,
} from 'src/enum.js';
import {
  CloudBackupClaimError,
  CloudBackupFileChangedError,
  CloudBackupStoreError,
} from 'src/repositories/cloud-backup-store.repository.js';
import { FrameleafCloudBackupRepository } from 'src/repositories/frameleaf-cloud-backup.repository.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { emptyRestoreResult } from 'src/services/cloud-backup-restore.js';
import {
  CLOUD_BACKUP_SCHEDULE_CRON,
  CLOUD_BACKUP_VERIFY_CRON,
  CloudBackupService,
} from 'src/services/cloud-backup.service.js';
import { selectBackupLocation } from 'src/utils/backup-location-selection.js';
import { EMPTY_DETAILS } from 'src/utils/cloud-backup-details.js';
import { unwrapBucketKey } from 'src/utils/cloud-backup-escrow.js';
import { backupKeyFile, bucketRef, keyFingerprint } from 'src/utils/cloud-backup.js';
import { readConfig } from 'src/utils/config.js';
import { executionSignal, operationExecution } from 'src/utils/execution-signal.js';
import { keyEscrowBlobSchema, managedStorageRef } from 'src/utils/frameleaf-cloud-backup.js';
import { FrameleafCloudError, errorEnvelopeSchema } from 'src/utils/frameleaf-cloud.js';
import { OperationDeadlineError, withOperationExecution } from 'src/utils/operation-execution.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getMocks } from 'test/utils.js';

vi.mock('src/utils/backup-location-selection.js', () => ({ selectBackupLocation: vi.fn() }));
vi.mock('node:dns', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:dns')>()),
  lookup: vi.fn(),
}));
vi.mock('node:https', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:https')>()),
  request: vi.fn(),
}));

/** Each escrow open or wrap runs the real scrypt (N = 2^17, 128 MiB); a busy runner needs more than 5 s. */
const SCRYPT_TEST_TIMEOUT_MS = 30_000;

const hex = (text: string) => createHash('sha256').update(text).digest('hex');
const SHA_A = hex('a');
const SHA_B = hex('b');
const SHA_C = hex('c');
const SHA_SIDECAR = hex('sidecar');
const SHA_DUMP = hex('dump');

const key = Buffer.alloc(32, 7);
const fingerprint = keyFingerprint(key);
const s3 = {
  endpoint: 'https://s3.eu-central-2.storage.example',
  region: '',
  bucket: 'family-backup',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: 's3-secret',
};
const ref = bucketRef(s3.endpoint, s3.bucket);
const instance = {
  instanceId: 'instance-1',
  kid: 'kid-1',
  publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'x' },
  keyFile: '/identity/instance-key.pem',
  createdAt: '2026-09-01T00:00:00.000Z',
};
type CloudBackupClaimOverrides = Record<string, unknown> & { target?: FrameleafCloudBackup['target'] };

const claim = (overrides: CloudBackupClaimOverrides = {}): FrameleafCloudBackup =>
  ({
    target: 'byo-s3',
    bucketRef: ref,
    endpoint: s3.endpoint,
    region: 'eu-central-2',
    bucket: s3.bucket,
    instanceId: 'instance-1',
    claimedAt: '2026-09-25T00:00:00.000Z',
    keyMode: 'server',
    keyFingerprint: fingerprint,
    reconciledAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  }) as FrameleafCloudBackup;
const enabledConfig = (keyMode = 'server', include?: { thumbs: boolean; encodedVideo: boolean }) => ({
  frameleafCloud: {
    cloudBackup: {
      enabled: true,
      target: 'byo-s3',
      s3,
      keyMode,
      include: include ?? { thumbs: false, encodedVideo: false },
    },
  },
});
const keyFileOf = (mode: 'server' | 'own-stored' | 'own-memory' = 'server') =>
  JSON.stringify(backupKeyFile({ key, instanceId: 'instance-1', bucket: s3.bucket, mode, createdAt: new Date() }));

const running = { status: MediaOperationStatus.Rendering, cancelRequestedAt: null, pauseRequestedAt: null };

const operationOf = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
  ({
    id: 'run-1',
    ownerId: authStub.admin.user.id,
    kind: MediaOperationKind.CloudBackup,
    status: MediaOperationStatus.Preparing,
    snapshot: { version: 1, bucketRef: ref, keyFingerprint: fingerprint },
    result: null,
    processedUnits: '0',
    totalUnits: null,
    progress: 0,
    pauseRequestedAt: null,
    createdAt: new Date('2026-09-26T03:00:00.000Z'),
    ...overrides,
  }) as unknown as MediaOperation;

const asset = (id: string, sha256: string | null, files: Array<{ type: string; path: string }> = []) => ({
  id,
  ownerId: 'owner-1',
  originalPath: `/data/library/${id}.jpg`,
  sha256,
  checksumSize: 100,
  verifiedAt: new Date('2026-09-10T00:00:00.000Z'),
  checksumPathVerified: true,
  files,
});

const entry = (fileKey: string, overrides: Partial<CloudBackupEntry> = {}): CloudBackupEntry => ({
  fileKey,
  assetId: fileKey.split(':', 1)[0],
  ownerId: 'owner-1',
  role: 'original',
  path: `/data/library/${fileKey}`,
  sha256: SHA_A,
  size: 100,
  mtime: new Date('2026-09-01T00:00:00.000Z'),
  ...overrides,
});

const dumpKey = 'db/cloud-backup-immich-db-backup-dump.sql.gz';
const ALBUM_ID = '5b0c4e8a-1d2f-4a3b-9c8d-7e6f5a4b3c2d';

describe(CloudBackupService.name, () => {
  let sut: CloudBackupService;
  let mocks: ReturnType<typeof getMocks>;
  let metadata: Record<string, unknown>;
  let operations: Record<string, ReturnType<typeof vi.fn>>;
  let store: Record<string, ReturnType<typeof vi.fn>>;
  let index: Record<string, ReturnType<typeof vi.fn>>;
  let keys: Record<string, ReturnType<typeof vi.fn>>;
  let databaseBackup: Record<string, ReturnType<typeof vi.fn>>;
  let cloudBackup: Record<string, ReturnType<typeof vi.fn>>;
  let details: Record<string, ReturnType<typeof vi.fn>>;
  /** What each streamed upload sent (the gzipped manifests). */
  let streamed: Buffer[];

  const build = () =>
    new CloudBackupService(
      mocks.logger as never,
      mocks.config as never,
      mocks.systemMetadata as never,
      mocks.forkSchema as never,
      mocks.database as never,
      mocks.instanceIdentity as never,
      mocks.frameleafCloud as never,
      mocks.event as never,
      mocks.websocket as never,
      operations as never,
      mocks.storage as never,
      mocks.crypto as never,
      store as never,
      index as never,
      keys as never,
      databaseBackup as never,
      cloudBackup as never,
      mocks.user as never,
      mocks.cron as never,
      mocks.job as never,
      details as never,
    );

  const configWrites = () =>
    mocks.systemMetadata.set.mock.calls
      .filter(([key]) => key === SystemMetadataKey.SystemConfig)
      .map(([, value]) => value);
  const savedConfig = () =>
    readConfig({
      configRepo: mocks.config,
      metadataRepo: mocks.systemMetadata as never,
      logger: mocks.logger as never,
    });

  const uploadedKeys = () => store.uploadFile.mock.calls.map(([, objectKey]) => objectKey as string);
  const manifestOf = (at = 0) => JSON.parse(gunzipSync(streamed[at]).toString());
  type Recorded = { mock: { calls: unknown[][]; invocationCallOrder: number[] } };
  const orderOf = (recorded: Recorded, predicate: (args: unknown[]) => boolean) =>
    recorded.mock.invocationCallOrder[recorded.mock.calls.findIndex((args) => predicate(args))];

  beforeEach(() => {
    vi.mocked(selectBackupLocation).mockReset();
    mocks = getMocks();
    metadata = {};
    mocks.systemMetadata.get.mockImplementation((name) => Promise.resolve(metadata[name] as never));
    mocks.systemMetadata.set.mockImplementation((name: string, value: unknown) => {
      metadata[name] = value;
      return Promise.resolve();
    });
    mocks.config.getEnv.mockReturnValue(
      mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: '/identity' } }),
    );
    mocks.instanceIdentity.loadOrCreate.mockResolvedValue(instance as never);
    mocks.event.emit.mockResolvedValue();
    mocks.storage.stat.mockResolvedValue({ size: 100, mtime: new Date('2026-09-01T00:00:00.000Z') } as never);
    mocks.storage.readdir.mockResolvedValue([]);
    streamed = [];
    mocks.crypto.hashFile.mockImplementation((path: string | Buffer) =>
      Promise.resolve(Buffer.from(hex(String(path).includes('dump') ? 'dump' : String(path)), 'hex')),
    );

    details = {
      putBack: vi.fn().mockResolvedValue(true),
      recreate: vi.fn().mockImplementation(({ assetId }) => Promise.resolve({ status: 'created', assetId })),
      restoreAlbum: vi.fn().mockResolvedValue('created'),
      restoreStacks: vi.fn().mockResolvedValue(undefined),
    };
    operations = {
      getActiveOfKind: vi.fn().mockResolvedValue(undefined),
      getOfKind: vi.fn().mockResolvedValue(undefined),
      createExclusive: vi.fn().mockResolvedValue({ created: operationOf() }),
      requestPause: vi.fn().mockResolvedValue(operationOf()),
      resume: vi.fn().mockResolvedValue(operationOf()),
      requestCancel: vi.fn().mockResolvedValue(operationOf()),
      claimNext: vi.fn().mockResolvedValue(undefined),
      heartbeat: vi.fn().mockResolvedValue(true),
      reportProgress: vi.fn().mockResolvedValue(true),
      setBulkResult: vi.fn().mockResolvedValue(running),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('failed'),
      requeue: vi.fn().mockResolvedValue(true),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      settlePause: vi.fn().mockResolvedValue(true),
    };
    store = {
      probe: vi.fn().mockResolvedValue({ state: 'empty' }),
      claim: vi.fn().mockResolvedValue({ existing: false, claimedAt: '2026-09-26T03:00:00.000Z' }),
      uploadFile: vi
        .fn()
        .mockImplementation((_connection, _key, path: string) =>
          Promise.resolve({ etag: '"etag"', size: path.includes('dump') ? 50 : 100 }),
        ),
      put: vi.fn().mockResolvedValue({ etag: '"manifest"', encrypted: true }),
      uploadStream: vi.fn().mockImplementation(async (_connection, _key, source: AsyncIterable<Buffer>) => {
        const chunks: Buffer[] = [];
        for await (const chunk of source) {
          chunks.push(Buffer.from(chunk));
        }
        streamed.push(Buffer.concat(chunks));
        return { etag: '"manifest"', size: streamed.at(-1)!.length };
      }),
      get: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      listAll: vi.fn().mockResolvedValue(0),
      readMarker: vi.fn().mockResolvedValue({
        format: 'frameleaf-backup',
        version: 1,
        instanceId: 'instance-1',
        keyFingerprint: fingerprint,
        claimedAt: '2026-09-25T00:00:00.000Z',
      }),
    };
    index = {
      getExisting: vi.fn().mockResolvedValue(new Set()),
      record: vi.fn().mockResolvedValue(undefined),
      touch: vi.fn().mockResolvedValue(undefined),
      getUsage: vi.fn().mockResolvedValue({ objects: 2, bytes: 200 }),
      createManifest: vi.fn().mockResolvedValue({ id: 'manifest-1', key: 'm/20260926T030000Z.json.gz' }),
      getManifest: vi.fn().mockResolvedValue(undefined),
      finishManifest: vi.fn().mockResolvedValue(undefined),
      upsertEntries: vi.fn().mockResolvedValue(undefined),
      getEntriesPage: vi.fn().mockResolvedValue([]),
      deleteEntries: vi.fn().mockResolvedValue(undefined),
      deleteBucket: vi.fn().mockResolvedValue(undefined),
      currentTime: vi.fn().mockResolvedValue('2026-09-26T02:59:00.123456+00:00'),
      pruneUnseen: vi.fn().mockResolvedValue(0),
      setManifestDatabase: vi.fn().mockResolvedValue(undefined),
      getKeptDatabaseKeys: vi.fn().mockResolvedValue(new Set()),
      getManifestKeys: vi.fn().mockResolvedValue(new Set()),
      adoptManifests: vi.fn().mockResolvedValue(0),
      listKeptManifests: vi.fn().mockResolvedValue([]),
      markManifests: vi.fn().mockResolvedValue(0),
      forget: vi.fn().mockResolvedValue(undefined),
      getOwnerRestoreIdentities: vi.fn().mockResolvedValue({}),
      getOwnerHistoryState: vi.fn().mockResolvedValue(new Map()),
      getLibraryState: vi.fn().mockResolvedValue(new Map()),
      getOwnerNames: vi.fn().mockResolvedValue(new Map()),
      endAbandonedManifests: vi.fn().mockResolvedValue(0),
      countAssets: vi.fn().mockResolvedValue(3),
      listAssets: vi.fn().mockResolvedValue([]),
      listProfileImages: vi.fn().mockResolvedValue([]),
      getAssetDetails: vi.fn().mockResolvedValue(new Map()),
      getAlbumRecords: vi.fn().mockResolvedValue(new Map()),
      getPersonRecords: vi.fn().mockResolvedValue(new Map()),
      getAlbumMembers: vi.fn().mockResolvedValue(new Map()),
    };
    keys = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue({ path: '/identity/cloud-backup.key', created: true }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    databaseBackup = {
      createDatabaseBackup: vi.fn().mockResolvedValue('/data/backups/cloud-backup-immich-db-backup-dump.sql.gz'),
    };
    cloudBackup = {
      metadata: vi.fn().mockResolvedValue(null),
      locations: vi.fn().mockResolvedValue({ version: 2, locations: [] }),
      grant: vi.fn(),
      rotate: vi.fn(),
      usage: vi.fn(),
      reportRun: vi.fn().mockResolvedValue(undefined),
      putSettings: vi.fn().mockResolvedValue(undefined),
      putEscrow: vi.fn().mockResolvedValue(undefined),
      getEscrow: vi.fn(),
      deleteEscrow: vi.fn().mockResolvedValue(undefined),
    };
    sut = build();
    // an own-memory key is asked for without waiting; a spec that needs the wait sets it
    sut.keyAskMs = 0;
  });

  describe('task checkpoint progress', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('only advancing persisted item counts extend the idle deadline', async () => {
      const operation = operationOf({ snapshot: { task: 'verify' } });
      const checkpoint = (processed: number) =>
        (
          sut as unknown as {
            checkpointTask: (
              operation: MediaOperation,
              token: string,
              result: object,
              units: { processed: number; total: number; progress: number },
            ) => Promise<string>;
          }
        ).checkpointTask(operation, 'claim-1', { checked: processed }, { processed, total: 10, progress: 10 });
      let advance!: (processed: number) => Promise<string>;
      const task = withOperationExecution(
        { renew: () => Promise.resolve(true), pollMs: 10, deadlineMs: 100, idleMs: 100 },
        async () => {
          const signal = executionSignal()!;
          const context = operationExecution.getStore()!;
          await new Promise<never>((_resolve, reject) => {
            advance = (processed) => operationExecution.run(context, () => checkpoint(processed));
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          });
        },
      );
      const rejection = expect(task).rejects.toBeInstanceOf(OperationDeadlineError);
      await vi.advanceTimersByTimeAsync(80);
      await advance(1);
      await vi.advanceTimersByTimeAsync(80);
      await advance(1);
      await vi.advanceTimersByTimeAsync(21);
      await rejection;
      expect(operations.setBulkResult).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('setup', () => {
    const setup = (overrides: Record<string, unknown> = {}) =>
      sut.setup(authStub.admin, {
        target: 'byo-s3',
        s3,
        keyMode: 'server',
        key: key.toString('base64'),
        ...overrides,
      } as never);

    it('claims the bucket with the generated key and keeps the key only in its 0600 key file (server mode)', async () => {
      mocks.crypto.randomBytes.mockReturnValue(key);
      const generated = sut.generateKey();
      expect(generated).toMatchObject({ key: key.toString('base64'), fingerprint });
      expect(generated.recoveryCode).toMatch(/^FLRK-/);
      keys.read.mockResolvedValue(keyFileOf());

      const status = await setup({ key: generated.key });

      expect(store.claim).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: s3.endpoint, bucket: s3.bucket, region: 'eu-central-2' }),
        key,
        expect.objectContaining({ instanceId: 'instance-1', keyFingerprint: fingerprint }),
      );
      expect(keys.write).toHaveBeenCalledWith(
        '/identity',
        fingerprint,
        expect.stringContaining(key.toString('base64')),
      );
      expect(JSON.parse(keys.write.mock.calls[0][2] as string)).toMatchObject({ mode: 'server', fingerprint });
      // the key file is written and read back before the bucket is claimed with it
      expect(keys.write.mock.invocationCallOrder[0]).toBeLessThan(store.claim.mock.invocationCallOrder[0]);

      // the key is never configuration: only the secret access key is, as a write-only credential
      const persisted = configWrites().at(-1)!;
      const saved = await savedConfig();
      expect(saved).toMatchObject({
        frameleafCloud: {
          cloudBackup: { enabled: true, target: 'byo-s3', keyMode: 'server', s3: { secretAccessKey: 's3-secret' } },
        },
      });
      expect(JSON.stringify([persisted, saved])).not.toContain(key.toString('base64'));
      expect(JSON.stringify(metadata[SystemMetadataKey.FrameleafCloudBackup])).not.toContain(key.toString('base64'));
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        bucketRef: ref,
        instanceId: 'instance-1',
        keyMode: 'server',
        keyFingerprint: fingerprint,
      });
      expect(mocks.event.emit).toHaveBeenCalledWith('ConfigUpdate', expect.anything());
      expect(JSON.stringify(status)).not.toContain(key.toString('base64'));
      expect(status).toMatchObject({ keyLoaded: true, keyFingerprint: fingerprint });
    });

    it('keeps a copy of your own key on this server in own-stored mode, never escrowed', async () => {
      await setup({ keyMode: 'own-stored' });

      expect(keys.write).toHaveBeenCalledOnce();
      expect(JSON.parse(keys.write.mock.calls[0][2] as string)).toMatchObject({ mode: 'own-stored' });
    });

    it('never saves the key in own-memory mode, and asks for the typed acknowledgement first', async () => {
      await expect(setup({ keyMode: 'own-memory' })).rejects.toBeInstanceOf(BadRequestException);
      expect(store.claim).not.toHaveBeenCalled();

      const status = await setup({ keyMode: 'own-memory', acknowledgement: ' I understand ' });

      expect(keys.write).not.toHaveBeenCalled();
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('CloudBackupKeyShare', { key: key.toString('base64') });
      // shared only once the claim is saved, so the other workers accept it
      const saved = orderOf(mocks.systemMetadata.set, ([name]) => name === SystemMetadataKey.FrameleafCloudBackup);
      const shared = orderOf(mocks.websocket.serverSend, ([name]) => name === 'CloudBackupKeyShare');
      expect(saved).toBeLessThan(shared);
      expect(status.keyLoaded).toBe(true);
    });

    it('refuses Frameleaf-managed storage while this server is not linked to Frameleaf Cloud', async () => {
      await expect(setup({ target: 'managed' })).rejects.toThrow('not linked to Frameleaf Cloud');
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('refuses a bucket the claim refuses, and stores nothing', async () => {
      store.claim.mockRejectedValue(
        new CloudBackupClaimError(
          'claimed-by-another-server',
          'This bucket already holds frameleaf-backup.json for another Frameleaf server.',
        ),
      );

      await expect(setup()).rejects.toThrow(ConflictException);
      // the key file this setup created goes again
      expect(keys.remove).toHaveBeenCalledWith('/identity', fingerprint);
      expect(configWrites()).toHaveLength(0);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toBeUndefined();
    });

    it('keeps a key file that was already there when the claim fails', async () => {
      keys.write.mockResolvedValue({ path: '/identity/cloud-backup.key', created: false });
      store.claim.mockRejectedValue(
        new CloudBackupClaimError('not-empty', 'This bucket already contains other files.'),
      );

      await expect(setup()).rejects.toThrow(ConflictException);
      expect(keys.remove).not.toHaveBeenCalled();
    });

    it('never claims a bucket with a key it could not keep', async () => {
      keys.write.mockRejectedValue(new Error('EACCES: permission denied'));

      await expect(setup()).rejects.toThrow('could not be stored on this server');
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('forgets what it knew of a bucket it claims afresh (emptied or recreated), and keeps it for its own claim', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();

      await setup();

      expect(index.deleteBucket).toHaveBeenCalledWith(ref);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).not.toHaveProperty('reconciledAt');

      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      index.deleteBucket.mockClear();
      store.claim.mockResolvedValue({ existing: true, claimedAt: '2026-09-25T00:00:00.000Z' });
      await setup();

      expect(index.deleteBucket).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        reconciledAt: '2026-09-25T00:00:00.000Z',
      });
    });

    it('refuses an HTTP storage address and a key that is not 256 bits', async () => {
      // eslint-disable-next-line unicorn/prefer-https -- an HTTP storage address is what is being refused
      await expect(setup({ s3: { ...s3, endpoint: 'http://s3.example.test' } })).rejects.toThrow('HTTPS');
      await expect(setup({ key: 'not-a-key' })).rejects.toBeInstanceOf(BadRequestException);
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('is refused while a run is active', async () => {
      operations.getActiveOfKind.mockResolvedValue({ id: 'run-1', fingerprint: null });

      await expect(setup()).rejects.toBeInstanceOf(ConflictException);
    });

    it('checks a bucket without claiming or saving anything', async () => {
      await expect(sut.check({ s3 })).resolves.toMatchObject({ ok: true, state: 'empty' });
      store.probe.mockResolvedValue({ state: 'not-empty' });
      await expect(sut.check({ s3 })).resolves.toMatchObject({ ok: false, state: 'not-empty' });
      store.probe.mockRejectedValue(new CloudBackupStoreError('refused', 403, 'AccessDenied'));
      await expect(sut.check({ s3 })).rejects.toThrow('refused these credentials');
      expect(store.claim).not.toHaveBeenCalled();
      expect(configWrites()).toHaveLength(0);
    });
  });

  describe('own-memory key', () => {
    it.each([
      ['endpoint', 'https://different-s3.test'],
      ['bucket', 'different-bucket'],
    ])('refuses stale safety proof after changed BYO %s with the same target', async (field, value) => {
      await sut.onKeyShare({ key: key.toString('base64') });
      const settings = enabledConfig('own-memory');
      settings.frameleafCloud.cloudBackup.s3 = { ...s3, [field]: value };
      metadata[SystemMetadataKey.SystemConfig] = settings;
      await expect(sut.getSafetyAvailability()).resolves.toEqual({
        state: 'not-configured',
        bucket: null,
        readOnly: false,
        readOnlyReason: null,
      });
      expect(cloudBackup.grant).not.toHaveBeenCalled();
      expect(store.probe).not.toHaveBeenCalled();
    });

    it('reports unavailable safety states without issuing a remote storage grant', async () => {
      metadata[SystemMetadataKey.SystemConfig] = { frameleafCloud: { cloudBackup: { enabled: false, target: 'off' } } };
      await expect(sut.getSafetyAvailability()).resolves.toEqual({
        state: 'off',
        bucket: null,
        readOnly: false,
        readOnlyReason: null,
      });
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: { cloudBackup: { enabled: true, target: 'managed' } },
      };
      delete metadata[SystemMetadataKey.FrameleafCloudLink];
      await expect(sut.getSafetyAvailability()).resolves.toEqual({
        state: 'not-linked',
        bucket: null,
        readOnly: false,
        readOnlyReason: null,
      });
      expect(cloudBackup.grant).not.toHaveBeenCalled();
      expect(store.probe).not.toHaveBeenCalled();
    });

    it('reports a unloaded key and recognizes another worker loading it', async () => {
      await expect(sut.getSafetyAvailability()).resolves.toEqual({
        state: 'paused-key-unloaded',
        bucket: ref,
        readOnly: false,
        readOnlyReason: null,
      });
      await sut.onKeyShare({ key: key.toString('base64') });
      await expect(sut.getSafetyAvailability()).resolves.toEqual({
        state: 'ready',
        bucket: ref,
        readOnly: false,
        readOnlyReason: null,
      });
      expect(cloudBackup.grant).not.toHaveBeenCalled();
    });

    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: 'own-memory' });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig('own-memory');
    });

    it('is not loaded after a restart, and backups wait until it is unlocked', async () => {
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });
      await expect(sut.startRun(authStub.admin)).rejects.toBeInstanceOf(ConflictException);
      expect(operations.createExclusive).not.toHaveBeenCalled();

      await expect(sut.unlock({ key: Buffer.alloc(32, 9).toString('base64') })).rejects.toThrow('different bucket');
      const status = await sut.unlock({ key: key.toString('base64') });

      expect(status.keyLoaded).toBe(true);
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('CloudBackupKeyShare', { key: key.toString('base64') });
      await sut.startRun(authStub.admin);
      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({ kind: MediaOperationKind.CloudBackup }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );
    });

    it('accepts the key another worker loaded, only for this bucket', async () => {
      await sut.onKeyShare({ key: Buffer.alloc(32, 9).toString('base64') });
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: false });

      await sut.onKeyShare({ key: key.toString('base64') });
      await expect(sut.getStatus()).resolves.toMatchObject({ keyLoaded: true });
      sut.onKeyRequest();
      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('CloudBackupKeyShare', { key: key.toString('base64') });
    });

    it('asks the other workers for the key when this worker restarted without it', async () => {
      sut.keyAskMs = 5000;
      const status = sut.getStatus();
      await vi.waitFor(() => expect(mocks.websocket.serverSend).toHaveBeenCalledWith('CloudBackupKeyRequest'));

      // another worker answers: the status is read with the key, without waiting out the timeout
      await sut.onKeyShare({ key: key.toString('base64') });

      await expect(status).resolves.toMatchObject({ keyLoaded: true });
    });

    it('asks for the key when a worker starts', async () => {
      await sut.onBootstrapAskForKey();

      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('CloudBackupKeyRequest');
    });

    it('has nothing to unlock in the stored key modes', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: 'server' });

      await expect(sut.unlock({ key: key.toString('base64') })).rejects.toThrow('nothing to unlock');
    });

    it('lets a run wait for the key without failing it', async () => {
      await sut.run(operationOf(), 'claim-1');

      expect(mocks.websocket.serverSend).toHaveBeenCalledWith('CloudBackupKeyRequest');
      expect(operations.requeue).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ returnAttempt: true }),
      );
      expect(operations.fail).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ dedupeKey: 'cloud-backup:key-locked' }),
      );
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        lastRun: { status: 'waiting-for-key' },
      });
    });
  });

  describe('run', () => {
    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
    });

    it('backs up the database first, then every unique file once, then the manifest', async () => {
      index.listAssets
        .mockResolvedValueOnce([
          asset('asset-1', SHA_A),
          // the same photo twice on this server: one object
          asset('asset-2', SHA_A),
          asset('asset-3', SHA_B, [{ type: 'sidecar', path: 'sidecar' }]),
        ])
        .mockResolvedValueOnce([]);
      index.getEntriesPage.mockResolvedValue([
        entry('asset-1:original'),
        entry('profile:owner-1', { assetId: null, role: 'profile', sha256: SHA_C }),
      ]);

      await sut.run(operationOf(), 'claim-1');

      expect(databaseBackup.createDatabaseBackup).toHaveBeenCalledWith('cloud-backup-', {
        signal: expect.any(AbortSignal),
        progress: expect.any(Function),
      });
      expect(uploadedKeys()).toEqual([
        'db/cloud-backup-immich-db-backup-dump.sql.gz',
        `o/${SHA_A}`,
        `o/${SHA_B}`,
        `o/${SHA_SIDECAR}`,
      ]);
      // the checksum on record was trusted for the originals; the sidecar was hashed now
      expect(mocks.crypto.hashFile).toHaveBeenCalledWith('sidecar', 'sha256');
      expect(mocks.crypto.hashFile).not.toHaveBeenCalledWith('/data/library/asset-1.jpg', 'sha256');
      expect(index.upsertEntries).toHaveBeenCalledWith(
        'manifest-1',
        expect.arrayContaining([
          expect.objectContaining({ fileKey: 'asset-2:original', sha256: SHA_A }),
          expect.objectContaining({ fileKey: 'asset-3:sidecar:sidecar', role: 'sidecar', sha256: SHA_SIDECAR }),
        ]),
      );
      // only the run's own dump is removed from this server
      expect(mocks.storage.unlink).toHaveBeenCalledOnce();
      expect(mocks.storage.unlink).toHaveBeenCalledWith('/data/backups/cloud-backup-immich-db-backup-dump.sql.gz');

      const [, manifestKey, , bucketKey, contentType] = store.uploadStream.mock.calls[0];
      expect(manifestKey).toBe('m/20260926T030000Z.json.gz');
      expect(bucketKey).toEqual(key);
      expect(contentType).toBe('application/gzip');
      expect(manifestOf()).toEqual({
        format: 'frameleaf-backup-manifest',
        version: 2,
        instanceId: 'instance-1',
        createdAt: expect.any(String),
        database: { key: dumpKey, sha256: SHA_DUMP, size: 50 },
        assets: {
          'asset-1': {
            owner: 'owner-1',
            files: [
              {
                role: 'original',
                path: '/data/library/asset-1:original',
                sha256: SHA_A,
                size: 100,
                mtime: '2026-09-01T00:00:00.000Z',
              },
            ],
          },
        },
        profiles: {
          'owner-1': {
            role: 'profile',
            path: '/data/library/profile:owner-1',
            sha256: SHA_C,
            size: 100,
            mtime: '2026-09-01T00:00:00.000Z',
          },
        },
        albums: {},
        people: {},
      });
      expect(index.setManifestDatabase).toHaveBeenCalledWith('manifest-1', dumpKey);
      expect(index.finishManifest).toHaveBeenCalledWith('manifest-1', {
        status: 'complete',
        assetCount: 1,
        fileCount: 2,
        bytes: 200,
      });
      // the done checkpoint is saved before the recorded files go, so a retry never writes it again
      const done = orderOf(
        operations.setBulkResult,
        (call) => (call[2] as { result: { phase: string } }).result.phase === 'done',
      );
      expect(done).toBeLessThan(index.deleteEntries.mock.invocationCallOrder[0]);
      expect(index.deleteEntries).toHaveBeenCalledWith('manifest-1');
      expect(operations.complete).toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        lastManifestKey: 'm/20260926T030000Z.json.gz',
        lastRun: { status: 'completed', uploaded: 3, skipped: 1 },
      });
    });

    it('uploads no file on a second run when nothing changed', async () => {
      index.listAssets
        .mockResolvedValueOnce([asset('asset-1', SHA_A), asset('asset-2', SHA_B)])
        .mockResolvedValueOnce([]);
      index.getExisting.mockResolvedValue(new Set([SHA_A, SHA_B]));

      await sut.run(operationOf(), 'claim-1');

      expect(uploadedKeys().filter((name) => name.startsWith('o/'))).toEqual([]);
      expect(index.touch).toHaveBeenCalledWith(ref, [SHA_A, SHA_B]);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRun: { uploaded: 0, skipped: 2 } });
    });

    it('hashes a file written since its checksum was taken and uploads it under its new hash', async () => {
      index.listAssets.mockResolvedValueOnce([asset('asset-1', SHA_A)]).mockResolvedValueOnce([]);
      mocks.storage.stat.mockResolvedValue({ size: 100, mtime: new Date('2026-09-20T00:00:00.000Z') } as never);
      mocks.crypto.hashFile.mockImplementation((path: string | Buffer) =>
        Promise.resolve(Buffer.from(String(path).includes('dump') ? SHA_DUMP : SHA_C, 'hex')),
      );

      await sut.run(operationOf(), 'claim-1');

      expect(uploadedKeys()).toContain(`o/${SHA_C}`);
      expect(uploadedKeys()).not.toContain(`o/${SHA_A}`);
    });

    it('uploads a file again once when it changed while uploading', async () => {
      index.listAssets.mockResolvedValueOnce([asset('asset-1', SHA_A)]).mockResolvedValueOnce([]);
      store.uploadFile
        .mockResolvedValueOnce({ etag: '"db"', size: 50 })
        .mockRejectedValueOnce(new CloudBackupFileChangedError('/data/library/asset-1.jpg'))
        .mockResolvedValueOnce({ etag: '"etag"', size: 100 });

      await sut.run(operationOf(), 'claim-1');

      expect(uploadedKeys().at(-1)).toBe(`o/${hex('/data/library/asset-1.jpg')}`);
      expect(operations.complete).toHaveBeenCalled();
    });

    it('counts a missing file and carries on', async () => {
      index.listAssets
        .mockResolvedValueOnce([asset('asset-1', SHA_A), asset('asset-2', SHA_B)])
        .mockResolvedValueOnce([]);
      mocks.storage.stat
        .mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'ENOENT' }))
        .mockResolvedValue({ size: 100, mtime: new Date('2026-09-01T00:00:00.000Z') } as never);

      await sut.run(operationOf(), 'claim-1');

      expect(uploadedKeys()).toEqual(['db/cloud-backup-immich-db-backup-dump.sql.gz', `o/${SHA_B}`]);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRun: { missing: 1 } });
    });

    it('asks for thumbnails and transcoded videos only when they are included', async () => {
      await sut.run(operationOf(), 'claim-1');
      expect(index.listAssets).toHaveBeenCalledWith(
        expect.objectContaining({ includeThumbs: false, includeEncodedVideo: false }),
      );

      metadata[SystemMetadataKey.SystemConfig] = enabledConfig('server', { thumbs: true, encodedVideo: true });
      await sut.run(operationOf(), 'claim-2');
      expect(index.listAssets).toHaveBeenLastCalledWith(
        expect.objectContaining({ includeThumbs: true, includeEncodedVideo: true }),
      );
    });

    it('fills the index from the bucket listing on the first run in a bucket', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ reconciledAt: undefined });
      store.listAll = vi
        .fn()
        .mockImplementation((_connection, prefix: string, onPage: (objects: unknown[]) => Promise<void>) =>
          prefix === 'o/'
            ? onPage([
                { key: `o/${SHA_A}`, size: 100, etag: '"a"' },
                { key: 'o/not-a-hash', size: 1, etag: null },
              ]).then(() => 2)
            : Promise.resolve(0),
        );

      await sut.run(operationOf(), 'claim-1');

      expect(index.record).toHaveBeenCalledWith(ref, [{ sha256: SHA_A, size: 100, etag: '"a"' }]);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toHaveProperty('reconciledAt');
    });

    it('resumes the same manifest after a restart, from its cursor, without dumping the database again', async () => {
      index.getManifest.mockResolvedValue({ id: 'manifest-1', key: 'm/20260926T030000Z.json.gz', status: 'running' });
      const resumed = operationOf({
        result: {
          phase: 'assets',
          manifestId: 'manifest-1',
          manifestKey: 'm/20260926T030000Z.json.gz',
          cursor: 'asset-25',
          database: { key: 'db/earlier.sql.gz', sha256: SHA_DUMP, size: 50 },
          uploaded: 25,
          skipped: 0,
          missing: 0,
          changed: 0,
          bytesUploaded: 2500,
          assets: 25,
          total: 30,
        },
      });

      await sut.run(resumed, 'claim-2');

      expect(databaseBackup.createDatabaseBackup).not.toHaveBeenCalled();
      expect(index.createManifest).not.toHaveBeenCalled();
      expect(index.listAssets).toHaveBeenCalledWith(expect.objectContaining({ afterId: 'asset-25' }));
      expect(store.uploadStream).toHaveBeenCalledWith(
        expect.anything(),
        'm/20260926T030000Z.json.gz',
        expect.anything(),
        key,
        'application/gzip',
      );
    });

    it('writes its cursor every 25 assets and stops there when paused', async () => {
      index.listAssets.mockResolvedValue(Array.from({ length: 25 }, (_, i) => asset(`asset-${i}`, SHA_A)));
      operations.setBulkResult
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce(running)
        .mockResolvedValueOnce({ ...running, pauseRequestedAt: new Date() });

      await sut.run(operationOf(), 'claim-1');

      const assetWrite = operations.setBulkResult.mock.calls[2][2] as { result: { cursor: string; assets: number } };
      expect(assetWrite.result).toMatchObject({ cursor: 'asset-24', assets: 25 });
      expect(operations.settlePause).toHaveBeenCalledWith('run-1', 'claim-1');
      expect(store.uploadStream).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('ends the manifest without writing it when cancelled', async () => {
      operations.setBulkResult.mockResolvedValue({ ...running, cancelRequestedAt: new Date() });

      await sut.run(operationOf(), 'claim-1');

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith('run-1', 'claim-1', { released: false });
      expect(index.finishManifest).toHaveBeenCalledWith('manifest-1', { status: 'cancelled' });
      expect(index.deleteEntries).toHaveBeenCalledWith('manifest-1');
      expect(store.uploadStream).not.toHaveBeenCalled();
    });

    it('never writes a manifest again once it is complete, when a claim resumes after writing it', async () => {
      index.getManifest.mockResolvedValue({ id: 'manifest-1', key: 'm/20260926T030000Z.json.gz', status: 'complete' });
      const resumed = operationOf({
        result: {
          phase: 'manifest',
          manifestId: 'manifest-1',
          manifestKey: 'm/20260926T030000Z.json.gz',
          cursor: 'asset-9',
          database: { key: dumpKey, sha256: SHA_DUMP, size: 50 },
          uploaded: 3,
          skipped: 1,
          missing: 0,
          changed: 0,
          bytesUploaded: 350,
          assets: 10,
          total: 10,
        },
      });

      await sut.run(resumed, 'claim-2');

      expect(store.uploadStream).not.toHaveBeenCalled();
      expect(index.finishManifest).not.toHaveBeenCalled();
      expect(operations.setBulkResult).toHaveBeenCalledWith(
        'run-1',
        'claim-2',
        expect.objectContaining({ result: expect.objectContaining({ phase: 'done' }) }),
      );
      expect(index.deleteEntries).toHaveBeenCalledWith('manifest-1');
      expect(operations.complete).toHaveBeenCalled();
    });

    it('keeps a manifest complete when its run fails after writing it', async () => {
      index.getManifest
        .mockResolvedValueOnce({ id: 'manifest-1', status: 'running' })
        .mockResolvedValue({ id: 'manifest-1', status: 'complete' });
      operations.beginValidation.mockRejectedValue(new Error('database went away'));

      await sut.run(operationOf(), 'claim-1');

      expect(store.uploadStream).toHaveBeenCalledOnce();
      expect(operations.fail).toHaveBeenCalled();
      expect(index.finishManifest).not.toHaveBeenCalledWith('manifest-1', { status: 'failed' });
    });

    it('writes each item’s record and details, and the albums and people they name (manifest v2)', async () => {
      index.getEntriesPage.mockResolvedValue([entry('asset-1:original'), entry('asset-2:original')]);
      const details = (albums: Array<{ id: string; name: string }>, personId: string | null) => ({
        isFavorite: true,
        visibility: 'timeline',
        rating: 5,
        description: 'Lake',
        dateTimeOriginal: '2026-08-14T09:12:00.000Z',
        timeZone: null,
        latitude: null,
        longitude: null,
        tags: ['Trips'],
        albums,
        faces: personId ? [{ personId, box: [1, 2, 3, 4], imageWidth: 10, imageHeight: 10, isHidden: false }] : [],
        stack: null,
        edits: [],
      });
      const record = {
        type: 'IMAGE',
        originalFileName: 'IMG_1.jpg',
        fileCreatedAt: '2026-08-14T07:12:00.000Z',
        fileModifiedAt: '2026-08-14T07:12:00.000Z',
        localDateTime: '2026-08-14T09:12:00.000Z',
        duration: null,
      };
      index.getAssetDetails.mockResolvedValue(
        new Map([
          ['asset-1', { record, details: details([{ id: 'album-1', name: 'Lake house' }], 'person-1') }],
          ['asset-2', { record, details: details([{ id: 'album-1', name: 'Lake house' }], null) }],
        ]),
      );
      const album = {
        name: 'Lake house',
        description: '',
        ownerId: 'owner-1',
        coverAssetId: 'asset-1',
        order: 'desc',
        sharedUsers: [],
      };
      const person = { ownerId: 'owner-1', name: 'Jamie', birthDate: null, isHidden: false, isFavorite: false };
      index.getAlbumRecords.mockResolvedValue(new Map([['album-1', album]]));
      index.getPersonRecords.mockResolvedValue(new Map([['person-1', person]]));

      await sut.run(operationOf(), 'claim-1');

      expect(index.getAssetDetails).toHaveBeenCalledWith(['asset-1', 'asset-2']);
      expect(index.getAlbumRecords).toHaveBeenCalledWith(['album-1']);
      expect(index.getPersonRecords).toHaveBeenCalledWith([{ ownerId: 'owner-1', personId: 'person-1' }]);
      const manifest = manifestOf();
      expect(manifest.version).toBe(2);
      expect(manifest.assets['asset-1']).toMatchObject({ ...record, details: { rating: 5, tags: ['Trips'] } });
      expect(manifest.albums).toEqual({ 'album-1': album });
      expect(manifest.people).toEqual({ 'person-1': person });
    });

    it('streams the manifest a page of recorded files at a time', async () => {
      const first = Array.from({ length: 1000 }, (_, i) =>
        entry(`asset-${String(i).padStart(4, '0')}:original`, { sha256: SHA_B }),
      );
      index.getEntriesPage.mockResolvedValueOnce(first).mockResolvedValueOnce([entry('asset-9999:original')]);

      await sut.run(operationOf(), 'claim-1');

      expect(index.getEntriesPage).toHaveBeenNthCalledWith(1, 'manifest-1', null, 1000);
      expect(index.getEntriesPage).toHaveBeenNthCalledWith(2, 'manifest-1', 'asset-0999:original', 1000);
      const manifest = manifestOf();
      expect(Object.keys(manifest.assets)).toHaveLength(1001);
      expect(index.finishManifest).toHaveBeenCalledWith('manifest-1', expect.objectContaining({ fileCount: 1001 }));
    });

    it('drops recorded objects the bucket no longer holds when it reads the listing', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ reconciledAt: undefined });
      index.pruneUnseen.mockResolvedValue(4);

      await sut.run(operationOf(), 'claim-1');

      expect(index.pruneUnseen).toHaveBeenCalledWith(ref, '2026-09-26T02:59:00.123456+00:00');
      expect(index.currentTime.mock.invocationCallOrder[0]).toBeLessThan(
        orderOf(store.listAll, ([, prefix]) => prefix === 'o/'),
      );
    });

    it('refuses a run whose bucket lost its claim (emptied or recreated), rather than trusting the index', async () => {
      store.readMarker.mockRejectedValue(
        new CloudBackupClaimError('claim-missing', 'This bucket no longer holds frameleaf-backup.json.'),
      );

      await sut.run(operationOf(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('no longer holds') }),
      );
      expect(databaseBackup.createDatabaseBackup).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('refuses a run when another server claimed the bucket since', async () => {
      store.readMarker.mockResolvedValue({ instanceId: 'instance-2' });

      await sut.run(operationOf(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('another Frameleaf server') }),
      );
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('never removes a database dump: only the clean-up, which reads the kept manifests, does (FL-164)', async () => {
      const older = Array.from({ length: 9 }, (_, i) => `db/cloud-backup-immich-db-backup-2026090${i}.sql.gz`);
      store.listAll = vi
        .fn()
        .mockImplementation((_connection, prefix: string, onPage: (objects: unknown[]) => Promise<void>) =>
          prefix === 'db/'
            ? onPage([...older, dumpKey].map((name) => ({ key: name, size: 1, etag: null }))).then(
                () => older.length + 1,
              )
            : Promise.resolve(0),
        );

      await sut.run(operationOf(), 'claim-1');

      expect(operations.complete).toHaveBeenCalled();
      expect(store.delete).not.toHaveBeenCalled();
    });

    it('records backups found in the bucket that this server has no record of (FL-164)', async () => {
      const earlier = 'm/20260920T030000Z.json.gz';
      store.listAll = vi
        .fn()
        .mockImplementation((_connection, prefix: string, onPage: (objects: unknown[]) => Promise<void>) =>
          prefix === 'm/' ? onPage([{ key: earlier, size: 1, etag: null }]).then(() => 1) : Promise.resolve(0),
        );
      store.get = vi.fn().mockResolvedValue(
        gzipSync(
          JSON.stringify({
            format: 'frameleaf-backup-manifest',
            version: 1,
            instanceId: 'instance-1',
            createdAt: '2026-09-20T03:00:00.000Z',
            database: { key: dumpKey, sha256: SHA_DUMP, size: 50 },
            assets: {
              'asset-1': {
                owner: 'owner-1',
                files: [{ role: 'original', path: '/data/a.jpg', sha256: SHA_A, size: 100, mtime: null }],
              },
            },
            profiles: {},
          }),
        ),
      );

      await sut.run(operationOf(), 'claim-1');

      expect(index.adoptManifests).toHaveBeenCalledWith(ref, [
        {
          key: earlier,
          createdAt: new Date('2026-09-20T03:00:00.000Z'),
          databaseKey: dumpKey,
          assetCount: 1,
          fileCount: 1,
          bytes: 100,
        },
      ]);
    });

    it('trusts a recorded checksum only when it was verified at the original path', async () => {
      index.listAssets
        .mockResolvedValueOnce([{ ...asset('asset-1', SHA_A), checksumPathVerified: false }])
        .mockResolvedValueOnce([]);

      await sut.run(operationOf(), 'claim-1');

      expect(mocks.crypto.hashFile).toHaveBeenCalledWith('/data/library/asset-1.jpg', 'sha256');
      expect(uploadedKeys()).toContain(`o/${hex('/data/library/asset-1.jpg')}`);
    });

    it('removes a dump an earlier run left behind before it makes a new one, and nothing else', async () => {
      mocks.storage.readdir.mockResolvedValue([
        'cloud-backup-frameleaf-db-backup-20260925T030000-v3.2.0-pg19beta4.sql.gz.tmp',
        'frameleaf-db-backup-20260925T020000-v3.2.0-pg19beta4.sql.gz',
        'cloud-backup-immich-db-backup-20260925T030000-v3.2.0-pg16.4.sql.gz.tmp',
      ]);

      await sut.run(operationOf(), 'claim-1');

      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        expect.stringContaining('cloud-backup-frameleaf-db-backup-20260925T030000-v3.2.0-pg19beta4.sql.gz.tmp'),
      );
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(
        expect.stringContaining('/frameleaf-db-backup-20260925T020000'),
      );
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(
        expect.stringContaining('cloud-backup-immich-db-backup-20260925T030000-v3.2.0-pg16.4.sql.gz.tmp'),
      );
      expect(mocks.storage.readdir.mock.invocationCallOrder[0]).toBeLessThan(
        databaseBackup.createDatabaseBackup.mock.invocationCallOrder[0],
      );
    });

    it('ends the manifests of runs the lease sweep failed before it looks for work, at most once a minute', async () => {
      index.endAbandonedManifests.mockResolvedValue(1);

      await sut.drain();
      await sut.drain();

      expect(index.endAbandonedManifests).toHaveBeenCalledOnce();
      expect(index.endAbandonedManifests.mock.invocationCallOrder[0]).toBeLessThan(
        operations.claimNext.mock.invocationCallOrder[0],
      );
      expect(operations.claimNext).toHaveBeenCalledTimes(2);
    });

    it('records a run cancelled after its manifest was written as complete', async () => {
      operations.beginValidation.mockResolvedValue(false);

      await sut.run(operationOf(), 'claim-1');

      expect(store.uploadStream).toHaveBeenCalledOnce();
      expect(operations.acknowledgeCancel).toHaveBeenCalledWith('run-1', 'claim-1', { released: false });
      expect(operations.complete).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        lastRun: { status: 'completed' },
        lastManifestKey: 'm/20260926T030000Z.json.gz',
        lastSuccessAt: expect.any(String),
      });
    });

    it('notifies every administrator once when a run fails for good', async () => {
      store.uploadFile.mockRejectedValue(new CloudBackupStoreError('The storage provider refused PUT: 403', 403, null));

      await sut.run(operationOf(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ errorCode: 'cloud_backup_failed' }),
      );
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ title: 'Cloud backup failed', dedupeKey: 'cloud-backup:failed' }),
      );
      expect(index.finishManifest).toHaveBeenCalledWith('manifest-1', { status: 'failed' });
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRun: { status: 'failed' } });
      // the local dump is still removed
      expect(mocks.storage.unlink).toHaveBeenCalledWith('/data/backups/cloud-backup-immich-db-backup-dump.sql.gz');
    });

    it('tells the owner by push that cloud backup needs attention when a run fails for good (FL-228)', async () => {
      store.uploadFile.mockRejectedValue(new CloudBackupStoreError('The storage provider refused PUT: 403', 403, null));

      await sut.run(operationOf(), 'claim-1');

      expect(mocks.event.emit).toHaveBeenCalledWith(
        'PushNotify',
        expect.objectContaining({
          type: PushEventType.BackupNeedsAttention,
          admins: true,
          title: 'Cloud backup failed',
          // native apps: Retry starts a new run (`POST /admin/cloud/backup/runs`)
          data: { reason: 'cloud-backup:failed', job: 'run-1', jobType: 'cloud-backup-run', jobActions: 'retry' },
        }),
      );
    });

    it('keeps the manifest for the automatic retry and does not notify yet', async () => {
      store.uploadFile.mockRejectedValue(new CloudBackupStoreError('unreachable', null, null));
      operations.fail.mockResolvedValue('retrying');

      await sut.run(operationOf(), 'claim-1');

      expect(index.finishManifest).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AdminNotify', expect.anything());
    });

    it('refuses a run queued for a bucket that is no longer the claimed one', async () => {
      await sut.run(
        operationOf({ snapshot: { version: 1, bucketRef: 'https://elsewhere/bucket', keyFingerprint: fingerprint } }),
        'claim-1',
      );

      expect(operations.fail).toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('fails a stored-key run whose key file is missing, and never guesses a key', async () => {
      keys.read.mockResolvedValue(null);

      await sut.run(operationOf(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('key file is missing') }),
      );
      expect(store.uploadFile).not.toHaveBeenCalled();
    });
  });

  describe('runs', () => {
    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
    });

    it('pauses, resumes and cancels a run for any administrator', async () => {
      operations.getOfKind.mockResolvedValue(operationOf({ ownerId: 'other-admin' }));

      await sut.pauseRun('run-1');
      await sut.resumeRun('run-1');
      await sut.cancelRun('run-1');

      expect(operations.requestPause).toHaveBeenCalledWith('run-1', 'other-admin', [
        MediaOperationKind.CloudBackup,
        MediaOperationKind.CloudRestore,
      ]);
      expect(operations.resume).toHaveBeenCalledWith('run-1', 'other-admin');
      expect(operations.requestCancel).toHaveBeenCalledWith('run-1', 'other-admin');
    });

    it('turns cloud backup off and keeps the claim and the key', async () => {
      await sut.turnOff(authStub.admin);

      expect(await savedConfig()).toMatchObject({
        frameleafCloud: { cloudBackup: { enabled: false } },
      });
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ bucketRef: ref });
      // FL-146 (FL-66): listed in the settings history as a Frameleaf Cloud change by this administrator
      expect((metadata[SystemMetadataKey.SystemConfigHistory] as ConfigHistory).entries[0]).toMatchObject({
        source: 'frameleaf-cloud',
        actorId: authStub.admin.user.id,
        changes: expect.arrayContaining([expect.objectContaining({ path: 'frameleafCloud.cloudBackup.enabled' })]),
      });
    });
  });

  describe('onConfigValidate', () => {
    it('needs a storage address and a bucket for your own bucket, over HTTPS', () => {
      const config = (s3Settings: Record<string, string>) =>
        ({
          frameleafCloud: { cloudBackup: { enabled: true, target: 'byo-s3', s3: { ...s3, ...s3Settings } } },
        }) as never;

      expect(() => sut.onConfigValidate({ newConfig: config({ bucket: '' }), oldConfig: config({}) })).toThrow(
        'storage address and a bucket name',
      );
      expect(() =>
        // eslint-disable-next-line unicorn/prefer-https -- an HTTP storage address is what is being refused
        sut.onConfigValidate({ newConfig: config({ endpoint: 'http://s3.example.test' }), oldConfig: config({}) }),
      ).toThrow('HTTPS');
      expect(() => sut.onConfigValidate({ newConfig: config({}), oldConfig: config({}) })).not.toThrow();
    });
  });
  describe('schedule (FL-164)', () => {
    const scheduled = (cronExpression = '0 4 * * *') =>
      ({
        frameleafCloud: {
          cloudBackup: { enabled: true, target: 'byo-s3', schedule: { cronExpression }, verifyWeekly: true },
        },
      }) as never;

    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      mocks.user.getAdmin.mockResolvedValue({ id: 'admin-1' } as never);
    });

    it('runs the schedule on the one server that holds its lock', async () => {
      mocks.cron.create.mockReturnValue();
      mocks.cron.update.mockReturnValue();
      mocks.database.tryLock.mockResolvedValue(false);
      await sut.onConfigInit({ newConfig: scheduled() });
      expect(mocks.cron.create).not.toHaveBeenCalled();

      mocks.database.tryLock.mockResolvedValue(true);
      await sut.onConfigInit({ newConfig: scheduled() });
      expect(mocks.database.tryLock).toHaveBeenCalledWith(DatabaseLock.FrameleafCloudBackupCheck);
      expect(mocks.cron.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: CLOUD_BACKUP_SCHEDULE_CRON, expression: '0 4 * * *', start: true }),
      );
      expect(mocks.cron.create).toHaveBeenCalledWith(
        expect.objectContaining({ name: CLOUD_BACKUP_VERIFY_CRON, start: true }),
      );

      sut.onConfigUpdate({ newConfig: scheduled('0 */6 * * *'), oldConfig: scheduled() });
      expect(mocks.cron.update).toHaveBeenCalledWith(
        expect.objectContaining({ name: CLOUD_BACKUP_SCHEDULE_CRON, expression: '0 */6 * * *' }),
      );
    });

    it('queues one scheduled run under the lock, owned by the first administrator', async () => {
      await expect(sut.handleSchedule()).resolves.toBe(JobStatus.Success);

      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: 'admin-1',
          kind: MediaOperationKind.CloudBackup,
          snapshot: expect.objectContaining({ task: 'backup', scheduled: true }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );
    });

    it('never duplicates a run already queued or in progress', async () => {
      operations.createExclusive.mockResolvedValue({ active: { id: 'run-1', ownerId: 'admin-1', fingerprint: null } });
      operations.getOfKind.mockResolvedValue(operationOf());

      await expect(sut.handleSchedule()).resolves.toBe(JobStatus.Skipped);
      expect(operations.createExclusive).toHaveBeenCalledTimes(1);
    });

    it('does nothing while cloud backup is off', async () => {
      metadata[SystemMetadataKey.SystemConfig] = { frameleafCloud: { cloudBackup: { enabled: false } } };

      await expect(sut.handleSchedule()).resolves.toBe(JobStatus.Skipped);
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('follows a scheduled run with the clean-up of runs past retention', async () => {
      keys.read.mockResolvedValue(keyFileOf());

      const snapshot = { version: 1, bucketRef: ref, keyFingerprint: fingerprint, scheduled: true };
      await sut.run(operationOf({ snapshot }), 'claim-1');

      expect(operations.complete).toHaveBeenCalled();
      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          snapshot: expect.objectContaining({ task: 'prune', dryRun: false, scheduled: true }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );
    });

    /** A schedule far from the fixed "now" below, so the quiet hour before a backup never interferes. */
    const farSchedule = () => ({
      frameleafCloud: {
        cloudBackup: { ...enabledConfig().frameleafCloud.cloudBackup, schedule: { cronExpression: '0 0 1 1 *' } },
      },
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('queues the monthly full check first, then a weekly sample, and nothing in between', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-15T12:00:00.000Z') });
      metadata[SystemMetadataKey.SystemConfig] = farSchedule();
      await expect(sut.handleVerifyCheck()).resolves.toBe(JobStatus.Success);
      expect(operations.createExclusive).toHaveBeenLastCalledWith(
        expect.objectContaining({ snapshot: expect.objectContaining({ task: 'verify', depth: 'full' }) }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );

      const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const lastWeek = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastFullVerifyAt: recent,
        lastVerify: { at: lastWeek },
      });
      await expect(sut.handleVerifyCheck()).resolves.toBe(JobStatus.Success);
      expect(operations.createExclusive).toHaveBeenLastCalledWith(
        expect.objectContaining({ snapshot: expect.objectContaining({ task: 'verify', depth: 'sample' }) }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );

      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastFullVerifyAt: recent,
        lastVerify: { at: recent },
      });
      await expect(sut.handleVerifyCheck()).resolves.toBe(JobStatus.Skipped);
      expect(operations.createExclusive).toHaveBeenCalledTimes(2);
    });

    it('waits a day after a failed check, and starts none in the hour before the scheduled backup', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-15T12:00:00.000Z') });
      metadata[SystemMetadataKey.SystemConfig] = farSchedule();
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastVerify: { at: new Date(Date.now() - 60 * 60 * 1000).toISOString(), status: 'failed' },
      });
      await expect(sut.handleVerifyCheck()).resolves.toBe(JobStatus.Skipped);

      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: {
          cloudBackup: { ...enabledConfig().frameleafCloud.cloudBackup, schedule: { cronExpression: '*/30 * * * *' } },
        },
      };
      await expect(sut.handleVerifyCheck()).resolves.toBe(JobStatus.Skipped);
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('starts a scheduled run that found a check holding the bucket once the check has ended', async () => {
      const snapshot = { version: 1, bucketRef: ref, keyFingerprint: fingerprint, task: 'verify' };
      const check = () => operationOf({ id: 'check-1', snapshot });
      operations.createExclusive.mockResolvedValueOnce({
        active: { id: 'check-1', ownerId: 'admin-1', fingerprint: null },
      });
      operations.getOfKind.mockResolvedValueOnce(check());

      await expect(sut.handleSchedule()).resolves.toBe(JobStatus.Success);
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ scheduledRunDueAt: expect.any(String) });

      // the check ends (here, it cannot open the bucket and fails); the run it held up is queued then
      await sut.run(check(), 'claim-1');

      expect(operations.createExclusive).toHaveBeenLastCalledWith(
        expect.objectContaining({ snapshot: expect.objectContaining({ task: 'backup', scheduled: true }) }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).not.toHaveProperty('scheduledRunDueAt');
    });
  });

  describe('clean-up (FL-164)', () => {
    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
    });

    it('asked for by hand, needs a dry run first', async () => {
      await expect(sut.startPrune(authStub.admin, { dryRun: false })).rejects.toThrow('Preview the clean-up first');

      await sut.startPrune(authStub.admin, { dryRun: true });
      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'Cloud backup clean-up preview',
          snapshot: expect.objectContaining({ dryRun: true }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );

      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastPrune: { dryRun: true, at: new Date().toISOString() },
      });
      await sut.startPrune(authStub.admin, { dryRun: false });
      expect(operations.createExclusive).toHaveBeenLastCalledWith(
        expect.objectContaining({
          label: 'Cloud backup clean-up',
          snapshot: expect.objectContaining({ dryRun: false }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudRestore] },
      );
    });

    it('needs a new dry run once a backup has run since the last one', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastPrune: { dryRun: true, at: new Date(Date.now() - 60_000).toISOString() },
        lastSuccessAt: new Date().toISOString(),
      });

      await expect(sut.startPrune(authStub.admin, { dryRun: false })).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('Frameleaf-managed storage (FL-164)', () => {
    const grant = cloudContractFixture('backup/grant-response.json');
    const rotated = cloudContractFixture('backup/grant-rotate-response.json');
    const managedRef = managedStorageRef(grant.storageId);
    const cloudUrl = 'https://cloud.frameleaf.test';
    const managedClaim = (overrides: Record<string, unknown> = {}) =>
      claim({
        target: 'managed',
        bucketRef: managedRef,
        endpoint: grant.endpoint,
        region: grant.region,
        bucket: grant.bucket,
        managed: {
          storageId: grant.storageId,
          location: grant.location,
          readOnly: false,
          readOnlyReason: null,
          quotaBytes: grant.quotaBytes,
          checkedAt: '2026-09-25T00:00:00.000Z',
        },
        ...overrides,
      });
    const managedOperation = () =>
      operationOf({ snapshot: { version: 1, bucketRef: managedRef, keyFingerprint: fingerprint } });

    beforeEach(() => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: '/identity', url: cloudUrl } }),
      );
      metadata[SystemMetadataKey.FrameleafCloudLink] = { status: 'linked', cloudUrl, instanceId: 'instance-1' };
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim();
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: { cloudBackup: { enabled: true, target: 'managed', keyMode: 'server' } },
      };
      keys.read.mockResolvedValue(keyFileOf());
      mocks.frameleafCloud.discovery.mockResolvedValue({ api: 'https://api.frameleaf.test' } as never);
      mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'token' } as never);
      cloudBackup.rotate.mockResolvedValue(rotated);
      vi.mocked(selectBackupLocation).mockResolvedValue({ ...grant.location, probeUrl: grant.endpoint });
    });

    it('rotates the key at the start of every run and never keeps it', async () => {
      await sut.run(managedOperation(), 'claim-1');

      expect(cloudBackup.rotate).toHaveBeenCalledTimes(1);
      expect(store.readMarker).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: grant.bucket, accessKeyId: rotated.credentials.accessKeyId }),
        key,
      );
      expect(operations.complete).toHaveBeenCalled();
      const secret = rotated.credentials.secretAccessKey;
      expect(JSON.stringify(metadata)).not.toContain(secret);
      expect(JSON.stringify(configWrites())).not.toContain(secret);
      expect(JSON.stringify(mocks.logger.log.mock.calls)).not.toContain(secret);
    });

    it('follows the first backup of the activation chain by push, ending it when the backup is done (FL-228)', async () => {
      await sut.run(managedOperation(), 'claim-1');

      const activation = mocks.event.emit.mock.calls
        .filter(([name]) => name === 'PushNotify')
        .map(([, notice]) => notice as PushNotice)
        .filter(({ type }) => type === PushEventType.CloudBackupActivation);
      expect(activation.length).toBeGreaterThanOrEqual(2);
      expect(activation[0]).toMatchObject({
        admins: true,
        activation: { step: 4, total: 4, stage: 'first-backup', state: 'active' },
      });
      expect(activation.at(-1)).toMatchObject({
        admins: true,
        body: '4 of 4 · First backup complete',
        systemTemplate: { version: 1, key: 'activation-first-backup-complete', args: { step: 4, total: 4 } },
        activation: { step: 4, stage: 'first-backup', state: 'complete', firstRun: 'done' },
      });
    });

    it('says storage is being prepared when managed setup starts (FL-228)', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
      cloudBackup.grant.mockRejectedValue(new Error('stop here'));

      await expect(
        sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: key.toString('base64') } as never),
      ).rejects.toThrow();

      expect(mocks.event.emit).toHaveBeenCalledWith(
        'PushNotify',
        expect.objectContaining({
          type: PushEventType.CloudBackupActivation,
          admins: true,
          body: '3 of 4 · Preparing storage',
          systemTemplate: { version: 1, key: 'activation-preparing-storage', args: { step: 3, total: 4 } },
          activation: expect.objectContaining({ step: 3, stage: 'preparing-storage', state: 'active' }),
        }),
      );
    });

    it('leaves the activation chain alone once a first backup has been done (FL-228)', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({ lastSuccessAt: '2026-09-20T00:00:00.000Z' });

      await sut.run(managedOperation(), 'claim-1');

      expect(mocks.event.emit).not.toHaveBeenCalledWith(
        'PushNotify',
        expect.objectContaining({ type: PushEventType.CloudBackupActivation }),
      );
    });

    it('stops uploads without touching this server’s files while the grant is read-only', async () => {
      cloudBackup.rotate.mockResolvedValue({ ...rotated, readOnly: true });

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('read-only') }),
      );
      expect(databaseBackup.createDatabaseBackup).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('pauses for a full plan, words it, and carries on by itself once the grant is writable (FL-301)', async () => {
      cloudBackup.rotate.mockResolvedValue({ ...rotated, readOnly: true, readOnlyReason: 'plan_full' });

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('because the Frameleaf plan is full') }),
      );
      expect((metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup).managed).toMatchObject({
        readOnly: true,
        readOnlyReason: 'plan_full',
      });
      expect(store.uploadFile).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();

      operations.fail.mockClear();
      cloudBackup.rotate.mockResolvedValue({ ...rotated, readOnly: false });
      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).not.toHaveBeenCalled();
      expect((metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup).managed).toMatchObject({
        readOnly: false,
        readOnlyReason: null,
      });
    });

    it('treats a read-only reason it does not know as read-only, worded generically (FL-301)', async () => {
      cloudBackup.rotate.mockResolvedValue({ ...rotated, readOnly: true, readOnlyReason: 'something_new' });

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({
          error: expect.stringMatching(
            /^Frameleaf-managed storage is read-only for this server, so backups are paused/,
          ),
        }),
      );
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('asks for no storage while Frameleaf Cloud suspects a copy of this server, and says so', async () => {
      metadata[SystemMetadataKey.FrameleafCloudLink] = {
        status: 'linked',
        cloudUrl,
        instanceId: 'instance-1',
        heartbeat: { cloneSuspected: true },
      };

      await sut.run(managedOperation(), 'claim-1');

      expect(cloudBackup.rotate).not.toHaveBeenCalled();
      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('copy of another one') }),
      );
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'AdminNotify',
        expect.objectContaining({ dedupeKey: 'frameleaf-cloud:clone-suspected' }),
      );
    });

    it('waits out a rate limit rather than failing', async () => {
      cloudBackup.rotate.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.CloudUnavailable,
          429,
          'rate limited',
          errorEnvelopeSchema.parse(cloudContractFixture('errors/rate-limited.json')),
          null,
          120,
        ),
      );

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.requeue).toHaveBeenCalledWith('run-1', 'claim-1', { delayMs: 120_000, returnAttempt: true });
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('stops on a withdrawn grant with the reason Frameleaf Cloud gave', async () => {
      cloudBackup.rotate.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.CloudUnavailable,
          410,
          'withdrawn',
          errorEnvelopeSchema.parse(cloudContractFixture('errors/grant-revoked.json')),
        ),
      );

      await sut.run(managedOperation(), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'run-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('unlinked from Frameleaf Cloud') }),
      );
    });

    it('sets up with the bucket Frameleaf Cloud grants, and keeps no credential for it', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
      metadata[SystemMetadataKey.SystemConfig] = {};
      cloudBackup.grant.mockResolvedValue(cloudContractFixture('backup/grant-metadata.json'));

      await sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: key.toString('base64') } as never);

      // a repeated grant answers without a key, so one is rotated for the claim
      expect(selectBackupLocation).toHaveBeenCalled();
      expect(cloudBackup.grant).toHaveBeenCalledWith(expect.anything(), grant.location.locationId);
      expect(vi.mocked(selectBackupLocation).mock.invocationCallOrder[0]).toBeLessThan(
        cloudBackup.grant.mock.invocationCallOrder[0],
      );
      expect(cloudBackup.rotate).toHaveBeenCalled();
      expect(store.claim).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: grant.bucket, secretAccessKey: rotated.credentials.secretAccessKey }),
        key,
        expect.anything(),
      );
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        target: 'managed',
        bucketRef: managedRef,
        bucket: grant.bucket,
        managed: {
          storageId: grant.storageId,
          location: grant.location,
          readOnly: false,
          quotaBytes: grant.quotaBytes,
        },
      });
      const persisted = JSON.stringify(configWrites());
      expect(persisted).toContain('"target":"managed"');
      expect(persisted).not.toContain(rotated.credentials.secretAccessKey);
      expect(cloudBackup.putSettings).toHaveBeenCalledWith(expect.anything(), {
        keyMode: 'server',
        scheduleEnabled: true,
      });
    });

    it('tests locations on this server before the first grant, and provisions nothing when selection fails', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
      const locations = [{ ...grant.location, probeUrl: grant.endpoint }];
      cloudBackup.locations.mockResolvedValue({ version: 2, locations });
      vi.mocked(selectBackupLocation).mockRejectedValue(new Error('provider detail must not escape'));

      await expect(
        sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: key.toString('base64') } as never),
      ).rejects.toThrow('No backup location could be reached reliably. Try setup again.');
      expect(selectBackupLocation).toHaveBeenCalledWith(locations);
      expect(cloudBackup.grant).not.toHaveBeenCalled();
      expect(cloudBackup.rotate).not.toHaveBeenCalled();
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('propagates the actual measured median and stable-ID winner into the first grant and persisted claim', async () => {
      // These are authored interfaces, not evidence of live Cloud provisioning or socket connectivity.
      const actual = await vi.importActual<typeof import('src/utils/backup-location-selection.js')>(
        'src/utils/backup-location-selection.js',
      );
      const locations = [
        { ...grant.location, locationId: 'loc-08', probeUrl: 'https://s3.eu-west-1.backup.frameleaf.cloud/' },
        { ...grant.location, locationId: 'loc-01', probeUrl: 'https://s3.eu-central-2.backup.frameleaf.cloud/' },
        { ...grant.location, probeUrl: `${grant.endpoint}/` },
      ];
      const samples: Record<string, number[]> = {
        's3.eu-west-1.backup.frameleaf.cloud': [70, 70, 80],
        's3.eu-central-2.backup.frameleaf.cloud': [1, 90, 100],
        's3.eu-central-1.backup.frameleaf.cloud': [70, 70, 1000],
      };
      let now = 0;
      const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
      vi.mocked(lookup).mockImplementation(((
        _host: string,
        _options: unknown,
        callback: (error: Error | null, addresses: LookupAddress[]) => void,
      ) => callback(null, [{ address: '8.8.8.8', family: 4 }])) as never);
      vi.mocked(request).mockImplementation(((
        url: URL,
        options: RequestOptions,
        respond: (response: unknown) => void,
      ) => {
        expect(options).toMatchObject({ method: 'HEAD', agent: false, rejectUnauthorized: true });
        expect(options).not.toHaveProperty('headers');
        const req = new EventEmitter() as EventEmitter & { end: () => void };
        req.end = () => {
          (options.lookup as LookupFunction)(url.hostname, {}, (error, address) => {
            expect(error).toBeNull();
            expect(address).toBe('8.8.8.8');
            now += samples[url.hostname].shift()!;
            respond({ statusCode: 200, resume: vi.fn() });
          });
        };
        return req;
      }) as never);
      vi.mocked(selectBackupLocation).mockImplementation((candidates) => actual.selectBackupLocation(candidates));
      metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
      metadata[SystemMetadataKey.SystemConfig] = {};
      const transport = vi.fn(
        (schema: { parse: (value: unknown) => unknown }, options: { url: string; method?: string }) => {
          if (options.url.endsWith('/locations')) {
            return Promise.resolve(schema.parse({ version: 2, locations }));
          }
          if (options.method !== 'POST') {
            return Promise.reject(
              new FrameleafCloudError(
                MlAdmissionRefusal.CloudUnavailable,
                404,
                'unclaimed',
                errorEnvelopeSchema.parse({ code: 'not-found', message: 'unclaimed', retryable: false }),
              ),
            );
          }
          return Promise.resolve(schema.parse(grant));
        },
      );
      const repository = new FrameleafCloudBackupRepository({ requestJson: transport } as never);
      cloudBackup.metadata = vi.fn<FrameleafCloudBackupRepository['metadata']>((target) => repository.metadata(target));
      cloudBackup.locations = vi.fn<FrameleafCloudBackupRepository['locations']>((target) =>
        repository.locations(target),
      );
      cloudBackup.grant = vi.fn<FrameleafCloudBackupRepository['grant']>((target, id) => repository.grant(target, id));
      try {
        await sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: key.toString('base64') } as never);
        expect(request).toHaveBeenCalledTimes(9);
        expect(Object.values(samples)).toEqual([[], [], []]);
        expect(cloudBackup.grant).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'loc-07');
        expect(transport).toHaveBeenLastCalledWith(expect.anything(), {
          method: 'POST',
          url: 'https://api.frameleaf.test/v2/backup/grant',
          dpop: expect.anything(),
          body: { locationId: 'loc-07' },
        });
        expect(vi.mocked(request).mock.invocationCallOrder.at(-1)).toBeLessThan(
          cloudBackup.grant.mock.invocationCallOrder[0],
        );
        expect(cloudBackup.rotate).not.toHaveBeenCalled();
        expect(store.claim).toHaveBeenCalledTimes(1);
        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
          bucketRef: managedRef,
          managed: { storageId: grant.storageId, location: grant.location },
        });
      } finally {
        clock.mockRestore();
        vi.mocked(request).mockReset();
        vi.mocked(lookup).mockReset();
      }
    });

    it.each([
      ['selected location', { ...grant, location: { ...grant.location, locationId: 'loc-01' } }, rotated],
      [
        'storage ID',
        cloudContractFixture('backup/grant-metadata.json'),
        { ...rotated, storageId: '0194b445-9c8a-7001-8000-000000000099' },
      ],
      [
        'bucket',
        cloudContractFixture('backup/grant-metadata.json'),
        { ...rotated, bucket: grant.bucket.replace('fl-eu-', 'fl-na-') },
      ],
      ['region', cloudContractFixture('backup/grant-metadata.json'), { ...rotated, region: 'us-east-1' }],
    ])(
      'refuses an initial setup grant/rotation %s mismatch before local claim or settings persistence',
      async (_field, offered, issued) => {
        metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
        metadata[SystemMetadataKey.SystemConfig] = {};
        // This refusal fixture has an existing fixed identity. Seed its metadata
        // so legitimate identity initialization is not mistaken for backup mutation.
        metadata[SystemMetadataKey.FrameleafInstance] = structuredClone(instance);
        const before = structuredClone(metadata);
        cloudBackup.grant.mockResolvedValue(offered);
        cloudBackup.rotate.mockResolvedValue(issued);
        await expect(
          sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: key.toString('base64') } as never),
        ).rejects.toThrow('different storage binding');
        expect(cloudBackup.grant).toHaveBeenCalledExactlyOnceWith(expect.anything(), grant.location.locationId);
        expect(store.claim).not.toHaveBeenCalled();
        expect(keys.write).not.toHaveBeenCalled();
        expect(configWrites()).toEqual([]);
        expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
        expect(cloudBackup.putSettings).not.toHaveBeenCalled();
        expect(metadata).toEqual(before);
      },
    );

    it('reuses the persisted location on setup retry without fetching or probing a new catalog', async () => {
      const recorded = cloudContractFixture('backup/grant-metadata.json');
      cloudBackup.metadata.mockResolvedValue(recorded);
      cloudBackup.grant.mockResolvedValue(grant);

      await sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: key.toString('base64') } as never);
      expect(cloudBackup.grant).toHaveBeenCalledWith(expect.anything(), recorded.location.locationId);
      expect(cloudBackup.locations).not.toHaveBeenCalled();
      expect(selectBackupLocation).not.toHaveBeenCalled();
    });

    it('keeps stable storage identity independently of the connection hostname but rejects a changed physical region or storage ID', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({
        endpoint: 'https://previous.backup.frameleaf.cloud',
      });
      await sut.run(managedOperation(), 'claim-1');
      expect(operations.complete).toHaveBeenCalled();
      expect((metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup).bucketRef).toBe(managedRef);

      operations.complete.mockClear();
      for (const changed of [
        { ...rotated, region: 'us-east-1' },
        { ...rotated, storageId: '0194b445-9c8a-7001-8000-000000000099' },
        { ...rotated, location: { ...rotated.location, locationId: 'loc-01' } },
        { ...rotated, bucket: rotated.bucket.replace('fl-eu-', 'fl-na-') },
      ]) {
        cloudBackup.rotate.mockResolvedValue(changed);
        await sut.run(managedOperation(), 'claim-1');
        expect(operations.fail).toHaveBeenCalledWith(
          'run-1',
          'claim-1',
          expect.objectContaining({ error: expect.stringContaining('different storage binding') }),
        );
      }
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('keeps an older address-based index identity unchanged without a backup-data migration', async () => {
      const oldRef = bucketRef(grant.endpoint, grant.bucket);
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({
        bucketRef: oldRef,
        managed: {
          readOnly: false,
          readOnlyReason: null,
          quotaBytes: grant.quotaBytes,
          checkedAt: '2026-09-25T00:00:00.000Z',
        },
      });
      await sut.run(
        operationOf({ snapshot: { version: 1, bucketRef: oldRef, keyFingerprint: fingerprint } }),
        'claim-1',
      );
      expect(operations.complete).toHaveBeenCalled();
      const saved = metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup;
      expect(saved.bucketRef).toBe(oldRef);
      expect(saved.managed?.storageId).toBeUndefined();
    });

    it('rejects a changed recorded legacy location before storage I/O or metadata replacement', async () => {
      const saved = managedClaim({
        bucketRef: bucketRef(grant.endpoint, grant.bucket),
        managed: {
          location: grant.location,
          readOnly: false,
          readOnlyReason: null,
          quotaBytes: grant.quotaBytes,
          checkedAt: '2026-09-25T00:00:00.000Z',
        },
      });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = saved;
      cloudBackup.rotate.mockResolvedValue({ ...rotated, location: { ...rotated.location, locationId: 'loc-01' } });

      await expect(sut['openManaged'](saved, managedOperation(), 'claim-1')).rejects.toThrow(
        'different storage binding',
      );
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toBe(saved);
      expect(store.get).not.toHaveBeenCalled();
      expect(store.uploadFile).not.toHaveBeenCalled();
    });

    it('rejects a rotation that disagrees with the POST binding during first setup before claiming storage', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = undefined;
      cloudBackup.grant.mockResolvedValue(cloudContractFixture('backup/grant-metadata.json'));
      for (const changed of [
        { ...rotated, region: 'us-east-1' },
        { ...rotated, storageId: '0194b445-9c8a-7001-8000-000000000099' },
        { ...rotated, bucket: rotated.bucket.replace('fl-eu-', 'fl-na-') },
      ]) {
        cloudBackup.rotate.mockResolvedValue(changed);
        await expect(
          sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: key.toString('base64') } as never),
        ).rejects.toThrow('different storage binding');
      }
      expect(store.claim).not.toHaveBeenCalled();
    });

    it('reclaims the same legacy binding without moving its index or dropping its history', async () => {
      const oldRef = bucketRef('https://previous.backup.frameleaf.cloud', grant.bucket);
      const lastSuccessAt = '2026-09-25T01:00:00.000Z';
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({
        bucketRef: oldRef,
        endpoint: 'https://previous.backup.frameleaf.cloud',
        lastSuccessAt,
        managed: { readOnly: false, readOnlyReason: null, quotaBytes: grant.quotaBytes, checkedAt: lastSuccessAt },
      });
      cloudBackup.metadata.mockResolvedValue(cloudContractFixture('backup/grant-metadata.json'));
      cloudBackup.grant.mockResolvedValue(grant);
      store.claim.mockResolvedValue({ existing: true, claimedAt: lastSuccessAt });
      await sut.setup(authStub.admin, { target: 'managed', keyMode: 'server', key: key.toString('base64') } as never);

      const saved = metadata[SystemMetadataKey.FrameleafCloudBackup] as FrameleafCloudBackup;
      expect(saved.bucketRef).toBe(oldRef);
      expect(saved.lastSuccessAt).toBe(lastSuccessAt);
      expect(saved.managed?.storageId).toBeUndefined();
      expect(index.deleteBucket).not.toHaveBeenCalled();
      expect(sut['managedConnection'](rotated, saved).region).toBe(grant.region);
    });

    it('does not serve a warm manifest cache after its recorded storage binding changes', async () => {
      const saved = managedClaim() as FrameleafCloudBackup;
      const key = 'm/2026-09-25T01:00:00.000Z.json.gz';
      index.listKeptManifests.mockResolvedValue([{ key }]);
      const manifest = {} as never;
      sut['manifestCache'] = {
        bucketRef: saved.bucketRef,
        key,
        manifest,
        binding: JSON.stringify([
          saved.bucketRef,
          saved.region,
          saved.bucket,
          saved.keyFingerprint,
          saved.managed?.storageId ?? null,
          saved.managed?.location?.locationId ?? null,
        ]),
      };
      await expect(sut['readManifestForRequest'](saved, key)).resolves.toBe(manifest);
      for (const changed of [
        { ...saved, region: 'us-east-1' },
        { ...saved, bucket: saved.bucket.replace('fl-eu-', 'fl-na-') },
        { ...saved, keyFingerprint: 'different-key-fingerprint' },
        { ...saved, managed: { ...saved.managed!, storageId: '0194b445-9c8a-7001-8000-000000000099' } },
        { ...saved, managed: { ...saved.managed!, location: { ...grant.location, locationId: 'loc-01' } } },
      ]) {
        await expect(sut['readManifestForRequest'](changed, key)).rejects.toThrow();
      }
      expect(store.get).not.toHaveBeenCalled();
    });
  });

  describe('key escrow (FL-164)', () => {
    const cloudUrl = 'https://cloud.frameleaf.test';

    beforeEach(() => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: '/identity', url: cloudUrl } }),
      );
      metadata[SystemMetadataKey.FrameleafCloudLink] = { status: 'linked', cloudUrl, instanceId: 'instance-1' };
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
      mocks.frameleafCloud.discovery.mockResolvedValue({ api: 'https://api.frameleaf.test' } as never);
      mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'token' } as never);
    });

    it(
      'sends only the scrypt-wrapped key, never the key or the passphrase (server key mode)',
      { timeout: SCRYPT_TEST_TIMEOUT_MS },
      async () => {
        const passphrase = 'correct horse battery staple';

        const status = await sut.storeEscrow(authStub.admin, { passphrase });

        const [, blob] = cloudBackup.putEscrow.mock.calls[0];
        expect(keyEscrowBlobSchema.safeParse(blob).success).toBe(true);
        await expect(unwrapBucketKey(blob, passphrase)).resolves.toEqual(key);
        const sent = JSON.stringify([cloudBackup.putEscrow.mock.calls, cloudBackup.putSettings.mock.calls]);
        expect(sent).not.toContain(key.toString('base64'));
        expect(sent).not.toContain(passphrase);
        expect(status.escrow).toMatchObject({ stored: true });
        expect(await savedConfig()).toMatchObject({
          frameleafCloud: { cloudBackup: { escrow: true } },
        });
      },
    );

    it('is never offered for your own key', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ keyMode: 'own-stored' });

      await expect(sut.storeEscrow(authStub.admin, { passphrase: 'correct horse battery staple' })).rejects.toThrow(
        'only available when this server generates its own backup key',
      );
      expect(cloudBackup.putEscrow).not.toHaveBeenCalled();
      expect(() =>
        sut.onConfigValidate({
          newConfig: { frameleafCloud: { cloudBackup: { enabled: false, keyMode: 'own-memory', escrow: true } } },
          oldConfig: {},
        } as never),
      ).toThrow('only available');
    });

    it('removes the copy from Frameleaf Cloud', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({ escrow: { storedAt: '2026-09-26T00:00:00.000Z' } });

      const status = await sut.removeEscrow(authStub.admin);

      expect(cloudBackup.deleteEscrow).toHaveBeenCalled();
      expect(status.escrow).toMatchObject({ stored: false });
    });
  });

  describe('FL234 owner history and thumbnails', () => {
    const manifestKey = 'm/20260926T030000Z.json.gz';
    const thumb = Buffer.from([255, 216, 255]);
    const thumbHash = createHash('sha256').update(thumb).digest('hex');
    const owner = authStub.user1.user.id;
    const dto = { manifestKey, limit: 10, offset: 0 };
    const kept = { key: manifestKey, status: 'complete', createdAt: new Date(), finishedAt: new Date() };
    const captured = () =>
      new Map([
        [
          'asset-1',
          {
            deletion: {
              ownerId: owner,
              deletedAt: new Date(),
              visibility: 'timeline',
              wasLocked: false,
              checksum: Buffer.from(SHA_A, 'hex'),
              checksumAlgorithm: 'sha256',
              evidenceVersion: 1,
              modernPrivacyEvidenceUnavailable: true,
            },
          },
        ],
      ]);
    const entry = (id: string) => ({
      owner: id,
      type: 'IMAGE',
      originalFileName: id === owner ? 'Own.jpg' : 'Secret.jpg',
      fileCreatedAt: '2026-09-01T00:00:00Z',
      fileModifiedAt: '2026-09-01T00:00:00Z',
      localDateTime: '2026-09-01T00:00:00Z',
      duration: null,
      details: EMPTY_DETAILS,
      files: [
        { role: 'original', path: '/private/path', sha256: SHA_A, size: 100, mtime: null },
        { role: 'thumbnail', path: '/private/thumb', sha256: thumbHash, size: thumb.length, mtime: null },
      ],
    });
    const refresh = () => vi.fn().mockResolvedValue(authStub.user1);
    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
      index.listKeptManifests.mockResolvedValue([kept]);
      index.getOwnerHistoryState.mockResolvedValue(captured());
      store.get = vi.fn().mockResolvedValue(
        gzipSync(
          JSON.stringify({
            format: 'frameleaf-backup-manifest',
            version: 2,
            instanceId: 'instance-1',
            createdAt: '2026-09-26T03:00:00Z',
            database: null,
            assets: { 'asset-1': entry(owner), 'foreign-1': entry('foreign') },
            profiles: {},
            albums: {},
            people: {},
          }),
        ),
      );
      store.getPreview = vi.fn().mockResolvedValue(thumb);
    });
    it('refuses forbidden metadata target before reading its original bytes', async () => {
      const folder = await mkdtemp(join(tmpdir(), 'owner-metadata-'));
      const target = join(folder, 'original.jpg');
      try {
        await writeFile(target, 'a');
        mocks.crypto.hashFile.mockResolvedValue(Buffer.from(SHA_A, 'hex'));
        index.withOwnerRestore = vi.fn().mockRejectedValue(new Error('current target forbidden'));
        await expect(
          sut['restoreOwnerLibrary'](
            operationOf() as MediaOperation,
            'claim',
            {} as CloudBackupManifest,
            { owner: { ownerId: owner, sessionId: 'session' }, assetIds: ['asset-1'] } as CloudBackupRestoreSnapshot,
            [{ assetId: 'asset-1', role: 'original', inPlace: true, target, sha256: SHA_A } as never],
            emptyRestoreResult(),
          ),
        ).rejects.toThrow('current target forbidden');
        expect(index.withOwnerRestore).toHaveBeenCalledOnce();
        expect(mocks.crypto.hashFile).not.toHaveBeenCalled();
      } finally {
        await rm(folder, { recursive: true, force: true });
      }
    });

    it('keeps a failed owner restore filename out of the public durable operation error', async () => {
      operations.fail.mockResolvedValue('failed');
      const operation = {
        id: 'owner-operation',
        kind: MediaOperationKind.CloudRestore,
        snapshot: { owner: { ownerId: owner } },
      } as unknown as MediaOperation;
      await sut['failTask'](
        operation,
        'claim',
        new Error('write failed /data/library/Locked-secret-name.jpg'),
        'Restore from cloud backup',
      );
      expect(operations.fail).toHaveBeenCalledWith(
        'owner-operation',
        'claim',
        expect.objectContaining({
          error:
            'The owner backup restore stopped. Already restored work is retained; check access and backup availability.',
          errorCode: 'cloud_restore_failed',
        }),
      );
    });

    it('queues only own bounded restore with a credentials-free immutable snapshot and allowlisted response', async () => {
      const elevated = { ...authStub.user1, session: { id: 'owner-session', hasElevatedPermission: true } };
      index.getOwnerRestoreIdentities.mockResolvedValue({});
      index.getAssetDetails.mockResolvedValue(new Map());
      const response = await sut.startOwnerRestore(
        elevated,
        { manifestKey, assetIds: ['asset-1'] },
        vi.fn().mockResolvedValue(elevated),
      );
      expect(Object.keys(response).sort()).toEqual(['operationId', 'status']);
      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: owner,
          settings: {},
          snapshot: expect.objectContaining({
            scope: 'asset',
            assetIds: ['asset-1'],
            owner: expect.objectContaining({ ownerId: owner, sessionId: 'owner-session' }),
          }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudBackup] },
      );
      expect(JSON.stringify(operations.createExclusive.mock.calls[0][0].snapshot)).not.toMatch(
        /token|password|bucketKey/i,
      );
    });
    it('refuses related album metadata changed after the immutable owner restore was submitted', async () => {
      const elevated = { ...authStub.user1, session: { id: 'owner-session', hasElevatedPermission: true } };
      index.getOwnerRestoreIdentities.mockResolvedValue({});
      index.getAssetDetails.mockResolvedValue(new Map());
      const backedUp = JSON.parse(
        gunzipSync(await (store.get as () => Promise<Buffer>)()).toString(),
      ) as CloudBackupManifest;
      backedUp.assets['asset-1'].details!.albums = [{ id: 'own-album', name: 'Original name' }];
      backedUp.albums['own-album'] = {
        name: 'Original name',
        description: '',
        ownerId: owner,
        coverAssetId: null,
        order: 'asc',
        sharedUsers: [],
      };
      store.get.mockResolvedValue(gzipSync(JSON.stringify(backedUp)));
      await sut.startOwnerRestore(
        elevated,
        { manifestKey, assetIds: ['asset-1'] },
        vi.fn().mockResolvedValue(elevated),
      );
      const snapshot = operations.createExclusive.mock.calls[0][0].snapshot as unknown as CloudBackupRestoreSnapshot;
      backedUp.albums['own-album'].name = 'Changed after submission';
      await expect(sut['checkOwnerRestoreItems'](elevated, backedUp, snapshot, true)).rejects.toThrow(
        'Backup item unavailable',
      );
    });

    it('refuses current external originals before creating an apparently supported owner restore', async () => {
      const elevated = { ...authStub.user1, session: { id: 'owner-session', hasElevatedPermission: true } };
      index.getOwnerRestoreIdentities.mockResolvedValue({
        'asset-1': {
          ownerId: owner,
          originalPath: '/external/Own.jpg',
          checksum: SHA_A,
          checksumAlgorithm: 'sha256',
          isExternal: true,
        },
      });
      index.getAssetDetails.mockResolvedValue(new Map());
      await expect(
        sut.startOwnerRestore(elevated, { manifestKey, assetIds: ['asset-1'] }, vi.fn().mockResolvedValue(elevated)),
      ).rejects.toThrow('external destination');
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('refuses duplicate and oversized owner selections before reading private backup metadata', async () => {
      for (const assetIds of [['asset-1', 'asset-1'], Array.from({ length: 101 }, (_, index) => `asset-${index}`)]) {
        await expect(sut.startOwnerRestore(authStub.user1, { manifestKey, assetIds }, refresh())).rejects.toThrow(
          'distinct',
        );
      }
      expect(store.get).not.toHaveBeenCalled();
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('refuses foreign selection, relocked session and unloaded key before queueing owner restore', async () => {
      const elevated = { ...authStub.user1, session: { id: 'owner-session', hasElevatedPermission: true } };
      index.getOwnerRestoreIdentities.mockResolvedValue({});
      index.getAssetDetails.mockResolvedValue(new Map());
      await expect(
        sut.startOwnerRestore(elevated, { manifestKey, assetIds: ['foreign-1'] }, vi.fn().mockResolvedValue(elevated)),
      ).rejects.toThrow('Backup item unavailable');
      await expect(sut.startOwnerRestore(elevated, { manifestKey, assetIds: ['asset-1'] }, refresh())).rejects.toThrow(
        'PIN',
      );
      keys.read.mockResolvedValue(null);
      await expect(
        sut.startOwnerRestore(elevated, { manifestKey, assetIds: ['asset-1'] }, vi.fn().mockResolvedValue(elevated)),
      ).rejects.toThrow('backup key file is missing');
      expect(operations.createExclusive).not.toHaveBeenCalled();
    });

    it('projects only own history and owner-scoped discovery with no paths/global owners', async () => {
      const result = await sut.listOwnerHistory(authStub.user1, dto, refresh());
      expect(result.total).toBe(1);
      expect(JSON.stringify(result)).not.toMatch(/Secret|private|foreign|ownerName|bucket/);
      expect(index.getOwnerNames).not.toHaveBeenCalled();
      expect(await sut.listOwnerBackups(authStub.user1, { limit: 1, offset: 0 }, refresh())).toMatchObject({
        backups: [{ manifestKey }],
        nextOffset: null,
      });
    });
    it('refuses revoked normal auth, shared links, changed owner, relock and pruned cached manifest', async () => {
      const revoked = refresh().mockRejectedValueOnce(new Error('revoked'));
      await expect(sut.listOwnerHistory(authStub.user1, dto, revoked)).rejects.toThrow('revoked');
      await expect(
        sut.listOwnerHistory(authStub.user1, dto, vi.fn().mockResolvedValue(authStub.adminSharedLink)),
      ).rejects.toThrow('Owner backup access');
      index.getOwnerHistoryState.mockResolvedValue(new Map([['asset-1', { ownerId: 'foreign', allowed: false }]]));
      expect((await sut.listOwnerHistory(authStub.user1, dto, refresh())).total).toBe(0);
      index.listKeptManifests.mockResolvedValue([]);
      await expect(sut.listOwnerHistory(authStub.user1, dto, refresh())).rejects.toThrow('not one of the kept backups');
    });
    it('rechecks privacy after thumbnail I/O and never returns stale authorized bytes', async () => {
      store.getPreview = vi.fn<() => Promise<Buffer>>(() => {
        index.getOwnerHistoryState.mockResolvedValue(new Map([['asset-1', { ownerId: owner, allowed: false }]]));
        return Promise.resolve(thumb);
      });
      await expect(sut.readOwnerThumbnail(authStub.user1, 'asset-1', manifestKey, refresh())).rejects.toThrow(
        'Backup preview unavailable',
      );
      expect(store.getPreview).toHaveBeenCalledWith(expect.anything(), `o/${thumbHash}`, key, thumbHash, thumb.length);
    });
    it('does not read foreign/missing thumbnails or disclose provider errors and requires a loaded key', async () => {
      await expect(sut.readOwnerThumbnail(authStub.user1, 'foreign-1', manifestKey, refresh())).rejects.toThrow(
        'Backup preview unavailable',
      );
      expect(store.getPreview).not.toHaveBeenCalled();
      store.getPreview.mockRejectedValueOnce(new Error('/private/provider-key'));
      await expect(sut.readOwnerThumbnail(authStub.user1, 'asset-1', manifestKey, refresh())).rejects.toThrow(
        'Backup preview unavailable',
      );
      keys.read.mockResolvedValue(null);
      await expect(sut.listOwnerHistory(authStub.user1, dto, refresh())).rejects.toThrow('backup key file is missing');
    });
  });

  describe('restore (FL-164)', () => {
    const manifestKey = 'm/20260926T030000Z.json.gz';
    const kept = {
      key: manifestKey,
      status: 'complete',
      databaseKey: dumpKey,
      createdAt: new Date('2026-09-26T03:00:00.000Z'),
      finishedAt: null,
      assetCount: 1,
      fileCount: 1,
      bytes: 100,
    };
    const manifestBody = gzipSync(
      JSON.stringify({
        format: 'frameleaf-backup-manifest',
        version: 1,
        instanceId: 'instance-1',
        createdAt: '2026-09-26T03:00:00.000Z',
        database: { key: dumpKey, sha256: SHA_DUMP, size: 50 },
        assets: {
          'asset-1': {
            owner: 'owner-1',
            files: [{ role: 'original', path: '/data/library/IMG_1.jpg', sha256: SHA_A, size: 100, mtime: null }],
          },
        },
        profiles: {},
      }),
    );
    const restoreOperation = (scope: string, assetIds: string[] | null = null) =>
      operationOf({
        id: 'restore-1',
        kind: MediaOperationKind.CloudRestore,
        snapshot: { version: 1, bucketRef: ref, keyFingerprint: fingerprint, manifestKey, scope, assetIds },
      });

    beforeEach(() => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
      index.listKeptManifests.mockResolvedValue([kept]);
      store.get = vi.fn().mockResolvedValue(manifestBody);
      store.download = vi
        .fn()
        .mockImplementation((_connection, _key, _bucketKey, _target, sha256: string) =>
          Promise.resolve({ size: 1, sha256 }),
        );
    });

    it('queues a restore under the bucket lock, named without the item, only from a kept backup', async () => {
      await expect(
        sut.startRestore(authStub.admin, { manifestKey: 'm/20250101T030000Z.json.gz', scope: 'files' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        sut.startRestore(authStub.admin, { manifestKey, scope: 'asset', assetIds: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await sut.startRestore(authStub.admin, {
        manifestKey,
        scope: 'asset',
        assetIds: ['8c5c3a24-2f65-4a8e-b3d4-3f1c3cb0c3e1'],
      });

      expect(operations.createExclusive).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.CloudRestore,
          label: 'Restore an item from cloud backup',
          snapshot: expect.objectContaining({ manifestKey, scope: 'asset' }),
        }),
        DatabaseLock.FrameleafCloudBackup,
        { alsoKinds: [MediaOperationKind.CloudBackup] },
      );
    });

    it('is refused while a backup operation holds the bucket', async () => {
      operations.createExclusive.mockResolvedValue({ active: { id: 'run-1', ownerId: 'admin', fingerprint: null } });

      await expect(sut.startRestore(authStub.admin, { manifestKey, scope: 'database' })).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('restores files into the restore folder as a cloud_restore operation, each checked by its hash', async () => {
      await sut.run(restoreOperation('files'), 'claim-1');

      expect(store.download).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: s3.bucket }),
        `o/${SHA_A}`,
        key,
        expect.stringMatching(/frameleaf\/restore\/restore-1\/asset-1\/original-IMG_1\.jpg$/),
        SHA_A,
      );
      expect(operations.complete).toHaveBeenCalledWith(
        'restore-1',
        'claim-1',
        { resultAssetId: null },
        undefined,
        true,
      );
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
        lastRestore: { operationId: 'restore-1', scope: 'files', status: 'completed', files: 1 },
      });
    });

    it('records a restore cancelled at its end as cancelled, never as completed', async () => {
      operations.setBulkResult.mockResolvedValue({ ...running, cancelRequestedAt: new Date() });

      await sut.run(restoreOperation('asset', ['asset-1']), 'claim-1');

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith('restore-1', 'claim-1', { released: false });
      expect(operations.complete).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRestore: { status: 'cancelled' } });
    });

    it('stops with a report when an object does not match its checksum', async () => {
      store.download = vi.fn().mockRejectedValue(new CloudBackupStoreError('mismatch', null, 'ChecksumMismatch'));

      await sut.run(restoreOperation('files'), 'claim-1');

      expect(operations.fail).toHaveBeenCalledWith(
        'restore-1',
        'claim-1',
        expect.objectContaining({ error: expect.stringContaining('does not match its checksum') }),
      );
      expect(operations.complete).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ lastRestore: { status: 'failed' } });
    });

    it('restores on bare metal from the newest backup, with the bucket and the key alone', async () => {
      metadata = {};
      store.listAll = vi
        .fn()
        .mockImplementation((_connection, prefix: string, onPage: (objects: unknown[]) => Promise<void>) =>
          prefix === 'm/'
            ? onPage([
                { key: 'm/20260925T030000Z.json.gz', size: 1, etag: null },
                { key: manifestKey, size: 1, etag: null },
                { key: 'm/notes.txt', size: 1, etag: null },
              ]).then(() => 3)
            : Promise.resolve(0),
        );
      const lines: string[] = [];

      const result = await sut.restoreFromBucket(
        { s3, key: key.toString('base64'), scope: 'files', restoreDatabase: false },
        (line) => {
          lines.push(line);
        },
      );

      expect(store.readMarker).toHaveBeenCalledWith(expect.objectContaining({ bucket: s3.bucket }), key);
      expect(store.get).toHaveBeenCalledWith(expect.anything(), manifestKey, key);
      expect(result).toMatchObject({ manifestKey, files: 1, databaseRestored: false });
      expect(lines.join('\n')).not.toContain(key.toString('base64'));
    });

    it('refuses a cached manifest after it stops being kept', async () => {
      await sut.listManifestItems({ manifestKey });
      index.listKeptManifests.mockResolvedValue([]);
      await expect(sut.listManifestItems({ manifestKey })).rejects.toThrow('not one of the kept backups');
    });

    it('lists the items a backup holds with whether each is still in the library', async () => {
      index.getLibraryState.mockResolvedValue(new Map());

      const found = await sut.listManifestItems({ manifestKey, query: 'img', filter: 'deleted' });

      expect(found).toEqual({
        manifestKey,
        total: 1,
        items: [
          expect.objectContaining({
            assetId: 'asset-1',
            name: 'IMG_1.jpg',
            state: 'deleted',
            bytes: 100,
            hasDetails: false,
          }),
        ],
      });
    });

    it('brings details back only for an item or an album', async () => {
      await expect(
        sut.startRestore(authStub.admin, { manifestKey, scope: 'files', details: 'fill' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.startRestore(authStub.admin, { manifestKey, scope: 'album' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('asks for a newer backup when this one was made before albums were recorded', async () => {
      await expect(
        sut.startRestore(authStub.admin, { manifestKey, scope: 'album', albumId: ALBUM_ID }),
      ).rejects.toThrow('made before albums were recorded');
    });

    describe('albums and details (manifest v2)', () => {
      const record = {
        type: 'IMAGE',
        originalFileName: 'IMG_1.jpg',
        fileCreatedAt: '2026-08-14T07:12:00.000Z',
        fileModifiedAt: '2026-08-14T07:12:00.000Z',
        localDateTime: '2026-08-14T09:12:00.000Z',
        duration: null,
      };
      const detailsOf = (stack: { id: string; isPrimary: boolean } | null = null) => ({
        isFavorite: true,
        visibility: 'timeline',
        rating: 5,
        description: 'Lake',
        dateTimeOriginal: null,
        timeZone: null,
        latitude: null,
        longitude: null,
        tags: [],
        albums: [{ id: ALBUM_ID, name: 'Lake house' }],
        faces: [],
        stack,
        edits: [],
      });
      const album = {
        name: 'Lake house',
        description: '',
        ownerId: 'owner-1',
        coverAssetId: 'asset-1',
        order: 'desc',
        sharedUsers: [],
      };
      const v2Body = gzipSync(
        JSON.stringify({
          format: 'frameleaf-backup-manifest',
          version: 2,
          instanceId: 'instance-1',
          createdAt: '2026-09-26T03:00:00.000Z',
          database: null,
          assets: {
            'asset-1': {
              owner: 'owner-1',
              files: [
                { role: 'original', path: '/data/library/IMG_1.jpg', sha256: SHA_A, size: 100, mtime: null },
                { role: 'sidecar', path: '/data/library/IMG_1.jpg.xmp', sha256: SHA_SIDECAR, size: 5, mtime: null },
              ],
              ...record,
              details: detailsOf({ id: 'stack-1', isPrimary: true }),
            },
            'asset-2': {
              owner: 'owner-1',
              files: [{ role: 'original', path: '/data/library/IMG_2.jpg', sha256: SHA_B, size: 100, mtime: null }],
              ...record,
              originalFileName: 'IMG_2.jpg',
              details: detailsOf(),
            },
            'asset-3': {
              owner: 'owner-1',
              files: [{ role: 'original', path: '/data/library/IMG_3.jpg', sha256: SHA_C, size: 100, mtime: null }],
              ...record,
              details: { ...detailsOf(), albums: [] },
            },
          },
          profiles: {},
          albums: { [ALBUM_ID]: album },
          people: {},
        }),
      );
      const libraryAsset = {
        status: 'active',
        ownerId: 'owner-1',
        originalPath: '/data/library/IMG_2.jpg',
        isExternal: false,
        locked: false,
      };

      beforeEach(() => {
        store.get = vi.fn().mockResolvedValue(v2Body);
      });

      it('queues an album restore with the album’s items from the backup and how their details come back', async () => {
        await sut.startRestore(authStub.admin, { manifestKey, scope: 'album', albumId: ALBUM_ID, details: 'fill' });

        expect(operations.createExclusive).toHaveBeenCalledWith(
          expect.objectContaining({
            label: 'Restore an album from cloud backup',
            snapshot: expect.objectContaining({
              scope: 'album',
              albumId: ALBUM_ID,
              assetIds: ['asset-1', 'asset-2'],
              details: 'fill',
            }),
          }),
          DatabaseLock.FrameleafCloudBackup,
          { alsoKinds: [MediaOperationKind.CloudBackup] },
        );
        await expect(
          sut.startRestore(authStub.admin, {
            manifestKey,
            scope: 'album',
            albumId: '0f0d1e2c-3b4a-4c5d-8e6f-7a8b9c0d1e2f',
          }),
        ).rejects.toThrow('does not hold the album');
      });

      it('restores an album: its deleted items made again, the others’ details back, then the album', async () => {
        index.getLibraryState = vi
          .fn()
          .mockImplementation((ids: string[]) =>
            Promise.resolve(new Map(ids.includes('asset-2') ? [['asset-2', libraryAsset]] : [])),
          );
        const current = { record, details: { ...detailsOf(), isFavorite: false, albums: [] } };
        index.getAssetDetails.mockResolvedValue(new Map([['asset-2', current]]));
        const operation = operationOf({
          id: 'restore-1',
          kind: MediaOperationKind.CloudRestore,
          snapshot: {
            version: 1,
            bucketRef: ref,
            keyFingerprint: fingerprint,
            manifestKey,
            scope: 'album',
            assetIds: ['asset-1', 'asset-2'],
            albumId: ALBUM_ID,
            details: 'replace',
          },
        });

        await sut.run(operation, 'claim-1');

        expect(details.recreate).toHaveBeenCalledOnce();
        expect(details.recreate).toHaveBeenCalledWith(
          expect.objectContaining({
            assetId: 'asset-1',
            ownerId: 'owner-1',
            record,
            sha256: SHA_A,
            originalPath: '/data/library/IMG_1.jpg',
            sidecarPath: '/data/library/IMG_1.jpg.xmp',
          }),
        );
        expect(details.putBack).toHaveBeenCalledWith(
          expect.objectContaining({ assetId: 'asset-2', mode: 'replace', current: current.details }),
        );
        expect(details.restoreStacks).toHaveBeenCalledWith([
          { assetId: 'asset-1', ownerId: 'owner-1', stack: { id: 'stack-1', isPrimary: true } },
        ]);
        expect(details.restoreAlbum).toHaveBeenCalledWith({
          albumId: ALBUM_ID,
          album,
          memberIds: ['asset-1', 'asset-2'],
        });
        expect(operations.complete).toHaveBeenCalledWith(
          'restore-1',
          'claim-1',
          { resultAssetId: null },
          undefined,
          true,
        );
        expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({
          lastRestore: { scope: 'album', status: 'completed', recreated: 1, detailsRestored: 1 },
        });
      });

      it('keeps current details when asked, and gives a deleted item back as its owner’s copy of the same file', async () => {
        details.recreate.mockResolvedValue({ status: 'duplicate', assetId: 'asset-9' });
        const operation = operationOf({
          id: 'restore-1',
          kind: MediaOperationKind.CloudRestore,
          snapshot: {
            version: 1,
            bucketRef: ref,
            keyFingerprint: fingerprint,
            manifestKey,
            scope: 'album',
            assetIds: ['asset-1'],
            albumId: ALBUM_ID,
            details: 'keep',
          },
        });

        await sut.run(operation, 'claim-1');

        expect(details.putBack).not.toHaveBeenCalled();
        expect(details.restoreAlbum).toHaveBeenCalledWith(expect.objectContaining({ memberIds: ['asset-9'] }));
      });

      it('lists deleted albums and albums missing items, by name', async () => {
        index.getAlbumMembers.mockResolvedValue(new Map());
        index.getOwnerNames.mockResolvedValue(new Map([['owner-1', 'Taylor']]));

        await expect(sut.listManifestAlbums({ manifestKey })).resolves.toEqual({
          manifestKey,
          hasDetails: true,
          albums: [
            {
              albumId: ALBUM_ID,
              name: 'Lake house',
              ownerId: 'owner-1',
              ownerName: 'Taylor',
              items: 2,
              missing: 2,
              state: 'deleted',
            },
          ],
        });

        index.getAlbumMembers.mockResolvedValue(new Map([[ALBUM_ID, new Set(['asset-1'])]]));
        sut['manifestCache'] = undefined;
        await expect(sut.listManifestAlbums({ manifestKey })).resolves.toMatchObject({
          albums: [{ state: 'missing-items', missing: 1 }],
        });

        index.getAlbumMembers.mockResolvedValue(new Map([[ALBUM_ID, new Set(['asset-1', 'asset-2'])]]));
        sut['manifestCache'] = undefined;
        await expect(sut.listManifestAlbums({ manifestKey })).resolves.toMatchObject({ albums: [] });
      });
    });
  });

  describe('FL-234 owner setup progress', () => {
    const grant = cloudContractFixture('backup/grant-response.json');
    const cloudUrl = 'https://cloud.frameleaf.test';
    const managedRef = bucketRef(grant.endpoint, grant.bucket);
    const managedClaim = (overrides: CloudBackupClaimOverrides = {}) =>
      claim({ target: 'managed', bucketRef: managedRef, endpoint: grant.endpoint, bucket: grant.bucket, ...overrides });
    const ALLOWED = ['bucketClaimed', 'claimedAt', 'entitlement', 'firstRun', 'keyLoaded', 'nextRunAt', 'target'];
    const useManaged = ({ linked }: { linked: boolean }) => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir: '/identity', url: cloudUrl } }),
      );
      if (linked) {
        metadata[SystemMetadataKey.FrameleafCloudLink] = { status: 'linked', cloudUrl, instanceId: 'instance-1' };
      }
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: { cloudBackup: { enabled: true, target: 'managed', keyMode: 'server' } },
      };
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it('reports nothing started before setup', async () => {
      const setup = await sut.getOwnerSetup(authStub.admin);

      expect(setup).toEqual({
        target: 'off',
        entitlement: 'not-applicable',
        bucketClaimed: false,
        claimedAt: null,
        keyLoaded: false,
        firstRun: 'not-started',
        nextRunAt: null,
      });
      expect(cloudBackup.usage).not.toHaveBeenCalled();
    });

    it('reports an own bucket claimed, its key loaded and a first run in progress', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());
      operations.getActiveOfKind.mockResolvedValue({ id: 'run-1' });
      operations.getOfKind.mockResolvedValue(operationOf({ status: MediaOperationStatus.Rendering }));

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({
        target: 'byo-s3',
        entitlement: 'not-applicable',
        bucketClaimed: true,
        claimedAt: '2026-09-25T00:00:00.000Z',
        keyLoaded: true,
        firstRun: 'running',
      });
    });

    it('reports a queued first run as queued', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      operations.getActiveOfKind.mockResolvedValue({ id: 'run-1' });
      operations.getOfKind.mockResolvedValue(operationOf({ status: MediaOperationStatus.Queued }));

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({ firstRun: 'queued' });
    });

    it('keeps the entitlement pending while managed storage waits for a link', async () => {
      useManaged({ linked: false });

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({
        target: 'managed',
        entitlement: 'pending',
        bucketClaimed: false,
      });
    });

    it('keeps the entitlement pending when Frameleaf Cloud refused it for the plan', async () => {
      useManaged({ linked: true });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim();
      keys.read.mockResolvedValue(keyFileOf());
      mocks.frameleafCloud.discovery.mockResolvedValue({ api: 'https://api.frameleaf.test' } as never);
      mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'token' } as never);
      cloudBackup.rotate.mockRejectedValue(
        new FrameleafCloudError(
          MlAdmissionRefusal.CloudUnavailable,
          403,
          'entitlement',
          errorEnvelopeSchema.parse(cloudContractFixture('errors/entitlement-missing.json')),
        ),
      );
      await sut.run(operationOf({ snapshot: { version: 1, bucketRef: managedRef, keyFingerprint: fingerprint } }), 'c');

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({
        entitlement: 'pending',
        bucketClaimed: true,
      });
    });

    it('tells the safety status that managed storage is paused for a full plan (FL-301)', async () => {
      useManaged({ linked: true });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({
        managed: { readOnly: true, readOnlyReason: 'plan_full', quotaBytes: 1, checkedAt: '2020-01-01T00:00:00.000Z' },
      });
      keys.read.mockResolvedValue(keyFileOf());

      await expect(sut.getSafetyAvailability()).resolves.toMatchObject({
        readOnly: true,
        readOnlyReason: 'plan_full',
      });
    });

    it('reports the entitlement seen once managed storage is linked and not refused, without asking Cloud', async () => {
      useManaged({ linked: true });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = managedClaim({
        managed: {
          readOnly: false,
          readOnlyReason: null,
          quotaBytes: 1,
          checkedAt: '2020-01-01T00:00:00.000Z',
          usage: { measuredAt: null, bytesCurrent: 0, objects: 0, allowanceBytes: 1, extraBlocks: 0 },
        },
      });

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({ entitlement: 'seen' });
      expect(cloudBackup.usage).not.toHaveBeenCalled();
      expect(mocks.frameleafCloud.discovery).not.toHaveBeenCalled();
    });

    it('reports the first run done once any backup succeeded', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastSuccessAt: '2026-09-26T04:00:00.000Z',
        lastRun: { operationId: 'run-2', status: 'failed', startedAt: '2026-09-27T04:00:00.000Z', error: 'x' },
      });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      operations.getActiveOfKind.mockResolvedValue({ id: 'run-3' });
      operations.getOfKind.mockResolvedValue(operationOf({ status: MediaOperationStatus.Rendering }));

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({ firstRun: 'done' });
    });

    it('reports a first run that failed', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastRun: { operationId: 'run-1', status: 'failed', startedAt: '2026-09-26T04:00:00.000Z', error: 'IMG_1.jpg' },
      });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({ firstRun: 'failed' });
    });

    it('computes the next scheduled run from the configured schedule', async () => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-06-15T12:00:00.000Z') });
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: {
          cloudBackup: { ...enabledConfig().frameleafCloud.cloudBackup, schedule: { cronExpression: '0 4 * * *' } },
        },
      };

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({
        nextRunAt: '2026-06-16T04:00:00.000Z',
      });
    });

    it('has no next run while cloud backup is turned off', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: { cloudBackup: { ...enabledConfig().frameleafCloud.cloudBackup, enabled: false } },
      };

      await expect(sut.getOwnerSetup(authStub.admin)).resolves.toMatchObject({ target: 'off', nextRunAt: null });
    });

    it('refuses a user who is not the server owner', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim();

      await expect(sut.getOwnerSetup(authStub.user1)).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.systemMetadata.get).not.toHaveBeenCalled();
    });

    it('exposes only the setup fields, never bucket, key, usage or error details', async () => {
      metadata[SystemMetadataKey.FrameleafCloudBackup] = claim({
        lastRun: { operationId: 'run-1', status: 'failed', startedAt: '2026-09-26T04:00:00.000Z', error: 'IMG_1.jpg' },
      });
      metadata[SystemMetadataKey.SystemConfig] = enabledConfig();
      keys.read.mockResolvedValue(keyFileOf());

      const setup = await sut.getOwnerSetup(authStub.admin);

      expect(Object.keys(setup).sort()).toEqual(ALLOWED);
      const text = JSON.stringify(setup);
      for (const secret of [s3.bucket, s3.endpoint, 'eu-central-2', 'instance-1', fingerprint, 'IMG_1.jpg', 'run-1']) {
        expect(text).not.toContain(secret);
      }
    });
  });
});
