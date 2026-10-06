import { mkdir, readFile, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { clusterId } from 'src/immich-import/adapters.js';
import { ImmichImportService } from 'src/immich-import/importer.js';
import { assertImmichImportActivated } from 'src/immich-import/state.js';
import { ImportDatabase, quote } from 'src/immich-import/types.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { PostgresImportFixture } from 'test/medium/specs/immich-import/postgres-transport.fixture.js';

// Both sides use real PostgreSQL transport. No source preflight, schema, fingerprint or batches are mocked.
describe('offline Immich import over PostgreSQL source and destination connections', () => {
  let fixture: PostgresImportFixture | undefined;
  const start = async (version?: string) => {
    fixture = new PostgresImportFixture(version);
    await fixture.initialize();
    return fixture;
  };
  afterEach(async () => {
    await fixture?.close();
    fixture = undefined;
  }, 30_000);

  const expectFresh = async (f: PostgresImportFixture) => {
    expect(await f.destination.db.query('SELECT * FROM public.frameleaf_immich_import')).toEqual([]);
    expect(await f.destination.db.query('SELECT * FROM public.frameleaf_immich_import_checkpoint')).toEqual([]);
    expect(await f.destination.db.query('SELECT id FROM public."user"')).toEqual([]);
    expect(await f.destination.db.query('SELECT id FROM public.asset')).toEqual([]);
  };

  // Deliberate destination fault only: user rows and their checkpoint really commit, then the
  // acknowledgement is lost. The source still uses the production reader and actual PostgreSQL rows.
  const interruptAfterUsers = async (f: PostgresImportFixture) => {
    const db = f.destination.db;
    const transaction = db.transaction.bind(db);
    let interrupted = false;
    const fault: ImportDatabase = {
      ...db,
      transaction: async <T>(body: (tx: ImportDatabase) => Promise<T>): Promise<T> => {
        let userCheckpoint = false;
        const result = await transaction((tx) =>
          body({
            ...tx,
            query: async (statement, parameters) => {
              const result = await tx.query(statement, parameters);
              if (
                statement.includes('INSERT INTO public.frameleaf_immich_import_checkpoint') &&
                parameters?.[0] === 'user'
              ) {
                userCheckpoint = true;
              }
              return result;
            },
          }),
        );
        if (userCheckpoint && !interrupted) {
          interrupted = true;
          throw new Error('destination acknowledgement lost after user commit');
        }
        return result;
      },
    };
    await expect(new ImmichImportService(fault, f.source.db, f.config).run()).rejects.toThrow('acknowledgement lost');
    expect(interrupted).toBe(true);
    expect(await db.query('SELECT id FROM public."user"')).toHaveLength(2);
    expect(await db.query('SELECT id FROM public.asset')).toHaveLength(0);
    expect(
      await db.query(
        "SELECT row_count::text AS count,complete,cursor,jsonb_typeof(cursor) AS type FROM public.frameleaf_immich_import_checkpoint WHERE table_name='user'",
      ),
    ).toEqual([{ count: '2', complete: false, cursor: [[f.owner, f.reader].sort().at(-1)], type: 'array' }]);
    await expect(assertImmichImportActivated(db)).rejects.toThrow('NOT_ACTIVATED');
  };

  it('enforces read-only transport and a non-writing role, including explicit transactions', async () => {
    const f = await start();
    expect(
      await f.source.db.query(`SELECT current_user AS name, current_setting('transaction_read_only') AS readonly`),
    ).toEqual([{ name: f.role, readonly: 'on' }]);
    expect(
      await f.source.db.query("SELECT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS statistics"),
    ).toEqual([{ statistics: true }]);
    await expect(
      f.source.db.query('UPDATE public."user" SET name=\'mutated\' WHERE id=$1', [f.owner]),
    ).rejects.toThrow();
    await f.source.db.transaction(async (tx) => {
      expect(await tx.query("SELECT current_setting('transaction_read_only') AS readonly")).toEqual([
        { readonly: 'on' },
      ]);
    });
    await expect(f.source.db.transaction((tx) => tx.query('DELETE FROM public.album_user'))).rejects.toThrow();
    expect(await f.source.db.query('SELECT name FROM public."user" WHERE id=$1', [f.owner])).toEqual([
      { name: 'Owner' },
    ]);
    await expect(f.importer().preflight()).resolves.toMatchObject({ status: 'fresh' });
    await expectFresh(f);
  }, 120_000);

  it('rejects a writable connection even when its role has only SELECT rights', async () => {
    const f = await start();
    await f.source.close();
    f.connections.delete(f.source);
    f.source = f.connect(f.sourceName, false, true);
    expect(await f.source.db.query("SELECT current_setting('transaction_read_only') AS readonly")).toEqual([
      { readonly: 'off' },
    ]);
    await expect(f.importer().run()).rejects.toThrow('SOURCE_ROLE_MUST_BE_READ_ONLY');
    await expectFresh(f);
  }, 120_000);

  it.each(['update privilege', 'table ownership', 'superuser', 'bypassrls', 'superuser membership'] as const)(
    'rejects a source role with %s even on a read-only connection',
    async (authority) => {
      const f = await start();
      if (authority === 'superuser membership') {
        await f.elevateMembership();
      } else {
        await f.mutateSource(async (db) => {
          const role = quote(f.role);
          await db.query(
            authority === 'update privilege'
              ? `GRANT UPDATE ON public."user" TO ${role}`
              : authority === 'table ownership'
                ? `ALTER TABLE public."user" OWNER TO ${role}`
                : `ALTER ROLE ${role} ${authority === 'superuser' ? 'SUPERUSER' : 'BYPASSRLS'}`,
          );
        });
      }
      await expect(f.importer().run()).rejects.toThrow(
        authority === 'superuser' || authority === 'bypassrls'
          ? 'SOURCE_ROLE_MUST_BE_READ_ONLY'
          : 'SOURCE_WRITERS_OR_WRITE_AUTHORITY_PRESENT',
      );
      await expectFresh(f);
    },
    120_000,
  );

  it('requires the stopped-writers attestation even when the source has no other sessions', async () => {
    const f = await start();
    await expect(f.importer({ ...f.config, writersStopped: false }).run()).rejects.toThrow(
      'OFFLINE_SOURCE_AND_MEDIA_MAP_REQUIRED',
    );
    await expectFresh(f);
    await expect(f.importer().preflight()).resolves.toMatchObject({ status: 'fresh' });
  }, 120_000);

  it.each(['same root', 'symlink alias', 'nested target', 'nested source', 'cross-map nesting'] as const)(
    'refuses empty-library independent-copy admission with %s',
    async (kind) => {
      const f = await start();
      const source = f.config.mediaRoots[0].source;
      const target = f.config.mediaRoots[0].target;
      await f.mutateSource(async (db) => {
        await db.query('TRUNCATE public.asset CASCADE');
        await db.query(
          `INSERT INTO public.library(name,"ownerId","importPaths","exclusionPatterns")
          VALUES ('Empty external library',$1,ARRAY[$2::text],ARRAY[]::text[])`,
          [f.owner, source],
        );
      });
      expect(await f.source.db.query('SELECT id FROM public.asset')).toEqual([]);
      expect(await f.source.db.query('SELECT "profileImagePath" FROM public."user"')).toEqual([
        { profileImagePath: '' },
        { profileImagePath: '' },
      ]);
      await expect(f.importer().preflight()).resolves.toMatchObject({ status: 'fresh' });
      const nested = join(source, 'nested');
      await mkdir(nested);
      const alias = join(f.directory, 'alias');
      await symlink(source, alias);
      switch (kind) {
        case 'same root': {
          f.config.mediaRoots = [{ source, target: source }];
          break;
        }
        case 'symlink alias': {
          f.config.mediaRoots = [{ source, target: alias }];
          break;
        }
        case 'nested target': {
          f.config.mediaRoots = [{ source, target: nested }];
          break;
        }
        case 'nested source': {
          f.config.mediaRoots = [{ source: nested, target: source }];
          break;
        }
        case 'cross-map nesting': {
          f.config.mediaRoots = [
            { source, target },
            { source: target, target: nested },
          ];
          break;
        }
      }
      await expect(f.importer().run()).rejects.toThrow('INDEPENDENT_COPY');
      await expectFresh(f);
    },
    120_000,
  );

  it.each([
    ['idle', true],
    ['uncommitted writer', true],
    ['idle', false],
    ['uncommitted writer', false],
  ] as const)(
    'rejects another %s session (statistics access=%s), then admits after it disconnects',
    async (kind, statistics) => {
      const f = await start();
      await expect(f.importer().preflight()).resolves.toMatchObject({ status: 'fresh' });
      const writer = f.connect(f.sourceName, false);
      const [session] = await writer.db.query('SELECT pg_backend_pid() AS pid');
      try {
        if (!statistics) {
          await writer.db.query(`REVOKE pg_read_all_stats FROM ${quote(f.role)}`);
        }
        expect(
          await f.source.db.query("SELECT pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS statistics"),
        ).toEqual([{ statistics }]);
        // Known client backends and unknown session types must both block admission.
        expect(
          await f.source.db.query('SELECT backend_type FROM pg_stat_activity WHERE pid=$1', [session.pid]),
        ).toEqual([{ backend_type: statistics ? 'client backend' : null }]);
        if (kind === 'uncommitted writer') {
          await writer.db.query('BEGIN');
          await writer.db.query('UPDATE public."user" SET name=\'pending writer\' WHERE id=$1', [f.owner]);
        }
        await expect(f.importer().run()).rejects.toThrow('SOURCE_WRITERS_OR_WRITE_AUTHORITY_PRESENT');
        await expectFresh(f);
      } finally {
        if (kind === 'uncommitted writer') await writer.db.query('ROLLBACK');
        if (!statistics) {
          // Restore supported authority before the positive control, so unrelated autovacuum
          // is classified rather than waited out. Reuse the writer; do not reconnect the reader.
          await writer.db.query(`GRANT pg_read_all_stats TO ${quote(f.role)}`);
        }
        await writer.close();
        f.connections.delete(writer);
      }
      // Driver close observes the local socket, not the server's backend removal. Prove that
      // this exact session has disappeared before asking the importer to admit the source once.
      // No backend termination or import retries.
      await vi.waitFor(
        async () => {
          expect(
            await f.source.db.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid=$1', [
              session.pid,
            ]),
          ).toEqual([]);
        },
        { timeout: 2000, interval: 50 },
      );
      await expect(f.importer().preflight()).resolves.toMatchObject({ status: 'fresh' });
      expect(await f.source.db.query('SELECT name FROM public."user" WHERE id=$1', [f.owner])).toEqual([
        { name: 'Owner' },
      ]);
    },
    120_000,
  );

  it.each([
    ['column', 'ALTER TABLE public."user" ADD COLUMN unexpected text', 'UNKNOWN_SOURCE_SCHEMA'],
    [
      'permission constraint',
      'ALTER TABLE public.album_user DROP CONSTRAINT "album_user_userId_fkey"',
      'UNKNOWN_SOURCE_SCHEMA',
    ],
    [
      'migration',
      `INSERT INTO public.kysely_migrations(name,"timestamp") VALUES ('future-release','future')`,
      'UNKNOWN_SOURCE_MIGRATIONS',
    ],
    ['Frameleaf source', 'CREATE TABLE public.frameleaf_migrations(name text)', 'SOURCE_IS_FRAMELEAF'],
  ])(
    'refuses unexpected %s through the real importer preflight, before destination writes',
    async (_kind, change, code) => {
      const f = await start();
      await f.mutateSource((db) => db.query(change));
      await expect(f.importer().preflight()).rejects.toThrow(code);
      await expect(f.importer().run()).rejects.toThrow(code);
      await expectFresh(f);
    },
    120_000,
  );

  it('recomputes the source fingerprint after reconnect and rejects changed rows before resuming', async () => {
    const f = await start();
    const initial = await f.importer().source.preflight();
    await interruptAfterUsers(f);
    const before = await f.destination.db.query(
      'SELECT * FROM public.frameleaf_immich_import_checkpoint ORDER BY table_name',
    );
    await f.mutateSource((db) =>
      db.query('UPDATE public."user" SET name=\'Changed after checkpoint\' WHERE id=$1', [f.owner]),
    );
    await f.restartConnections();
    expect(await f.importer().source.preflight()).not.toBe(initial);
    await expect(f.importer().run(true)).rejects.toThrow('RESUME_SOURCE_OR_CONFIGURATION_CHANGED');
    expect(
      await f.destination.db.query('SELECT * FROM public.frameleaf_immich_import_checkpoint ORDER BY table_name'),
    ).toEqual(before);
    expect(await f.destination.db.query('SELECT id FROM public.asset')).toHaveLength(0);
    await expect(assertImmichImportActivated(f.destination.db)).rejects.toThrow('NOT_ACTIVATED');
    // Negative control: unchanged source content is accepted on a genuinely new connection and service.
    await f.mutateSource((db) => db.query('UPDATE public."user" SET name=\'Owner\' WHERE id=$1', [f.owner]));
    await f.restartConnections();
    expect(await f.importer().source.preflight()).toBe(initial);
    await f.importer().run(true);
    expect(await f.destination.db.query('SELECT id FROM public."user"')).toHaveLength(2);
    expect(await f.destination.db.query('SELECT id FROM public.asset')).toHaveLength(1);
    expect((await f.importer().status()).status).toBe('verifying');
  }, 120_000);

  it('rejects a byte-identical source database clone with a different PostgreSQL database identity on resume', async () => {
    const f = await start();
    const initial = await f.importer().source.preflight();
    await interruptAfterUsers(f);
    await f.cloneSource();
    expect(await f.source.db.query('SELECT password FROM public."user" WHERE id=$1', [f.owner])).toEqual([
      { password: f.passwordHash },
    ]);
    expect(await f.importer().source.preflight()).not.toBe(initial);
    await expect(f.importer().run(true)).rejects.toThrow('RESUME_SOURCE_OR_CONFIGURATION_CHANGED');
    expect(await f.destination.db.query('SELECT id FROM public.asset')).toHaveLength(0);
    await expect(assertImmichImportActivated(f.destination.db)).rejects.toThrow('NOT_ACTIVATED');
  }, 120_000);

  // One pin for each distinct frozen structural catalog. Existing source-schema/restart suites retain all ten pins.
  it.each(['3.0.3', '3.1.0', '3.2.4'])(
    'preserves real %s password hashes, ownership and album-sharing relationships',
    async (version) => {
      const f = await start(version);
      const metadata = [
        { key: 'json-array', value: [null, false, 17, { nested: 'value' }], type: 'array' },
        { key: 'json-boolean', value: false, type: 'boolean' },
        { key: 'json-number', value: 17.5, type: 'number' },
        {
          key: 'json-object',
          value: { nested: { values: [null, true, String.raw`"quoted" \ path`] } },
          type: 'object',
        },
        { key: 'json-string', value: '{"this":"stays a string"}', type: 'string' },
      ];
      await f.mutateSource(async (db) => {
        for (const { key, value } of metadata) {
          await db.query('INSERT INTO public.asset_metadata("assetId",key,value) VALUES ($1,$2,$3::text::jsonb)', [
            f.asset,
            key,
            JSON.stringify(value),
          ]);
        }
      });
      const importer = f.importer();
      const fingerprint = await importer.source.preflight();
      const fileBefore = await stat(f.sourcePath, { bigint: true });
      await importer.run();
      await expect(assertImmichImportActivated(f.destination.db)).rejects.toThrow('NOT_ACTIVATED');
      const [owner] = await f.destination.db.query(
        'SELECT id,password,"pinCode","isAdmin","shouldChangePassword","clusterGroupId" FROM public."user" WHERE id=$1',
        [f.owner],
      );
      expect(owner).toEqual({
        id: f.owner,
        password: f.passwordHash,
        pinCode: f.pinHash,
        isAdmin: true,
        shouldChangePassword: false,
        clusterGroupId: version.startsWith('3.2.') ? f.group : clusterId(f.owner),
      });
      const crypto = new CryptoRepository();
      expect(crypto.compareBcrypt(f.password, String(owner.password))).toBe(true);
      expect(crypto.compareBcrypt('wrong password', String(owner.password))).toBe(false);
      expect(crypto.compareBcrypt(f.pin, String(owner.pinCode))).toBe(true);
      expect(crypto.compareBcrypt('000000', String(owner.pinCode))).toBe(false);
      expect(await f.destination.db.query('SELECT id,"ownerId","originalPath",visibility FROM public.asset')).toEqual([
        { id: f.asset, ownerId: f.owner, originalPath: f.targetPath, visibility: 'locked' },
      ]);
      expect(
        await f.destination.db.query(`SELECT a.id,a."albumThumbnailAssetId",aa."assetId",au."userId",au.role
      FROM public.album a JOIN public.album_asset aa ON aa."albumId"=a.id JOIN public.album_user au ON au."albumId"=a.id ORDER BY au.role::text`),
      ).toEqual([
        { id: f.album, albumThumbnailAssetId: f.asset, assetId: f.asset, userId: f.owner, role: 'owner' },
        { id: f.album, albumThumbnailAssetId: f.asset, assetId: f.asset, userId: f.reader, role: 'viewer' },
      ]);
      expect(
        await f.destination.db.query(
          'SELECT "sharedById","sharedWithId","inTimeline","shareLocation" FROM public.partner',
        ),
      ).toEqual([{ sharedById: f.owner, sharedWithId: f.reader, inTimeline: false, shareLocation: false }]);
      expect(
        await f.destination.db.query(
          'SELECT id,"userId","albumId",password,"allowUpload","allowDownload","showExif" FROM public.shared_link',
        ),
      ).toEqual([
        {
          id: f.link,
          userId: f.owner,
          albumId: f.album,
          password: f.passwordHash,
          allowUpload: false,
          allowDownload: false,
          showExif: false,
        },
      ]);
      expect(
        await f.destination.db.query(
          'SELECT key,value,jsonb_typeof(value) AS type FROM public.asset_metadata ORDER BY key',
        ),
      ).toEqual(metadata);
      for (const table of ['asset_audio', 'asset_video', 'asset_keyframe']) {
        const rows = await f.source.db.query(`SELECT * FROM public.${quote(table)}`);
        expect(rows).toHaveLength(1);
        expect(await f.destination.db.query(`SELECT * FROM public.${quote(table)}`)).toEqual(
          rows.map((row) =>
            table === 'asset_audio' ? { ...row, channels: null, channelLayout: null, sampleRate: null } : row,
          ),
        );
      }
      const [metadataCheckpoint] = await f.destination.db.query(
        "SELECT cursor,jsonb_typeof(cursor) AS type,row_count::text AS count,complete FROM public.frameleaf_immich_import_checkpoint WHERE table_name='asset_metadata'",
      );
      expect(metadataCheckpoint).toEqual({
        cursor: [f.asset, 'json-string'],
        type: 'array',
        count: '5',
        complete: true,
      });
      // Check a real permission tamper before permitting the activation gate to succeed.
      await f.destination.db.query('UPDATE public.album_user SET role=\'editor\' WHERE "userId"=$1', [f.reader]);
      const dispatch = vi.fn(async () => {
        // Dispatcher acknowledgement stand-in only; production queue dispatch is outside this transport packet.
        await f.destination.db.query('UPDATE public.frameleaf_immich_import_work SET dispatched_at=now()');
      });
      await expect(importer.verify(dispatch)).rejects.toThrow('DESTINATION_ROW_OR_PERMISSION_MISMATCH');
      expect(dispatch).not.toHaveBeenCalled();
      await f.destination.db.query('UPDATE public.album_user SET role=\'viewer\' WHERE "userId"=$1', [f.reader]);
      await f.destination.db.query('UPDATE public.asset_keyframe SET pts=ARRAY[99]');
      await expect(importer.verify(dispatch)).rejects.toThrow('DESTINATION_ROW_OR_PERMISSION_MISMATCH');
      expect(dispatch).not.toHaveBeenCalled();
      await f.destination.db.query('UPDATE public.asset_keyframe SET pts=ARRAY[0,15360]');
      // A JSON string containing the same serialized object is still corrupted destination data.
      const objectValue = JSON.stringify(metadata.find((row) => row.type === 'object')!.value);
      await f.destination.db.query(
        "UPDATE public.asset_metadata SET value=to_jsonb($1::text) WHERE key='json-object'",
        [objectValue],
      );
      await expect(importer.verify(dispatch)).rejects.toThrow('DESTINATION_ROW_OR_PERMISSION_MISMATCH');
      expect(dispatch).not.toHaveBeenCalled();
      await f.destination.db.query("UPDATE public.asset_metadata SET value=$1::text::jsonb WHERE key='json-object'", [
        objectValue,
      ]);
      await importer.verify(dispatch);
      expect(dispatch).toHaveBeenCalledOnce();
      await expect(assertImmichImportActivated(f.destination.db)).resolves.toBeUndefined();
      expect(await importer.source.preflight()).toBe(fingerprint);
      expect(await readFile(f.sourcePath)).toEqual(f.original);
      expect(await readFile(f.targetPath)).toEqual(f.original);
      const fileAfter = await stat(f.sourcePath, { bigint: true });
      expect([fileAfter.dev, fileAfter.ino, fileAfter.size, fileAfter.mtimeNs, fileAfter.ctimeNs]).toEqual([
        fileBefore.dev,
        fileBefore.ino,
        fileBefore.size,
        fileBefore.mtimeNs,
        fileBefore.ctimeNs,
      ]);
    },
    120_000,
  );
});
