import { type Repository, backup, memoryStore, prune } from '@frameleaf/backup-core';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGunzip, gzipSync } from 'node:zlib';
import {
  CATALOG_PATH,
  CLOUD_BACKUP_CATALOG_VERSION,
  databaseTreePath,
  decodeTreeName,
  encodeTreeName,
  fileTreePath,
  lockedKeyTreePath,
  readCatalog,
  treeKey,
  treePathOf,
} from 'src/utils/cloud-backup-catalog.js';
import { BackupSource, type BackupSourceFile } from 'src/utils/cloud-backup-source.js';
import {
  VaultFileError,
  type VaultKeyring,
  openVault,
  parseSnapshotObjectKey,
  readVaultCatalog,
  readVaultFile,
  readVaultSnapshot,
  restoreVaultFile,
  snapshotObjectKey,
  vaultKeyVersion,
} from 'src/utils/cloud-backup-vault.js';
import { CLOUD_BACKUP_MANIFEST_FORMAT, type CloudBackupManifest } from 'src/utils/cloud-backup.js';

const sha256 = (body: Buffer) => createHash('sha256').update(body).digest('hex');
const keyring = (): VaultKeyring => ({ current: 1, keys: { 1: randomBytes(32).toString('base64') } });
const USER = '0195a1b2-0000-7000-8000-00000000000a';
const ASSET = '0195a1b2-0000-7000-8000-0000000000a1';

describe('cloud backup in the backup engine (FL-1676)', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-vault-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A small library on disk, and one run's source over it with the catalog made last. */
  const library = async () => {
    const original = join(root, 'library', 'admin', '2026', 'IMG 0001.jpg');
    const sidecar = `${original}.xmp`;
    const odd = join(root, 'library', 'admin', '2026', String.raw`back\slash 100%.jpg`);
    const keyFile = join(root, 'locked-keys', `${USER}.json`);
    const dump = join(root, 'backups', 'cloud-backup-frameleaf-db-backup-20261117T030000-v1.0.0-pg19.sql.gz');
    const bodies = {
      [original]: randomBytes(70_000),
      [sidecar]: Buffer.from('<x:xmpmeta/>'),
      [odd]: randomBytes(1000),
      [keyFile]: Buffer.from('{"wrapped":true}'),
    };
    const sql = Buffer.from('-- PostgreSQL database dump\nSELECT 1;\n-- PostgreSQL database dump complete\n');
    for (const [path, body] of Object.entries(bodies)) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, body);
    }
    await mkdir(join(dump, '..'), { recursive: true });
    await writeFile(dump, gzipSync(sql));
    return { original, sidecar, odd, keyFile, dump, bodies, sql };
  };

  const sourceOf = (lib: Awaited<ReturnType<typeof library>>, options: { failCatalog?: boolean } = {}) => {
    const controller = new AbortController();
    const file = (path: string, treePath = fileTreePath(path)): BackupSourceFile => ({ treePath, path });
    const database: BackupSourceFile = {
      treePath: databaseTreePath('cloud-backup-frameleaf-db-backup-20261117T030000-v1.0.0-pg19.sql.gz'),
      path: lib.dump,
      open: () => createReadStream(lib.dump).pipe(createGunzip()),
      size: lib.sql.length,
    };
    const catalogPath = join(root, 'catalog.json');
    const source: BackupSource = new BackupSource(
      [
        { name: 'locked-keys', files: [file(lib.keyFile, lockedKeyTreePath(USER))] },
        { name: 'database', files: [database] },
        { name: 'files', files: [file(lib.original), file(lib.sidecar), file(lib.odd), file(join(root, 'gone.jpg'))] },
        {
          name: 'catalog',
          files: async () => {
            if (options.failCatalog) {
              throw new Error('the catalog could not be made');
            }
            // A file the engine took from the last backup without reading it has no fresh hash; a real run
            // takes that from the last catalog. Here the content is known.
            const read = (key: string, body: Buffer) =>
              source.hashed.get(key) ?? { sha256: sha256(body), size: body.length };
            const entry = (role: string, path: string, treePath = fileTreePath(path)) => {
              const key = treeKey(treePath);
              return { role, path, objectKey: key, ...read(key, lib.bodies[path]), mtime: null };
            };
            const catalog: CloudBackupManifest = {
              format: CLOUD_BACKUP_MANIFEST_FORMAT,
              version: CLOUD_BACKUP_CATALOG_VERSION,
              instanceId: USER,
              createdAt: '2026-11-17T03:00:00.000Z',
              database: { key: treeKey(database.treePath), ...read(treeKey(database.treePath), lib.sql) },
              assets: {
                [ASSET]: {
                  owner: USER,
                  files: [entry('original', lib.original), entry('sidecar', lib.sidecar)],
                },
              },
              profiles: {},
              lockedKeys: { [USER]: entry('locked-key', lib.keyFile, lockedKeyTreePath(USER)) },
              albums: {},
              people: {},
            };
            await writeFile(catalogPath, JSON.stringify(catalog));
            return [{ treePath: CATALOG_PATH, path: catalogPath }];
          },
        },
      ],
      (error) => controller.abort(error),
    );
    return { source, signal: controller.signal };
  };

  const collect = async (repository: Repository, snapshotKey: string, key: string) => {
    const parts: Buffer[] = [];
    for await (const part of readVaultFile(repository, await repository.readSnapshot(snapshotKey), key)) {
      parts.push(part);
    }
    return Buffer.concat(parts);
  };

  it('backs up the run’s files at their places, the dump uncompressed and the catalog last', async () => {
    const lib = await library();
    const store = memoryStore();
    const ring = keyring();
    const repository = await openVault(store, ring, { create: true });
    const { source, signal } = sourceOf(lib);
    const made = await backup(repository, source, { signal, sequence: 1, snapshotId: 'a'.repeat(32) });

    expect(made.problems).toEqual([]);
    expect(made.key).toBe(`s/000000000001-${'a'.repeat(32)}`);
    // The file that was gone is counted, not stored and not a failure.
    expect([...source.missing]).toEqual([treeKey(fileTreePath(join(root, 'gone.jpg')))]);
    expect(source.hashed.get(treeKey(fileTreePath(lib.original)))).toEqual({
      sha256: sha256(lib.bodies[lib.original]),
      size: 70_000,
      sealed: false,
    });

    const opened = await openVault(store, ring);
    await opened.loadIndex();
    const snapshot = await readVaultSnapshot(opened, made.key, { ciphertextSha256: made.ciphertextSha256 });
    const catalog = await readVaultCatalog(opened, snapshot);
    expect(Object.keys(catalog.assets)).toEqual([ASSET]);
    const [original, sidecar] = catalog.assets[ASSET].files;
    expect(original.objectKey).toBe(treeKey(fileTreePath(lib.original)));
    expect((await collect(opened, made.key, original.objectKey!)).equals(lib.bodies[lib.original])).toBe(true);
    expect((await collect(opened, made.key, sidecar.objectKey!)).toString()).toBe('<x:xmpmeta/>');
    // The dump comes back as plain SQL, whatever it was compressed with on this server.
    expect(catalog.database!.key).toBe('database/cloud-backup-frameleaf-db-backup-20261117T030000-v1.0.0-pg19.sql');
    expect((await collect(opened, made.key, catalog.database!.key)).equals(lib.sql)).toBe(true);
    expect(catalog.database!.sha256).toBe(sha256(lib.sql));
    expect((await collect(opened, made.key, catalog.lockedKeys![USER].objectKey!)).toString()).toBe('{"wrapped":true}');
    // A name with a backslash is stored under a name the engine accepts, and its bytes come back.
    const oddKey = treeKey(fileTreePath(lib.odd));
    expect(oddKey.endsWith('back%5Cslash 100%25.jpg')).toBe(true);
    expect((await collect(opened, made.key, oddKey)).equals(lib.bodies[lib.odd])).toBe(true);

    // Nothing in storage carries a name, a path or the item's id.
    const stored = store.objects.keys().toArray().join('\n');
    const bytes = Buffer.concat(store.objects.values().toArray()).toString('latin1');
    for (const secret of ['IMG 0001', 'admin', ASSET, 'catalog.json', 'xmpmeta']) {
      expect(stored).not.toContain(secret);
      expect(bytes).not.toContain(secret);
    }
  });

  it('restores a file to a new path and says what it wrote', async () => {
    const lib = await library();
    const store = memoryStore();
    const ring = keyring();
    const repository = await openVault(store, ring, { create: true });
    const { source, signal } = sourceOf(lib);
    const made = await backup(repository, source, { signal });
    const snapshot = await repository.readSnapshot(made.key);
    const key = treeKey(fileTreePath(lib.original));

    const target = join(root, 'restored.jpg');
    expect(await restoreVaultFile(repository, snapshot, key, target)).toEqual({
      size: 70_000,
      sha256: sha256(lib.bodies[lib.original]),
    });
    expect((await readFile(target)).equals(lib.bodies[lib.original])).toBe(true);
    // Never over something that is there.
    await expect(restoreVaultFile(repository, snapshot, key, target)).rejects.toThrow(/EEXIST/);
    await expect(restoreVaultFile(repository, snapshot, 'files/nowhere.jpg', join(root, 'x'))).rejects.toMatchObject({
      name: 'VaultFileError',
      reason: 'missing',
    });
    await expect(stat(join(root, 'x'))).rejects.toThrow(/ENOENT/);

    // A piece gone from storage is named as damage, and no half file is left behind.
    const chunk = repository.index.values().find((location) => location.length > 60_000)!;
    await store.delete(chunk.pack);
    const again = await openVault(store, ring);
    await again.loadIndex();
    const error = await restoreVaultFile(again, snapshot, key, join(root, 'y')).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(VaultFileError);
    expect((error as VaultFileError).reason).toBe('damaged');
    await expect(stat(join(root, 'y'))).rejects.toThrow(/ENOENT/);
  });

  it('reads an unchanged file once: the next run takes it from the last backup', async () => {
    const lib = await library();
    const repository = await openVault(memoryStore(), keyring(), { create: true });
    const first = sourceOf(lib);
    await backup(repository, first.source, { signal: first.signal });

    await writeFile(lib.sidecar, '<x:xmpmeta changed="yes"/>');
    await utimes(lib.sidecar, new Date(), new Date(Date.now() + 5000));
    const second = sourceOf(lib);
    const made = await backup(repository, second.source, { signal: second.signal });

    const originalKey = treeKey(fileTreePath(lib.original));
    const sidecarKey = treeKey(fileTreePath(lib.sidecar));
    expect(second.source.opened.has(originalKey)).toBe(false);
    expect(second.source.opened.has(sidecarKey)).toBe(true);
    // It was listed, so the run still knows its size and time for the catalog.
    expect(second.source.listed.get(originalKey)?.size).toBe(70_000);
    expect((await collect(repository, made.key, sidecarKey)).toString()).toBe('<x:xmpmeta changed="yes"/>');
    // The earlier version is still in the earlier backup.
    const earlier = (await repository.listSnapshots())[0].key;
    expect((await collect(repository, earlier, sidecarKey)).toString()).toBe('<x:xmpmeta/>');
  });

  it('writes no snapshot when the catalog cannot be made', async () => {
    const lib = await library();
    const store = memoryStore();
    const repository = await openVault(store, keyring(), { create: true });
    const { source, signal } = sourceOf(lib, { failCatalog: true });
    await expect(backup(repository, source, { signal })).rejects.toThrow('the catalog could not be made');
    expect(await repository.listSnapshots()).toEqual([]);
  });

  it('opens with the root the repository names, whatever is current now, and refuses any other', async () => {
    const store = memoryStore();
    const ring = keyring();
    const repository = await openVault(store, ring, { create: true });
    expect(vaultKeyVersion(repository)).toBe(1);

    const rotated: VaultKeyring = { current: 2, keys: { ...ring.keys, 2: randomBytes(32).toString('base64') } };
    expect(vaultKeyVersion(await openVault(store, rotated))).toBe(1);
    await expect(openVault(store, { current: 2, keys: { 2: rotated.keys[2] } })).rejects.toThrow(
      /does not hold the key/,
    );
    await expect(openVault(store, { current: 1, keys: { 1: rotated.keys[2] } })).rejects.toThrow(/does not open/);
    await expect(openVault(memoryStore(), ring)).rejects.toThrow('No backup is stored here yet.');
  });

  it('refuses a stored backup that is not the one this server recorded', async () => {
    const lib = await library();
    const repository = await openVault(memoryStore(), keyring(), { create: true });
    const { source, signal } = sourceOf(lib);
    const made = await backup(repository, source, { signal });
    await expect(readVaultSnapshot(repository, made.key, { ciphertextSha256: 'f'.repeat(64) })).rejects.toThrow(
      /not the one this server recorded/,
    );
  });

  it('keeps the backups this server’s own retention chooses', async () => {
    const lib = await library();
    const store = memoryStore();
    const repository = await openVault(store, keyring(), { create: true });
    const keys: string[] = [];
    for (let run = 0; run < 3; run++) {
      const { source, signal } = sourceOf(lib);
      keys.push((await backup(repository, source, { signal })).key);
    }
    const report = await prune(repository, { keep: () => [keys[0]], minAgeDays: 0 });
    expect(report.removedSnapshots).toEqual([keys[1]]);
    expect((await repository.listSnapshots()).map(({ key }) => key)).toEqual([keys[0], keys[2]]);
  });

  it('names a backup by its full object name', () => {
    const name = snapshotObjectKey(USER, `s/000000000007-${'b'.repeat(32)}`);
    expect(name).toBe(`r/v1/${USER}/s/000000000007-${'b'.repeat(32)}`);
    expect(parseSnapshotObjectKey(name)).toEqual({
      vaultId: USER,
      key: `s/000000000007-${'b'.repeat(32)}`,
      sequence: 7,
    });
    expect(parseSnapshotObjectKey('m/v1/x/1/20260926T030000Z.json.gz')).toBeNull();
    expect(parseSnapshotObjectKey(`r/v1/${USER}/p/${'b'.repeat(32)}`)).toBeNull();
  });
});

describe('the catalog of a cloud backup (FL-1676)', () => {
  const file = (objectKey: string) => ({
    role: 'original',
    path: '/x',
    objectKey,
    sha256: 'a'.repeat(64),
    size: 1,
    mtime: null,
  });
  const catalog = (change: object = {}) =>
    Buffer.from(
      JSON.stringify({
        format: CLOUD_BACKUP_MANIFEST_FORMAT,
        version: CLOUD_BACKUP_CATALOG_VERSION,
        instanceId: USER,
        createdAt: '2026-11-17T03:00:00.000Z',
        database: null,
        assets: { [ASSET]: { owner: USER, files: [file('files/x')], type: 'IMAGE', details: { nonsense: true } } },
        profiles: {},
        albums: {},
        people: {},
        ...change,
      }),
    );

  it('keeps the files of an item whose details are not well formed', () => {
    const read = readCatalog(catalog());
    expect(read.assets[ASSET].files).toEqual([file('files/x')]);
    expect(read.assets[ASSET].details).toBeUndefined();
  });

  it('refuses a catalog of another kind, or one naming a file outside the backup', () => {
    expect(() => readCatalog(Buffer.from('not json'))).toThrow(/cannot be read/);
    expect(() => readCatalog(catalog({ version: 3 }))).toThrow(/not one this server can read/);
    for (const key of ['files/../../etc/passwd', '/etc/passwd', 'files', String.raw`files/a\b`, 'files//x']) {
      expect(() => readCatalog(catalog({ assets: { [ASSET]: { owner: USER, files: [file(key)] } } }))).toThrow(
        /names a file it does not describe/,
      );
    }
    expect(() => readCatalog(catalog({ lockedKeys: { 'not-a-user': file('locked-keys/x.json') } }))).toThrow();
    expect(() => readCatalog(catalog({ database: { key: 'database/x.sql', sha256: 'short', size: 1 } }))).toThrow();
  });

  it('gives every name a place the engine accepts, and reads it back exactly', () => {
    for (const name of ['plain.jpg', String.raw`a\b.jpg`, '100%.jpg', String.raw`%5C\%25`]) {
      expect(decodeTreeName(encodeTreeName(name))).toBe(name);
      expect(encodeTreeName(name)).not.toContain('\\');
    }
    expect(fileTreePath('/data/library/a b.jpg')).toEqual(['files', 'data', 'library', 'a b.jpg']);
    expect(treePathOf('files/data/x.jpg')).toEqual(['files', 'data', 'x.jpg']);
  });
});
