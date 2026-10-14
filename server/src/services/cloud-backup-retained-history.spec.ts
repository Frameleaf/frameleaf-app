import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { CloudBackupStoreRepository } from 'src/repositories/cloud-backup-store.repository.js';
import { CloudBackupBucket, CloudBackupMaintenance } from 'src/services/cloud-backup-maintenance.js';
import { clientBackupContext, clientBackupObjectKey, encryptClientBackup } from 'src/utils/cloud-backup-crypto.js';

const vault = 'f0000000-0000-4000-8000-000000000001';
const root = Buffer.alloc(32, 1);
const historical = Buffer.alloc(32, 2);
const sha = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const h1 = `m/v1/${vault}/2/20261013T030000Z.json.gz`;
const h0 = `m/v1/${vault}/1/20261012T030000Z.json.gz`;
const original = sha('retained original');
const o0 = clientBackupObjectKey(root, vault, 1, original);
const sibling = clientBackupObjectKey(historical, vault, 2, original);
const retainedDump = clientBackupObjectKey(root, vault, 1, sha('old dump'), '20261001.sql.gz');
const currentObject = clientBackupObjectKey(historical, vault, 2, sha('current original'));
const legacyManifest = 'm/20261011T030000Z.json.gz';
const legacy = `o/${sha('legacy original')}`;

describe('production pruning with hidden retained history', () => {
  let bucket: CloudBackupBucket;
  let current: Map<string, Buffer>;
  let versions: Map<string, Buffer>;
  let requests: Array<{ method: string; key: string; version: string | null }>;
  let kept: string[];
  let known: Set<string>;
  let pruned: Set<string>;
  let index: Record<string, ReturnType<typeof vi.fn>>;
  let sut: CloudBackupMaintenance;
  const retention = { keepDaily: 3, keepWeekly: 0, keepMonthly: 0 };
  const carryOn = () => Promise.resolve(true);

  beforeEach(async () => {
    current = new Map([
      [o0, Buffer.from('ciphertext')],
      [sibling, Buffer.from('sibling')],
      [legacy, Buffer.from('legacy')],
      [currentObject, Buffer.from('current')],
      [retainedDump, Buffer.from('dump')],
      ['db/zzz1.sql.gz', Buffer.from('dump')],
      ['db/zzz2.sql.gz', Buffer.from('dump')],
      ['db/zzz3.sql.gz', Buffer.from('dump')],
      ['db/zzz4.sql.gz', Buffer.from('dump')],
      ['db/zzz5.sql.gz', Buffer.from('dump')],
      ['db/zzz6.sql.gz', Buffer.from('dump')],
      ['db/zzz7.sql.gz', Buffer.from('dump')],
    ]);
    versions = new Map();
    requests = [];
    kept = [h1, h0];
    known = new Set(kept);
    pruned = new Set();
    bucket = {
      bucketRef: 'retention-fixture',
      bucketKey: Buffer.alloc(32, 7),
      connection: {
        endpoint: 'https://retention.test',
        region: 'us-east-1',
        bucket: 'fixture',
        accessKeyId: 'synthetic',
        secretAccessKey: 'synthetic',
        vaultId: vault,
        recoveryKeys: { 1: root.toString('base64'), 2: historical.toString('base64') },
        trustedManifestHead: h1,
        trustedManifests: {},
      },
    };
    for (const [key, objectKeys, keyRoot] of [
      [h1, [currentObject], historical],
      [h0, [o0], root],
    ] as const) {
      const body = gzipSync(
        JSON.stringify({
          format: 'frameleaf-backup-manifest',
          version: 3,
          instanceId: vault,
          createdAt: '2026-10-12T03:00:00.000Z',
          database: key === h0 ? { key: retainedDump, sha256: sha('old dump'), size: 4 } : null,
          profiles: {},
          assets: {
            asset: {
              owner: 'owner',
              files: objectKeys.map((objectKey) => ({
                role: 'original',
                path: '/fixture/original.jpg',
                sha256: objectKey === currentObject ? sha('current original') : original,
                size: 10,
                mtime: null,
                objectKey,
              })),
            },
          },
        }),
      );
      const wire = Buffer.concat(
        await Array.fromAsync(
          encryptClientBackup(Readable.from([body]), body.length, keyRoot, clientBackupContext('fixture', key)!),
        ),
      );
      versions.set(`${key}/exact`, wire);
      bucket.connection.trustedManifests![key] = { versionId: 'exact', ciphertextSha256: sha(wire) };
      if (key === h1) current.set(key, wire);
    }
    current.set(
      legacyManifest,
      gzipSync(
        JSON.stringify({
          format: 'frameleaf-backup-manifest',
          version: 1,
          instanceId: vault,
          createdAt: '2026-10-11T03:00:00.000Z',
          database: null,
          profiles: {},
          assets: {
            legacy: {
              owner: 'owner',
              files: [
                {
                  role: 'original',
                  path: '/fixture/legacy.jpg',
                  sha256: sha('legacy original'),
                  size: 10,
                  mtime: null,
                },
              ],
            },
          },
        }),
      ),
    );
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      await Promise.resolve();
      const url = new URL(input);
      const key = url.pathname
        .split('/')
        .slice(2)
        .map((part) => decodeURIComponent(part))
        .join('/');
      const method = init?.method ?? 'GET';
      const version = url.searchParams.get('versionId');
      requests.push({ method, key, version });
      if (url.searchParams.has('list-type')) {
        const prefix = url.searchParams.get('prefix') ?? '';
        return new Response(
          `<ListBucketResult><IsTruncated>false</IsTruncated>${[...current]
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, body]) => `<Contents><Key>${key}</Key><Size>${body.length}</Size></Contents>`)
            .join('')}</ListBucketResult>`,
        );
      }
      if (method === 'DELETE') {
        current.delete(key);
        return new Response(null, { status: 204 });
      }
      const body = version ? versions.get(`${key}/${version}`) : current.get(key);
      return body
        ? new Response(new Uint8Array(body))
        : new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    });
    index = {
      listKeptManifests: vi.fn().mockImplementation(() => Promise.resolve(kept.map((key) => ({ key })))),
      getManifestKeys: vi
        .fn()
        .mockImplementation((_bucket, _keys, status) => Promise.resolve(status === 'pruned' ? pruned : known)),
      adoptManifests: vi.fn().mockImplementation((_bucket, manifests, status) => {
        for (const { key } of manifests) {
          known.add(key);
          if (status === 'pruned') pruned.add(key);
          else kept.push(key);
        }
        return Promise.resolve(manifests.length);
      }),
      markManifests: vi.fn().mockImplementation((_bucket, keys, status) => {
        if (status === 'pruned') {
          for (const key of keys) pruned.add(key);
          kept = kept.filter((key) => !pruned.has(key));
        }
        return Promise.resolve(0);
      }),
      forget: vi.fn().mockResolvedValue(undefined),
    };
    const store = new CloudBackupStoreRepository({
      setContext: vi.fn(),
      debug: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    } as never);
    store.retryDelaysMs = [];
    sut = new CloudBackupMaintenance(store, index as never, { log: vi.fn() } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('reads the hidden retained exact version with its historical key and protects its exclusive object', async () => {
    await expect(sut.prune(bucket, retention, false, carryOn)).resolves.toMatchObject({
      manifestsKept: 3,
      objectsRemoved: 1,
    });
    expect(current.has(o0)).toBe(true);
    expect(current.has(retainedDump)).toBe(true);
    expect(current.has(legacy)).toBe(true);
    expect(current.has(sibling)).toBe(false);
    expect(requests).toContainEqual({ method: 'GET', key: h0, version: 'exact' });
    expect(index.forget).not.toHaveBeenCalledWith(bucket.bucketRef, expect.arrayContaining([o0.slice(2)]));
  });

  it.each(['missing', 'corrupt', 'untrusted'] as const)(
    'makes zero destructive calls when hidden retained history is %s',
    async (failure) => {
      switch (failure) {
        case 'missing': {
          versions.delete(`${h0}/exact`);
          break;
        }
        case 'corrupt': {
          versions.get(`${h0}/exact`)![60] ^= 1;
          break;
        }
        case 'untrusted': {
          delete bucket.connection.trustedManifests![h0];
          // No default
          break;
        }
      }
      await expect(sut.prune(bucket, retention, false, carryOn)).rejects.toThrow();
      expect(requests.some(({ method }) => method === 'DELETE')).toBe(false);
      expect(index.forget).not.toHaveBeenCalled();
      expect(index.markManifests).not.toHaveBeenCalled();
    },
  );

  it('reconciles signed history not yet adopted into a replacement server index', async () => {
    kept = [h1];
    known = new Set([h1]);
    await sut.prune(bucket, retention, false, carryOn);
    expect(current.has(o0)).toBe(true);
    expect(current.has(retainedDump)).toBe(true);
  });

  it('protects signed history when a crash leaves its existing index row unfinished', async () => {
    kept = [h1];
    await sut.prune(bucket, retention, false, carryOn);
    expect(current.has(o0)).toBe(true);
    expect(requests).toContainEqual({ method: 'GET', key: h0, version: 'exact' });
  });

  it('refuses hidden legacy history without authenticated exact-version authority', async () => {
    kept.push(legacyManifest);
    current.delete(legacyManifest);
    await expect(sut.prune(bucket, retention, false, carryOn)).rejects.toThrow('trusted exact version');
    expect(requests.some(({ method }) => method === 'DELETE')).toBe(false);
    expect(index.forget).not.toHaveBeenCalled();
    expect(index.markManifests).not.toHaveBeenCalled();
  });

  it('protects hidden references in a dry run without index or provider mutations', async () => {
    await expect(sut.prune(bucket, retention, true, carryOn)).resolves.toMatchObject({
      manifestsKept: 3,
      objectsRemoved: 1,
      dumpsRemoved: 0,
    });
    expect(current.has(o0)).toBe(true);
    expect(requests.some(({ method }) => method === 'DELETE')).toBe(false);
    expect(index.forget).not.toHaveBeenCalled();
    expect(index.markManifests).not.toHaveBeenCalled();
  });

  it('keeps the missing anchored head refusal even when an exact historical version exists', async () => {
    current.delete(h1);
    await expect(sut.prune(bucket, retention, false, carryOn)).rejects.toThrow('anchored backup head');
    expect(requests.some(({ method }) => method === 'DELETE')).toBe(false);
    expect(index.forget).not.toHaveBeenCalled();
    expect(index.markManifests).not.toHaveBeenCalled();
  });

  it('expires the final reference and does not resurrect a pruned historical receipt', async () => {
    await sut.prune(bucket, { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, false, carryOn);
    expect(current.has(o0)).toBe(false);
    expect(current.has(retainedDump)).toBe(false);
    expect(current.has(legacy)).toBe(false);
    expect(current.has(currentObject)).toBe(true);
    expect(index.markManifests).toHaveBeenCalledWith(bucket.bucketRef, [h0, legacyManifest], 'pruned');
    kept = [h1];
    versions.delete(`${h0}/exact`);
    requests = [];
    await expect(sut.prune(bucket, retention, false, carryOn)).resolves.toMatchObject({ manifestsKept: 1 });
    expect(requests.some(({ key }) => key === h0)).toBe(false);
  });

  it('persists expiry of unknown signed history before deletion and never resurrects it with expanded retention', async () => {
    kept = [h1];
    known = new Set([h1]);
    await sut.prune(bucket, { keepDaily: 1, keepWeekly: 0, keepMonthly: 0 }, false, carryOn);
    expect(current.has(o0)).toBe(false);
    expect(known.has(h0)).toBe(true);
    expect(index.adoptManifests.mock.invocationCallOrder[0]).toBeLessThan(
      index.markManifests.mock.invocationCallOrder[0],
    );
    versions.delete(`${h0}/exact`);
    requests = [];
    await expect(sut.prune(bucket, retention, false, carryOn)).resolves.toMatchObject({ manifestsKept: 1 });
    expect(requests.some(({ key }) => key === h0)).toBe(false);
  });
});
