import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
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
const enabledConfig = (keyMode = 'server', include = { thumbs: false, encodedVideo: false }) => ({
  frameleafCloud: { cloudBackup: { enabled: true, target: 'byo-s3', s3, keyMode, include } },
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
  files,
});

describe(CloudBackupService.name, () => {
  let sut: CloudBackupService;
  let mocks: ReturnType<typeof getMocks>;
  let metadata: Record<string, unknown>;
  let operations: Record<string, ReturnType<typeof vi.fn>>;
  let store: Record<string, ReturnType<typeof vi.fn>>;
  let index: Record<string, ReturnType<typeof vi.fn>>;
  let keys: Record<string, ReturnType<typeof vi.fn>>;
  let databaseBackup: Record<string, ReturnType<typeof vi.fn>>;

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

  beforeEach(() => {
    mocks = getMocks();
    metadata = {};
    mocks.systemMetadata.get.mockImplementation((name: string) => Promise.resolve(metadata[name]));
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
      delete: vi.fn().mockResolvedValue(undefined),
      listAll: vi.fn().mockResolvedValue(0),
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
      getEntries: vi.fn().mockResolvedValue([]),
      deleteEntries: vi.fn().mockResolvedValue(undefined),
      countAssets: vi.fn().mockResolvedValue(3),
      listAssets: vi.fn().mockResolvedValue([]),
      listProfileImages: vi.fn().mockResolvedValue([]),
    };
    keys = {
      read: vi.fn().mockResolvedValue(null),
      write: vi.fn().mockResolvedValue('/identity/cloud-backup.key'),
    };
    databaseBackup = {
      createDatabaseBackup: vi.fn().mockResolvedValue('/data/backups/cloud-backup-immich-db-backup-dump.sql.gz'),
    };
    sut = build();
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
      expect(keys.write).not.toHaveBeenCalled();
      expect(mocks.forkSchema.persistConfig).not.toHaveBeenCalled();
      expect(metadata[SystemMetadataKey.FrameleafCloudBackup]).toBeUndefined();
    });

    it('refuses an HTTP storage address and a key that is not 256 bits', async () => {
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
      index.getEntries.mockResolvedValue([
        {
          fileKey: 'asset-1:original',
          assetId: 'asset-1',
          ownerId: 'owner-1',
          role: 'original',
          path: '/a',
          sha256: SHA_A,
          size: 100,
          mtime: new Date(),
        },
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

      const [, manifestKey, body, bucketKey] = store.put.mock.calls[0];
      expect(manifestKey).toBe('m/20260926T030000Z.json.gz');
      expect(bucketKey).toEqual(key);
      const manifest = JSON.parse(gunzipSync(body as Buffer).toString());
      expect(manifest).toMatchObject({
        format: 'frameleaf-backup-manifest',
        instanceId: 'instance-1',
        database: { key: 'db/cloud-backup-immich-db-backup-dump.sql.gz', sha256: SHA_DUMP },
        assets: { 'asset-1': { owner: 'owner-1', files: [{ role: 'original', sha256: SHA_A }] } },
      });
      expect(index.finishManifest).toHaveBeenCalledWith('manifest-1', expect.objectContaining({ status: 'complete' }));
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
      store.listAll.mockImplementation((_connection, prefix: string, onPage: (objects: unknown[]) => Promise<void>) =>
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
      expect(store.put).toHaveBeenCalledWith(
        expect.anything(),
        'm/20260926T030000Z.json.gz',
        expect.any(Buffer),
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
      expect(store.put).not.toHaveBeenCalled();
      expect(operations.complete).not.toHaveBeenCalled();
    });

    it('ends the manifest without writing it when cancelled', async () => {
      operations.setBulkResult.mockResolvedValue({ ...running, cancelRequestedAt: new Date() });

      await sut.run(operationOf(), 'claim-1');

      expect(operations.acknowledgeCancel).toHaveBeenCalledWith('run-1', 'claim-1', { released: false });
      expect(index.finishManifest).toHaveBeenCalledWith('manifest-1', { status: 'cancelled' });
      expect(index.deleteEntries).toHaveBeenCalledWith('manifest-1');
      expect(store.put).not.toHaveBeenCalled();
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
      expect(mocks.storage.unlink).toHaveBeenCalledOnce();
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
        sut.onConfigValidate({ newConfig: config({ endpoint: 'http://s3.example.test' }), oldConfig: config({}) }),
      ).toThrow('HTTPS');
      expect(() => sut.onConfigValidate({ newConfig: config({}), oldConfig: config({}) })).not.toThrow();
    });
  });
});
