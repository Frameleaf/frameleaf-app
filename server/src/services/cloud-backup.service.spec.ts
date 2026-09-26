import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import type { CloudBackupEntry } from 'src/repositories/cloud-backup-index.repository.js';
import { DatabaseLock, MediaOperationKind, MediaOperationStatus, SystemMetadataKey } from 'src/enum.js';
import {
  CloudBackupClaimError,
  CloudBackupFileChangedError,
  CloudBackupStoreError,
} from 'src/repositories/cloud-backup-store.repository.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import { CloudBackupService, MANAGED_STORAGE_UNAVAILABLE } from 'src/services/cloud-backup.service.js';
import { backupKeyFile, bucketRef, keyFingerprint } from 'src/utils/cloud-backup.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getMocks } from 'test/utils.js';

const hex = (text: string) => createHash('sha256').update(text).digest('hex');
const SHA_A = hex('a');
const SHA_B = hex('b');
const SHA_C = hex('c');
const SHA_SIDECAR = hex('sidecar');
const SHA_DUMP = hex('dump');

const key = Buffer.alloc(32, 7);
const fingerprint = keyFingerprint(key);
const s3 = {
  endpoint: 'https://s3.eu-central-2.wasabisys.test',
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
const claim = (overrides: Record<string, unknown> = {}) => ({
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
});
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

describe(CloudBackupService.name, () => {
  let sut: CloudBackupService;
  let mocks: ReturnType<typeof getMocks>;
  let metadata: Record<string, unknown>;
  let operations: Record<string, ReturnType<typeof vi.fn>>;
  let store: Record<string, ReturnType<typeof vi.fn>>;
  let index: Record<string, ReturnType<typeof vi.fn>>;
  let keys: Record<string, ReturnType<typeof vi.fn>>;
  let databaseBackup: Record<string, ReturnType<typeof vi.fn>>;
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
    );

  const uploadedKeys = () => store.uploadFile.mock.calls.map(([, objectKey]) => objectKey as string);
  const manifestOf = (at = 0) => JSON.parse(gunzipSync(streamed[at]).toString());
  type Recorded = { mock: { calls: unknown[][]; invocationCallOrder: number[] } };
  const orderOf = (recorded: Recorded, predicate: (args: unknown[]) => boolean) =>
    recorded.mock.invocationCallOrder[recorded.mock.calls.findIndex((args) => predicate(args))];

  beforeEach(() => {
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
      getLatestManifestDatabaseKey: vi.fn().mockResolvedValue(null),
      endAbandonedManifests: vi.fn().mockResolvedValue(0),
      countAssets: vi.fn().mockResolvedValue(3),
      listAssets: vi.fn().mockResolvedValue([]),
      listProfileImages: vi.fn().mockResolvedValue([]),
    };
    keys = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue({ path: '/identity/cloud-backup.key', created: true }),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    databaseBackup = {
      createDatabaseBackup: vi.fn().mockResolvedValue('/data/backups/cloud-backup-immich-db-backup-dump.sql.gz'),
    };
    sut = build();
    // an own-memory key is asked for without waiting; a spec that needs the wait sets it
    sut.keyAskMs = 0;
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
      const [persisted, saved] = mocks.forkSchema.persistConfig.mock.calls.at(-1)!;
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

    it('refuses Frameleaf-managed storage until Frameleaf Cloud offers it', async () => {
      await expect(setup({ target: 'managed' })).rejects.toThrow(MANAGED_STORAGE_UNAVAILABLE);
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
      expect(mocks.forkSchema.persistConfig).not.toHaveBeenCalled();
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
      expect(mocks.forkSchema.persistConfig).not.toHaveBeenCalled();
    });
  });

  describe('own-memory key', () => {
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

      expect(databaseBackup.createDatabaseBackup).toHaveBeenCalledWith('cloud-backup-');
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
        version: 1,
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

    it('keeps the newest seven dumps and the dump of the newest complete backup', async () => {
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
      index.getLatestManifestDatabaseKey.mockResolvedValue(older[0]);

      await sut.run(operationOf(), 'claim-1');

      const deleted = store.delete.mock.calls.map(([, name]) => name as string);
      // the current dump and the six newest earlier ones stay; the oldest stays because the newest complete
      // manifest names it; every other dump goes, whatever older manifest named it
      expect(deleted.toSorted()).toEqual([older[1], older[2]]);
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
        'cloud-backup-immich-db-backup-20260925T030000-v2.0.0-pg16.4.sql.gz.tmp',
        'immich-db-backup-20260925T020000-v2.0.0-pg16.4.sql.gz',
      ]);

      await sut.run(operationOf(), 'claim-1');

      expect(mocks.storage.unlink).toHaveBeenCalledWith(
        expect.stringContaining('cloud-backup-immich-db-backup-20260925T030000-v2.0.0-pg16.4.sql.gz.tmp'),
      );
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(
        expect.stringContaining('/immich-db-backup-20260925T020000'),
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

      expect(operations.requestPause).toHaveBeenCalledWith('run-1', 'other-admin', [MediaOperationKind.CloudBackup]);
      expect(operations.resume).toHaveBeenCalledWith('run-1', 'other-admin');
      expect(operations.requestCancel).toHaveBeenCalledWith('run-1', 'other-admin');
    });

    it('turns cloud backup off and keeps the claim and the key', async () => {
      await sut.turnOff(authStub.admin);

      expect(mocks.forkSchema.persistConfig.mock.calls.at(-1)![1]).toMatchObject({
        frameleafCloud: { cloudBackup: { enabled: false } },
      });
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toMatchObject({ bucketRef: ref });
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
});
