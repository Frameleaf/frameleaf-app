import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import content from 'src/library-import/fixtures/lychee/7.12.0-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/lychee/7.12.0-sqlite.json' with { type: 'json' };
import { adapter } from 'src/library-import/preparation/lychee.js';
import { UNTESTED_VERSION_LOSS, inspectPreparationSource } from 'src/library-import/preparation/prepare.js';

describe('Lychee preparation adapter', () => {
  let directory: string;
  let snapshotPath: string;
  let originalsRoot: string;
  const input = () => ({
    source: {
      kind: 'lychee' as const,
      version: fixture.source.version,
      identity: 'synthetic-lychee',
      revision: 'a'.repeat(64),
      schemaSha256: fixture.schemaSha256,
    },
    snapshotPath,
    originalsRoot,
  });
  const edit = (sql: string) => {
    const database = new DatabaseSync(snapshotPath);
    database.exec(sql);
    database.close();
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-prepare-lychee-'));
    snapshotPath = join(directory, 'source.sqlite');
    originalsRoot = join(directory, 'uploads');
    const database = new DatabaseSync(snapshotPath);
    const insert = (table: string, row: Record<string, SQLInputValue>) => {
      const names = Object.keys(row);
      database
        .prepare(
          // eslint-disable-next-line unicorn/no-unsafe-sqlite-interpolation -- Fixture identifiers only; values are bound.
          `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
        )
        .run(...Object.values(row));
    };
    database.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
    for (const migration of fixture.migrations) insert('migrations', migration);
    for (const [table, records] of Object.entries(content.rows))
      for (const value of records) {
        const row: Record<string, SQLInputValue> = { ...value };
        if (table === 'users') row.password = 'excluded-password';
        else if (table === 'access_permissions') {
          row.password = row.has_password === 1 ? 'excluded-share-password' : null;
          delete row.has_password;
        }
        insert(table, row);
      }
    database.exec('ANALYZE; COMMIT');
    database.close();
    for (const original of content.originals) {
      const path = join(originalsRoot, original.path.slice('/uploads/'.length));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(original.originalBase64, 'base64'));
    }
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('inspects the qualified fixture as tested', async () => {
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection).toMatchObject({
      format: 'frameleaf-library-import-inspection',
      tested: true,
      testedVersion: fixture.source.version,
      summary: {
        owners: 4,
        assets: 4,
        albums: 3,
        files: 4,
        bytes: String(content.originals.reduce((sum, file) => sum + Number(file.bytes), 0)),
      },
    });
    expect(inspection.owners.map(({ sourceId, assets, restrictions }) => ({ sourceId, assets, restrictions }))).toEqual(
      [
        { sourceId: '1', assets: 0, restrictions: [] },
        { sourceId: '2', assets: 3, restrictions: [] },
        { sourceId: '3', assets: 1, restrictions: [] },
        { sourceId: '4', assets: 0, restrictions: [] },
      ],
    );
    expect(inspection.owners.find((owner) => owner.sourceId === '2')?.name).toBe('fixture_alice');
    const codes = inspection.losses.map((loss) => loss.code);
    expect(codes).toContain('LYCHEE_SHARING_RESTRICTED');
    expect(codes).not.toContain(UNTESTED_VERSION_LOSS);
  });

  it('reports LDAP accounts as requiring an external identity', async () => {
    edit('UPDATE users SET is_ldap=1 WHERE id=3');
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.owners.find((owner) => owner.sourceId === '3')?.restrictions).toEqual([
      'external-identity-required',
    ]);
  });

  it('reads an untested schema best effort and records the untested-version loss', async () => {
    edit('CREATE TABLE frameleaf_extra (id INTEGER PRIMARY KEY); ALTER TABLE photos ADD COLUMN frameleaf_extra TEXT');
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.tested).toBe(false);
    expect(inspection.summary).toMatchObject({ owners: 4, assets: 4, albums: 3, files: 4 });
    expect(inspection.losses).toContainEqual({ code: UNTESTED_VERSION_LOSS, count: 1 });
  });

  it('refuses when an original is missing from the mount', async () => {
    await rm(join(originalsRoot, content.originals[0].path.slice('/uploads/'.length)));
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('IMPORT_SOURCE_ORIGINALS_MISSING');
  });
});
