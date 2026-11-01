import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/photoview/2.4.0-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/photoview/2.4.0-sqlite.json' with { type: 'json' };
import { PhotoviewTable, openPhotoviewSnapshot } from 'src/library-import/photoview.js';

describe('Photoview pinned SQLite extraction', () => {
  let root: string;
  let path: string;
  let database: DatabaseSync;
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
    for (let index = 0; index < 2001; index++) insert.run(9_007_199_254_740_993n + BigInt(index), 1);
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
