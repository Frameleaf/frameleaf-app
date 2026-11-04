import { hash } from 'bcrypt';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/photoview/2.4.0-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/photoview/2.4.0-sqlite.json' with { type: 'json' };
import { verifyImportedPassword } from 'src/library-import/passwords.js';
import { PhotoviewTable, openPhotoviewSnapshot } from 'src/library-import/photoview.js';

describe('Photoview pinned SQLite extraction', () => {
  let root: string;
  let path: string;
  let database: DatabaseSync;
  const tableSchemaVariant = (table: 'media' | 'image_faces', sql: string) => {
    const candidatePath = join(root, 'schema-variant.sqlite');
    const candidate = new DatabaseSync(candidatePath);
    try {
      candidate.exec('PRAGMA foreign_keys=OFF');
      for (const type of ['table', 'index', 'trigger', 'view'])
        for (const object of fixture.objects)
          if (object.type === type && object.sql && !object.name.startsWith('sqlite_'))
            candidate.exec(object.type === 'table' && object.name === table ? sql : object.sql);
      expect(candidate.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
    } finally {
      candidate.close();
    }
    return candidatePath;
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-photoview-'));
    path = join(root, 'snapshot.sqlite');
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=OFF');
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.objects) {
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
      }
    for (const [table, rows] of Object.entries(content.rows))
      for (const captured of rows) {
        const row: Record<string, SQLInputValue> = { ...captured };
        switch (table) {
          case 'users': {
            row.password = 'excluded-password-hash';
            break;
          }
          case 'media_urls': {
            row.media_name = 'excluded-cache-name';
            break;
          }
          case 'share_tokens': {
            row.value = 'excluded-bearer-token';
            row.password = row.has_password === 1 ? 'excluded-share-password-hash' : null;
            delete row.has_password;

            break;
          }
          // No default
        }
        const names = Object.keys(row);
        database
          .prepare(
            `INSERT INTO "${table}" (${names.map((key) => `"${key}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
          )
          .run(...Object.values(row));
      }
  });
  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const rows = (table: PhotoviewTable) => {
    const source = openPhotoviewSnapshot(path, 'v2.4.0');
    try {
      return [...source.rows(table)].flat();
    } finally {
      source.close();
    }
  };
  it('transfers an explicitly mapped owner password through a protected channel', async () => {
    const password = 'synthetic owner password';
    const encoded = await hash(password, 12);
    database.prepare('UPDATE users SET password=? WHERE id=2').run(encoded);
    const source = openPhotoviewSnapshot(path, 'v2.4.0');
    try {
      const credential = await source.password({
        operationId: '11111111-1111-4111-8111-111111111111',
        sourceUserId: '2',
        destinationUserId: '22222222-2222-4222-8222-222222222222',
      });
      expect(credential).toBeDefined();
      expect(await verifyImportedPassword(password, credential!.forImport())).toBe(true);
      expect(JSON.stringify(credential)).not.toContain(encoded);
      expect([...source.rows('users')].flat()[0]).not.toHaveProperty('password');
    } finally {
      source.close();
    }
  });
  it('reads all native projected records, retaining shared access and per-user favourites', () => {
    for (const [table, expected] of Object.entries(content.rows))
      expect(rows(table as PhotoviewTable)).toHaveLength(expected.length);
    expect(rows('media')).toHaveLength(4);
    expect(
      rows('user_albums')
        .filter((row) => row.album_id === 7n)
        .map((row) => row.user_id),
    ).toEqual([2n, 3n]);
    expect(rows('user_media_data')).toMatchObject([{ user_id: 2n, media_id: 3n, favorite: 1n }]);
    expect(rows('users')[0]).not.toHaveProperty('password');
    expect(rows('media_urls')[0]).not.toHaveProperty('media_name');
  });
  it('refuses unknown versions and schema drift before returning content', () => {
    expect(() => openPhotoviewSnapshot(path, 'unknown')).toThrow('PHOTOVIEW_VERSION_UNQUALIFIED');
    database.exec('ALTER TABLE media ADD COLUMN unexpected TEXT');
    expect(() => openPhotoviewSnapshot(path, 'v2.4.0')).toThrow('PHOTOVIEW_SCHEMA_UNQUALIFIED');
  });

  it.each(['image_faces', 'media', 'share_tokens', 'user_albums'])(
    'admits only the known foreign-key order permutations in %s and retains their raw fingerprint',
    (table) => {
      const expected = fixture.objects.find((object) => object.type === 'table' && object.name === table)!.sql!;
      const [columns, ...constraints] = expected.slice(0, -1).split(',CONSTRAINT ');
      const foreignKeys = constraints.filter((clause) => clause.startsWith('`fk_')).toReversed();
      const other = constraints.filter((clause) => !clause.startsWith('`fk_'));
      const sql = [columns, ...foreignKeys, ...other].join(',CONSTRAINT ') + ')';
      database.exec('PRAGMA writable_schema=ON');
      database.prepare("UPDATE sqlite_schema SET sql=? WHERE type='table' AND name=?").run(sql, table);
      const source = openPhotoviewSnapshot(path, fixture.source.version);
      try {
        expect(source.schemaSha256).not.toBe(fixture.schemaSha256);
        expect([...source.rows('media')].flat()).toHaveLength(content.rows.media.length);
      } finally {
        source.close();
      }
    },
  );

  it.each(['missing', 'duplicate', 'changed'] as const)('refuses a %s foreign key', (change) => {
    const expected = fixture.objects.find((object) => object.type === 'table' && object.name === 'image_faces')!.sql!;
    const clause = ',CONSTRAINT ' + expected.slice(0, -1).split(',CONSTRAINT ', 2)[1];
    const sql =
      change === 'missing'
        ? expected.replace(clause, '')
        : change === 'duplicate'
          ? expected.replace(clause, () => clause + clause.replace('`fk_media_faces`', '`fk_extra`'))
          : expected.replace('ON DELETE CASCADE', 'ON DELETE SET NULL');
    database.exec('PRAGMA writable_schema=ON');
    database.prepare("UPDATE sqlite_schema SET sql=? WHERE name='image_faces'").run(sql);
    expect(() => openPhotoviewSnapshot(path, fixture.source.version)).toThrow('PHOTOVIEW_SCHEMA_UNQUALIFIED');
  });

  it('admits the captured native media uniqueness-clause order while retaining its raw fingerprint', () => {
    const expected = fixture.objects.find((object) => object.type === 'table' && object.name === 'media')!.sql!;
    const [columns, ...constraints] = expected.slice(0, -1).split(',CONSTRAINT ');
    const foreignKeys = constraints.filter((clause) => clause.startsWith('`fk_'));
    const unique = constraints.filter((clause) => clause.startsWith('`uni_')).toReversed();
    const candidate = tableSchemaVariant('media', [columns, ...foreignKeys, ...unique].join(',CONSTRAINT ') + ')');
    const source = openPhotoviewSnapshot(candidate, fixture.source.version);
    try {
      expect(source.schemaSha256).not.toBe(fixture.schemaSha256);
      expect([...source.rows('media')].flat()).toHaveLength(0);
    } finally {
      source.close();
    }
  });

  it.each(['missing', 'duplicate', 'changed'] as const)('refuses a %s uniqueness constraint', (change) => {
    const expected = fixture.objects.find((object) => object.type === 'table' && object.name === 'media')!.sql!;
    const clause = ',CONSTRAINT `uni_media_path_hash` UNIQUE (`path_hash`)';
    const sql =
      change === 'missing'
        ? expected.replace(clause, '')
        : change === 'duplicate'
          ? expected.replace(clause, () => clause + clause.replace('`uni_media_path_hash`', '`uni_extra`'))
          : expected.replace(clause, () => clause.replace('UNIQUE (`path_hash`)', 'UNIQUE (`side_car_hash`)'));
    const candidate = tableSchemaVariant('media', sql);
    expect(() => openPhotoviewSnapshot(candidate, fixture.source.version)).toThrow('PHOTOVIEW_SCHEMA_UNQUALIFIED');
  });

  it('refuses a constraint hidden inside a quoted column name instead of the qualified table tail', () => {
    const expected = fixture.objects.find((object) => object.type === 'table' && object.name === 'media')!.sql!;
    const clause = ',CONSTRAINT `uni_media_path_hash` UNIQUE (`path_hash`)';
    const sql = expected.replace(clause, '').replace('`title`', () => '`title' + clause + '`');
    const candidate = tableSchemaVariant('media', sql);
    expect(() => openPhotoviewSnapshot(candidate, fixture.source.version)).toThrow('PHOTOVIEW_SCHEMA_UNQUALIFIED');
  });
  it('refuses a foreign-key clause hidden inside a quoted column without changing the index inventory', () => {
    const expected = fixture.objects.find((object) => object.type === 'table' && object.name === 'image_faces')!.sql!;
    const clause = ',CONSTRAINT `fk_media_faces` FOREIGN KEY (`media_id`) REFERENCES `media`(`id`) ON DELETE CASCADE';
    const sql = expected.replace(clause, '').replace('`descriptor`', () => '`descriptor' + clause + '`');
    const candidate = tableSchemaVariant('image_faces', sql);
    expect(() => openPhotoviewSnapshot(candidate, fixture.source.version)).toThrow('PHOTOVIEW_SCHEMA_UNQUALIFIED');
  });
  it('refuses broken native foreign-key relationships', () => {
    database.exec('UPDATE media SET album_id=999 WHERE id=1');
    expect(() => openPhotoviewSnapshot(path, 'v2.4.0')).toThrow('PHOTOVIEW_RELATIONSHIPS_INVALID');
  });
  it('never reads sessions, tokens or unapproved tables', () => {
    const source = openPhotoviewSnapshot(path, 'v2.4.0');
    try {
      expect(() => [...source.rows('access_tokens' as never)]).toThrow('PHOTOVIEW_TABLE_NOT_ALLOWED');
    } finally {
      source.close();
    }
  });

  it('refuses added triggers or indexes as unqualified schema', () => {
    database.exec('CREATE INDEX unexpected ON media(title)');
    expect(() => openPhotoviewSnapshot(path, 'v2.4.0')).toThrow('PHOTOVIEW_SCHEMA_UNQUALIFIED');
  });

  it('preserves public share password requirements without transferring secrets', () => {
    const shares = rows('share_tokens');
    expect(shares.map((row) => row.has_password)).toEqual([0n, 1n]);
    for (const share of shares) {
      expect(share).not.toHaveProperty('password');
      expect(share).not.toHaveProperty('value');
    }
  });

  it('redacts filesystem failures and refuses reads after close', () => {
    expect(() => openPhotoviewSnapshot(join(root, 'private-missing.sqlite'), 'v2.4.0')).toThrow(
      'PHOTOVIEW_SNAPSHOT_UNAVAILABLE',
    );
    const source = openPhotoviewSnapshot(path, 'v2.4.0');
    source.close();
    expect(() => [...source.rows('users')]).toThrow('PHOTOVIEW_SNAPSHOT_READ_FAILED');
  });
  it('keeps all pages and integer identities exact for composite-key tables', () => {
    const insert = database.prepare('INSERT INTO user_media_data(user_id,media_id,favorite) VALUES(?,?,0)');
    database.exec('BEGIN');
    for (let index = 0; index < 2001; index++) insert.run(9_007_199_254_740_993n + BigInt(index), 1);
    database.exec('COMMIT');
    const source = openPhotoviewSnapshot(path, 'v2.4.0');
    try {
      const batches = [...source.rows('user_media_data')];
      expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 2]);
      expect(batches.flat().at(-1)!.user_id).toBe(9_007_199_254_742_993n);
    } finally {
      source.close();
    }
  });
});
