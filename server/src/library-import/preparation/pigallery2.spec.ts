import { hash } from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import content from 'src/library-import/fixtures/pigallery2/3.5.2-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-sqlite.json' with { type: 'json' };
import { verifyImportedPassword } from 'src/library-import/passwords.js';
import { adapter, pigallery2Login } from 'src/library-import/preparation/pigallery2.js';
import { UNTESTED_VERSION_LOSS, inspectPreparationSource } from 'src/library-import/preparation/prepare.js';

const directoryPath = (id: number) => {
  const row = content.rows.directory_entity.find((directory) => directory.id === id)!;
  return (row.path === './' ? '' : row.path) + (row.name === '.' ? '' : row.name + '/');
};
const originals = content.rows.media_entity.map((media) => ({
  path: directoryPath(media.directoryId) + media.name,
  bytes: media.metadataFilesize,
}));

describe('PiGallery2 preparation adapter', () => {
  let directory: string;
  let snapshotPath: string;
  let originalsRoot: string;
  const input = () => ({
    source: {
      kind: 'pigallery2' as const,
      version: fixture.source.version,
      identity: 'synthetic-pigallery2',
      revision: 'a'.repeat(64),
      schemaSha256: fixture.schemaSha256,
    },
    snapshotPath,
    originalsRoot,
  });
  const edit = (sql: string, ...values: SQLInputValue[]) => {
    const database = new DatabaseSync(snapshotPath);
    database.prepare(sql).run(...values);
    database.close();
  };
  const open = async <T>(use: (source: Awaited<ReturnType<typeof adapter.open>>) => Promise<T>) => {
    const source = await adapter.open(input());
    try {
      return await use(source);
    } finally {
      await source.close();
    }
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-prepare-pigallery2-'));
    snapshotPath = join(directory, 'source.sqlite');
    originalsRoot = join(directory, 'images');
    const database = new DatabaseSync(snapshotPath);
    database.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.structure.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
    for (const [table, records] of Object.entries({ ...content.rows, version_entity: fixture.versions }))
      for (const captured of records) {
        const row: Record<string, SQLInputValue> = { ...captured };
        if (table === 'user_entity') row.password = 'excluded-password-hash';
        else if (table === 'sharing_entity') {
          row.password = row.has_password === 1 ? 'excluded-share-password-hash' : null;
          row.sharingKey = 'excluded-bearer-token';
          delete row.has_password;
        }
        const keys = Object.keys(row);
        database
          .prepare(
            // eslint-disable-next-line unicorn/no-unsafe-sqlite-interpolation -- Fixture identifiers only; values are bound.
            `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
          )
          .run(...Object.values(row));
      }
    database.exec('COMMIT');
    database.close();
    for (const original of originals) {
      const path = join(originalsRoot, original.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(original.bytes, 1));
    }
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('inspects the qualified fixture as tested with the library owned by the administrator', async () => {
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection).toMatchObject({
      format: 'frameleaf-library-import-inspection',
      tested: true,
      testedVersion: fixture.source.version,
      summary: {
        owners: 4,
        assets: originals.length,
        // One folder album per directory holding media; the saved search is archived.
        albums: new Set(content.rows.media_entity.map((media) => media.directoryId)).size,
        files: originals.length,
        bytes: String(originals.reduce((sum, file) => sum + file.bytes, 0)),
      },
    });
    expect(
      inspection.owners.map(({ sourceId, name, assets, restrictions }) => ({ sourceId, name, assets, restrictions })),
    ).toEqual([
      { sourceId: '1', name: 'fixture-admin', assets: originals.length, restrictions: [] },
      { sourceId: '2', name: 'alice', assets: 0, restrictions: ['restricted-library-access'] },
      { sourceId: '3', name: 'bob', assets: 0, restrictions: ['restricted-library-access'] },
      { sourceId: '4', name: 'mallory', assets: 0, restrictions: ['restricted-library-access'] },
    ]);
    expect(inspection.losses).toEqual([
      { code: 'PIGALLERY2_CAPTURE_OFFSET_UNKNOWN', count: originals.length },
      { code: 'PIGALLERY2_SAVED_SEARCH_ARCHIVED', count: 1 },
      { code: 'PIGALLERY2_SHARING_RESTRICTED', count: 1 },
      { code: 'PIGALLERY2_SOURCE_METADATA_ARCHIVED', count: 1 },
    ]);
  });

  it('archives exactly named sidecars and keeps the saved search rows', async () => {
    const [first] = originals;
    await writeFile(join(originalsRoot, first.path + '.xmp'), 'sidecar');
    const { manifest, archive } = await open(async (source) => {
      const files = await source.files();
      return source.manifest(
        files.map((file) => ({
          ...file,
          bytes: String(originals.find((original) => original.path === file.path)!.bytes),
          sha256: '0'.repeat(64),
          modifiedAt: '2026-11-01T00:00:00.000Z',
        })),
      );
    });
    const records = [...(archive as Iterable<{ table: string; value: Record<string, unknown> }>)];
    expect(
      records.filter((record) => record.table === 'frameleaf_archived_file').map((record) => record.value.path),
    ).toEqual([first.path + '.xmp']);
    expect(records.filter((record) => record.table === 'album_base_entity')).toHaveLength(1);
    expect(manifest.albums.every((album) => album.id.startsWith('directory:'))).toBe(true);
    expect(manifest.assets.every((asset) => asset.ownerId === '1')).toBe(true);
  });

  it('carries each account bcrypt verifier', async () => {
    const encoded = await hash('synthetic owner password', 4);
    edit('UPDATE user_entity SET password=? WHERE id=1', encoded);
    const credential = await open(async (source) => {
      const [owner] = await source.owners();
      return owner.password({
        operationId: randomUUID(),
        sourceUserId: owner.sourceId,
        destinationUserId: randomUUID(),
      });
    });
    expect(await verifyImportedPassword('synthetic owner password', credential!.forImport())).toBe(true);
  });

  it('reads an untested schema best effort and records the untested-version loss', async () => {
    edit('CREATE TABLE frameleaf_extra (id INTEGER PRIMARY KEY)');
    const inspection = await inspectPreparationSource(adapter, {
      ...input(),
      source: { ...input().source, version: '9.9.9' },
    });
    expect(inspection.tested).toBe(false);
    expect(inspection.summary).toMatchObject({ owners: 4, assets: originals.length, files: originals.length });
    expect(inspection.losses).toContainEqual({ code: UNTESTED_VERSION_LOSS, count: 1 });
  });

  it('treats a newer data-structure version as untested', async () => {
    edit('UPDATE version_entity SET version=version+1');
    expect((await inspectPreparationSource(adapter, input())).tested).toBe(false);
  });

  it('refuses when an original is missing from the images folder', async () => {
    await rm(join(originalsRoot, originals[0].path));
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('IMPORT_SOURCE_ORIGINALS_MISSING');
  });
});

describe('PiGallery2 login facts', () => {
  it.each([
    [{ role: 4n, overrideAllowBlockList: 0n }, {}],
    [{ role: 3n, overrideAllowBlockList: 1n }, { ownedLibraryAccess: 'restricted' }],
    [{ role: 2n, overrideAllowBlockList: 0n }, { ownedLibraryAccess: 'restricted' }],
    [{ role: 9n, overrideAllowBlockList: 0n }, { otherRestrictions: 'present' }],
  ])('maps %o conservatively', (user, expected) => {
    expect(pigallery2Login(user)).toEqual({
      accountEnabled: true,
      passwordLoginEnabled: true,
      secondFactorRequired: false,
      externalIdentityRequired: false,
      ownedLibraryAccess: 'full',
      otherRestrictions: 'none',
      ...expected,
    });
  });
});
