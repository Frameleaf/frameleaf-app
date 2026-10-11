import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { CloudBackupConnection, CloudBackupStoreRepository } from 'src/repositories/cloud-backup-store.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { CloudBackupRestorer, emptyRestoreResult, restorePlan } from 'src/services/cloud-backup-restore.js';
import { clientBackupContext, clientBackupObjectKey } from 'src/utils/cloud-backup-crypto.js';
import { appendBackupSnapshot, selectBackupSnapshot, signBackupSnapshot } from 'src/utils/cloud-backup-recovery.js';
import { readManifest } from 'src/utils/cloud-backup-retention.js';
import { CLOUD_BACKUP_PART_BYTES, CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

const vaultId = 'f0000000-0000-4000-8000-000000000001';
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
type ObjectVersion = { bytes: Buffer; version: string };
type RequestSample = { method: string; key: string; query: URLSearchParams; headers: Headers; body: Buffer };

/** Synthetic versioned storage that can interrupt parts, lose completions, and hide current heads. */
class EncryptedS3 {
  requests: RequestSample[] = [];
  current = new Map<string, ObjectVersion>();
  versions = new Map<string, ObjectVersion>();
  uploads = new Map<string, { key: string; parts: Map<number, Buffer> }>();
  failPart = 0;
  loseComplete = false;
  losePut = false;
  private sequence = 0;
  private uploadSequence = 0;

  private put(key: string, bytes: Buffer) {
    const object = { bytes, version: `version-${++this.sequence}` };
    this.current.set(key, object);
    this.versions.set(`${key}/${object.version}`, object);
    return object;
  }
  fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    await Promise.resolve();
    const url = new URL(input);
    const key = url.pathname
      .split('/')
      .slice(2)
      .map((part) => decodeURIComponent(part))
      .join('/');
    const method = init?.method ?? 'GET';
    const headers = new Headers(init?.headers);
    const body = init?.body ? Buffer.from(init.body as Uint8Array) : Buffer.alloc(0);
    this.requests.push({ key, method, headers, body, query: url.searchParams });
    const context = clientBackupContext('family-backup', key);
    if (context) {
      expect(headers.keys().some((name) => name.includes('encryption-customer'))).toBe(false);
      expect(headers.get('x-amz-content-sha256')).toBe(sha(body));
    }
    const failure = (status: number, code: string) => new Response(`<Error><Code>${code}</Code></Error>`, { status });
    const answer = (object: ObjectVersion, head = false) =>
      new Response(head ? null : new Uint8Array(object.bytes), {
        headers: {
          etag: '"complete"',
          'content-length': String(object.bytes.length),
          'x-amz-version-id': object.version,
        },
      });
    if (method === 'POST' && url.searchParams.has('uploads')) {
      const id = `upload-${++this.uploadSequence}`;
      this.uploads.set(id, { key, parts: new Map() });
      return new Response(`<UploadId>${id}</UploadId>`);
    }
    const uploadId = url.searchParams.get('uploadId');
    if (uploadId) {
      const upload = this.uploads.get(uploadId);
      if (!upload) return failure(404, 'NoSuchUpload');
      if (method === 'PUT') {
        const number = Number(url.searchParams.get('partNumber'));
        if (number === this.failPart) return failure(503, 'SlowDown');
        upload.parts.set(number, body);
        return new Response(null, { headers: { etag: `"part-${number}"` } });
      }
      if (headers.has('if-none-match') && this.current.has(key)) return failure(412, 'PreconditionFailed');
      const bytes = Buffer.concat([...upload.parts].sort(([a], [b]) => a - b).map(([, part]) => part));
      const object = this.put(key, bytes);
      this.uploads.delete(uploadId);
      if (this.loseComplete) {
        this.loseComplete = false;
        return failure(500, 'InternalError');
      }
      return new Response('<CompleteMultipartUploadResult><ETag>"complete"</ETag></CompleteMultipartUploadResult>', {
        headers: { 'x-amz-version-id': object.version },
      });
    }
    if (method === 'PUT') {
      if (headers.has('if-none-match') && this.current.has(key)) return failure(412, 'PreconditionFailed');
      const object = this.put(key, body);
      if (this.losePut) {
        this.losePut = false;
        return failure(500, 'InternalError');
      }
      return new Response(null, { headers: { etag: '"complete"', 'x-amz-version-id': object.version } });
    }
    if (method === 'GET' || method === 'HEAD') {
      const version = url.searchParams.get('versionId');
      const object = version ? this.versions.get(`${key}/${version}`) : this.current.get(key);
      return object ? answer(object, method === 'HEAD') : failure(404, 'NoSuchKey');
    }
    return failure(405, 'MethodNotAllowed');
  };
}

describe('client-encrypted storage and independent recovery', () => {
  let directory: string;
  let s3: EncryptedS3;
  let store: CloudBackupStoreRepository;
  let connection: CloudBackupConnection;
  const legacy = randomBytes(32);
  const root = randomBytes(32);
  const logger = LoggingRepository.create();
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'client-backup-'));
    s3 = new EncryptedS3();
    vi.stubGlobal('fetch', s3.fetch);
    store = new CloudBackupStoreRepository(logger);
    store.retryDelaysMs = [];
    connection = {
      endpoint: 'https://storage.example',
      bucket: 'family-backup',
      region: 'us-east-1',
      accessKeyId: 'synthetic-access',
      secretAccessKey: 'synthetic-secret',
      vaultId,
      recoveryKeys: { 1: root.toString('base64') },
      stagingDirectory: join(directory, 'staging'),
    };
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(directory, { force: true, recursive: true });
  });
  const keyFor = (bytes: Buffer, dump?: string) => clientBackupObjectKey(root, vaultId, 1, sha(bytes), dump);
  const manifestKey = `m/v1/${vaultId}/1/20261011T000001Z.json.gz`;

  it('keeps plaintext, plaintext identities and client roots out of storage bodies/headers and restores authenticated previews/files', async () => {
    const bytes = Buffer.from('private-photo-and-thumbnail-sentinel');
    const key = keyFor(bytes);
    await store.put(connection, key, bytes, legacy);
    expect(key).not.toContain(sha(bytes));
    expect(await store.head(connection, key, legacy)).toMatchObject({ size: bytes.length });
    expect((await store.getPreview(connection, key, legacy, sha(bytes), bytes.length)).equals(bytes)).toBe(true);
    const target = join(directory, 'restored');
    await store.download(connection, key, legacy, target, sha(bytes));
    expect((await readFile(target)).equals(bytes)).toBe(true);
    for (const request of s3.requests) {
      const wire = Buffer.concat([Buffer.from(JSON.stringify([...request.headers])), request.body]);
      for (const sentinel of [
        bytes,
        Buffer.from(root.toString('base64')),
        Buffer.from(legacy.toString('base64')),
        Buffer.from(sha(bytes)),
      ])
        expect(wire.includes(sentinel)).toBe(false);
    }
    const object = s3.current.get(key)!;
    object.bytes[object.bytes.length - 1] ^= 1;
    await expect(store.download(connection, key, legacy, target, sha(bytes))).rejects.toMatchObject({
      code: 'ChecksumMismatch',
    });
    expect((await readFile(target)).equals(bytes)).toBe(true);
    expect((await readdir(directory)).some((name) => name.includes('.part-'))).toBe(false);
  });

  it('resumes an interrupted multipart upload in another worker with the same ciphertext and completed parts', async () => {
    const bytes = randomBytes(CLOUD_BACKUP_PART_BYTES + 91);
    const key = keyFor(bytes);
    const path = join(directory, 'source');
    await writeFile(path, bytes);
    s3.failPart = 2;
    await expect(store.uploadFile(connection, key, path, legacy, sha(bytes))).rejects.toThrow();
    const staged = await readdir(connection.stagingDirectory!);
    const encrypted = await readFile(
      join(
        connection.stagingDirectory!,
        staged.find((name) => name.endsWith('.ciphertext'))!,
      ),
    );
    s3.failPart = 0;
    const restarted = new CloudBackupStoreRepository(logger);
    restarted.retryDelaysMs = [];
    await restarted.uploadFile(connection, key, path, legacy, sha(bytes));
    expect(s3.current.get(key)!.bytes.equals(encrypted)).toBe(true);
    expect(s3.requests.filter((request) => request.query.has('uploads'))).toHaveLength(1);
    expect(s3.requests.filter((request) => request.query.get('partNumber') === '1')).toHaveLength(1);
    expect(s3.requests.some((request) => request.method === 'DELETE')).toBe(false);
    expect((await store.get(connection, key, legacy)).equals(bytes)).toBe(true);
    expect(await readdir(connection.stagingDirectory!)).toEqual([]);
  });

  it('restarts only an expired multipart session while retaining its immutable ciphertext', async () => {
    const bytes = randomBytes(CLOUD_BACKUP_PART_BYTES + 71);
    const key = keyFor(bytes);
    const path = join(directory, 'source');
    await writeFile(path, bytes);
    s3.failPart = 2;
    await expect(store.uploadFile(connection, key, path, legacy, sha(bytes))).rejects.toThrow();
    const originalPart = s3.requests.find((request) => request.query.get('partNumber') === '1')!.body;
    s3.uploads.clear();
    s3.failPart = 0;
    await store.uploadFile(connection, key, path, legacy, sha(bytes));
    const firstParts = s3.requests.filter((request) => request.query.get('partNumber') === '1');
    expect(firstParts).toHaveLength(2);
    expect(firstParts[1].body.equals(originalPart)).toBe(true);
    expect((await store.get(connection, key, legacy)).equals(bytes)).toBe(true);
  });

  it('reads identical content under independent historical roots without mixing key versions', async () => {
    const bytes = Buffer.from('retained across rotation');
    const oldKey = keyFor(bytes);
    const nextRoot = randomBytes(32);
    connection.recoveryKeys![2] = nextRoot.toString('base64');
    const nextKey = clientBackupObjectKey(nextRoot, vaultId, 2, sha(bytes));
    await store.put(connection, oldKey, bytes, legacy);
    await store.put(connection, nextKey, bytes, legacy);
    expect(oldKey).not.toBe(nextKey);
    expect(s3.current.get(oldKey)!.bytes.equals(s3.current.get(nextKey)!.bytes)).toBe(false);
    expect((await store.get(connection, oldKey, legacy)).equals(bytes)).toBe(true);
    expect((await store.get(connection, nextKey, legacy)).equals(bytes)).toBe(true);
    delete connection.recoveryKeys![1];
    await expect(store.get(connection, oldKey, legacy)).rejects.toThrow('authentication failed');
    expect((await store.get(connection, nextKey, legacy)).equals(bytes)).toBe(true);
  });

  it.each(['single', 'multipart'])(
    'recovers a lost %s manifest completion and preserves its receipt until history is committed',
    async (kind) => {
      const bytes = randomBytes(kind === 'single' ? 300 : CLOUD_BACKUP_PART_BYTES + 19);
      s3.losePut = kind === 'single';
      s3.loseComplete = kind === 'multipart';
      store.retryDelaysMs = [0];
      const uploaded = await store.uploadStream(connection, manifestKey, [bytes], legacy, 'application/gzip');
      expect(uploaded.versionId).toBe('version-1');
      connection.trustedManifests = {
        [manifestKey]: { versionId: uploaded.versionId!, ciphertextSha256: uploaded.ciphertextSha256! },
      };
      expect((await store.get(connection, manifestKey, legacy)).equals(bytes)).toBe(true);
      const before = s3.requests.length;
      const restarted = new CloudBackupStoreRepository(logger);
      expect(
        await restarted.uploadStream(
          connection,
          manifestKey,
          [Buffer.from('regenerated timestamp')],
          legacy,
          'application/gzip',
        ),
      ).toEqual(uploaded);
      expect(s3.requests).toHaveLength(before);
      await store.finishClientUpload(connection, manifestKey);
      expect(await readdir(connection.stagingDirectory!)).toEqual([]);
    },
  );

  it('fetches the trusted exact manifest version despite a delete marker and refuses a missing or altered trusted version', async () => {
    const bytes = Buffer.from('trusted manifest');
    const uploaded = await store.uploadStream(connection, manifestKey, [bytes], legacy, 'application/gzip');
    connection.trustedManifests = {
      [manifestKey]: { versionId: uploaded.versionId!, ciphertextSha256: uploaded.ciphertextSha256! },
    };
    s3.current.delete(manifestKey);
    expect((await store.get(connection, manifestKey, legacy)).equals(bytes)).toBe(true);
    const object = s3.versions.get(`${manifestKey}/${uploaded.versionId}`)!;
    object.bytes[object.bytes.length - 1] ^= 1;
    await expect(store.get(connection, manifestKey, legacy)).rejects.toThrow('authentication');
    s3.versions.delete(`${manifestKey}/${uploaded.versionId}`);
    await expect(store.get(connection, manifestKey, legacy)).rejects.toMatchObject({ status: 404 });
    expect(
      s3.requests
        .filter((request) => request.key === manifestKey && request.method === 'GET')
        .every((request) => request.query.get('versionId') === uploaded.versionId),
    ).toBe(true);
  });

  it.each([1, 2, 3] as const)(
    'exports a v%i snapshot and restores media, thumbnail and database bytes with networking disabled',
    async (version) => {
      const photo = Buffer.from('photo');
      const thumbnail = Buffer.from('thumbnail');
      const dump = gzipSync('consistent synthetic SQL dump');
      const photoKey = version === 3 ? keyFor(photo) : `o/${sha(photo)}`;
      const thumbnailKey = version === 3 ? keyFor(thumbnail) : `o/${sha(thumbnail)}`;
      const dumpKey =
        version === 3
          ? keyFor(dump, 'cloud-backup-immich-db-backup-test.sql.gz')
          : 'db/cloud-backup-immich-db-backup-test.sql.gz';
      const manifestKey = version === 3 ? `m/v1/${vaultId}/1/20261011T000001Z.json.gz` : 'm/20261011T000001Z.json.gz';
      await store.put(connection, photoKey, photo, legacy);
      await store.put(connection, thumbnailKey, thumbnail, legacy);
      await store.put(connection, dumpKey, dump, legacy);
      const media = join(directory, 'replacement');
      const manifest: CloudBackupManifest = {
        format: 'frameleaf-backup-manifest',
        version,
        instanceId: vaultId,
        createdAt: '2026-10-11T00:00:00.000Z',
        database: { key: dumpKey, sha256: sha(dump), size: dump.length },
        assets: {
          'asset-1': {
            owner: 'owner-1',
            type: 'IMAGE',
            originalFileName: 'photo.jpg',
            duration: null,
            fileCreatedAt: '2026-10-11T00:00:00.000Z',
            fileModifiedAt: '2026-10-11T00:00:00.000Z',
            localDateTime: '2026-10-11T00:00:00.000Z',
            files: [
              {
                role: 'original',
                path: join(media, 'library/photo.jpg'),
                ...(version === 3 && { objectKey: photoKey }),
                sha256: sha(photo),
                size: photo.length,
                mtime: null,
              },
              {
                role: 'thumbnail',
                path: join(media, 'thumbs/photo.jpg'),
                ...(version === 3 && { objectKey: thumbnailKey }),
                sha256: sha(thumbnail),
                size: thumbnail.length,
                mtime: null,
              },
            ],
          },
        },
        profiles: {},
        albums: {},
        people: {},
      };
      const manifestBytes = gzipSync(JSON.stringify(manifest));
      const uploaded = await store.uploadStream(connection, manifestKey, [manifestBytes], legacy, 'application/gzip');
      if (version === 3) {
        const pair = generateKeyPairSync('ed25519');
        const jwk = pair.publicKey.export({ format: 'jwk' });
        const publicJwk = { kty: 'OKP' as const, crv: 'Ed25519' as const, x: jwk.x! };
        const kid = ed25519Thumbprint(publicJwk);
        const record = signBackupSnapshot(
          {
            version: 2,
            instanceId: vaultId,
            vaultId,
            snapshotId: 'f0000000-0000-4000-8000-000000000003',
            sequence: 1,
            previousDigest: null,
            createdAt: manifest.createdAt,
            signerKid: kid,
            manifest: {
              format: 'frameleaf-client-backup',
              formatVersion: 1,
              keyVersion: 1,
              objectKey: manifestKey,
              versionId: uploaded.versionId!,
              ciphertextSha256: uploaded.ciphertextSha256!,
            },
          },
          { kid, publicJwk, sign: () => '', signBytes: (bytes) => sign(null, bytes, pair.privateKey) },
        );
        const history = appendBackupSnapshot(null, record);
        expect(selectBackupSnapshot(history).record.descriptor.manifest.objectKey).toBe(manifestKey);
        connection.trustedManifests = { [manifestKey]: record.descriptor.manifest };
      }
      const offline = join(directory, 'export');
      await mkdir(offline);
      for (const key of [manifestKey, photoKey, thumbnailKey, dumpKey])
        await store.exportObject(connection, key, legacy, offline);
      await expect(store.exportObject(connection, photoKey, legacy, offline)).rejects.toMatchObject({ code: 'EEXIST' });
      const noNetwork = vi.fn().mockRejectedValue(new Error('Networking is disabled'));
      vi.stubGlobal('fetch', noNetwork);
      const recovered: CloudBackupConnection = {
        ...connection,
        accessKeyId: '',
        secretAccessKey: '',
        offlineDirectory: offline,
      };
      const parsed = readManifest(await store.get(recovered, manifestKey, legacy));
      expect(parsed.assets['asset-1'].originalFileName).toBe(version === 1 ? undefined : 'photo.jpg');
      const plan = restorePlan({
        manifest: parsed,
        scope: 'library',
        assetIds: null,
        operationId: 'offline-restore',
        mediaLocation: media,
        currentOriginals: new Map(),
      });
      const restorer = new CloudBackupRestorer(store, new StorageRepository(logger), new CryptoRepository(), logger);
      const result = await restorer.restore({
        bucket: { connection: recovered, bucketKey: legacy, bucketRef: 'offline' },
        manifest: parsed,
        scope: 'library',
        files: plan.files,
        destination: plan.destination,
        operationId: 'offline-restore',
        mediaLocation: media,
        backupsFolder: join(media, 'backups'),
        start: emptyRestoreResult(),
        checkpoint: () => Promise.resolve(true),
      });
      expect((await readFile(join(media, 'library/photo.jpg'))).equals(photo)).toBe(true);
      expect((await readFile(join(media, 'thumbs/photo.jpg'))).equals(thumbnail)).toBe(true);
      expect((await readFile(join(media, 'backups', result!.databaseFile!))).equals(dump)).toBe(true);
      expect(noNetwork).not.toHaveBeenCalled();
    },
  );
});
