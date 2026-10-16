import { ServiceUnavailableException } from '@nestjs/common';
import { json } from 'body-parser';
import { Kysely, sql } from 'kysely';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
import { AssetUploadResourceController } from 'src/controllers/asset-upload-resource.controller.js';
import { DesktopDeviceController } from 'src/controllers/desktop-device.controller.js';
import { PhotoSourceController } from 'src/controllers/photo-source.controller.js';
import { UserController } from 'src/controllers/user.controller.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetChecksumRepository } from 'src/repositories/asset-checksum.repository.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafAccountRepository } from 'src/repositories/frameleaf-account.repository.js';
import { ICloudIdentityRepository } from 'src/repositories/icloud-identity.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetUploadDirectService } from 'src/services/asset-upload-direct.service.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { AuthService } from 'src/services/auth.service.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopDeviceService } from 'src/services/desktop-device.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { FrameleafLicenseService } from 'src/services/frameleaf-license.service.js';
import { PhotoSourceService } from 'src/services/photo-source.service.js';
import { PinnedCollectionService } from 'src/services/pinned-collection.service.js';
import { UserService } from 'src/services/user.service.js';
import { canonicalDatabaseUrl } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let folder: string;
let admission: RateLimitRepository;
beforeAll(async () => {
  db = await getKyselyDB();
  folder = await mkdtemp(join(tmpdir(), 'frameleaf-folder-upload-'));
  StorageCore.setMediaLocation(folder);
  await mkdir(join(folder, 'upload'), { recursive: true });
  const { rows } = await sql<{ name: string }>`select current_database() name`.execute(db);
  const config = new ConfigRepository();
  const env = config.getEnv();
  vi.spyOn(config, 'getEnv').mockReturnValue({
    ...env,
    database: {
      ...env.database,
      config: {
        connectionType: 'url',
        url: canonicalDatabaseUrl(process.env.IMMICH_TEST_POSTGRES_URL!, rows[0].name),
      },
    },
  });
  admission = new RateLimitRepository(config);
});
afterAll(async () => {
  await admission?.onModuleDestroy();
  await db?.destroy();
  if (folder) await rm(folder, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function setup() {
  const { sut: media, ctx } = newMediumService(AssetMediaService, {
    database: db,
    real: [
      ConfigRepository,
      SystemMetadataRepository,
      PhysicalFileRepository,
      AssetChecksumRepository,
      AccessRepository,
      AlbumRepository,
      AssetRepository,
      SharedLinkRepository,
      UserRepository,
      StorageRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository],
  });
  ctx.getMock(JobRepository).queue.mockResolvedValue(undefined);
  ctx.getMock(EventRepository).emit.mockResolvedValue(undefined);
  const { user } = await ctx.newUser();
  const { session } = await ctx.newSession({ userId: user.id });
  const auth = { user, session: { ...session, hasElevatedPermission: false } } as AuthDto;
  const authority = { ownerId: user.id, sessionId: session.id };
  const devices = new DesktopDeviceRepository(db);
  const device = (await devices.enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32, 7).toString('base64'),
    name: 'Fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'awaiting-approval',
  }))!;
  const sources = new PhotoSourceRepository(db);
  const source = await sources.create(authority, {
    id: randomUUID(),
    deviceId: device.id,
    kind: 'folder',
    mode: 'copy',
    name: 'Synthetic folder',
    scopeFingerprint: 'a'.repeat(64),
  });
  const run = await sources.run(authority, source.id, { id: randomUUID(), maxItems: 1, maxBytes: 100 });
  const bytes = Buffer.from('independent synthetic original');
  const checksum = createHash('sha256').update(bytes).digest();
  const item = await sources.plan(authority, source.id, run.id, {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: checksum.toString('hex'),
    bytes: bytes.length,
  });
  const repository = new AssetUploadResourceRepository(db);
  const native = new AssetUploadResourceService(
    repository,
    media,
    ctx.get(AssetRepository),
    ctx.get(AccessRepository),
    ctx.get(StorageRepository),
    ctx.get(PhysicalFileRepository),
    ctx.getMock(LoggingRepository),
    admission,
    new ICloudIdentityRepository(db),
    sources,
  );
  const identity = { kind: 'folder' as const, sourceId: source.id, runId: run.id, itemId: item.id };
  const headers = {
    'upload-draft-interop-version': '9',
    'upload-complete': '?0',
    'upload-length': String(bytes.length),
    'content-type': 'image/jpeg',
    'repr-digest': `sha-256=:${checksum.toString('base64')}:`,
    'asset-metadata': Buffer.from(
      JSON.stringify({
        filename: 'synthetic.jpg',
        fileCreatedAt: new Date().toISOString(),
        fileModifiedAt: new Date().toISOString(),
        sourceIdentity: identity,
      }),
    ).toString('base64url'),
  };
  const append = {
    'upload-draft-interop-version': '9',
    'upload-complete': '?1',
    'content-type': 'application/partial-upload',
    'upload-offset': '0',
  };
  return { native, repository, media, ctx, auth, authority, sources, source, run, item, bytes, headers, append };
}
it('publishes a folder upload through the real native pipeline and verifies its independently stored bytes', async () => {
  const f = await setup();
  const created = await f.native.create(f.auth, f.headers, Readable.from([]), () => {});
  const result = await f.native.append(f.auth, created.resource.id, f.append, Readable.from([f.bytes]));
  expect(result.result?.status).toBe('created');
  const asset = await f.ctx.get(AssetRepository).getById(result.result!.id);
  expect(await readFile(asset!.originalPath)).toEqual(f.bytes);
  const service = new PhotoSourceService(
    f.sources,
    f.ctx.get(AccessRepository),
    f.ctx.get(StorageRepository),
    new CryptoRepository(),
    f.ctx.get(SystemMetadataRepository),
    admission,
    f.ctx.getMock(LoggingRepository),
  );
  const receipt = await service.verify(f.auth, f.source.id, f.run.id, f.item.id, {
    uploadResourceId: created.resource.id,
  });
  expect(receipt).toMatchObject({ assetId: asset!.id, storage: 'managed', sha256: f.item.checksum.toString('hex') });
});
it('refuses revoked folder authority before assigning a URI or reading a request body', async () => {
  const f = await setup();
  await f.sources.revoke(f.authority, f.source.id);
  let read = false;
  const resume = vi.fn();
  await expect(
    f.native.create(
      f.auth,
      f.headers,
      Readable.from(
        (function* () {
          read = true;
          yield f.bytes;
        })(),
      ),
      resume,
    ),
  ).rejects.toThrow();
  expect(read).toBe(false);
  expect(resume).not.toHaveBeenCalled();
  expect(
    await db.selectFrom('asset_upload_resource').select('id').where('ownerId', '=', f.auth.user.id).execute(),
  ).toHaveLength(0);
});
it('a revocation after real media preparation prevents publication and retains the verified resumable bytes', async () => {
  const f = await setup();
  const created = await f.native.create(f.auth, f.headers, Readable.from([]), () => {});
  const prepare = f.media.prepareUploadAsset.bind(f.media);
  vi.spyOn(f.media, 'prepareUploadAsset').mockImplementation(async (...args) => {
    const prepared = await prepare(...args);
    await f.sources.revoke(f.authority, f.source.id);
    return prepared;
  });
  await expect(f.native.append(f.auth, created.resource.id, f.append, Readable.from([f.bytes]))).rejects.toThrow();
  const retained = await f.repository.get(created.resource.id, f.auth.user.id);
  expect(retained.state).toBe('verified');
  expect(retained.resultAssetId).toBeNull();
  expect(await readFile(retained.finalPath!)).toEqual(f.bytes);
  expect(await db.selectFrom('asset').select('id').where('ownerId', '=', f.auth.user.id).execute()).toHaveLength(0);
  await f.native['recover']();
  expect((await f.repository.get(created.resource.id, f.auth.user.id)).state).toBe('verified');
});

it.skipIf(!process.env.FRAMELEAF_NATIVE_DESKTOP_ROOT)(
  'runs the actual native approved-folder coordinator over HTTPS and retains staging through lost and unhealthy receipts',
  async () => {
    const desktop = process.env.FRAMELEAF_NATIVE_DESKTOP_ROOT!;
    const f = await setup();
    const root = await mkdtemp(join(await realpath(tmpdir()), 'frameleaf-native-folder-'));
    const crypto = new CryptoRepository();
    const token = randomBytes(32).toString('base64url');
    await db
      .updateTable('session')
      .set({ token: crypto.hashSha256(token) })
      .where('id', '=', f.auth.session!.id)
      .execute();
    const { sut: authentication } = newMediumService(AuthService, {
      database: db,
      real: [
        ConfigRepository,
        CryptoRepository,
        SessionRepository,
        SharedLinkRepository,
        SystemMetadataRepository,
        UserRepository,
      ],
      mock: [LoggingRepository],
    });
    const { sut: users } = newMediumService(UserService, {
      database: db,
      real: [ConfigRepository, SystemMetadataRepository, UserRepository, FrameleafAccountRepository],
      mock: [LoggingRepository],
    });
    const metadata = f.ctx.get(SystemMetadataRepository);
    const policies = new DesktopAssistancePolicyService(metadata);
    const service = new PhotoSourceService(
      f.sources,
      f.ctx.get(AccessRepository),
      f.ctx.get(StorageRepository),
      crypto,
      metadata,
      admission,
      f.ctx.getMock(LoggingRepository),
    );
    const verify = service.verify.bind(service);
    let loseReply = true;
    vi.spyOn(service, 'verify').mockImplementation(async (...args) => {
      const receipt = await verify(...args);
      if (loseReply) {
        loseReply = false;
        throw new ServiceUnavailableException('Synthetic lost receipt reply');
      }
      return receipt;
    });
    const http = await controllerSetup(
      [DesktopDeviceController, UserController, PhotoSourceController, AssetUploadResourceController],
      [
        { provide: AuthService, useValue: authentication },
        { provide: UserService, useValue: users },
        { provide: FrameleafLicenseService, useValue: {} },
        { provide: PinnedCollectionService, useValue: {} },
        {
          provide: DesktopDeviceService,
          useValue: new DesktopDeviceService(new DesktopDeviceRepository(db), metadata, policies),
        },
        { provide: DesktopAssistancePolicyService, useValue: policies },
        { provide: DesktopWorkerAuthService, useValue: {} },
        { provide: PhotoSourceService, useValue: service },
        { provide: AssetUploadResourceService, useValue: f.native },
        { provide: AssetUploadDirectService, useValue: {} },
      ],
    );
    const requests: { method: string | undefined; path: string }[] = [];
    const parse = json({ limit: '10mb' });
    const tls = createServer(
      {
        key: readFileSync('test/fixtures/frameleaf-relay/tun.key.pem'),
        cert: readFileSync('test/fixtures/frameleaf-relay/tun.cert.pem'),
      },
      (request, response) => {
        if (!request.url?.startsWith('/api/')) {
          response.writeHead(404).end();
          return;
        }
        requests.push({ method: request.method, path: request.url.split('?', 1)[0] });
        // Preserve the mounted /api prefix used by the production upload Location header.
        Object.assign(request, { originalUrl: request.url });
        request.url = request.url.slice(4);
        parse(request, response, (error) => {
          if (error) {
            response.writeHead(error.status ?? 400).end();
            return;
          }
          http.getHttpServer().emit('request', request, response);
        });
      },
    );
    let native: ChildProcess | undefined;
    let exit: Promise<number | null> | undefined;
    try {
      await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
      const address = tls.address() as { port: number };
      const built = await promisify(execFile)(
        'cargo',
        ['test', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--no-run', '--message-format=json'],
        { cwd: desktop, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const artifact = built.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find(
          (item) =>
            item.reason === 'compiler-artifact' &&
            item.target.name === 'frameleaf_desktop' &&
            item.profile.test &&
            item.executable,
        );
      expect(artifact?.executable).toBeTruthy();
      native = spawn(
        artifact.executable,
        ['source_import::native_nas_tests::actual_native_folder_copy', '--ignored', '--exact', '--nocapture'],
        { cwd: desktop, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      exit = new Promise((resolve) => {
        native!.once('exit', resolve);
        native!.once('error', () => resolve(-1));
      });
      let errors = '';
      native.stderr!.on('data', (bytes) => {
        errors = (errors + String(bytes)).slice(-8192);
      });
      const lines = createInterface({ input: native.stdout! })[Symbol.asyncIterator]();
      const message = async () => {
        while (true) {
          let timer: NodeJS.Timeout | undefined;
          const next = await Promise.race([
            lines.next(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Native folder fixture deadline')), 120_000);
            }),
          ]).finally(() => clearTimeout(timer));
          if (next.done) throw new Error('Native folder fixture stopped: ' + errors);
          if (next.value.startsWith('FOLDER_COPY ')) return JSON.parse(next.value.slice(12));
        }
      };
      native.stdin!.write(
        JSON.stringify({
          server: `https://tun.eu1.relays.frameleaf.test:${address.port}`,
          accountId: f.auth.user.id,
          token,
          caPem: readFileSync('test/fixtures/frameleaf-relay/ca.cert.pem', 'utf8'),
          root,
        }) + '\n',
      );
      const paused = await message();
      expect(paused.phase).toBe('lost-receipt');
      const item = await db
        .selectFrom('photo_source_resource')
        .selectAll()
        .where('id', '=', paused.itemId)
        .executeTakeFirstOrThrow();
      expect(item.state).toBe('verified');
      const asset = await f.ctx.get(AssetRepository).getById(item.assetId!);
      expect(asset).toBeDefined();
      const original = Buffer.alloc(2 * 1024 * 1024 + 7, 42);
      expect(await readFile(asset!.originalPath)).toEqual(original);
      expect(createHash('sha256').update(original).digest('hex')).toBe(paused.sha256);
      await writeFile(asset!.originalPath, Buffer.alloc(original.length, 43));
      native.stdin!.write(JSON.stringify({ command: 'resume' }) + '\n');
      expect((await message()).phase).toBe('unhealthy-copy-retained');
      await writeFile(asset!.originalPath, original);
      native.stdin!.write(JSON.stringify({ command: 'resume' }) + '\n');
      expect(await message()).toMatchObject({ phase: 'complete', originalUnchanged: true, stagingReleased: true });
      native.stdin!.end();
      let exitTimer: NodeJS.Timeout | undefined;
      try {
        const code = await Promise.race([
          exit,
          new Promise<never>((_, reject) => {
            exitTimer = setTimeout(() => reject(new Error('Native folder shutdown deadline')), 10_000);
          }),
        ]);
        expect(code, errors).toBe(0);
      } finally {
        clearTimeout(exitTimer);
      }
      const uploads = await db
        .selectFrom('asset_upload_resource')
        .selectAll()
        .where('ownerId', '=', f.auth.user.id)
        .execute();
      expect(uploads).toHaveLength(1);
      expect(uploads[0].resultAssetId).toBe(asset!.id);
      const run = await db
        .selectFrom('photo_source_run')
        .select('state')
        .where('id', '=', paused.runId)
        .executeTakeFirstOrThrow();
      expect(run.state).toBe('complete');
      expect(requests.filter((r) => r.method === 'POST' && r.path === '/api/assets/uploads')).toHaveLength(1);
      expect(requests.filter((r) => r.method === 'PATCH' && r.path.startsWith('/api/assets/uploads/'))).toHaveLength(3);
      expect(requests.filter((r) => r.method === 'HEAD')).toHaveLength(0);
    } finally {
      if (native && native.exitCode === null) {
        native.kill('SIGKILL');
        await exit;
      }
      await new Promise<void>((resolve) => {
        tls.close(() => resolve());
        tls.closeAllConnections();
      });
      await http.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  600_000,
);
