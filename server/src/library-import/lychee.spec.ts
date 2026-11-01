import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/lychee/7.12.0-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/lychee/7.12.0-sqlite.json' with { type: 'json' };
import { LycheeTable, openLycheeSnapshot } from 'src/library-import/lychee.js';

describe('Lychee pinned SQLite extraction', () => {
  let root: string;
  let path: string;
  let database: DatabaseSync;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-lychee-'));
    path = join(root, 'snapshot.sqlite');
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
    const insert = (table: string, row: Record<string, SQLInputValue>) => {
      const names = Object.keys(row);
      database
        .prepare(
          `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
        )
        .run(...Object.values(row));
    };
    for (const migration of fixture.migrations) insert('migrations', migration);
    for (const [table, captured] of Object.entries(content.rows))
      for (const original of captured) {
        const row: Record<string, SQLInputValue> = { ...original };
        if (table === 'users') {
          row.password = 'excluded-native-password-hash';
          row.token = `excluded-api-token-${row.id}`;
          row.remember_token = 'excluded-session-token';
        } else if (table === 'access_permissions') {
          row.password = row.has_password === 1 ? 'excluded-share-password' : null;
          delete row.has_password;
        }
        insert(table, row);
      }
    database.exec('ANALYZE; COMMIT');
  });
  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  const rows = (table: LycheeTable) => {
    const source = openLycheeSnapshot(path, 'v7.12.0');
    try {
      return [...source.rows(table)].flat();
    } finally {
      source.close();
    }
  };
  it('reconciles every captured field without authentication material', () => {
    for (const [table, expected] of Object.entries(content.rows))
      expect(
        JSON.parse(
          JSON.stringify(rows(table as LycheeTable), (_key, value) =>
            typeof value === 'bigint' ? Number(value) : value,
          ),
        ),
      ).toEqual(expected);
    for (const user of rows('users')) {
      expect(user).not.toHaveProperty('password');
      expect(user).not.toHaveProperty('token');
      expect(user).not.toHaveProperty('remember_token');
    }
  });
  it('preserves recorded owner and original-download restrictions independently of URL reachability', () => {
    expect(rows('access_permissions')).toMatchObject([
      { user_id: 3n, grants_download: 0n, grants_full_photo_access: 0n },
    ]);
    expect(new Set(rows('photos').map((row) => row.owner_id))).toEqual(new Set([2n, 3n]));
    expect(content.expected.staticOriginalUrl.status).toBe(200);
    expect(content.expected.access.find((row) => row.user === 'bob' && row.canDownload === false)).toBeDefined();
  });
  it('retains password requirements without transferring password hashes', () => {
    database.exec("UPDATE access_permissions SET password='excluded-share-password'");
    const permissions = rows('access_permissions');
    expect(permissions[0].has_password).toBe(1n);
    expect(permissions[0]).not.toHaveProperty('password');
  });
  it('preserves original size variants separately from generated and watermarked variants', () => {
    const originals = rows('size_variants').filter((row) => row.type === 1n);
    expect(originals).toHaveLength(4);
    for (const original of content.originals) {
      const variant = originals.find((row) => row.photo_id === original.photoId)!;
      const bytes = Buffer.from(original.originalBase64, 'base64');
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(original.sha256);
      expect(String(variant.filesize)).toBe(original.bytes);
      expect(variant.storage_disk).toBe('images');
      expect(variant.short_path_watermarked).toBeNull();
      expect(original.path).toBe('/uploads/' + variant.short_path);
    }
  });
  it('refuses unknown builds, schema changes and broken foreign keys', () => {
    expect(() => openLycheeSnapshot(path, 'unknown')).toThrow('LYCHEE_VERSION_UNQUALIFIED');
    database.exec("UPDATE photo_album SET photo_id='missing' WHERE rowid=(SELECT min(rowid) FROM photo_album)");
    expect(() => openLycheeSnapshot(path, 'v7.12.0')).toThrow('LYCHEE_RELATIONSHIPS_INVALID');
  });
  it.each([
    'DELETE FROM migrations WHERE id=1',
    "INSERT INTO migrations(migration,batch) VALUES('unexpected',1)",
    'UPDATE migrations SET batch=0',
    "UPDATE migrations SET migration='duplicate'",
  ])('refuses incomplete/unknown migration inventory: %s', (sql) => {
    database.exec(sql);
    expect(() => openLycheeSnapshot(path, 'v7.12.0')).toThrow('LYCHEE_MIGRATIONS_UNQUALIFIED');
  });
  it('refuses unapproved tables and reads after close without leaking source paths', () => {
    expect(() => openLycheeSnapshot(join(root, 'private-missing.sqlite'), 'v7.12.0')).toThrow(
      'LYCHEE_SNAPSHOT_UNAVAILABLE',
    );
    const source = openLycheeSnapshot(path, 'v7.12.0');
    expect(() => [...source.rows('oauth_credentials' as never)]).toThrow('LYCHEE_TABLE_NOT_ALLOWED');
    source.close();
    expect(() => [...source.rows('photos')]).toThrow('LYCHEE_SNAPSHOT_READ_FAILED');
  });
  it('refuses executable schema drift before returning a reader', () => {
    database.exec('CREATE TRIGGER unexpected AFTER INSERT ON photos BEGIN SELECT 1; END');
    expect(() => openLycheeSnapshot(path, 'v7.12.0')).toThrow('LYCHEE_SCHEMA_UNQUALIFIED');
  });
  it('reads integer-safe bounded batches under one stable read transaction', () => {
    database.exec('BEGIN');
    const insert = database.prepare('INSERT INTO tags(id,name) VALUES(?,?)');
    for (let i = 0; i < 2001; i++) insert.run(9_007_199_254_740_993n + BigInt(i), `tag-${i}`);
    database.exec('COMMIT');
    const source = openLycheeSnapshot(path, 'v7.12.0');
    try {
      const batches = [...source.rows('tags')];
      expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 1]);
      expect(batches[0][0].id).toBe(9_007_199_254_740_993n);
      expect(() => database.exec("INSERT INTO tags(name) VALUES('changed')")).toThrow();
    } finally {
      source.close();
    }
  });
});
