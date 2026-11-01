import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/pigallery2/3.5.2-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-sqlite.json' with { type: 'json' };
import { Pigallery2Table, openPigallery2Snapshot } from 'src/library-import/pigallery2.js';

describe('PiGallery2 pinned SQLite extraction', () => {
  let root: string;
  let path: string;
  let database: DatabaseSync;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-pigallery2-'));
    path = join(root, 'snapshot.sqlite');
    database = new DatabaseSync(path);
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
            `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
          )
          .run(...Object.values(row));
      }
    database.exec('COMMIT');
  });
  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const rows = (table: Pigallery2Table) => {
    const source = openPigallery2Snapshot(path, '3.5.2');
    try {
      return [...source.rows(table)].flat();
    } finally {
      source.close();
    }
  };

  it('reconciles every native projected record and directory/media relationship', () => {
    const normalize = (value: unknown) =>
      JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' || typeof v === 'number' ? String(v) : v)));
    for (const [table, expected] of Object.entries(content.rows))
      expect(normalize(rows(table as Pigallery2Table))).toEqual(normalize(expected));
    expect(rows('media_entity')).toHaveLength(4);
    expect(rows('directory_entity')).toHaveLength(4);
    expect(typeof rows('media_entity')[0].id).toBe('bigint');
  });

  it('retains captions, source date values and unknown timezone offset', () => {
    expect(rows('media_entity').find((row) => row.id === 4n)).toMatchObject({
      metadataCaption: 'Synthetic alice-private',
      metadataCreationdate: 1_552_832_116_000n,
      metadataCreationdateoffset: null,
    });
  });

  it('retains per-user allow/block queries and saved searches without granting ownership', () => {
    const alice = rows('user_entity').find((row) => row.name === 'alice')!;
    expect(alice.overrideAllowBlockList).toBe(1n);
    expect(JSON.parse(String(alice.allowQuery))).toMatchObject({ type: 2, list: [{ type: 101 }, { type: 101 }] });
    expect(JSON.parse(String(alice.blockQuery))).toEqual({ type: 103, value: 'duplicate.jpg', matchType: 1 });
    expect(rows('album_base_entity')[0]).toMatchObject({
      name: 'Shared originals snapshot',
      type: 'SavedSearchEntity',
    });
    expect(rows('media_entity')[0]).not.toHaveProperty('ownerId');
  });

  it('preserves password-protected share intent and creator but excludes authentication material', () => {
    expect(rows('sharing_entity')).toMatchObject([{ has_password: 1n, creatorId: 2n }]);
    for (const row of [...rows('user_entity'), ...rows('sharing_entity')])
      for (const key of ['password', 'sharingKey']) expect(row).not.toHaveProperty(key);
  });

  it('refuses unknown application versions and unqualified schema', () => {
    expect(() => openPigallery2Snapshot(path, 'unknown')).toThrow('PIGALLERY2_VERSION_UNQUALIFIED');
    database.exec('CREATE TABLE unexpected_plugin (id INTEGER)');
    expect(() => openPigallery2Snapshot(path, '3.5.2')).toThrow('PIGALLERY2_SCHEMA_UNQUALIFIED');
  });

  it.each([
    'UPDATE version_entity SET version=40',
    'DELETE FROM version_entity',
    'INSERT INTO version_entity(id,version) VALUES(2,41)',
  ])('refuses unqualified structure-version state: %s', (statement) => {
    database.exec(statement);
    expect(() => openPigallery2Snapshot(path, '3.5.2')).toThrow('PIGALLERY2_STRUCTURE_VERSION_UNQUALIFIED');
  });

  it('refuses broken declared foreign keys', () => {
    database.exec('UPDATE media_entity SET directoryId=999 WHERE id=1');
    expect(() => openPigallery2Snapshot(path, '3.5.2')).toThrow('PIGALLERY2_RELATIONSHIPS_INVALID');
  });

  it('never extracts generated projection caches or unapproved tables', () => {
    const source = openPigallery2Snapshot(path, '3.5.2');
    try {
      expect(() => [...source.rows('projected_directory_cache_entity' as never)]).toThrow(
        'PIGALLERY2_TABLE_NOT_ALLOWED',
      );
    } finally {
      source.close();
    }
  });

  it('keeps all pages and integer identities exact', () => {
    const insert = database.prepare('INSERT INTO user_entity(id,name,password,role) VALUES(?,?,?,3)');
    database.exec('BEGIN');
    for (let index = 0; index < 2001; index++)
      insert.run(9_007_199_254_740_993n + BigInt(index), `user-${index}`, 'excluded-hash');
    database.exec('COMMIT');
    const source = openPigallery2Snapshot(path, '3.5.2');
    try {
      const batches = [...source.rows('user_entity')];
      expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 5]);
      expect(batches.flat().at(-1)!.id).toBe(9_007_199_254_742_993n);
    } finally {
      source.close();
    }
  });

  it('redacts unavailable snapshots and refuses reads after close', () => {
    expect(() => openPigallery2Snapshot(join(root, 'missing.sqlite'), '3.5.2')).toThrow(
      'PIGALLERY2_SNAPSHOT_UNAVAILABLE',
    );
    const source = openPigallery2Snapshot(path, '3.5.2');
    source.close();
    expect(() => [...source.rows('media_entity')]).toThrow('PIGALLERY2_SNAPSHOT_READ_FAILED');
  });
});
