import { createHash } from 'node:crypto';
import { access, link, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Mock } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { ChecksumAlgorithm, DatabaseLock, MediaOperationKind, StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { CloudBackupStoreError } from 'src/repositories/cloud-backup-store.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { CloudBackupService } from 'src/services/cloud-backup.service.js';
import { backupKeyFile, bucketRef, keyFingerprint } from 'src/utils/cloud-backup.js';
import { managedStorageRef } from 'src/utils/frameleaf-cloud-backup.js';
import { ManagedBackupAuthorizationError } from 'src/utils/managed-backup-session.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { getMocks } from 'test/utils.js';

// Real filesystem calls; one case simulates a drive without hard links through `link`.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, link: vi.fn(actual.link) };
});

/**
 * FL-1337: Library care puts one lost original back from Cloud Backup by itself. Real files on disk: the
 * copy is fetched beside the original's path, proven against the photo's own checksum and published
 * without replacing anything.
 */

const INSTANCE_ID = 'f0000000-0000-4000-8000-000000000001';
const ASSET_ID = 'a5e7c0de-0000-4000-8000-000000000001';
const OWNER_ID = 'b0b0b0b0-0000-4000-8000-000000000001';
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
const claim = {
  target: 'byo-s3',
  bucketRef: ref,
  endpoint: s3.endpoint,
  region: 'eu-central-2',
  bucket: s3.bucket,
  instanceId: INSTANCE_ID,
  claimedAt: '2026-09-25T00:00:00.000Z',
  keyMode: 'server',
  keyFingerprint: fingerprint,
  reconciledAt: '2026-09-25T00:00:00.000Z',
};
const config = { frameleafCloud: { cloudBackup: { enabled: true, target: 'byo-s3', s3, keyMode: 'server' } } };
const keyFile = JSON.stringify({
  ...backupKeyFile({ key, instanceId: INSTANCE_ID, bucket: s3.bucket, mode: 'server', createdAt: new Date() }),
  client: { vaultId: INSTANCE_ID, current: 1, keys: { 1: Buffer.alloc(32, 42).toString('base64') } },
});

const PHOTO = Buffer.from('the photo, exactly as it was uploaded');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest();
const sha1 = (bytes: Buffer) => createHash('sha1').update(bytes).digest();
const NEWEST = 'm/20261101T030000Z.json.gz';
const OLDEST = 'm/20261001T030000Z.json.gz';

describe('CloudBackupService.restoreLostOriginal (FL-1337)', () => {
  let sut: CloudBackupService;
  let mocks: ReturnType<typeof getMocks>;
  let metadata: Record<string, unknown>;
  let operations: Record<string, Mock>;
  let store: Record<string, Mock>;
  let index: Record<string, Mock>;
  let cloudBackup: Record<string, Mock>;
  let held: { backendPid: number; verify: Mock; release: Mock };
  let media: string;
  let identityDir: string;
  let previousMedia: string | undefined;
  let originalPath: string;
  /** What the bucket answers for the original's object: the backed-up bytes. */
  let backedUp: Buffer;
  let target: Record<string, unknown>;

  const manifestWith = (bytes: Buffer) =>
    gzipSync(
      JSON.stringify({
        format: 'frameleaf-backup-manifest',
        version: 1,
        instanceId: INSTANCE_ID,
        createdAt: '2026-11-01T03:00:00.000Z',
        database: null,
        assets: {
          [ASSET_ID]: {
            owner: OWNER_ID,
            files: [
              {
                role: 'original',
                path: originalPath,
                sha256: sha256(bytes).toString('hex'),
                size: bytes.length,
                mtime: null,
              },
            ],
          },
        },
        profiles: {},
      }),
    );
  /** The bucket holds `bytes` as the asset's original, in the newest kept backup. */
  const backup = (bytes: Buffer) => {
    backedUp = bytes;
    store.get.mockResolvedValue(manifestWith(bytes));
    index.getKeptOriginals.mockResolvedValue([
      { key: NEWEST, createdAt: new Date('2026-11-01T03:00:00.000Z'), sha256: sha256(bytes).toString('hex') },
    ]);
  };
  const exists = (path: string) =>
    access(path)
      .then(() => true)
      .catch(() => false);
  const leftovers = async () =>
    (await readdir(dirname(originalPath))).filter(
      (name) => name.startsWith('.cloud-restore-') || name.includes('.part'),
    );

  beforeEach(async () => {
    mocks = getMocks();
    media = await mkdtemp(join(tmpdir(), 'lost-original-'));
    identityDir = await mkdtemp(join(tmpdir(), 'lost-original-identity-'));
    try {
      previousMedia = StorageCore.getMediaLocation();
    } catch {
      previousMedia = undefined;
    }
    StorageCore.setMediaLocation(media);
    // each of Frameleaf's folders is on its drive while its mount file is there
    for (const folder of [StorageFolder.Upload, StorageFolder.Library, StorageFolder.EncodedVideo]) {
      await mkdir(StorageCore.getBaseFolder(folder), { recursive: true });
      await writeFile(join(StorageCore.getBaseFolder(folder), '.frameleaf'), '');
    }
    originalPath = join(StorageCore.getBaseFolder(StorageFolder.Upload), OWNER_ID, 'a5', 'e7', 'IMG_2041.jpg');
    await mkdir(dirname(originalPath), { recursive: true });

    metadata = {
      [SystemMetadataKey.FrameleafCloudBackup]: claim,
      [SystemMetadataKey.SystemConfig]: config,
    };
    mocks.systemMetadata.get.mockImplementation((name) => Promise.resolve(metadata[name] as never));
    mocks.config.getEnv.mockReturnValue(
      mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir } }),
    );
    mocks.storage.stat.mockImplementation((path: string) => stat(path) as never);
    const crypto = new CryptoRepository();
    mocks.crypto.hashFileMatching.mockImplementation((file, reference) => crypto.hashFileMatching(file, reference));
    mocks.crypto.hashFileDigests.mockImplementation((file) => crypto.hashFileDigests(file));
    held = { backendPid: 1, verify: vi.fn().mockResolvedValue(true), release: vi.fn().mockResolvedValue(undefined) };
    mocks.database.holdLock.mockResolvedValue(held);

    target = {
      ownerId: OWNER_ID,
      originalPath,
      checksum: sha256(PHOTO),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      isExternal: false,
      active: true,
      locked: false,
    };
    operations = { getActiveOfKind: vi.fn().mockResolvedValue(undefined) };
    index = {
      getRestoreTarget: vi.fn().mockImplementation(() => Promise.resolve(target)),
      listKeptManifests: vi.fn().mockResolvedValue([
        { key: NEWEST, status: 'complete', createdAt: new Date('2026-11-01T03:00:00.000Z') },
        { key: OLDEST, status: 'complete', createdAt: new Date('2026-10-01T03:00:00.000Z') },
      ]),
      getKeptOriginals: vi.fn().mockResolvedValue([]),
    };
    cloudBackup = { rotate: vi.fn(), listSnapshots: vi.fn().mockResolvedValue([]) };
    store = {
      get: vi.fn(),
      // the store checks what arrives against the manifest's SHA-256 and moves it to `destination` only then
      download: vi.fn().mockImplementation(async (_connection, _object, _bucketKey, destination: string, expected) => {
        if (sha256(backedUp).toString('hex') !== expected) {
          throw new CloudBackupStoreError('The backup copy does not match its checksum', null, 'ChecksumMismatch');
        }
        await writeFile(destination, backedUp, { flag: 'wx', mode: 0o600 });
        return { size: backedUp.length, sha256: expected };
      }),
    };
    sut = new CloudBackupService(
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
      { read: vi.fn().mockResolvedValue(keyFile) } as never,
      {} as never,
      cloudBackup as never,
      mocks.user as never,
      mocks.cron as never,
      mocks.job as never,
      {} as never,
      {} as never,
      mocks.lockedEncryption as never,
    );
    sut.keyAskMs = 0;
  });

  afterEach(async () => {
    await sut.onShutdown();
    if (previousMedia !== undefined) {
      StorageCore.setMediaLocation(previousMedia);
    }
    await rm(media, { recursive: true, force: true });
    await rm(identityDir, { recursive: true, force: true });
  });

  it('restores a missing original and verifies it', async () => {
    backup(PHOTO);

    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({
      outcome: 'restored',
      since: '2026-10-01T03:00:00.000Z',
    });

    // the photo's own bytes are back at its path, fetched from the newest backup that holds them
    await expect(readFile(originalPath)).resolves.toEqual(PHOTO);
    expect(store.get).toHaveBeenCalledWith(expect.objectContaining({ bucket: s3.bucket }), NEWEST, key);
    expect(store.download).toHaveBeenCalledWith(
      expect.objectContaining({ bucket: s3.bucket }),
      `o/${sha256(PHOTO).toString('hex')}`,
      key,
      // a private file beside the original's path
      expect.stringMatching(new RegExp(String.raw`^${dirname(originalPath)}/\.cloud-restore-[\da-f-]+\.tmp$`)),
      sha256(PHOTO).toString('hex'),
    );
    expect(mocks.crypto.hashFileMatching).toHaveBeenCalledWith(store.download.mock.calls[0][3], sha256(PHOTO));
    expect(await leftovers()).toEqual([]);
    // checked under the bucket lock, without waiting for it
    expect(mocks.database.holdLock).toHaveBeenCalledWith(DatabaseLock.FrameleafCloudBackup);
    expect(mocks.database.withLock).not.toHaveBeenCalled();
    expect(held.release).toHaveBeenCalled();
  });

  it("refuses a download whose bytes don't match", async () => {
    // an older upload's SHA-1: only the bytes themselves can tell, and these are some other file's
    target = { ...target, checksum: sha1(PHOTO), checksumAlgorithm: ChecksumAlgorithm.sha1File };
    backup(Buffer.from('another photo that was backed up under this item'));

    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({
      outcome: 'not-in-backup',
      since: '2026-10-01T03:00:00.000Z',
    });

    // nothing is placed, and the fetched file is gone
    await expect(exists(originalPath)).resolves.toBe(false);
    expect(store.download).toHaveBeenCalledTimes(1);
    expect(await leftovers()).toEqual([]);
  });

  it('moves a changed file aside instead of replacing it', async () => {
    const changed = Buffer.from('a file that is no longer the photo');
    await writeFile(originalPath, changed);
    backup(PHOTO);

    const result = await sut.restoreLostOriginal(ASSET_ID);

    expect(result).toMatchObject({ outcome: 'restored', since: '2026-10-01T03:00:00.000Z' });
    await expect(readFile(originalPath)).resolves.toEqual(PHOTO);
    // the changed file still exists, in the owner's Library care folder beside their uploads
    const libraryCare = join(
      dirname(StorageCore.getNestedPath(StorageFolder.Upload, OWNER_ID, ASSET_ID)),
      '.library-care',
    );
    expect(result.retainedPath).toEqual(
      expect.stringMatching(new RegExp(String.raw`^${libraryCare}/${ASSET_ID}-[\da-f]{8}\.damaged\.jpg$`)),
    );
    await expect(readFile(result.retainedPath!)).resolves.toEqual(changed);
    expect(await leftovers()).toEqual([]);
  });

  it('puts a changed file back where it was when the copy cannot be placed', async () => {
    const changed = Buffer.from('a file that is no longer the photo');
    await writeFile(originalPath, changed);
    backup(PHOTO);
    // the disk fails while the copy is written next to the original's path
    const crypto = new CryptoRepository();
    mocks.crypto.hashFileDigests.mockImplementation((file) =>
      String(file).endsWith('.partial') ? Promise.reject(new Error('EIO: i/o error')) : crypto.hashFileDigests(file),
    );

    await expect(sut.restoreLostOriginal(ASSET_ID)).rejects.toThrow('EIO');

    // nothing was replaced or lost: the changed file is back at its path, and nothing else is left behind
    await expect(readFile(originalPath)).resolves.toEqual(changed);
    const libraryCare = join(
      dirname(StorageCore.getNestedPath(StorageFolder.Upload, OWNER_ID, ASSET_ID)),
      '.library-care',
    );
    expect(await readdir(libraryCare)).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });

  it('restores on a drive without hard links, still never replacing anything', async () => {
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(link).mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    onTestFinished(() => {
      vi.mocked(link).mockReset().mockImplementation(actual.link);
    });
    const changed = Buffer.from('a file that is no longer the photo');
    await writeFile(originalPath, changed);
    backup(PHOTO);

    const result = await sut.restoreLostOriginal(ASSET_ID);

    expect(result).toMatchObject({ outcome: 'restored', retainedPath: expect.stringContaining('.library-care') });
    expect(link).toHaveBeenCalled();
    await expect(readFile(originalPath)).resolves.toEqual(PHOTO);
    await expect(readFile(result.retainedPath!)).resolves.toEqual(changed);
    expect(await leftovers()).toEqual([]);
  });

  it('moves nothing aside while the drive of the Library care folder is unplugged', async () => {
    // the original lives in the library folder (a storage template); the Library care folder is on the uploads drive
    originalPath = join(StorageCore.getBaseFolder(StorageFolder.Library), OWNER_ID, '2019', 'IMG_2041.jpg');
    await mkdir(dirname(originalPath), { recursive: true });
    target = { ...target, originalPath };
    const changed = Buffer.from('a file that is no longer the photo');
    await writeFile(originalPath, changed);
    backup(PHOTO);
    await rm(join(StorageCore.getBaseFolder(StorageFolder.Upload), '.frameleaf'));

    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'busy' });

    // the changed file is where it was, nothing went into the empty mount point, and nothing is left behind
    await expect(readFile(originalPath)).resolves.toEqual(changed);
    const libraryCare = join(
      dirname(StorageCore.getNestedPath(StorageFolder.Upload, OWNER_ID, ASSET_ID)),
      '.library-care',
    );
    await expect(exists(libraryCare)).resolves.toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  it.each([
    ['refused credentials', 'not-set-up', new CloudBackupStoreError('Access denied', 403, 'AccessDenied')],
    ['an unsigned request', 'not-set-up', new CloudBackupStoreError('Unauthorized', 401, null)],
    ['a bad request', 'not-set-up', new CloudBackupStoreError('Bad request', 400, null)],
    ['a bucket that is gone', 'not-set-up', new CloudBackupStoreError('No such bucket', 404, 'NoSuchBucket')],
    ['a provider error', 'busy', new CloudBackupStoreError('Unavailable', 503, null)],
    ['a rate limit', 'busy', new CloudBackupStoreError('Slow down', 429, 'SlowDown')],
    ['an unreachable provider', 'busy', new CloudBackupStoreError('could not be reached', null, null)],
  ] as const)('answers %s with %s, never as a backup without the photo', async (_name, outcome, error) => {
    backup(PHOTO);
    store.download.mockRejectedValueOnce(error);

    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome });
    await expect(exists(originalPath)).resolves.toBe(false);
    expect(await leftovers()).toEqual([]);
  });

  it('leaves the photo’s own bytes where they are, fetching nothing', async () => {
    await writeFile(originalPath, PHOTO);
    backup(PHOTO);

    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({
      outcome: 'restored',
      since: '2026-10-01T03:00:00.000Z',
    });
    expect(store.download).not.toHaveBeenCalled();
  });

  it('waits while a backup runs', async () => {
    backup(PHOTO);
    operations.getActiveOfKind.mockImplementation((kind) =>
      Promise.resolve(kind === MediaOperationKind.CloudBackup ? { id: 'run-1' } : undefined),
    );

    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'busy' });

    // the lock is let go at once, and the bucket is not read
    expect(held.release).toHaveBeenCalled();
    expect(store.get).not.toHaveBeenCalled();
    expect(store.download).not.toHaveBeenCalled();
    await expect(exists(originalPath)).resolves.toBe(false);
  });

  it('waits, without waiting on it, while another backup operation is being started', async () => {
    backup(PHOTO);
    mocks.database.holdLock.mockResolvedValue(null);

    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'busy' });
    expect(store.download).not.toHaveBeenCalled();
  });

  it('waits while the drive the original belongs on is unplugged, writing nothing there', async () => {
    backup(PHOTO);
    await rm(join(StorageCore.getBaseFolder(StorageFolder.Upload), '.frameleaf'));

    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'busy' });
    expect(store.download).not.toHaveBeenCalled();
    await expect(exists(originalPath)).resolves.toBe(false);
  });

  it('says when no kept backup holds the original, and since when there are backups', async () => {
    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({
      outcome: 'not-in-backup',
      since: '2026-10-01T03:00:00.000Z',
    });
    expect(index.getKeptOriginals).toHaveBeenCalledWith(ref, ASSET_ID);
    expect(store.get).not.toHaveBeenCalled();
  });

  it('is not set up without Cloud Backup', async () => {
    delete metadata[SystemMetadataKey.FrameleafCloudBackup];
    backup(PHOTO);

    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'not-set-up' });
    expect(store.get).not.toHaveBeenCalled();
  });

  describe('on Frameleaf-managed storage', () => {
    const grant = cloudContractFixture('backup/capability-restore.json');
    const cloudUrl = 'https://cloud.frameleaf.test';

    beforeEach(() => {
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ frameleafCloud: { ...mockEnvData({}).frameleafCloud, identityDir, url: cloudUrl } }),
      );
      metadata[SystemMetadataKey.FrameleafCloudLink] = { status: 'linked', cloudUrl, instanceId: INSTANCE_ID };
      metadata[SystemMetadataKey.FrameleafCloudBackup] = {
        ...claim,
        target: 'managed',
        bucketRef: managedStorageRef(grant.storageId),
        endpoint: grant.endpoint,
        region: grant.region,
        bucket: grant.bucket,
        managed: { storageId: grant.storageId, location: grant.location, readOnly: false, quotaBytes: 0 },
      };
      metadata[SystemMetadataKey.SystemConfig] = {
        frameleafCloud: { cloudBackup: { enabled: true, target: 'managed', keyMode: 'server' } },
      };
      mocks.frameleafCloud.discovery.mockResolvedValue({ api: 'https://api.frameleaf.test' } as never);
      mocks.frameleafCloud.accessToken.mockResolvedValue({ accessToken: 'token' } as never);
      mocks.instanceIdentity.loadOrCreate.mockResolvedValue({ instanceId: INSTANCE_ID } as never);
      cloudBackup.rotate.mockResolvedValue(grant);
    });

    it('restores with a restore key asked for while nothing holds the bucket', async () => {
      backup(PHOTO);

      await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toMatchObject({ outcome: 'restored' });

      await expect(readFile(originalPath)).resolves.toEqual(PHOTO);
      expect(cloudBackup.rotate).toHaveBeenCalledTimes(1);
      expect(cloudBackup.rotate).toHaveBeenCalledWith(expect.anything(), 'restore');
      expect(operations.getActiveOfKind.mock.invocationCallOrder[0]).toBeLessThan(
        cloudBackup.rotate.mock.invocationCallOrder[0],
      );
      expect(store.download.mock.calls[0][0]).toMatchObject({
        bucket: grant.bucket,
        accessKeyId: grant.capability.credentials.accessKeyId,
      });
    });

    it('never renews its key while a backup holds the bucket: a new key would revoke the backup’s', async () => {
      backup(PHOTO);
      store.download.mockImplementationOnce(async (connection) => {
        // a backup started meanwhile, and the key ran out
        operations.getActiveOfKind.mockResolvedValue({ id: 'run-1' });
        await connection.managedCredentials(grant.capability.credentials.accessKeyId);
      });

      await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'busy' });

      expect(cloudBackup.rotate).toHaveBeenCalledTimes(1);
      await expect(exists(originalPath)).resolves.toBe(false);
      expect(await leftovers()).toEqual([]);
    });

    it('waits while managed storage asks to wait, as for an unlinked server', async () => {
      backup(PHOTO);
      delete metadata[SystemMetadataKey.FrameleafCloudLink];

      await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'busy' });
      expect(cloudBackup.rotate).not.toHaveBeenCalled();
      expect(store.download).not.toHaveBeenCalled();
      expect(held.release).toHaveBeenCalled();
    });

    it('is not set up while managed storage refuses this server for good', async () => {
      backup(PHOTO);
      metadata[SystemMetadataKey.FrameleafCloudLink] = {
        status: 'linked',
        cloudUrl,
        instanceId: INSTANCE_ID,
        heartbeat: { cloneSuspected: true },
      };

      await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'not-set-up' });
      expect(mocks.logger.log).toHaveBeenCalledWith(expect.stringContaining('may be a copy of another one'));
      expect(cloudBackup.rotate).not.toHaveBeenCalled();
      expect(store.download).not.toHaveBeenCalled();
    });

    it('treats a key refused for now as busy, and one refused for good as not set up', async () => {
      backup(PHOTO);
      store.download.mockRejectedValueOnce(new ManagedBackupAuthorizationError(undefined, 60_000));
      await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'busy' });

      store.download.mockRejectedValueOnce(new ManagedBackupAuthorizationError());
      await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'not-set-up' });
    });

    it('reads for one photo at a time: each new restore key revokes the one before', async () => {
      backup(PHOTO);
      const events: string[] = [];
      cloudBackup.rotate.mockImplementation(() => {
        events.push('rotate');
        return Promise.resolve(grant);
      });
      const download = store.download.getMockImplementation()!;
      const { promise: firstHeld, resolve: releaseFirst } = Promise.withResolvers<void>();
      store.download.mockImplementation(async (...args: unknown[]) => {
        events.push('download');
        if (events.filter((event) => event === 'download').length === 1) {
          await firstHeld;
        }
        const result = await download(...args);
        events.push('downloaded');
        return result;
      });

      const first = sut.restoreLostOriginal(ASSET_ID);
      const second = sut.restoreLostOriginal(ASSET_ID);
      await vi.waitFor(() => expect(events).toContain('download'));
      // the second fix waits for the first read to end before it asks for a key
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(cloudBackup.rotate).toHaveBeenCalledTimes(1);
      releaseFirst();

      await expect(first).resolves.toMatchObject({ outcome: 'restored' });
      await expect(second).resolves.toMatchObject({ outcome: 'restored' });
      expect(events).toEqual(['rotate', 'download', 'downloaded', 'rotate', 'download', 'downloaded']);
      await expect(readFile(originalPath)).resolves.toEqual(PHOTO);
      expect(await leftovers()).toEqual([]);
    });
  });

  it.each([
    ['a Locked photo', { locked: true }],
    ['a photo in an external library', { isExternal: true }],
    ['a photo in the trash', { active: false }],
  ])('skips %s', async (_name, change) => {
    target = { ...target, ...change };
    backup(PHOTO);

    await expect(sut.restoreLostOriginal(ASSET_ID)).resolves.toEqual({ outcome: 'skipped' });
    expect(index.getKeptOriginals).not.toHaveBeenCalled();
    expect(store.download).not.toHaveBeenCalled();
    await expect(exists(originalPath)).resolves.toBe(false);
  });
});
