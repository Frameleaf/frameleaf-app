import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import records from 'src/library-import/fixtures/photoprism/261029-records.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/photoprism/261029-sqlite.json' with { type: 'json' };
import { readPhotoprismInventory } from 'src/library-import/photoprism-inventory.js';

describe('PhotoPrism snapshot inventory reconciliation', () => {
  let root: string;
  let path: string;
  let database: DatabaseSync;
  const collect = () => {
    const events = [...readPhotoprismInventory(path, fixture.source.version)];
    return {
      photos: events.filter((event) => event.type === 'photo').map((event) => event.value),
      files: events.filter((event) => event.type === 'file').map((event) => event.value),
      albums: events.filter((event) => event.type === 'album').map((event) => event.value),
      memberships: events.filter((event) => event.type === 'membership').map((event) => event.value),
      principals: events.filter((event) => event.type === 'principal').map((event) => event.value),
      archive: Object.fromEntries(
        Object.keys(records.tables).map((table) => [
          table,
          events
            .filter((event) => event.type === 'archive')
            .filter((event) => event.table === table)
            .map((event) => event.value),
        ]),
      ),
    };
  };
  const insert = (table: string, row: Record<string, SQLInputValue>) => {
    const keys = Object.keys(row);
    database
      .prepare(
        `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      )
      .run(...Object.values(row));
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-photoprism-inventory-'));
    path = join(root, 'source.sqlite');
    database = new DatabaseSync(path);
    for (const type of ['table', 'index', 'trigger', 'view']) {
      for (const object of fixture.objects) {
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
      }
    }
    for (const migration of fixture.migrations)
      insert('migrations', { ...migration, error: '', finished_at: '2026-11-01T00:00:00Z' });
    insert('versions', { version: fixture.source.executableVersion, error: '', migrated_at: '2026-11-01T00:00:00Z' });
    for (const [name, rows] of Object.entries(records.tables)) {
      for (const row of rows)
        insert(name === 'users' ? 'auth_users' : name === 'shares' ? 'auth_users_shares' : name, row);
    }
  });
  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  it('reconciles the actual generated source records while keeping system principals out of account candidates', () => {
    const inventory = collect();
    expect(inventory.photos).toHaveLength(2);
    expect(inventory.files).toHaveLength(2);
    expect(inventory.albums).toHaveLength(3);
    expect(inventory.photos.every((photo) => inventory.files.some((file) => file.photoId === photo.id))).toBe(true);
    expect(inventory.principals.filter((principal) => !principal.system).map((principal) => principal.name)).toEqual([
      'Admin',
    ]);
    expect(inventory.principals.filter((principal) => principal.system)).toHaveLength(2);
    expect(inventory.archive.photos_albums[0].photo_uid).toBe(records.tables.photos_albums[0].photo_uid);
    expect(inventory.albums.find((album) => album.private)?.id).toBe(records.tables.photos_albums[0].album_uid);
    expect(inventory.archive.photos_keywords).toHaveLength(7);
    expect(inventory.photos.every((photo) => photo.createdBy === undefined)).toBe(true);
    expect(JSON.stringify(inventory.principals)).not.toMatch(/reset_token|invite_token|preview_token/u);
  });
  it('retains every physical original within a logical photo without deduplicating bytes', () => {
    const original = records.tables.files[0];
    insert('files', {
      ...original,
      id: 99,
      file_uid: 'second-original',
      file_name: 'owner-a/second.png',
      file_primary: 0,
      time_index: null,
      media_id: null,
    });
    const inventory = collect();
    expect(inventory.files).toHaveLength(3);
    expect(inventory.files.filter((file) => file.photoId === original.photo_uid).map((file) => file.id)).toEqual([
      original.file_uid,
      'second-original',
    ]);
  });
  it('refuses mismatched numeric and stable photo identities on files', () => {
    database.exec('UPDATE files SET photo_id=999 WHERE id=(SELECT min(id) FROM files)');
    expect(() => collect()).toThrow('PHOTOPRISM_FILE_PHOTO_MISMATCH');
  });
  it('refuses dangling active album memberships', () => {
    database.exec("UPDATE photos_albums SET photo_uid='absent'");
    expect(() => collect()).toThrow('PHOTOPRISM_ALBUM_PHOTO_MISSING');
  });
  it.each([
    { hidden: 1, missing: 0 },
    { hidden: 0, missing: 1 },
  ])('retains excluded historical relationships without reviving them case %#', (flags) => {
    database
      .prepare("UPDATE photos_albums SET photo_uid='removed-photo',hidden=?,missing=?")
      .run(flags.hidden, flags.missing);
    const inventory = collect();
    expect(inventory.archive.photos_albums[0]).toMatchObject({
      photo_uid: 'removed-photo',
      hidden: BigInt(flags.hidden),
      missing: BigInt(flags.missing),
    });
    expect(inventory.memberships[0]).toMatchObject({
      photoId: 'removed-photo',
      hidden: Boolean(flags.hidden),
      missing: Boolean(flags.missing),
    });
  });
  it('refuses ambiguous membership visibility flags', () => {
    database.exec('UPDATE photos_albums SET hidden=NULL');
    expect(() => collect()).toThrow('PHOTOPRISM_ALBUM_MEMBERSHIP_INVALID');
  });
  it('refuses membership records without an album', () => {
    database.exec("UPDATE photos_albums SET album_uid='absent'");
    expect(() => collect()).toThrow('PHOTOPRISM_MEMBERSHIP_ALBUM_MISSING');
  });
  it('refuses photos for which only a generated primary rendition remains', () => {
    database.exec("UPDATE files SET file_root='sidecar',file_primary=1 WHERE id=(SELECT min(id) FROM files)");
    expect(() => collect()).toThrow('PHOTOPRISM_PHOTO_WITHOUT_ORIGINAL');
  });
  it('refuses orphan details', () => {
    insert('details', { photo_id: 999, keywords: '' });
    expect(() => collect()).toThrow('PHOTOPRISM_DETAILS_PHOTO_MISSING');
  });
  it('keeps distinct user identities separate when their emails match', () => {
    const user = records.tables.users.find((user) => user.user_name === 'admin')!;
    insert('auth_users', {
      ...user,
      user_uid: 'another-source-user',
      user_name: 'another',
      user_email: 'fixture@example.invalid',
    });
    database
      .prepare('UPDATE auth_users SET user_email=? WHERE user_uid=?')
      .run('fixture@example.invalid', user.user_uid);
    expect(
      collect()
        .principals.filter((principal) => !principal.system)
        .map((principal) => principal.id),
    ).toEqual([user.user_uid, 'another-source-user']);
  });
  it('rejects changed built-in system identity semantics rather than treating them as ordinary accounts', () => {
    database.exec("UPDATE auth_users SET can_login=1 WHERE user_uid='u000000000000001'");
    expect(() => collect()).toThrow('PHOTOPRISM_SYSTEM_PRINCIPAL_CHANGED');
  });
  it('closes its read transaction on refusal', () => {
    database.exec('DELETE FROM files');
    expect(() => collect()).toThrow('PHOTOPRISM_PHOTO_WITHOUT_ORIGINAL');
    expect(() => database.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE; ROLLBACK')).not.toThrow();
  });
  it('closes the source read transaction when a consumer stops early', () => {
    const stream = readPhotoprismInventory(path, fixture.source.version);
    expect(stream.next().done).toBe(false);
    stream.return();
    expect(() => database.exec('BEGIN EXCLUSIVE; ROLLBACK')).not.toThrow();
  });
});
