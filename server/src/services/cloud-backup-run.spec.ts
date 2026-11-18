import { type Repository, memoryStore } from '@frameleaf/backup-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { CloudBackupAsset } from 'src/repositories/cloud-backup-index.repository.js';
import { AssetFileType } from 'src/enum.js';
import {
  type CloudBackupRunOutcome,
  CloudBackupRunner,
  sha256OfFile,
  summarizeCatalog,
} from 'src/services/cloud-backup-run.js';
import { fileTreePath, treeKey } from 'src/utils/cloud-backup-catalog.js';
import { type VaultKeyring, openVault, readVaultCatalog, readVaultFile } from 'src/utils/cloud-backup-vault.js';

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const OWNER = '0195a1b2-0000-7000-8000-00000000000a';
const OTHER = '0195a1b2-0000-7000-8000-00000000000b';
const A1 = '0195a1b2-0000-7000-8000-0000000000a1';
const A2 = '0195a1b2-0000-7000-8000-0000000000a2';
const B1 = '0195a1b2-0000-7000-8000-0000000000b1';
const SQL = Buffer.from('-- PostgreSQL database dump\nSELECT 1;\n-- PostgreSQL database dump complete\n');

describe('a cloud backup run on the backup engine (FL-1676)', () => {
  let root: string;
  let media: string;
  let bodies: Record<string, Buffer>;
  let assets: CloudBackupAsset[];
  let repository: Repository;
  let keyring: VaultKeyring;
  const store = { current: memoryStore() };
  const logger = { warn: vitest.fn(), log: vitest.fn() };

  const asset = (id: string, ownerId: string, originalPath: string, files: CloudBackupAsset['files'] = []) => ({
    id,
    ownerId,
    originalPath,
    sha256: null,
    checksumSize: null,
    verifiedAt: null,
    checksumPathVerified: false,
    files,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-run-'));
    media = join(root, 'media');
    const at = (...names: string[]) => join(media, ...names);
    bodies = {
      [at('library', 'a', 'one.jpg')]: randomBytes(50_000),
      [at('library', 'a', 'one.jpg.xmp')]: Buffer.from('<x:xmpmeta/>'),
      [at('library', 'a', 'two.mov')]: randomBytes(90_000),
      [at('library', 'b', 'theirs.jpg')]: randomBytes(20_000),
      [at('profile', OWNER, 'me.jpg')]: randomBytes(3000),
    };
    for (const [path, body] of Object.entries(bodies)) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, body);
    }
    assets = [
      asset(A1, OWNER, at('library', 'a', 'one.jpg'), [
        { type: AssetFileType.Sidecar, path: at('library', 'a', 'one.jpg.xmp') },
      ]),
      asset(A2, OWNER, at('library', 'a', 'two.mov')),
      asset(B1, OTHER, at('library', 'b', 'theirs.jpg')),
    ];
    store.current = memoryStore();
    keyring = { current: 1, keys: { 1: randomBytes(32).toString('base64') } };
    repository = await openVault(store.current, keyring, { create: true });
    vitest.clearAllMocks();
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const index = () => ({
    listAssets: vitest.fn(({ afterId, limit }: { afterId: string | null; limit: number }) =>
      Promise.resolve(assets.filter(({ id }) => !afterId || id > afterId).slice(0, limit)),
    ),
    listProfileImages: vitest.fn(() =>
      Promise.resolve([{ userId: OWNER, path: join(media, 'profile', OWNER, 'me.jpg') }]),
    ),
    getAssetDetails: vitest.fn((ids: string[]) =>
      Promise.resolve(
        new Map(
          ids.map((id) => [
            id,
            {
              record: {
                type: 'IMAGE',
                originalFileName: `${id}.jpg`,
                fileCreatedAt: '2026-01-01T00:00:00.000Z',
                fileModifiedAt: '2026-01-01T00:00:00.000Z',
                localDateTime: '2026-01-01T00:00:00.000Z',
                duration: null,
              },
              details: {
                isFavorite: id === A1,
                visibility: 'timeline' as const,
                rating: null,
                description: '',
                dateTimeOriginal: null,
                timeZone: null,
                latitude: null,
                longitude: null,
                tags: [],
                albums: id === A1 ? [{ id: 'album-1', name: 'Rockies' }] : [],
                faces: [],
                stack: null,
                edits: [],
              },
            },
          ]),
        ),
      ),
    ),
    getAlbumRecords: vitest.fn((ids: string[]) =>
      Promise.resolve(
        new Map(
          ids.map((id) => [
            id,
            {
              name: 'Rockies',
              description: '',
              ownerId: OWNER,
              coverAssetId: null,
              order: 'desc' as const,
              sharedUsers: [],
            },
          ]),
        ),
      ),
    ),
    getPersonRecords: vitest.fn(() => Promise.resolve(new Map())),
  });

  let sequence = 0;
  const run = async (
    change: { mayUpload?: (ownerId: string | null) => boolean; signal?: AbortSignal } = {},
    using = index(),
  ): Promise<CloudBackupRunOutcome & { index: ReturnType<typeof index> }> => {
    const dump = join(
      media,
      'backups',
      `cloud-backup-frameleaf-db-backup-2026111${sequence}T030000-v1.0.0-pg19.sql.gz`,
    );
    await mkdir(join(dump, '..'), { recursive: true });
    await writeFile(dump, gzipSync(SQL));
    const controller = new AbortController();
    change.signal?.addEventListener('abort', () => controller.abort(change.signal!.reason));
    const runner = new CloudBackupRunner(using as never, logger as never, sha256OfFile);
    const outcome = await runner.run({
      repository,
      runId: `0195a1b2-0000-7000-8000-00000000f00${sequence}`,
      instanceId: OWNER,
      createdAt: `2026-11-1${sequence}T03:00:00.000Z`,
      sequence: ++sequence,
      snapshotId: `${'0'.repeat(31)}${sequence}`,
      mediaLocation: media,
      scratch: join(root, 'scratch'),
      dump,
      include: { thumbs: false, encodedVideo: false },
      mayUpload: change.mayUpload ?? (() => true),
      signal: controller.signal,
      fail: (error) => controller.abort(error),
    });
    return { ...outcome, index: using };
  };

  const content = async (snapshotKey: string, key: string) => {
    const parts: Buffer[] = [];
    for await (const part of readVaultFile(repository, await repository.readSnapshot(snapshotKey), key)) {
      parts.push(part);
    }
    return Buffer.concat(parts);
  };

  beforeEach(() => {
    sequence = 0;
  });

  it('stores every file of every item at its place, with a catalog that says what it holds', async () => {
    const outcome = await run();

    expect(outcome.stored.key).toBe(`s/000000000001-${'0'.repeat(31)}1`);
    expect(outcome).toMatchObject({ uploaded: 5, skipped: 0, missing: 0, changed: 0 });
    const catalog = await readVaultCatalog(repository, outcome.stored.snapshot);
    expect(summarizeCatalog(catalog)).toEqual(outcome.summary);
    expect(outcome.summary).toMatchObject({ assets: 3, files: 5 });
    expect(outcome.summary.originals).toEqual([
      { assetId: A1, sha256: sha256(bodies[join(media, 'library', 'a', 'one.jpg')]) },
      { assetId: A2, sha256: sha256(bodies[join(media, 'library', 'a', 'two.mov')]) },
      { assetId: B1, sha256: sha256(bodies[join(media, 'library', 'b', 'theirs.jpg')]) },
    ]);
    expect(catalog.assets[A1]).toMatchObject({
      owner: OWNER,
      originalFileName: `${A1}.jpg`,
      details: { isFavorite: true, albums: [{ id: 'album-1', name: 'Rockies' }] },
    });
    expect(catalog.assets[A1].files.map(({ role }) => role)).toEqual(['original', 'sidecar']);
    expect(catalog.albums['album-1'].name).toBe('Rockies');
    expect(Object.keys(catalog.profiles)).toEqual([OWNER]);
    for (const file of [...catalog.assets[A1].files, catalog.profiles[OWNER]]) {
      expect(file.objectKey).toBe(treeKey(fileTreePath(file.path)));
      expect((await content(outcome.stored.key, file.objectKey!)).equals(bodies[file.path])).toBe(true);
      expect(file.sha256).toBe(sha256(bodies[file.path]));
    }
    // The dump is stored as plain SQL, and the catalog names it.
    expect(catalog.database).toEqual({
      key: 'database/cloud-backup-frameleaf-db-backup-20261110T030000-v1.0.0-pg19.sql',
      sha256: sha256(SQL),
      size: SQL.length,
    });
    expect((await content(outcome.stored.key, catalog.database!.key)).equals(SQL)).toBe(true);
    // The catalog's own working file is gone again.
    expect(await readdir(join(root, 'scratch'))).toEqual([]);
  });

  it('reads only what changed on the next run, and still describes everything', async () => {
    const first = await run();
    const sidecar = join(media, 'library', 'a', 'one.jpg.xmp');
    await writeFile(sidecar, '<x:xmpmeta rating="5"/>');
    await utimes(sidecar, new Date(), new Date(Date.now() + 5000));
    await rm(join(media, 'library', 'a', 'two.mov'));

    const second = await run();
    // the changed sidecar; three untouched files taken from the first backup; one file gone
    expect(second).toMatchObject({ uploaded: 1, skipped: 3, missing: 1, changed: 0 });
    const catalog = await readVaultCatalog(repository, second.stored.snapshot);
    expect(Object.keys(catalog.assets)).toEqual([A1, B1]);
    const [original, changed] = catalog.assets[A1].files;
    // An unread file keeps the hash the first catalog has for it.
    expect(original.sha256).toBe(sha256(bodies[original.path]));
    expect(changed.sha256).toBe(sha256(Buffer.from('<x:xmpmeta rating="5"/>')));
    expect((await content(second.stored.key, changed.objectKey!)).toString()).toBe('<x:xmpmeta rating="5"/>');
    // The earlier backup still holds the earlier version and the deleted file.
    expect((await content(first.stored.key, changed.objectKey!)).toString()).toBe('<x:xmpmeta/>');
    const gone = treeKey(fileTreePath(join(media, 'library', 'a', 'two.mov')));
    expect((await content(first.stored.key, gone)).length).toBe(90_000);
    // Almost nothing new was stored: the sidecar, the trees and the catalog.
    expect(second.stored.snapshot.stats.storedBytes).toBeLessThan(10_000);
  });

  it('leaves out the accounts the licence does not cover', async () => {
    const outcome = await run({ mayUpload: (ownerId) => ownerId === OWNER });
    const catalog = await readVaultCatalog(repository, outcome.stored.snapshot);
    expect(Object.keys(catalog.assets)).toEqual([A1, A2]);
    expect(outcome.summary.originals.map(({ assetId }) => assetId)).toEqual([A1, A2]);
  });

  it('backs up each Locked key file first, and names it in the catalog', async () => {
    await mkdir(join(media, 'locked-keys'), { recursive: true });
    await writeFile(join(media, 'locked-keys', `${OWNER}.json`), '{"not":"a real key file"}');
    const outcome = await run();
    const catalog = await readVaultCatalog(repository, outcome.stored.snapshot);
    expect(catalog.lockedKeys?.[OWNER]).toMatchObject({
      role: 'locked-key',
      objectKey: `locked-keys/${OWNER}.json`,
      sha256: sha256(Buffer.from('{"not":"a real key file"}')),
    });
    expect(outcome.lockedKeyOwners).toEqual([OWNER]);
  });

  it('stores nothing as a backup when it is stopped, and sends none of it again', async () => {
    const stop = new AbortController();
    const using = index();
    using.getAssetDetails.mockImplementationOnce(() => {
      // every file has been read and stored by now; the catalog is being written
      stop.abort(new Error('paused'));
      return Promise.resolve(new Map());
    });
    await expect(run({ signal: stop.signal }, using)).rejects.toThrow('paused');
    expect(await repository.listSnapshots()).toEqual([]);

    repository = await openVault(store.current, keyring);
    sequence = 0;
    const again = await run();
    expect((await repository.listSnapshots()).map(({ key }) => key)).toEqual([again.stored.key]);
    // Only the dump (a new one each run), the trees and the catalog were left to send.
    expect(again.stored.snapshot.stats.storedBytes).toBeLessThan(10_000);
  });
});
