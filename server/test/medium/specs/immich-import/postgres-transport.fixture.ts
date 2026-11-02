import { createMigrationProvider, createPostgres } from '@frameleaf/sql-tools';
import { Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import postgres from 'postgres';
import * as semver from 'semver';
import { frozenSource } from 'src/immich-import/adapters.js';
import { connectImportDatabase } from 'src/immich-import/database.js';
import provenance from 'src/immich-import/fixtures/structure/provenance.json' with { type: 'json' };
import { ImmichImportService } from 'src/immich-import/importer.js';
import { ImportConfig, ImportDatabase, quote } from 'src/immich-import/types.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';

/** Disposable hosted PostgreSQL databases, using only the checked-in, frozen source structural DDL. */
export class PostgresImportFixture {
  readonly owner = randomUUID();
  readonly reader = randomUUID();
  readonly group = randomUUID();
  readonly asset = randomUUID();
  readonly album = randomUUID();
  readonly link = randomUUID();
  // Immich 2.x rows that exercise every legacy view.
  readonly video = randomUUID();
  readonly readerAsset = randomUUID();
  readonly tag = randomUUID();
  readonly memory = randomUUID();
  readonly person = randomUUID();
  readonly crossPerson = randomUUID();
  readonly face = randomUUID();
  readonly crossFace = randomUUID();
  readonly role = `import_reader_${randomUUID().replaceAll('-', '')}`;
  readonly sourceName = `import_source_${randomUUID().replaceAll('-', '')}`;
  readonly destinationName = `import_target_${randomUUID().replaceAll('-', '')}`;
  readonly original = Buffer.from('real-postgres-offline-immich-original');
  readonly password = 'fixture password: never a live account';
  readonly pin = '583021';
  readonly connections = new Set<ReturnType<typeof connectImportDatabase>>();
  readonly databases: string[] = [];
  readonly extraRoles: string[] = [];
  directory = '';
  passwordHash = '';
  pinHash = '';
  source!: ReturnType<typeof connectImportDatabase>;
  destination!: ReturnType<typeof connectImportDatabase>;
  config!: ImportConfig;
  private readonly credential = randomUUID();
  private readonly admin: ReturnType<typeof postgres>;
  private roleCreated = false;

  constructor(readonly version = '3.2.4') {
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = '/postgres';
    this.admin = postgres(url.href, { max: 1, onnotice: () => {} });
  }

  url(name: string, sourceRole = false): string {
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    url.pathname = `/${name}`;
    if (sourceRole) {
      url.username = this.role;
      url.password = this.credential;
    }
    return url.href;
  }

  connect(name: string, readOnly: boolean, sourceRole = false) {
    const connection = connectImportDatabase(this.url(name, sourceRole), readOnly);
    this.connections.add(connection);
    return connection;
  }

  async initialize() {
    for (const name of [this.sourceName, this.destinationName]) {
      await this.admin.unsafe(`CREATE DATABASE ${quote(name)}`);
      this.databases.push(name);
    }
    // Generated UUID contains no quote; credentials stay out of command-line arguments and diagnostics.
    await this.admin.unsafe(
      `CREATE ROLE ${quote(this.role)} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT PASSWORD '${this.credential}'`,
    );
    this.roleCreated = true;
    this.directory = await mkdtemp(join(tmpdir(), 'immich-transport-'));
    await mkdir(join(this.directory, 'source'));
    await mkdir(join(this.directory, 'target'));
    await writeFile(this.sourcePath, this.original);
    await writeFile(this.targetPath, this.original);
    const crypto = new CryptoRepository();
    this.passwordHash = await crypto.hashBcrypt(this.password, 4);
    this.pinHash = await crypto.hashBcrypt(this.pin, 4);
    this.config = {
      version: this.version,
      sourceId: 'frozen-offline-library',
      writersStopped: true,
      mediaRoots: [{ source: join(this.directory, 'source'), target: join(this.directory, 'target') }],
    };
    const writer = this.connect(this.sourceName, false);
    try {
      const fixtureRoot = new URL('../../../../src/immich-import/fixtures/structure/', import.meta.url);
      if (this.legacy) {
        // Schema-only dump of the newest replayed 2.x shape at or below this release.
        const shape = semver.maxSatisfying(Object.keys(provenance.replayed), `<=${this.version}`)!;
        const dump = await readFile(
          new URL(provenance.replayed[shape as keyof typeof provenance.replayed].dump, fixtureRoot),
          'utf8',
        );
        await writer.db.query(gunzipSync(Buffer.from(dump, 'base64')).toString('utf8'));
        await writer.db.query(
          'CREATE TABLE public.kysely_migrations (name varchar(255) PRIMARY KEY, "timestamp" varchar(255) NOT NULL)',
        );
      } else {
        await writer.db.query('CREATE EXTENSION "uuid-ossp"; CREATE EXTENSION vector');
        await writer.db.query(await readFile(new URL('3.1.0.sql', fixtureRoot), 'utf8'));
        const structure = this.version.startsWith('3.0.')
          ? '3.0.0'
          : this.version.startsWith('3.1.')
            ? '3.1.0'
            : '3.2.0';
        if (structure !== '3.1.0') {
          await writer.db.query(await readFile(new URL(`${structure}-from-3.1.0.sql`, fixtureRoot), 'utf8'));
        }
      }
      await writer.db.query(
        `INSERT INTO public.kysely_migrations(name,"timestamp")
        SELECT value, '2026-01-01T00:00:00Z' FROM jsonb_array_elements_text($1::text::jsonb)`,
        [JSON.stringify(frozenSource(this.version).migrations)],
      );
      await (this.legacy ? this.seedLegacy(writer.db) : this.seed(writer.db));
      await writer.db.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        ALTER ROLE ${quote(this.role)} INHERIT;
        GRANT pg_read_all_stats TO ${quote(this.role)};
        GRANT USAGE ON SCHEMA public TO ${quote(this.role)};
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${quote(this.role)};
        GRANT EXECUTE ON FUNCTION pg_catalog.pg_control_system() TO ${quote(this.role)}`);
    } finally {
      await writer.close();
      this.connections.delete(writer);
    }
    const db = new Kysely<any>({
      dialect: new PostgresJSDialect({
        postgres: createPostgres({
          connection: { connectionType: 'url', url: this.url(this.destinationName) },
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
      if (error) throw error;
    } finally {
      await db.destroy();
    }
    this.source = this.connect(this.sourceName, true, true);
    this.destination = this.connect(this.destinationName, false);
  }

  get legacy() {
    return semver.lt(this.version, '3.0.0');
  }
  file(name: string, root: 'source' | 'target' = 'source') {
    return join(this.directory, root, name);
  }
  get sourcePath() {
    return join(this.directory, 'source', 'original.jpg');
  }
  get targetPath() {
    return join(this.directory, 'target', 'original.jpg');
  }
  importer(config: ImportConfig = this.config) {
    return new ImmichImportService(this.destination.db, this.source.db, config);
  }

  private async seed(db: ImportDatabase) {
    const current = !!frozenSource(this.version).tables.cluster_group;
    if (current) await db.query('INSERT INTO public.cluster_group(id) VALUES ($1)', [this.group]);
    for (const [id, email, name, admin] of [
      [this.owner, 'owner@example.test', 'Owner', true],
      [this.reader, 'reader@example.test', 'Reader', false],
    ] as const) {
      await db.query(
        `INSERT INTO public."user"(id,email,name,password,"pinCode","isAdmin","shouldChangePassword"${current ? ',"clusterGroupId"' : ''})
        VALUES ($1,$2,$3,$4,$5,$6,false${current ? ',$7' : ''})`,
        [
          id,
          email,
          name,
          this.passwordHash,
          id === this.owner ? this.pinHash : null,
          admin,
          ...(current ? [this.group] : []),
        ],
      );
    }
    await db.query(
      `INSERT INTO public.asset(id,"ownerId",type,"originalPath","originalFileName",checksum,
      "checksumAlgorithm","fileCreatedAt","fileModifiedAt","localDateTime",visibility,"isFavorite")
      VALUES ($1,$2,'IMAGE',$3,'original.jpg',$4,'sha1','2026-01-01','2026-01-01','2026-01-01','locked',true)`,
      [this.asset, this.owner, this.sourcePath, createHash('sha1').update(this.original).digest()],
    );
    await db.query(
      `INSERT INTO public.asset_audio("assetId",bitrate,index,profile,"codecName")
      VALUES ($1,192000,1,NULL,'aac')`,
      [this.asset],
    );
    await db.query(
      `INSERT INTO public.asset_video("assetId",bitrate,"frameCount","timeBase",index,profile,level,
      "colorPrimaries","colorTransfer","colorMatrix","dvProfile","dvLevel","dvBlSignalCompatibilityId",
      "codecName","formatName","formatLongName","pixelFormat")
      VALUES ($1,4000000,300,15360,0,100,41,1,1,1,NULL,NULL,NULL,'h264','mov','QuickTime / MOV','yuv420p')`,
      [this.asset],
    );
    await db.query(
      `INSERT INTO public.asset_keyframe("assetId",pts,"accDuration","ownDuration","totalDuration","packetCount","outputFrames")
      VALUES ($1,ARRAY[0,15360],ARRAY[0,1000],ARRAY[1000,1000],2000,60,60)`,
      [this.asset],
    );
    await db.query(
      `INSERT INTO public.album(id,"albumName","albumThumbnailAssetId",description,"isActivityEnabled")
      VALUES ($1,'Shared album',$2,'Preserve relationships',false)`,
      [this.album, this.asset],
    );
    await db.query(`INSERT INTO public.album_user("albumId","userId",role) VALUES ($1,$2,'owner'),($1,$3,'viewer')`, [
      this.album,
      this.owner,
      this.reader,
    ]);
    await db.query('INSERT INTO public.album_asset("albumId","assetId") VALUES ($1,$2)', [this.album, this.asset]);
    await db.query('INSERT INTO public.partner("sharedById","sharedWithId","inTimeline") VALUES ($1,$2,false)', [
      this.owner,
      this.reader,
    ]);
    await db.query(
      `INSERT INTO public.shared_link(id,"userId","albumId",key,type,password,"allowUpload","allowDownload","showExif")
      VALUES ($1,$2,$3,$4,'ALBUM',$5,false,false,false)`,
      [this.link, this.owner, this.album, Buffer.from('private-share-key'), this.passwordHash],
    );
  }

  /** Immich 2.x rows covering each change an older release has not migrated, in that release's own columns. */
  private async seedLegacy(db: ImportDatabase) {
    const has = async (table: string, column: string) =>
      (
        await db.query(
          `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
          [table, column],
        )
      ).length > 0;
    const renamed = !(await has('album_asset', 'albumId'));
    const c = (current: string, legacy: string) => quote(renamed ? legacy : current);
    const checksumColumn = await has('asset', 'checksumAlgorithm');
    const sidecar = await has('asset', 'sidecarPath');
    const encoded = await has('asset', 'encodedVideoPath');
    const files = { video: 'video.mp4', reader: 'reader.jpg', sidecar: 'original.jpg.xmp', encoded: 'encoded.mp4' };
    for (const name of Object.values(files)) {
      for (const root of ['source', 'target'] as const) {
        await writeFile(this.file(name, root), `legacy ${name}`);
      }
    }
    const sha1 = (name: string) => createHash('sha1').update(`legacy ${name}`).digest();
    for (const [id, email, password, admin] of [
      [this.owner, 'owner@example.test', this.passwordHash, true],
      [this.reader, 'reader@example.test', '', false],
    ] as const) {
      await db.query(
        `INSERT INTO public."user"(id,email,name,password,"pinCode","isAdmin","shouldChangePassword","oauthId")
        VALUES ($1,$2,$2,$3,$4,$5,false,'')`,
        [id, email, password, id === this.owner ? this.pinHash : null, admin],
      );
    }
    const asset = async (
      id: string,
      owner: string,
      type: string,
      path: string,
      digest: Buffer,
      extra: Record<string, unknown>,
    ) => {
      const row: Record<string, unknown> = {
        id,
        ownerId: owner,
        deviceAssetId: id,
        deviceId: 'legacy-device',
        type,
        originalPath: path,
        originalFileName: path.split('/').at(-1),
        checksum: digest,
        fileCreatedAt: '2025-06-01',
        fileModifiedAt: '2025-06-01',
        localDateTime: '2025-06-01',
        ...(checksumColumn && { checksumAlgorithm: 'sha1' }),
        ...extra,
      };
      const columns = Object.keys(row);
      await db.query(
        `INSERT INTO public.asset(${columns.map((column) => quote(column)).join(',')})
        VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`,
        Object.values(row),
      );
    };
    await asset(this.video, this.owner, 'VIDEO', this.file(files.video), sha1(files.video), {
      duration: '00:01:02.345',
      visibility: 'hidden',
      ...(encoded && { encodedVideoPath: this.file(files.encoded) }),
    });
    // A Live Photo still wrongly hidden; 3.1 makes it visible again.
    await asset(this.asset, this.owner, 'IMAGE', this.sourcePath, createHash('sha1').update(this.original).digest(), {
      visibility: 'hidden',
      livePhotoVideoId: this.video,
      isFavorite: true,
      ...(sidecar && { sidecarPath: this.file(files.sidecar) }),
    });
    await asset(this.readerAsset, this.reader, 'IMAGE', this.file(files.reader), sha1(files.reader), {});
    await db.query(
      `INSERT INTO public.asset_exif("assetId",orientation,"exifImageWidth","exifImageHeight",rating,description)
      VALUES ($1,'6',4000,3000,0,'Beach day')`,
      [this.asset],
    );
    await db.query(
      `INSERT INTO public.album(id,"ownerId","albumName","albumThumbnailAssetId",description,"isActivityEnabled")
      VALUES ($1,$2,'Shared album',$3,'',false)`,
      [this.album, this.owner, this.asset],
    );
    // The owner is also listed as a member; ownership wins.
    await db.query(
      `INSERT INTO public.album_user(${c('albumId', 'albumsId')},${c('userId', 'usersId')},role)
      VALUES ($1,$2,'editor'),($1,$3,'viewer')`,
      [this.album, this.reader, this.owner],
    );
    await db.query(
      `INSERT INTO public.album_asset(${c('albumId', 'albumsId')},${c('assetId', 'assetsId')}) VALUES ($1,$2)`,
      [this.album, this.asset],
    );
    await db.query('INSERT INTO public.partner("sharedById","sharedWithId","inTimeline") VALUES ($1,$2,true)', [
      this.owner,
      this.reader,
    ]);
    await db.query(
      `INSERT INTO public.shared_link(id,"userId","albumId",key,type,"allowUpload","allowDownload","showExif")
      VALUES ($1,$2,$3,$4,'ALBUM',false,true,true)`,
      [this.link, this.owner, this.album, Buffer.from('legacy-share-key')],
    );
    await db.query(
      `INSERT INTO public.shared_link_asset(${c('assetId', 'assetsId')},${c('sharedLinkId', 'sharedLinksId')}) VALUES ($1,$2)`,
      [this.asset, this.link],
    );
    await db.query(`INSERT INTO public.tag(id,"userId",value) VALUES ($1,$2,'Holidays')`, [this.tag, this.owner]);
    await db.query(`INSERT INTO public.tag_asset(${c('assetId', 'assetsId')},${c('tagId', 'tagsId')}) VALUES ($1,$2)`, [
      this.asset,
      this.tag,
    ]);
    await db.query(
      `INSERT INTO public.memory(id,"ownerId",type,data,"memoryAt") VALUES ($1,$2,'on_this_day','{"year":2025}','2026-06-01')`,
      [this.memory, this.owner],
    );
    // The second memory asset belongs to another user; 3.2 removes it.
    await db.query(`INSERT INTO public.memory_asset("memoriesId",${c('assetId', 'assetsId')}) VALUES ($1,$2),($1,$3)`, [
      this.memory,
      this.asset,
      this.readerAsset,
    ]);
    await db.query(`INSERT INTO public.person(id,"ownerId",name) VALUES ($1,$2,'Alex'),($3,$2,'Cross')`, [
      this.person,
      this.owner,
      this.crossPerson,
    ]);
    // The second face puts the owner's person on the reader's asset; 3.0 deletes it.
    await db.query(
      `INSERT INTO public.asset_face(id,"assetId","personId","imageWidth","imageHeight") VALUES ($1,$2,$3,4000,3000),($4,$5,$6,4000,3000)`,
      [this.face, this.asset, this.person, this.crossFace, this.readerAsset, this.crossPerson],
    );
    await db.query('UPDATE public.person SET "faceAssetId"=$2 WHERE id=$1', [this.person, this.face]);
    await db.query('UPDATE public.person SET "faceAssetId"=$2 WHERE id=$1', [this.crossPerson, this.crossFace]);
  }

  /** No writer remains connected when admission is evaluated, including after a mutation fixture. */
  async mutateSource(body: (db: ImportDatabase) => Promise<unknown>) {
    await this.source.close();
    this.connections.delete(this.source);
    const writer = this.connect(this.sourceName, false);
    const [session] = await writer.db.query('SELECT pg_backend_pid() AS pid');
    try {
      await body(writer.db);
    } finally {
      await writer.close();
      this.connections.delete(writer);
      this.source = this.connect(this.sourceName, true, true);
      // Driver close observes the local socket, not PostgreSQL backend removal.
      await vi.waitFor(
        async () => {
          expect(
            await this.source.db.query('SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND pid=$1', [
              session.pid,
            ]),
          ).toEqual([]);
        },
        { timeout: 2000, interval: 50 },
      );
    }
  }

  async restartConnections() {
    const [session] = await this.source.db.query('SELECT pg_backend_pid() AS pid');
    for (const connection of [this.source, this.destination]) {
      await connection.close();
      this.connections.delete(connection);
    }
    // As in mutateSource, socket close does not prove PostgreSQL removed the old backend.
    // Observe only that source PID using the fixture's existing observer before reconnecting.
    await vi.waitFor(
      async () => {
        expect(
          await this.admin.unsafe('SELECT pid FROM pg_stat_activity WHERE datname=$1 AND pid=$2', [
            this.sourceName,
            Number(session.pid),
          ]),
        ).toHaveLength(0);
      },
      { timeout: 2000, interval: 50 },
    );
    this.source = this.connect(this.sourceName, true, true);
    this.destination = this.connect(this.destinationName, false);
  }

  async elevateMembership() {
    const role = `import_privileged_${randomUUID().replaceAll('-', '')}`;
    await this.admin.unsafe(`CREATE ROLE ${quote(role)} NOLOGIN SUPERUSER`);
    this.extraRoles.push(role);
    await this.admin.unsafe(`GRANT ${quote(role)} TO ${quote(this.role)}`);
  }

  async cloneSource() {
    await this.source.close();
    this.connections.delete(this.source);
    const name = `import_clone_${randomUUID().replaceAll('-', '')}`;
    await this.admin.unsafe(`CREATE DATABASE ${quote(name)} TEMPLATE ${quote(this.sourceName)}`);
    this.databases.push(name);
    this.source = this.connect(name, true, true);
  }

  async close() {
    // Attempt every cleanup step, so one failure does not leak the rest; report the first failure.
    const errors: unknown[] = [];
    const attempt = async (step: () => Promise<unknown>) => {
      try {
        await step();
      } catch (error) {
        errors.push(error);
      }
    };
    const closed = await Promise.allSettled([...this.connections].map((connection) => connection.close()));
    for (const result of closed) if (result.status === 'rejected') errors.push(result.reason);
    for (const name of this.databases.toReversed()) {
      await attempt(() => this.admin.unsafe(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`));
    }
    if (this.roleCreated) await attempt(() => this.admin.unsafe(`DROP ROLE ${quote(this.role)}`));
    for (const role of this.extraRoles) await attempt(() => this.admin.unsafe(`DROP ROLE ${quote(role)}`));
    await attempt(() => this.admin.end());
    if (this.directory) {
      const directory = this.directory;
      await attempt(() => rm(directory, { recursive: true, force: true }));
    }
    if (errors.length > 0) throw errors[0];
  }
}
