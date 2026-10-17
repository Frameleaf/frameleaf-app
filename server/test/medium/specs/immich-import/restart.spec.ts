import { createMigrationProvider, createPostgres } from '@frameleaf/sql-tools';
import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clusterId } from 'src/immich-import/adapters.js';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { assertCanonicalDestination } from 'src/immich-import/destination-schema.js';
import { ImmichImportService } from 'src/immich-import/importer.js';
import { assertImmichImportActivated } from 'src/immich-import/state.js';
import { ImportDatabase, ImportMediaPolicy, ImportRow, quote } from 'src/immich-import/types.js';
import { getFrameleafSchema } from 'src/schema/frameleaf-schema.js';

// Hosted PG19 only: real pinned baseline, constraints/triggers, checkpoints and media verification.
// Source transport/fingerprinting is deterministic here; source-schema/read-only tests cover admission.
describe('Immich import into the canonical Frameleaf baseline', () => {
  const owner1 = 'bcab63f5-8747-4227-a821-d013a353e704';
  const owner2 = 'caf67e17-b7df-4f5c-b645-c538285b2e05';
  const albumId = '417e0279-4682-46e5-a312-ec023907c66b';
  const personId = 'bf9a1b69-0bab-4b14-9dd9-631d48d1c39b';
  const groupId = 'c3b5ab28-d937-4c4b-b686-36187c37592b';
  const assetId = '4c4afc4a-b0e1-4787-a174-b6ef4b0ad93d';
  const faceId = 'ef518d01-df62-474a-9cac-73d4d741f617';
  const date = '2026-01-01T00:00:00.000Z';
  const original = Buffer.from('immutable-source-original');
  const checksum = createHash('sha256').update(original).digest('hex');
  let admin: ReturnType<typeof createPostgres>;
  let connection: ReturnType<typeof connectImportDatabase>;
  let name: string;
  let directory: string;
  let sourcePath: string;
  let targetPath: string;
  let importer: ImmichImportService;
  let content: Record<string, ImportRow[]>;
  let interruptAfterCopy: boolean;

  beforeAll(() => {
    const endpoint = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    endpoint.pathname = '/postgres';
    admin = createPostgres({
      connection: { connectionType: 'url', url: endpoint.href },
      maxConnections: 1,
      onNotice: () => {},
    });
  });
  beforeEach(async () => {
    directory = '';
    name = `import_${randomUUID().replaceAll('-', '')}`;
    await admin.unsafe(`CREATE DATABASE ${quote(name)}`);
    const endpoint = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    endpoint.pathname = `/${name}`;
    const db = new Kysely<any>({
      dialect: new PostgresJSDialect({
        postgres: createPostgres({
          connection: { connectionType: 'url', url: endpoint.href },
          maxConnections: 1,
          onNotice: () => {},
        }),
      }),
    });
    try {
      const { error } = await new Migrator({
        db,
        migrationTableName: 'frameleaf_migrations',
        migrationLockTableName: 'frameleaf_migrations_lock',
        provider: createMigrationProvider(
          fileURLToPath(new URL('../../../../src/schema/migrations/', import.meta.url)),
          { import: (path) => import(path) },
        ),
      }).migrateToLatest();
      if (error) {
        throw error;
      }
    } finally {
      await db.destroy();
    }
    connection = connectImportDatabase(endpoint.href, false);
    await assertCanonicalDestination(connection.db);
    directory = await mkdtemp(join(tmpdir(), 'canonical-import-'));
    await mkdir(join(directory, 'source'));
    await mkdir(join(directory, 'destination'));
    sourcePath = join(directory, 'source', 'original.jpg');
    targetPath = join(directory, 'destination', 'original.jpg');
    await writeFile(sourcePath, original);
    await writeFile(targetPath, original);
    content = {};
    interruptAfterCopy = false;
  }, 30_000);
  afterEach(async () => {
    await connection?.close();
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quote(name)}`);
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  });
  afterAll(async () => {
    await admin?.end();
  });

  const configure = (version = '3.0.0', media?: ImportMediaPolicy) => {
    const source: ImportDatabase = {
      query: (sql) =>
        Promise.resolve(
          sql.includes('pg_control_system') ? [{ system_identifier: 'offline-source-fixture', database_oid: '1' }] : [],
        ),
      transaction: async (body) => body(source),
    };
    importer = new ImmichImportService(connection.db, source, {
      version,
      sourceId: 'hosted-fixture',
      writersStopped: true,
      ...(media && { media }),
      mediaRoots: [
        {
          source: join(directory, 'source'),
          target: join(directory, media?.mode === 'manager-in-place' ? 'source' : 'destination'),
        },
      ],
    });
    // Keep real destination preflight, frozen adapters, mapping, verification and activation.
    vi.spyOn(importer.source, 'preflight').mockResolvedValue('same-offline-source');
    vi.spyOn(importer.source, 'batches').mockImplementation(async function* (table, after) {
      await Promise.resolve();
      const shape = importer.source.fixture.tables[table];
      const rows = (content[table] ?? []).map((row) =>
        Object.fromEntries(Object.entries(row).filter(([column]) => shape.columns.includes(column))),
      );
      const remaining = after ? rows.filter((row) => String(row[shape.key[0]]) > after[0]) : rows;
      if (remaining.length > 0) {
        yield remaining.map((row) => ({ row, cursor: shape.key.map((key) => String(row[key])) }));
      }
      if (table === 'user' && interruptAfterCopy) {
        throw new Error('simulated restart after durable checkpoint');
      }
    });
    content.user = [
      {
        id: owner1,
        email: 'owner@example.test',
        name: 'Owner',
        password: 'password-hash-one',
        pinCode: 'pin-hash-one',
        profileImagePath: '',
        isAdmin: true,
        shouldChangePassword: false,
        clusterGroupId: groupId,
      },
      {
        id: owner2,
        email: 'reader@example.test',
        name: 'Reader',
        password: 'password-hash-two',
        pinCode: null,
        profileImagePath: '',
        isAdmin: false,
        clusterGroupId: groupId,
      },
    ];
    if (importer.source.fixture.tables.cluster_group) {
      content.cluster_group = [{ id: groupId }];
    }
  };

  const addLibrary = () => {
    content.asset = [
      {
        id: assetId,
        ownerId: owner1,
        type: 'IMAGE',
        originalPath: sourcePath,
        originalFileName: 'original.jpg',
        checksum: String.raw`\x${checksum}`,
        checksumAlgorithm: 'sha256',
        fileCreatedAt: date,
        fileModifiedAt: date,
        localDateTime: date,
        visibility: 'locked',
        deletedAt: date,
        isFavorite: true,
        isExternal: false,
      },
    ];
    content.album = [{ id: albumId, albumName: 'Private album', description: 'preserved', isActivityEnabled: false }];
    content.asset_audio = [{ assetId, bitrate: 192_000, index: 1, profile: null, codecName: 'aac' }];
    content.asset_video = [
      {
        assetId,
        bitrate: 4_000_000,
        frameCount: 300,
        timeBase: 15_360,
        index: 0,
        profile: 100,
        level: 41,
        colorPrimaries: 1,
        colorTransfer: 1,
        colorMatrix: 1,
        dvProfile: null,
        dvLevel: null,
        dvBlSignalCompatibilityId: null,
        codecName: 'h264',
        formatName: 'mov',
        formatLongName: 'QuickTime / MOV',
        pixelFormat: 'yuv420p',
      },
    ];
    content.asset_keyframe = [
      {
        assetId,
        pts: [0, 15_360],
        accDuration: [0, 1000],
        ownDuration: [1000, 1000],
        totalDuration: 2000,
        packetCount: 60,
        outputFrames: 60,
      },
    ];
    content.album_user = [
      { albumId, userId: owner1, role: 'owner' },
      { albumId, userId: owner2, role: 'viewer' },
    ];
    content.album_asset = [{ albumId, assetId }];
    content.partner = [{ sharedById: owner1, sharedWithId: owner2, inTimeline: false }];
    content.shared_link = [
      {
        id: 'b1f005b7-8bdc-4ee0-a4d9-dff24eac5f5e',
        userId: owner1,
        albumId,
        key: String.raw`\x0123456789abcdef`,
        type: 'ALBUM',
        allowUpload: false,
        allowDownload: false,
        showExif: false,
        password: 'share-password-hash',
        expiresAt: date,
      },
    ];
    content.person = [
      {
        id: personId,
        ownerId: owner1,
        personGroupId: personId,
        name: 'Private person',
        thumbnailPath: '',
        isHidden: true,
        isFavorite: true,
        faceAssetId: faceId,
      },
    ];
    if (importer.source.fixture.tables.person_group) {
      content.person_group = [{ id: personId, clusterGroupId: groupId }];
    }
    content.asset_face = [
      {
        id: faceId,
        assetId,
        personId,
        personGroupId: personId,
        imageWidth: 100,
        imageHeight: 100,
        boundingBoxX1: 10,
        boundingBoxY1: 10,
        boundingBoxX2: 50,
        boundingBoxY2: 50,
        sourceType: 'manual',
        isVisible: false,
      },
    ];
  };

  // Simulate the durable dispatcher acknowledgement, not ML execution or production queue acceptance.
  const acknowledgeWork = async () => {
    await connection.db.query('UPDATE public.frameleaf_immich_import_work SET dispatched_at=now()');
  };

  it.each(['3.0.0', '3.0.1', '3.0.2', '3.0.3', '3.1.0', '3.2.0', '3.2.1', '3.2.2', '3.2.3', '3.2.4'])(
    'maps %s ownership, permissions, passwords/PINs and media into the real baseline before activation',
    async (version) => {
      configure(version);
      addLibrary();
      const before = await stat(sourcePath, { bigint: true });
      await importer.run();
      await expect(assertImmichImportActivated(connection.db)).rejects.toThrow('NOT_ACTIVATED');
      await importer.verify(acknowledgeWork);
      expect((await importer.status()).status).toBe('activated');
      await expect(assertImmichImportActivated(connection.db)).resolves.toBeUndefined();
      expect(
        await connection.db.query('SELECT id,password,"pinCode","isAdmin" FROM public."user" ORDER BY id'),
      ).toEqual([
        { id: owner1, password: 'password-hash-one', pinCode: 'pin-hash-one', isAdmin: true },
        { id: owner2, password: 'password-hash-two', pinCode: null, isAdmin: false },
      ]);
      expect(await connection.db.query('SELECT "userId",role FROM public.album_user ORDER BY "userId"')).toEqual([
        { userId: owner1, role: 'owner' },
        { userId: owner2, role: 'viewer' },
      ]);
      expect(
        await connection.db.query(
          'SELECT "sharedById","sharedWithId","inTimeline","shareLocation" FROM public.partner',
        ),
      ).toEqual([{ sharedById: owner1, sharedWithId: owner2, inTimeline: false, shareLocation: false }]);
      expect(
        await connection.db.query('SELECT "allowUpload","allowDownload","showExif",password FROM public.shared_link'),
      ).toEqual([{ allowUpload: false, allowDownload: false, showExif: false, password: 'share-password-hash' }]);
      expect(
        await connection.db.query(
          'SELECT "ownerId","originalPath",visibility,"deletedAt" IS NOT NULL AS deleted FROM public.asset',
        ),
      ).toEqual([{ ownerId: owner1, originalPath: targetPath, visibility: 'locked', deleted: true }]);
      expect(
        await connection.db.query('SELECT "ownerId","personGroupId","isHidden","faceAssetId" FROM public.person'),
      ).toEqual([{ ownerId: owner1, personGroupId: personId, isHidden: true, faceAssetId: faceId }]);
      expect(
        await connection.db.query('SELECT "personGroupId","sourceType","isVisible" FROM public.asset_face'),
      ).toEqual([{ personGroupId: personId, sourceType: 'manual', isVisible: false }]);
      const [owner] = await connection.db.query('SELECT "clusterGroupId" FROM public."user" WHERE id=$1', [owner1]);
      expect(owner.clusterGroupId).toBe(importer.source.fixture.tables.cluster_group ? groupId : clusterId(owner1));
      for (const table of ['asset_audio', 'asset_video', 'asset_keyframe']) {
        expect(await connection.db.query(`SELECT * FROM public.${quote(table)}`)).toEqual(
          content[table].map((row) =>
            table === 'asset_audio' ? { ...row, channels: null, channelLayout: null, sampleRate: null } : row,
          ),
        );
      }
      expect(await readFile(sourcePath)).toEqual(original);
      expect(await readFile(targetPath)).toEqual(original);
      const after = await stat(sourcePath, { bigint: true });
      expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
        before.dev,
        before.ino,
        before.size,
        before.mtimeNs,
        before.ctimeNs,
      ]);
    },
    30_000,
  );

  it('activates a 3.1.0 Manager import with unchanged media locations and access associations', async () => {
    configure('3.1.0', {
      mode: 'manager-in-place',
      authority: 'frameleaf-manager',
      operationId: 'hosted-in-place-operation',
      deploymentId: 'hosted-managed-deployment',
    });
    addLibrary();
    // No independent destination original exists. This exercises real PG19 destination transport,
    // canonical schema, row/media verification and activation; source admission and dispatch remain stand-ins.
    await rm(targetPath);
    const before = await stat(sourcePath, { bigint: true });
    await importer.run();
    await expect(assertImmichImportActivated(connection.db)).rejects.toThrow('NOT_ACTIVATED');
    await importer.verify(acknowledgeWork);
    expect((await importer.status()).status).toBe('activated');
    await expect(assertImmichImportActivated(connection.db)).resolves.toBeUndefined();
    await expect(assertCanonicalDestination(connection.db)).resolves.toBeUndefined();
    expect(await connection.db.query('SELECT id,"ownerId","originalPath",visibility FROM public.asset')).toEqual([
      { id: assetId, ownerId: owner1, originalPath: sourcePath, visibility: 'locked' },
    ]);
    expect(await connection.db.query('SELECT id,password,"pinCode","isAdmin" FROM public."user" ORDER BY id')).toEqual([
      { id: owner1, password: 'password-hash-one', pinCode: 'pin-hash-one', isAdmin: true },
      { id: owner2, password: 'password-hash-two', pinCode: null, isAdmin: false },
    ]);
    expect(
      await connection.db.query('SELECT "albumId","userId",role FROM public.album_user ORDER BY "userId"'),
    ).toEqual([
      { albumId, userId: owner1, role: 'owner' },
      { albumId, userId: owner2, role: 'viewer' },
    ]);
    expect(await connection.db.query('SELECT "albumId","assetId" FROM public.album_asset')).toEqual([
      { albumId, assetId },
    ]);
    expect(await connection.db.query('SELECT "sharedById","sharedWithId","inTimeline" FROM public.partner')).toEqual([
      { sharedById: owner1, sharedWithId: owner2, inTimeline: false },
    ]);
    expect(
      await connection.db.query(
        'SELECT "userId","albumId","allowUpload","allowDownload","showExif" FROM public.shared_link',
      ),
    ).toEqual([{ userId: owner1, albumId, allowUpload: false, allowDownload: false, showExif: false }]);
    const after = await stat(sourcePath, { bigint: true });
    expect([after.dev, after.ino, after.size, after.mtimeNs, after.ctimeNs]).toEqual([
      before.dev,
      before.ino,
      before.size,
      before.mtimeNs,
      before.ctimeNs,
    ]);
    expect(await readFile(sourcePath)).toEqual(original);
    await expect(stat(targetPath)).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('rolls back failed batches/checkpoints, resumes a committed checkpoint once and leaves abandonment inactive', async () => {
    configure();
    const transaction = connection.db.transaction.bind(connection.db);
    // A real PostgreSQL failure after inserting the first user must roll back both it and its group.
    // Keep the source rows/fingerprint unchanged across restart.
    connection.db.transaction = async <T>(body: (db: ImportDatabase) => Promise<T>): Promise<T> => {
      connection.db.transaction = transaction;
      return transaction(async (tx) =>
        body({
          ...tx,
          query: async (statement, parameters) => {
            const result = await tx.query(statement, parameters);
            if (statement.startsWith('INSERT INTO public."user"')) {
              await tx.query('SELECT 1/0');
            }
            return result;
          },
        }),
      );
    };
    await expect(importer.run()).rejects.toThrow();
    expect(await connection.db.query('SELECT id FROM public."user"')).toHaveLength(0);
    expect(await connection.db.query('SELECT id FROM public.cluster_group')).toHaveLength(0);
    expect(
      await connection.db.query(
        "SELECT table_name FROM public.frameleaf_immich_import_checkpoint WHERE table_name='user'",
      ),
    ).toHaveLength(0);
    await expect(assertImmichImportActivated(connection.db)).rejects.toThrow('NOT_ACTIVATED');
    interruptAfterCopy = true;
    await expect(importer.run(true)).rejects.toThrow('simulated restart');
    const [checkpoint] = await connection.db.query(
      "SELECT row_count::text AS count,cursor,complete FROM public.frameleaf_immich_import_checkpoint WHERE table_name='user'",
    );
    expect(checkpoint).toMatchObject({ count: '2', cursor: [owner2], complete: false });
    interruptAfterCopy = false;
    await importer.run(true);
    expect(await connection.db.query('SELECT id FROM public."user"')).toHaveLength(2);
    expect((await importer.status()).status).toBe('verifying');
    await importer.abandon();
    await expect(assertImmichImportActivated(connection.db)).rejects.toThrow('NOT_ACTIVATED');
    await expect(importer.run(true)).rejects.toThrow('ABANDONED_DESTINATION');
  });

  const dropProtection = async (kind: 'constraint' | 'trigger') => {
    const asset = getFrameleafSchema().tables.find(({ name }) => name === 'asset')!;
    const object =
      kind === 'constraint'
        ? asset.constraints.find((item) => item.definition?.includes('FOREIGN KEY ("ownerId")'))!
        : asset.triggers.find(({ name }) => name === 'asset_backup_deletion_capture_trigger')!;
    expect(object).toBeDefined();
    await connection.db.query(
      kind === 'constraint'
        ? `ALTER TABLE public.asset DROP CONSTRAINT ${quote(object.name)}`
        : `DROP TRIGGER ${quote(object.name)} ON public.asset`,
    );
  };

  it('rejects a changed real album permission row before dispatch or activation', async () => {
    configure('3.2.4');
    addLibrary();
    await importer.run();
    await connection.db.query('UPDATE public.album_user SET role=\'editor\' WHERE "userId"=$1', [owner2]);
    const dispatch = vi.fn(acknowledgeWork);
    await expect(importer.verify(dispatch)).rejects.toThrow('DESTINATION_ROW_OR_PERMISSION_MISMATCH');
    expect(dispatch).not.toHaveBeenCalled();
    expect((await importer.status()).status).toBe('verifying');
    await expect(assertImmichImportActivated(connection.db)).rejects.toThrow('NOT_ACTIVATED');
  });

  it.each(['constraint', 'trigger'] as const)(
    'refuses a missing %s with the baseline ledger intact before any journal writes',
    async (kind) => {
      configure();
      await dropProtection(kind);
      expect(await connection.db.query('SELECT name FROM public.frameleaf_migrations')).not.toHaveLength(0);
      await expect(importer.preflight()).rejects.toThrow('DESTINATION_SCHEMA_NOT_CANONICAL');
      await expect(importer.run()).rejects.toThrow('DESTINATION_SCHEMA_NOT_CANONICAL');
      expect(await connection.db.query('SELECT status FROM public.frameleaf_immich_import')).toHaveLength(0);
    },
  );

  it.each(['constraint', 'trigger'] as const)('blocks activation when %s drift happens after copy', async (kind) => {
    configure();
    await importer.run();
    await dropProtection(kind);
    await expect(importer.verify(acknowledgeWork)).rejects.toThrow('DESTINATION_SCHEMA_NOT_CANONICAL');
    expect((await importer.status()).status).toBe('verifying');
    await expect(assertImmichImportActivated(connection.db)).rejects.toThrow('NOT_ACTIVATED');
  });

  it('checks schema again if a protection trigger disappears during dispatch', async () => {
    configure();
    await importer.run();
    await expect(importer.verify(async () => dropProtection('trigger'))).rejects.toThrow(
      'DESTINATION_SCHEMA_NOT_CANONICAL',
    );
    expect((await importer.status()).status).toBe('verifying');
  });
});
