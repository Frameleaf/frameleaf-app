import { hash } from 'bcrypt';
import { type Connection, createConnection } from 'mysql2/promise';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { Socket, connect, createServer } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fileFixture from 'src/library-import/fixtures/photoprism/261029-files.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/photoprism/261029-mariadb114.json' with { type: 'json' };
import { verifyImportedPassword } from 'src/library-import/passwords.js';
import { assemblePhotoprismManifest } from 'src/library-import/photoprism-manifest.js';
import { readPhotoprismMariadbInventory } from 'src/library-import/photoprism-mariadb-source.js';

const config = {
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: 'synthetic-only',
  database: 'unavailable',
  version: fixture.source.version,
};
it('refuses unqualified source versions before connecting', async () => {
  await expect(readPhotoprismMariadbInventory({ ...config, version: 'unknown' }).next()).rejects.toThrow(
    'PHOTOPRISM_VERSION_UNQUALIFIED',
  );
});
it('refuses remote plaintext connections before reading source credentials', async () => {
  await expect(readPhotoprismMariadbInventory({ ...config, host: 'restore.invalid' }).next()).rejects.toThrow(
    'PHOTOPRISM_SOURCE_TLS_REQUIRED',
  );
});

it('sanitizes failed source handshakes and closes their owned transport', async () => {
  const server = createServer((socket) => socket.destroy());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test listener');
  try {
    await expect(readPhotoprismMariadbInventory({ ...config, port: address.port }).next()).rejects.toThrow(
      'PHOTOPRISM_SOURCE_UNAVAILABLE',
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const path = process.env.FRAMELEAF_PHOTOPRISM_TEST_CONFIG;
describe.skipIf(!path)('native isolated PhotoPrism MariaDB restore', () => {
  let admin: Connection;
  let source: typeof config;
  const collect = async () => {
    const records = [];
    for await (const record of readPhotoprismMariadbInventory(source)) records.push(record);
    return records;
  };
  beforeAll(async () => {
    source = { ...config, ...JSON.parse(readFileSync(path!, 'utf8')) };
    if (source.host !== '127.0.0.1' || !/^frameleaf_photoprism_test_[a-f0-9]{8}$/u.test(source.database))
      throw new Error('Native source test requires a dedicated loopback fixture database');
    admin = await createConnection({ ...source, version: undefined, multipleStatements: true } as never);
  });
  afterAll(async () => {
    await admin?.end();
  });
  beforeEach(async () => {
    await admin.query('SET SESSION lock_wait_timeout=1; SET GLOBAL read_only=ON');
    await admin.query(
      readFileSync(new URL('fixtures/photoprism/261029-mariadb114-schema.sql', import.meta.url), 'utf8'),
    );
    await admin.query(
      readFileSync(new URL('fixtures/photoprism/261029-mariadb114-content.sql', import.meta.url), 'utf8'),
    );
  });
  it('preserves all native originals and manual metadata without transferring credentials', async () => {
    await admin.query(
      "UPDATE photos SET photo_title='Manual caption title',title_src='manual',photo_caption='Private edited caption',caption_src='manual',photo_private=1,photo_favorite=1,taken_at='2020-05-02 12:34:56',taken_at_local='2020-05-02 14:34:56',time_zone='Europe/Paris' WHERE id=1",
    );
    const records = await collect();
    const photos = records.filter((row) => row.type === 'photo').map((row) => row.value);
    expect(photos).toHaveLength(2);
    expect(photos[0]).toMatchObject({
      metadata: {
        title: 'Manual caption title',
        description: 'Private edited caption',
        favorite: true,
        takenAt: '2020-05-02T12:34:56Z',
        timeZone: 'Europe/Paris',
      },
      localDateTime: '2020-05-02T14:34:56',
      state: { private: true },
    });
    expect(
      records
        .filter((row) => row.type === 'file')
        .map((row) => row.value.path)
        .sort(),
    ).toEqual(['owner-a/blue.png', 'owner-b/green.png']);
    expect(JSON.stringify(records, (_, value) => (typeof value === 'bigint' ? value.toString() : value))).not.toMatch(
      /invite_token|verify_token|reset_token|passwords|auth_sessions/u,
    );
  });
  it('retains the native numeric account ID without replacing its stable UID', async () => {
    const uid = 'u000000000000777';
    await admin.query(
      "INSERT INTO auth_users(id,user_uid,user_name,user_role,auth_provider,can_login) VALUES(777,?,'identity-owner','admin','',1)",
      [uid],
    );
    const records = await collect();
    expect(
      records.find((row) => row.type === 'archive' && row.table === 'users' && row.value.user_uid === uid),
    ).toMatchObject({
      value: { id: 777n, user_uid: uid, auth_provider: '' },
    });
    expect(records.find((row) => row.type === 'principal' && row.value.id === uid)).toMatchObject({
      value: { id: uid },
    });
  });
  it('archives native account preferences alongside the same explicitly identified principal', async () => {
    await admin.query(
      "INSERT INTO auth_users (user_uid,user_name,display_name,user_role,auth_provider,can_login) VALUES ('u000000000000777','settings-owner','Settings Owner','admin','local',1)",
    );
    await admin.query(
      "INSERT INTO auth_users_settings (user_uid,ui_language,ui_time_zone,download_originals,download_media_raw,download_media_sidecar,upload_path) VALUES ('u000000000000777','fr','Europe/Paris',1,-1,0,'family/uploads')",
    );
    const records = await collect();
    const settings = records.filter((row) => row.type === 'archive' && row.table === 'user-settings');
    expect(settings).toContainEqual({
      type: 'archive',
      table: 'user-settings',
      value: expect.objectContaining({
        user_uid: 'u000000000000777',
        ui_language: 'fr',
        ui_time_zone: 'Europe/Paris',
        download_originals: 1n,
        download_media_raw: -1n,
        download_media_sidecar: 0n,
        upload_path: 'family/uploads',
      }),
    });
  });
  it('maps native manual label rows into tags without carrying generated or rejected classifications', async () => {
    await admin.query('DELETE FROM photos_albums; DELETE FROM albums');
    await admin.query(`INSERT INTO auth_users(user_uid,user_name,display_name,user_role,auth_provider,can_login)
      VALUES('u000000000000777','label-owner','Label Owner','admin','local',1)`);
    await admin.query(`INSERT INTO labels(id,label_name,label_priority) VALUES
      (900,'Native manual label',0),(901,'Native generated label',0),(902,'Native rejected label',0);
      INSERT INTO photos_labels(photo_id,label_id,label_src,uncertainty) VALUES
      (1,900,'manual',0),(1,901,'image',0),(1,902,'manual',100)`);
    const records = await collect();
    const photos = records.filter((row) => row.type === 'photo');
    const owner = records.filter((row) => row.type === 'principal').find((row) => !row.value.system)!.value.id;
    const proof = new Map(fileFixture.files.map((file) => [file.expected.path, file.expected]));
    const files = records.flatMap((row) =>
      row.type === 'file' && row.value.role
        ? [
            {
              ...proof.get(row.value.path)!,
              id: row.value.id,
              role: row.value.role,
              modifiedAt: '2020-06-10T18:31:00Z',
            },
          ]
        : [],
    );
    const { manifest, archive } = assemblePhotoprismManifest(records, {
      source: {
        kind: 'photoprism',
        version: source.version,
        identity: source.database,
        revision: 'native-label-snapshot',
        schemaSha256: fixture.schemaSha256,
      },
      inventory: {
        complete: true,
        ownershipComplete: true,
        privacyComplete: true,
        writersStopped: true,
        revisionBefore: 'native-label-snapshot',
        revisionAfter: 'native-label-snapshot',
      },
      photoOwners: Object.fromEntries(photos.map((row) => [row.value.id, owner])),
      albumOwners: {},
      materializedAlbums: {},
      files,
    });
    expect(manifest.assets[0].metadata.tags).toContain('Native manual label');
    expect(manifest.assets[0].metadata.tags).not.toContain('Native generated label');
    expect(manifest.assets[0].metadata.tags).not.toContain('Native rejected label');
    expect(manifest.assets[1].metadata.tags).not.toContain('Native manual label');
    expect(archive.filter((row) => row.table === 'photos_labels')).toHaveLength(3);
  });
  it('reads beyond one page without losing originals or changing Unicode path bytes', async () => {
    const values = Array.from({ length: 1001 }, (_, i) => [
      1,
      'ptnwpm1cvu0urc3i',
      `file-${i}`,
      `\u{FEFF}追加/${i}.png`,
      '/',
      3,
      0,
      0,
      0,
      0,
    ]);
    await admin.query(
      'INSERT INTO files (photo_id,photo_uid,file_uid,file_name,file_root,file_size,file_primary,file_sidecar,file_missing,file_watermark) VALUES ?',
      [values],
    );
    const files = (await collect()).filter((row) => row.type === 'file').map((row) => row.value);
    expect(files).toHaveLength(1003);
    expect(new Set(files.map((row) => row.id)).size).toBe(1003);
    expect(files.find((row) => row.id === 'file-1000')?.path).toBe('\u{FEFF}追加/1000.png');
  });
  it('retains composite album memberships and restrictions across page boundaries', async () => {
    const albums = Array.from({ length: 1001 }, (_, i) => [
      `album-${String(i).padStart(4, '0')}`,
      'Private album',
      'album',
      '',
      1,
      0,
    ]);
    await admin.query(
      'INSERT INTO albums (album_uid,album_title,album_type,album_filter,album_private,album_favorite) VALUES ?',
      [albums],
    );
    const memberships = albums.map(([id], i) => ['ptnwpm1cvu0urc3i', id, i, i === 1000 ? 1 : 0, 0]);
    await admin.query('INSERT INTO photos_albums (photo_uid,album_uid,`order`,hidden,missing) VALUES ?', [memberships]);
    const records = await collect();
    const members = records.filter((row) => row.type === 'membership').map((row) => row.value);
    expect(members).toHaveLength(1001);
    expect(new Set(members.map((row) => row.albumId)).size).toBe(1001);
    expect(members.find((row) => row.albumId === 'album-1000')).toMatchObject({
      order: '1000',
      hidden: true,
      missing: false,
    });
    expect(
      records
        .filter((row) => row.type === 'album')
        .map((row) => row.value)
        .filter((row) => row.id.startsWith('album-'))
        .every((row) => row.private),
    ).toBe(true);
  });
  it('refuses a writable restored source before emitting records', async () => {
    await admin.query('SET GLOBAL read_only=OFF');
    await expect(readPhotoprismMariadbInventory(source).next()).rejects.toThrow('PHOTOPRISM_RESTORE_NOT_ISOLATED');
  });
  it('holds a consistent source lock and releases it when the consumer stops', async () => {
    const reader = readPhotoprismMariadbInventory(source);
    try {
      expect((await reader.next()).done).toBe(false);
      await expect(admin.query("UPDATE photos SET photo_caption='changed' WHERE id=1")).rejects.toMatchObject({
        code: 'ER_LOCK_WAIT_TIMEOUT',
      });
    } finally {
      await reader.return(undefined);
    }
    await admin.query("UPDATE photos SET photo_caption='changed' WHERE id=1");
  });
  it('releases the source lock before returning even when transport teardown is delayed', async () => {
    const peers = new Set<Socket>();
    const proxy = createServer({ allowHalfOpen: true }, (client) => {
      const upstream = connect({ host: '127.0.0.1', port: source.port });
      for (const socket of [client, upstream]) {
        peers.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => peers.delete(socket));
      }
      client.pipe(upstream, { end: false });
      upstream.pipe(client);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Missing proxy address');
    const reader = readPhotoprismMariadbInventory({ ...source, port: address.port });
    try {
      expect((await reader.next()).done).toBe(false);
      await reader.return(undefined);
      await admin.query("UPDATE photos SET photo_caption='unlocked before return' WHERE id=1");
    } finally {
      await reader.return(undefined);
      for (const socket of peers) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
  it('releases the global lock when rollback stalls behind an unfinished socket write', async () => {
    const reader = readPhotoprismMariadbInventory(source);
    await reader.next();
    const stalled = new Set<Socket>();
    const originalWrite = Socket.prototype._write;
    const write = vi.spyOn(Socket.prototype, '_write').mockImplementation(function (
      this: Socket,
      chunk: unknown,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      if (this.remotePort === source.port && Buffer.isBuffer(chunk) && chunk.includes(Buffer.from('ROLLBACK'))) {
        stalled.add(this);
        // An unfinished write also prevents a graceful end from sending its FIN.
        return;
      }
      originalWrite.call(this, chunk, encoding, callback);
    });
    try {
      await expect(reader.return(undefined)).rejects.toThrow('PHOTOPRISM_SOURCE_UNAVAILABLE');
      expect(stalled.size).toBe(1);
      await admin.query("UPDATE photos SET photo_caption='unlocked after hard abort' WHERE id=1");
    } finally {
      write.mockRestore();
      for (const socket of stalled) socket.destroy();
      await reader.return(undefined);
    }
  }, 15_000);
  it('preserves qualified passwords through the protected callback and expires escaped readers', async () => {
    await admin.execute(
      "INSERT INTO auth_users (user_uid,user_name,auth_provider,can_login) VALUES ('owner-test','owner','local',1)",
    );
    await admin.execute('INSERT INTO passwords (uid,hash) VALUES (?,?)', [
      'owner-test',
      await hash('source password', 10),
    ]);
    const context = {
      operationId: '00000000-0000-4000-8000-000000000001',
      sourceUserId: 'owner-test',
      destinationUserId: '00000000-0000-4000-8000-000000000002',
    };
    let escaped: ((value: typeof context) => Promise<unknown>) | undefined;
    const reader = readPhotoprismMariadbInventory(source, async (read) => {
      escaped = read;
      const expected = { ...context };
      const pending = read(context);
      context.sourceUserId = 'other-owner';
      context.destinationUserId = '33333333-3333-4333-8333-333333333333';
      const password = await pending;
      expect(password).toMatchObject(expected);
      expect(password).toBeDefined();
      expect(await verifyImportedPassword('source password', password!.forImport())).toBe(true);
      expect(await verifyImportedPassword('incorrect', password!.forImport())).toBe(false);
    });
    try {
      await reader.next();
    } finally {
      await reader.return(undefined);
    }
    await expect(escaped!(context)).rejects.toThrow('PHOTOPRISM_PASSWORD_UNAVAILABLE');
  });
  it('refuses mismatched numeric and stable photo identities before emitting content', async () => {
    await admin.query('UPDATE files SET photo_id=999 WHERE id=1');
    await expect(readPhotoprismMariadbInventory(source).next()).rejects.toThrow('PHOTOPRISM_FILE_PHOTO_MISMATCH');
  });
  it('refuses changed schema and unfinished migrations before emitting content', async () => {
    await admin.query('ALTER TABLE photos ADD COLUMN unqualified INT');
    await expect(readPhotoprismMariadbInventory(source).next()).rejects.toThrow('PHOTOPRISM_SCHEMA_UNQUALIFIED');
    await admin.query('ALTER TABLE photos DROP COLUMN unqualified');
    await admin.query("UPDATE migrations SET error='unfinished' LIMIT 1");
    await expect(readPhotoprismMariadbInventory(source).next()).rejects.toThrow('PHOTOPRISM_MIGRATIONS_INCOMPLETE');
  });
});
