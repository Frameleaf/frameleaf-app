import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/nextcloud/35-8-10.2-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/nextcloud/35-8-10.2-sqlite.json' with { type: 'json' };
import argonVectors from 'src/library-import/fixtures/password-argon2-vectors.json' with { type: 'json' };
import bcryptVectors from 'src/library-import/fixtures/password-vectors.json' with { type: 'json' };
import { NextcloudTable, openNextcloudSnapshot } from 'src/library-import/nextcloud.js';
import { verifyImportedPassword } from 'src/library-import/passwords.js';

describe('Nextcloud Photos / Memories pinned SQLite extraction', () => {
  let root: string;
  let path: string;
  let database: DatabaseSync;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-nextcloud-'));
    path = join(root, 'snapshot.sqlite');
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.structure.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
    const records = { ...content.rows, oc_appconfig: fixture.appState, oc_migrations: fixture.migrations };
    for (const [table, captured] of Object.entries(records))
      for (const value of captured) {
        const row: Record<string, SQLInputValue> = { ...value };
        if (table === 'oc_users') row.password = 'excluded-user-password-hash';
        else if (table === 'oc_files_metadata') row.sync_token = 'excluded-sync-cursor';
        else if (table === 'oc_photos_albums_collabs' && row.collaborator_type === 3)
          row.collaborator_id = 'excluded-public-link-token';
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
  it.each(['1', '2', '3'])('preserves a mapped local account with source password version %s', async (version) => {
    const vector =
      version === '1'
        ? bcryptVectors.php.vectors[0]
        : argonVectors.vectors.find((row) => row.hash.startsWith(version === '2' ? '$argon2i$' : '$argon2id$'))!;
    const uid = String(database.prepare('SELECT uid FROM oc_users ORDER BY uid LIMIT 1').get()!.uid);
    database.prepare('UPDATE oc_users SET password=? WHERE uid=?').run(`${version}|${vector.hash}`, uid);
    const source = openNextcloudSnapshot(path, fixture.source.version);
    try {
      const credential = await source.password({
        operationId: '11111111-1111-4111-8111-111111111111',
        sourceUserId: uid,
        destinationUserId: '22222222-2222-4222-8222-222222222222',
      });
      expect(await verifyImportedPassword(vector.password, credential!.forImport())).toBe(true);
      expect(await verifyImportedPassword('wrong', credential!.forImport())).toBe(false);
      expect([...source.rows('oc_users')].flat()[0]).not.toHaveProperty('password');
    } finally {
      source.close();
    }
  });
  const rows = (table: NextcloudTable) => {
    const source = openNextcloudSnapshot(path, fixture.source.version);
    try {
      return [...source.rows(table)].flat();
    } finally {
      source.close();
    }
  };
  const normalize = (value: unknown) =>
    JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' || typeof v === 'number' ? String(v) : v)));

  it('reconciles every native projected row without rounding database integers', () => {
    for (const [table, expected] of Object.entries(content.rows))
      expect(normalize(rows(table as NextcloudTable))).toEqual(normalize(expected));
    expect(rows('oc_filecache')).toHaveLength(100);
    expect(typeof rows('oc_filecache')[0].fileid).toBe('bigint');
  });

  it('retains storage identities and internal paths independently of host paths', () => {
    for (const file of content.native.files) {
      const cached = rows('oc_filecache').find((row) => String(row.fileid) === file.id)!;
      const storage = rows('oc_storages').find((row) => row.numeric_id === cached.storage)!;
      expect(cached).toMatchObject({ path: file.internalPath, size: BigInt(file.bytes), encrypted: 0n });
      expect(storage.id).toBe(file.storageId);
      expect(rows('oc_mounts')).toContainEqual(
        expect.objectContaining({ storage_id: cached.storage, user_id: file.owner }),
      );
    }
    expect(content.native.files[0].sha256).toBe(content.native.files[4].sha256);
    expect(content.native.files[0].id).not.toBe(content.native.files[4].id);
  });

  it('retains album owners, memberships, and separate user/group/public-link access kinds', () => {
    expect(rows('oc_photos_albums')).toHaveLength(4);
    expect(rows('oc_photos_albums_files')).toHaveLength(4);
    expect(rows('oc_photos_albums_collabs').map((row) => row.collaborator_type)).toEqual([1n, 0n, 3n]);
    expect(rows('oc_group_user')).toContainEqual({ gid: 'family', uid: 'bob' });
    expect(content.native.access.filter((row) => row.collaborator)).toEqual([
      { albumId: '2', userId: 'bob', owner: false, collaborator: true },
      { albumId: '3', userId: 'bob', owner: false, collaborator: true },
    ]);
  });

  it('keeps optional Memories records without inventing video or Live Photo metadata', () => {
    expect(rows('oc_memories')).toHaveLength(3);
    expect(rows('oc_memories').every((row) => row.liveid === '' && row.isvideo === 0n)).toBe(true);
    expect(content.native.files.filter((row) => row.mime.startsWith('video/'))).toHaveLength(2);
  });

  it('excludes account hashes, source public-link tokens, and unapproved authentication tables', () => {
    expect(JSON.stringify(normalize(rows('oc_users')))).not.toContain('excluded-');
    expect(JSON.stringify(normalize(rows('oc_photos_albums_collabs')))).not.toContain('excluded-');
    const source = openNextcloudSnapshot(path, fixture.source.version);
    try {
      expect(() => [...source.rows('oc_authtoken' as never)]).toThrow('NEXTCLOUD_TABLE_NOT_ALLOWED');
    } finally {
      source.close();
    }
  });

  it('retains restrictive share policy while excluding password and bearer material', () => {
    database
      .prepare(
        "INSERT INTO oc_share(id,share_type,share_with,uid_owner,uid_initiator,file_source,permissions,hide_download,password,token,attributes) VALUES(1,0,'bob','alice','alice',95,1,1,?,?,?)",
      )
      .run('excluded-share-hash', 'excluded-share-token', '[{"scope":"permissions","key":"download","value":false}]');
    expect(rows('oc_share')[0]).toMatchObject({ permissions: 1n, hide_download: 1n, has_password: 1n });
    expect(JSON.stringify(normalize(rows('oc_share')))).not.toContain('excluded-');
    expect(rows('oc_share')[0]).not.toHaveProperty('token');
    expect(rows('oc_share')[0]).not.toHaveProperty('password');
  });

  it('redacts failed reads after close', () => {
    const source = openNextcloudSnapshot(path, fixture.source.version);
    source.close();
    expect(() => [...source.rows('oc_filecache')]).toThrow('NEXTCLOUD_SNAPSHOT_READ_FAILED');
  });

  it.each([
    "UPDATE oc_appconfig SET configvalue='9.0.0' WHERE appid='photos' AND configkey='installed_version'",
    "DELETE FROM oc_appconfig WHERE appid='memories' AND configkey='installed_version'",
    "UPDATE oc_appconfig SET configvalue='no' WHERE appid='photos' AND configkey='enabled'",
    "DELETE FROM oc_migrations WHERE app='photos'",
  ])('refuses unqualified installed application state: %s', (sql) => {
    database.exec(sql);
    expect(() => openNextcloudSnapshot(path, fixture.source.version)).toThrow(
      'NEXTCLOUD_APPLICATION_STATE_UNQUALIFIED',
    );
  });

  it('refuses unknown versions, schemas, and unavailable snapshots with redacted errors', () => {
    expect(() => openNextcloudSnapshot(path, 'unknown')).toThrow('NEXTCLOUD_VERSION_UNQUALIFIED');
    expect(() => openNextcloudSnapshot(join(root, 'private-location.sqlite'), fixture.source.version)).toThrow(
      'NEXTCLOUD_SNAPSHOT_UNAVAILABLE',
    );
    database.exec('CREATE TABLE unexpected_plugin(id INTEGER)');
    expect(() => openNextcloudSnapshot(path, fixture.source.version)).toThrow('NEXTCLOUD_SCHEMA_UNQUALIFIED');
  });

  it('keeps pagination and signed 64-bit identities exact', () => {
    const insert = database.prepare(
      'INSERT INTO oc_filecache(fileid,storage,path,path_hash,parent,name,mimetype,mimepart,size,mtime,storage_mtime,encrypted,unencrypted_size,etag,permissions,checksum) VALUES(?,3,?,?,0,?,1,1,0,0,0,0,0,?,31,?)',
    );
    database.exec('BEGIN');
    for (let index = 0; index < 2001; index++)
      insert.run(9_007_199_254_740_993n + BigInt(index), `files/${index}`, `hash-${index}`, String(index), '', '');
    database.exec('COMMIT');
    const source = openNextcloudSnapshot(path, fixture.source.version);
    try {
      const batches = [...source.rows('oc_filecache')];
      expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 101]);
      expect(batches.flat().at(-1)!.fileid).toBe(9_007_199_254_742_993n);
    } finally {
      source.close();
    }
  });
});
