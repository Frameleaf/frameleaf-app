import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { crc32 } from 'node:zlib';
import { StorageCore } from 'src/cores/storage.core.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetVisibility, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import {
  StudioBundleUpload,
  StudioProject,
  StudioProjectRepository,
} from 'src/repositories/studio-project.repository.js';
import { StudioBundleService } from 'src/services/studio-bundle.service.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import {
  STUDIO_BUNDLE_MANIFEST_ENTRY,
  STUDIO_BUNDLE_MAX_ATTEMPTS,
  StudioBundleManifest,
  buildStudioBundleManifest,
  readZipDirectory,
  readZipEntry,
  serializeStudioBundleProject,
} from 'src/utils/studio-bundle.js';
import { STUDIO_ENGINE, STUDIO_ENVELOPE_SCHEMA_VERSION, studioEnvelopeDigest } from 'src/utils/studio-project.js';
import { extractStudioResourceReferences, studioReferenceKey } from 'src/utils/studio-resources.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newUuid, newUuidV7 } from 'test/small.factory.js';
import { getMocks } from 'test/utils.js';

/* ------------------------------------------------------------------ */
/* An in-memory file system and a stored-only ZIP writer                */
/* ------------------------------------------------------------------ */

const buildZip = (entries: Array<{ name: string; data: Buffer }>): Buffer => {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04_03_4b_50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02_01_4b_50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, 46);
    locals.push(local, entry.data);
    centrals.push(central);
    offset += local.length + entry.data.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
};

const memoryFs = () => {
  const files = new Map<string, Buffer>();
  const read = (path: string) => {
    const bytes = files.get(path);
    if (!bytes) {
      throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
    }
    return bytes;
  };
  const storage = {
    mkdirSync: vi.fn(),
    createOrOverwriteFile: vi.fn((path: string, bytes: Buffer) => {
      files.set(path, Buffer.from(bytes));
      return Promise.resolve();
    }),
    unlink: vi.fn((path: string) => {
      files.delete(path);
      return Promise.resolve();
    }),
    unlinkDir: vi.fn((folder: string) => {
      for (const path of files.keys()) {
        if (path.startsWith(`${folder}/`)) {
          files.delete(path);
        }
      }
      return Promise.resolve();
    }),
    stat: vi.fn((path: string) => Promise.resolve({ size: read(path).length })),
    rename: vi.fn((from: string, to: string) => {
      files.set(to, read(from));
      files.delete(from);
      return Promise.resolve();
    }),
    createZipStream: vi.fn(() => {
      const stream = new PassThrough();
      const entries: Array<{ name: string; data: Buffer }> = [];
      return {
        stream,
        addFile: (path: string, name: string) => {
          entries.push({ name, data: read(path) });
        },
        finalize: () => {
          stream.end(buildZip(entries));
          return Promise.resolve();
        },
      };
    }),
    createWriteStream: vi.fn((path: string) => {
      const chunks: Buffer[] = [];
      return new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
        final(callback) {
          files.set(path, Buffer.concat(chunks));
          callback();
        },
      });
    }),
    openForRandomRead: vi.fn((path: string) => {
      const bytes = read(path);
      return Promise.resolve({
        size: bytes.length,
        read: (position: number, length: number) => Promise.resolve(bytes.subarray(position, position + length)),
        close: () => Promise.resolve(),
      });
    }),
    createReadStream: vi.fn((path: string, type: string) =>
      Promise.resolve({ stream: new PassThrough(), length: read(path).length, type }),
    ),
  };
  const crypto = {
    hashFile: vi.fn((path: string, algorithm: 'sha1' | 'sha256' = 'sha1') =>
      Promise.resolve(createHash(algorithm).update(read(path)).digest()),
    ),
  };
  return { files, storage, crypto };
};

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest();

/* ------------------------------------------------------------------ */

describe(StudioBundleService.name, () => {
  let sut: StudioBundleService;
  let fs: ReturnType<typeof memoryFs>;
  let owner: AuthDto;
  let operations: Record<string, ReturnType<typeof vi.fn>>;
  let projects: Record<string, ReturnType<typeof vi.fn>>;
  let assets: { getByIds: ReturnType<typeof vi.fn>; getByChecksums: ReturnType<typeof vi.fn> };
  let resources: { resolveProjectResources: ReturnType<typeof vi.fn> };
  let studio: { authorizeRevision: ReturnType<typeof vi.fn> };
  let users: { get: ReturnType<typeof vi.fn> };
  /** Asset ids FL-90 authorizes for the acting account, and the file behind each. */
  let allowed: Map<string, { path: string; ownerId: string }>;

  const assetA = newUuid();
  const assetB = newUuid();
  const assetC = newUuid();

  const graph = {
    sequences: [
      {
        id: 'seq-1',
        tracks: [
          {
            clips: [
              { id: 'c1', assetId: assetA, grade: { look: 'warm' } },
              { id: 'c2', assetId: assetB },
              { id: 'c3', assetId: assetC, futureField: { nested: [1, { keep: true }] } },
            ],
          },
        ],
      },
    ],
    unknownTopLevel: { keep: 'me' },
  };
  const envelope = {
    schemaVersion: STUDIO_ENVELOPE_SCHEMA_VERSION,
    engine: STUDIO_ENGINE,
    engineRevision: 'rev-1',
    graph,
  };

  const resolveLikeFl90 = () =>
    vi.fn().mockImplementation((auth: AuthDto, context: { graph: unknown }) => {
      const { references } = extractStudioResourceReferences(context.graph);
      const entries = references
        .filter((reference) => allowed.has(reference.id))
        .map((reference) => ({
          key: studioReferenceKey(reference),
          kind: reference.kind,
          id: reference.id,
          graphPath: reference.graphPath,
          ownerId: allowed.get(reference.id)!.ownerId,
          checksum: null,
          path: allowed.get(reference.id)!.path,
          sourceAccess: allowed.get(reference.id)!.ownerId === auth.user.id ? 'owner' : 'shared',
          grant: 'render',
        }));
      return Promise.resolve({
        manifest: {
          complete: entries.length === references.length,
          refusedCount: references.length - entries.length,
          entries,
        },
        refused: [],
      });
    });

  const operationOf = (overrides: Partial<MediaOperation>): MediaOperation =>
    ({
      id: newUuidV7(),
      ownerId: owner.user.id,
      status: MediaOperationStatus.Preparing,
      attempt: 1,
      maxAttempts: STUDIO_BUNDLE_MAX_ATTEMPTS,
      result: null,
      progress: 0,
      error: null,
      errorCode: null,
      projectId: null,
      ...overrides,
    }) as unknown as MediaOperation;

  const lastResult = () => operations.setBulkResult.mock.calls.at(-1)![2].result as Record<string, unknown>;

  beforeEach(() => {
    StorageCore.setMediaLocation('/media');
    owner = AuthFactory.create();
    fs = memoryFs();
    allowed = new Map();

    operations = {
      create: vi.fn().mockImplementation((row: Record<string, unknown>) =>
        Promise.resolve({
          ...operationOf({}),
          ...row,
          status: MediaOperationStatus.Queued,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      ),
      getByRequestKey: vi.fn().mockResolvedValue(undefined),
      getForOwner: vi.fn(),
      claimNext: vi.fn().mockResolvedValue(undefined),
      recoverExpiredClaims: vi.fn().mockResolvedValue({ requeued: 0, retried: 0, failed: 0, abandonedCancels: 0 }),
      setBulkResult: vi.fn().mockResolvedValue({ status: MediaOperationStatus.Rendering, cancelRequestedAt: null }),
      reportProgress: vi.fn().mockResolvedValue(true),
      beginValidation: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue('retrying'),
      acknowledgeCancel: vi.fn().mockResolvedValue(true),
      listExpiredBundleExports: vi.fn().mockResolvedValue([]),
      setFinishedResult: vi.fn().mockResolvedValue(true),
    };
    projects = {
      getById: vi.fn(),
      getRevision: vi.fn(),
      createWithRevision: vi
        .fn()
        .mockImplementation(() => Promise.resolve({ project: { id: newUuidV7() } as StudioProject, created: true })),
      createUpload: vi.fn(),
      getUpload: vi.fn(),
      deleteUpload: vi.fn(),
      markUploadConsumed: vi.fn(),
      deletePurgeable: vi.fn().mockResolvedValue([]),
      deleteExpiredUploads: vi.fn().mockResolvedValue([]),
    };
    assets = { getByIds: vi.fn().mockResolvedValue([]), getByChecksums: vi.fn().mockResolvedValue([]) };
    resources = { resolveProjectResources: resolveLikeFl90() };
    studio = { authorizeRevision: vi.fn() };
    users = { get: vi.fn().mockResolvedValue({ ...owner.user }) };

    sut = new StudioBundleService(
      getMocks().logger as never,
      operations as unknown as MediaOperationRepository,
      projects as unknown as StudioProjectRepository,
      fs.storage as never,
      fs.crypto as never,
      assets as never,
      users as never,
      resources as unknown as StudioResourceService,
      studio as unknown as StudioProjectService,
    );
  });

  describe('createExport', () => {
    const authorized = (access: 'owner' | 'reviewer', entries: unknown[]) => ({
      access,
      project: { id: newUuidV7(), name: 'Lake trip' },
      revision: { id: newUuidV7(), revision: 4, digest: studioEnvelopeDigest(envelope) },
      manifest: { entries },
    });

    it('freezes only media the session owns and may place in Studio, and retries at most once', async () => {
      studio.authorizeRevision.mockResolvedValue(
        authorized('owner', [
          { key: `library-asset:${assetA}`, kind: 'library-asset', id: assetA, sourceAccess: 'owner', path: '/a' },
          { key: `library-asset:${assetC}`, kind: 'library-asset', id: assetC, sourceAccess: 'shared', path: '/c' },
          { key: 'font:Inter', kind: 'font', id: 'Inter', sourceAccess: 'deployment', path: '/f' },
        ]),
      );

      await sut.createExport(owner, newUuidV7(), { includeMedia: true, requestKey: 'export-1' });

      const created = operations.create.mock.calls[0][0];
      expect(created).toMatchObject({
        kind: MediaOperationKind.StudioBundleExport,
        maxAttempts: STUDIO_BUNDLE_MAX_ATTEMPTS,
        label: 'Lake trip',
      });
      expect(created.snapshot.embed).toEqual([{ key: `library-asset:${assetA}`, kind: 'library-asset', id: assetA }]);
      expect(created.snapshot.requestKey).toBe('export-1');
    });

    it('embeds nothing when media was not asked for', async () => {
      studio.authorizeRevision.mockResolvedValue(
        authorized('owner', [
          { key: `library-asset:${assetA}`, kind: 'library-asset', id: assetA, sourceAccess: 'owner', path: '/a' },
        ]),
      );
      await sut.createExport(owner, newUuidV7(), {});
      expect(operations.create.mock.calls[0][0].snapshot.embed).toEqual([]);
    });

    it('refuses a reviewer and answers a repeated submit with the first job', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized('reviewer', []));
      await expect(sut.createExport(owner, newUuidV7(), {})).rejects.toBeInstanceOf(ForbiddenException);

      const projectId = newUuidV7();
      const first = operationOf({
        kind: MediaOperationKind.StudioBundleExport,
        snapshot: { kind: 'studio-bundle-export', projectId },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      operations.getByRequestKey.mockResolvedValue(first);
      await expect(sut.createExport(owner, projectId, { requestKey: 'k' })).resolves.toMatchObject({ id: first.id });

      // The same key for another project is a client bug, never a replay of somebody else's job.
      await expect(sut.createExport(owner, newUuidV7(), { requestKey: 'k' })).rejects.toBeInstanceOf(ConflictException);
      expect(operations.create).not.toHaveBeenCalled();
    });
  });

  describe('registerUpload', () => {
    it('refuses and deletes a file whose entry names traverse out of the archive', async () => {
      fs.files.set('/uploads/x.zip', buildZip([{ name: '../evil.json', data: Buffer.from('{}') }]));
      const file = { path: '/uploads/x.zip', size: fs.files.get('/uploads/x.zip')!.length, originalname: 'x.zip' };

      await expect(sut.registerUpload(owner, file as Express.Multer.File)).rejects.toBeInstanceOf(BadRequestException);
      expect(fs.files.has('/uploads/x.zip')).toBe(false);
      expect(projects.createUpload).not.toHaveBeenCalled();
    });

    it('refuses a bundle whose project uses media the manifest does not list', async () => {
      const project = serializeStudioBundleProject(envelope);
      const manifest = buildStudioBundleManifest({
        createdAt: new Date('2026-09-22T10:00:00.000Z'),
        producerVersion: '3.0.0',
        name: 'Lake trip',
        revision: 1,
        digest: studioEnvelopeDigest(envelope),
        sourceProjectId: 'p',
        engine: STUDIO_ENGINE,
        engineRevision: 'rev-1',
        project,
        sources: [],
        media: {},
      });
      fs.files.set(
        '/uploads/m.zip',
        buildZip([
          { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
          { name: 'project.json', data: project },
        ]),
      );
      const file = { path: '/uploads/m.zip', size: 10, originalname: 'm.zip' };

      await expect(sut.registerUpload(owner, file as Express.Multer.File)).rejects.toBeInstanceOf(BadRequestException);
      expect(fs.files.has('/uploads/m.zip')).toBe(false);
    });

    it('refuses a ZIP that is not a bundle', async () => {
      fs.files.set('/uploads/y.zip', buildZip([{ name: 'photo.jpg', data: Buffer.from('jpeg') }]));
      const file = { path: '/uploads/y.zip', size: 10, originalname: 'y.zip' };
      await expect(sut.registerUpload(owner, file as Express.Multer.File)).rejects.toBeInstanceOf(BadRequestException);
      expect(fs.files.has('/uploads/y.zip')).toBe(false);
    });
  });

  describe('a bundle round trip', () => {
    it('exports the stored revision with verified copies of owned media, and imports it with relinks', async () => {
      // --- The exporting server -------------------------------------------------------------
      const project = { id: newUuidV7(), ownerId: owner.user.id, name: 'Lake trip', deletedAt: null } as StudioProject;
      const digest = studioEnvelopeDigest(envelope);
      projects.getById.mockResolvedValue(project);
      projects.getRevision.mockResolvedValue({ id: newUuidV7(), revision: 4, digest, envelope });

      fs.files.set('/library/a.mov', Buffer.from('lake video bytes'));
      fs.files.set('/library/b.jpg', Buffer.from('locked photo bytes'));
      fs.files.set('/library/c.jpg', Buffer.from('shared photo bytes'));
      allowed = new Map([
        [assetA, { path: '/library/a.mov', ownerId: owner.user.id }],
        [assetB, { path: '/library/b.jpg', ownerId: owner.user.id }],
        [assetC, { path: '/library/c.jpg', ownerId: newUuid() }],
      ]);
      const row = (id: string, ownerId: string, visibility: AssetVisibility, fileName: string, bytes: string) => ({
        id,
        ownerId,
        visibility,
        originalFileName: fileName,
        checksum: sha256(bytes),
      });
      assets.getByIds.mockResolvedValue([
        row(assetA, owner.user.id, AssetVisibility.Timeline, 'Lake.MOV', 'lake video bytes'),
        row(assetB, owner.user.id, AssetVisibility.Locked, 'secret.jpg', 'locked photo bytes'),
        row(assetC, newUuid(), AssetVisibility.Timeline, 'c.jpg', 'shared photo bytes'),
      ]);

      const exportJob = operationOf({
        kind: MediaOperationKind.StudioBundleExport,
        snapshot: {
          kind: 'studio-bundle-export',
          projectId: project.id,
          revision: 4,
          digest,
          includeMedia: true,
          // Even if a snapshot named them, the Locked and the shared item are never copied.
          embed: [assetA, assetB, assetC].map((id) => ({ key: `library-asset:${id}`, kind: 'library-asset', id })),
          sequenceIds: null,
          requestKey: null,
        },
      } as never);

      await sut.run({ operation: exportJob, claimToken: 'token' });

      expect(operations.fail).not.toHaveBeenCalled();
      expect(operations.complete).toHaveBeenCalledWith(exportJob.id, 'token', { resultAssetId: null });
      const exported = lastResult();
      expect(exported).toMatchObject({ embedded: 1, referenced: 2, fileName: 'Lake-trip.frameleaf-studio.zip' });
      expect(fs.files.has(`${exported.path as string}.partial`)).toBe(false);

      const bundle = fs.files.get(exported.path as string)!;
      const source = {
        size: bundle.length,
        read: (position: number, length: number) => Promise.resolve(bundle.subarray(position, position + length)),
      };
      const directory = await readZipDirectory(source);
      const manifest = JSON.parse(
        (await readZipEntry(source, directory.byName.get(STUDIO_BUNDLE_MANIFEST_ENTRY)!)).toString('utf8'),
      ) as StudioBundleManifest;
      const byId = new Map(manifest.sources.map((item) => [item.id, item]));
      expect(byId.get(assetA)).toMatchObject({
        mode: 'embedded',
        fileName: 'Lake.MOV',
        path: `media/library-asset-${assetA}.mov`,
      });
      expect(byId.get(assetB)).toMatchObject({ mode: 'reference', fileName: null, sha256: null });
      expect(byId.get(assetC)).toMatchObject({ mode: 'reference', fileName: 'c.jpg' });
      expect(manifest.project.digest).toBe(digest);

      // --- The importing server -------------------------------------------------------------
      // A is not there, B has a stand-in the importer chose, C still resolves (shared with them).
      const standIn = newUuid();
      allowed = new Map([
        [standIn, { path: '/library/stand-in.jpg', ownerId: owner.user.id }],
        [assetC, { path: '/library/c.jpg', ownerId: newUuid() }],
      ]);
      fs.files.set('/uploads/lake.zip', bundle);
      const upload = {
        id: newUuidV7(),
        ownerId: owner.user.id,
        path: '/uploads/lake.zip',
        digest: sha256(bundle).toString('hex'),
        expiresAt: new Date(Date.now() + 60_000),
        manifest,
      } as unknown as StudioBundleUpload;
      projects.getUpload.mockResolvedValue(upload);
      operations.setBulkResult.mockClear();

      const importJob = operationOf({
        kind: MediaOperationKind.StudioBundleImport,
        snapshot: {
          kind: 'studio-bundle-import',
          uploadId: upload.id,
          digest: upload.digest,
          name: null,
          mapping: { [`library-asset:${assetB}`]: standIn },
          requestKey: null,
        },
      } as never);

      await sut.run({ operation: importJob, claimToken: 'token-2' });

      expect(operations.fail).not.toHaveBeenCalled();
      const seed = projects.createWithRevision.mock.calls[0][0];
      expect(seed).toMatchObject({ ownerId: owner.user.id, name: 'Lake trip', importOperationId: importJob.id });
      const clips = seed.revision.envelope.graph.sequences[0].tracks[0].clips;
      expect(clips[0].assetId).toBe(assetA);
      expect(clips[1].assetId).toBe(standIn);
      expect(clips[2]).toEqual({ id: 'c3', assetId: assetC, futureField: { nested: [1, { keep: true }] } });
      expect(seed.revision.envelope.graph.unknownTopLevel).toEqual({ keep: 'me' });
      expect(projects.markUploadConsumed).toHaveBeenCalledWith(upload.id);

      expect(lastResult()).toMatchObject({
        relinked: 1,
        kept: 1,
        embeddedVerified: 1,
        missing: [{ key: `library-asset:${assetA}`, fileName: 'Lake.MOV', embedded: true }],
      });
      // Nothing in the library was written to at any point.
      expect(fs.files.get('/library/a.mov')!.toString()).toBe('lake video bytes');
    });
  });

  describe('run', () => {
    it('retries a failed job once through the shared retry, and fails it when the retry is spent', async () => {
      projects.getById.mockResolvedValue(undefined);
      const job = operationOf({
        kind: MediaOperationKind.StudioBundleExport,
        snapshot: { kind: 'studio-bundle-export', projectId: newUuidV7(), revision: 1, digest: 'd', embed: [] },
      } as never);

      await sut.run({ operation: job, claimToken: 'token' });
      // One path for every kind (FL-104): the repository decides between the retry and the failure.
      expect(operations.fail).toHaveBeenCalledTimes(1);
      expect(operations.fail).toHaveBeenCalledWith(job.id, 'token', {
        error: expect.any(String),
        errorCode: 'bundle_project_unavailable',
      });
      // The failure was ours to report, so the partial export is cleared before the retry runs.
      expect(fs.storage.unlink).toHaveBeenCalledWith(expect.stringContaining(`${job.id}.zip.partial`));

      operations.fail.mockResolvedValue('failed');
      await sut.run({ operation: { ...job, attempt: 2, autoRetries: 1 } as MediaOperation, claimToken: 'token' });
      expect(operations.fail).toHaveBeenCalledTimes(2);
      expect(operations.fail).toHaveBeenLastCalledWith(
        job.id,
        'token',
        expect.objectContaining({ errorCode: 'bundle_project_unavailable' }),
      );
    });

    it('leaves the files alone when the claim was already lost', async () => {
      projects.getById.mockResolvedValue(undefined);
      const job = operationOf({
        kind: MediaOperationKind.StudioBundleExport,
        snapshot: { kind: 'studio-bundle-export', projectId: newUuidV7(), revision: 1, digest: 'd', embed: [] },
      } as never);
      operations.fail.mockResolvedValue(false);

      await sut.run({ operation: job, claimToken: 'stale' });

      expect(operations.fail).toHaveBeenCalledWith(
        job.id,
        'stale',
        expect.objectContaining({ errorCode: 'bundle_project_unavailable' }),
      );
      // Another worker may hold the job now and be writing the same file.
      expect(fs.storage.unlink).not.toHaveBeenCalled();
    });

    it('does not recover lapsed claims itself', async () => {
      await sut.drain();

      expect(operations.claimNext).toHaveBeenCalled();
      expect(operations.recoverExpiredClaims).not.toHaveBeenCalled();
    });

    it('refuses an import whose upload changed after it was checked', async () => {
      fs.files.set('/uploads/z.zip', Buffer.from('changed'));
      projects.getUpload.mockResolvedValue({
        id: newUuidV7(),
        path: '/uploads/z.zip',
        digest: 'a'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const job = operationOf({
        kind: MediaOperationKind.StudioBundleImport,
        snapshot: { kind: 'studio-bundle-import', uploadId: newUuidV7(), digest: 'a'.repeat(64), mapping: {} },
      } as never);

      await sut.run({ operation: job, claimToken: 'token' });
      expect(operations.fail).toHaveBeenCalledWith(
        job.id,
        'token',
        expect.objectContaining({ errorCode: 'bundle_upload_changed' }),
      );
      expect(projects.createWithRevision).not.toHaveBeenCalled();
    });
  });

  describe('createImport', () => {
    const upload = () =>
      ({
        id: newUuidV7(),
        ownerId: owner.user.id,
        path: '/uploads/u.zip',
        digest: 'f'.repeat(64),
        expiresAt: new Date(Date.now() + 60_000),
        manifest: {
          format: 'frameleaf-studio-bundle',
          schemaVersion: 1,
          createdAt: '2026-09-22T10:00:00.000Z',
          producer: { product: 'frameleaf', version: '3.0.0' },
          project: { name: 'Lake trip', revision: 4, digest: 'e'.repeat(64), sourceProjectId: 'p' },
          engine: { engine: STUDIO_ENGINE, engineRevision: 'rev-1' },
          files: { 'project.json': { sha256: 'e'.repeat(64), bytes: 10 } },
          sources: [
            {
              key: `library-asset:${assetA}`,
              kind: 'library-asset',
              id: assetA,
              mode: 'reference',
              path: null,
              sha256: null,
              bytes: null,
              fileName: null,
              contentType: null,
            },
          ],
        },
      }) as unknown as StudioBundleUpload;

    it('refuses a stand-in that FL-90 does not authorize for this session', async () => {
      projects.getUpload.mockResolvedValue(upload());
      const lockedItem = newUuid();
      await expect(
        sut.createImport(owner, { uploadId: newUuidV7(), mapping: { [`library-asset:${assetA}`]: lockedItem } }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('refuses a mapping for a source the bundle does not have, and an unknown upload', async () => {
      projects.getUpload.mockResolvedValue(upload());
      await expect(
        sut.createImport(owner, { uploadId: newUuidV7(), mapping: { 'library-asset:nobody': newUuid() } }),
      ).rejects.toBeInstanceOf(BadRequestException);

      projects.getUpload.mockResolvedValue(undefined);
      await expect(sut.createImport(owner, { uploadId: newUuidV7() })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('queues an import with an authorized stand-in and one automatic retry', async () => {
      const item = upload();
      projects.getUpload.mockResolvedValue(item);
      const standIn = newUuid();
      allowed.set(standIn, { path: '/s', ownerId: owner.user.id });

      await sut.createImport(owner, { uploadId: item.id, mapping: { [`library-asset:${assetA}`]: standIn } });
      expect(operations.create.mock.calls[0][0]).toMatchObject({
        kind: MediaOperationKind.StudioBundleImport,
        label: 'Lake trip',
        maxAttempts: STUDIO_BUNDLE_MAX_ATTEMPTS,
        snapshot: { uploadId: item.id, digest: item.digest, mapping: { [`library-asset:${assetA}`]: standIn } },
      });
    });
  });

  describe('downloadExport', () => {
    it('serves only a finished, unexpired export of the caller', async () => {
      fs.files.set('/exports/b.zip', Buffer.from('zip'));
      const finished = operationOf({
        kind: MediaOperationKind.StudioBundleExport,
        status: MediaOperationStatus.Completed,
        result: {
          path: '/exports/b.zip',
          fileName: 'Lake-trip.frameleaf-studio.zip',
          digest: 'd',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
      operations.getForOwner.mockResolvedValue(finished);
      await expect(sut.downloadExport(owner, finished.id)).resolves.toMatchObject({ type: 'application/zip' });

      operations.getForOwner.mockResolvedValue({
        ...finished,
        result: { ...(finished.result as object), expiresAt: new Date(Date.now() - 1000).toISOString() },
      });
      await expect(sut.downloadExport(owner, finished.id)).rejects.toBeInstanceOf(NotFoundException);

      operations.getForOwner.mockResolvedValue(undefined);
      await expect(sut.downloadExport(owner, finished.id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getOperation', () => {
    it('reports a job waiting for its automatic retry the way Activity does', async () => {
      const retryAt = new Date(Date.now() + 30_000);
      const waiting = operationOf({
        kind: MediaOperationKind.StudioBundleExport,
        status: MediaOperationStatus.Queued,
        attempt: 1,
        autoRetries: 1,
        retryAt,
        error: 'disk full',
        errorCode: 'bundle_write_failed',
        projectId: newUuidV7(),
      });
      operations.getForOwner.mockResolvedValue(waiting);

      await expect(sut.getOperation(owner, waiting.id)).resolves.toMatchObject({
        operationId: waiting.id,
        status: MediaOperationStatus.Queued,
        autoRetries: 1,
        retryAt: retryAt.toISOString(),
        export: null,
      });
    });

    it('reports no retry state for a job that never failed', async () => {
      const fresh = operationOf({ kind: MediaOperationKind.StudioBundleImport, status: MediaOperationStatus.Queued });
      operations.getForOwner.mockResolvedValue(fresh);

      await expect(sut.getOperation(owner, fresh.id)).resolves.toMatchObject({ autoRetries: 0, retryAt: null });
    });
  });

  describe('sweep', () => {
    it('purges expired trash, uploads and export files, and never touches library media', async () => {
      fs.files.set('/uploads/old.zip', Buffer.from('old'));
      fs.files.set('/exports/old.zip', Buffer.from('old'));
      fs.files.set('/library/a.mov', Buffer.from('keep'));
      projects.deletePurgeable.mockResolvedValue([newUuidV7()]);
      projects.deleteExpiredUploads.mockResolvedValue([{ id: newUuidV7(), path: '/uploads/old.zip' }]);
      const expired = {
        id: newUuidV7(),
        ownerId: owner.user.id,
        result: { path: '/exports/old.zip', digest: 'd', expiresAt: '2026-01-01T00:00:00.000Z' },
      };
      operations.listExpiredBundleExports.mockResolvedValue([expired]);

      const now = new Date('2026-09-22T12:00:00.000Z');
      await sut.sweep(now);

      expect(fs.files.has('/uploads/old.zip')).toBe(false);
      expect(fs.files.has('/exports/old.zip')).toBe(false);
      expect(fs.files.has('/library/a.mov')).toBe(true);
      expect(operations.setFinishedResult).toHaveBeenCalledWith(expired.id, {
        ...expired.result,
        expiredAt: now.toISOString(),
      });
    });
  });
});
