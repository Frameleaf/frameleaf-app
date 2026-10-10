import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
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
import { STUDIO_BUNDLE_DOCUMENT_RESERVATION } from 'src/repositories/studio-storage-admission.js';
import { StudioBundleService } from 'src/services/studio-bundle.service.js';
import { StudioProjectImportService, studioImportProjectFolder } from 'src/services/studio-project-import.service.js';
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
import { StudioResourceKind, extractStudioResourceReferences, studioReferenceKey } from 'src/utils/studio-resources.js';
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
    readFile: vi.fn((path: string, options?: { buffer: Buffer; position: number; length: number }) => {
      const bytes = read(path);
      if (!options) {
        return Promise.resolve(bytes);
      }
      bytes.copy(options.buffer, 0, options.position, options.position + options.length);
      return Promise.resolve(options.buffer);
    }),
    checkFileExists: vi.fn((path: string) => Promise.resolve(files.has(path))),
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
  let studio: {
    authorizeRevision: ReturnType<typeof vi.fn>;
    hiddenOwnedItems: ReturnType<typeof vi.fn>;
    requireOwnedProject: ReturnType<typeof vi.fn>;
  };
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
      listUnreleasedBundleExports: vi.fn().mockResolvedValue([]),
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
      listGeneratedResources: vi.fn().mockResolvedValue([]),
      listImportDeclarations: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      getRevision: vi.fn(),
      createWithRevision: vi
        .fn()
        .mockImplementation(() => Promise.resolve({ project: { id: newUuidV7() } as StudioProject, created: true })),
      getByImportOperation: vi.fn().mockResolvedValue(undefined),
      createUpload: vi.fn().mockResolvedValue({ id: newUuidV7() }),
      finalizeUpload: vi.fn(),
      getUpload: vi.fn(),
      deleteUpload: vi.fn(),
      markUploadConsumed: vi.fn(),
      deletePurgeable: vi.fn().mockResolvedValue([]),
      listExpiredUploads: vi.fn().mockResolvedValue([]),
    };
    assets = { getByIds: vi.fn().mockResolvedValue([]), getByChecksums: vi.fn().mockResolvedValue([]) };
    resources = { resolveProjectResources: resolveLikeFl90() };
    studio = {
      authorizeRevision: vi.fn(),
      hiddenOwnedItems: vi.fn().mockResolvedValue(new Set()),
      // the owner passes the shared owner check unless a test says otherwise
      requireOwnedProject: vi.fn().mockResolvedValue({}),
    };
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
      { sweep: vi.fn().mockResolvedValue(undefined) } as never,
    );
  });

  describe('createExport', () => {
    const authorized = (access: 'owner' | 'reviewer', entries: unknown[]) => ({
      access,
      project: { id: newUuidV7(), name: 'Lake trip' },
      revision: { id: newUuidV7(), revision: 4, digest: studioEnvelopeDigest(envelope) },
      envelope,
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

    it('refuses a generated-media bundle before creating an unusable job', async () => {
      studio.authorizeRevision.mockResolvedValue({
        ...authorized('owner', []),
        envelope: { ...envelope, graph: { clips: [{ generatedId: 'reverse' }] } },
      });
      await expect(sut.createExport(owner, newUuidV7(), { includeMedia: true })).rejects.toThrow(
        'Bundles containing generated media are not supported yet',
      );
      expect(operations.create).not.toHaveBeenCalled();
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

    it('freezes a sequence subset and copies only the media the chosen sequences use', async () => {
      const twoSequences = {
        ...envelope,
        graph: {
          sequences: [
            { id: 'seq-1', tracks: [{ clips: [{ assetId: assetA }] }] },
            { id: 'seq-2', tracks: [{ clips: [{ assetId: assetB }] }] },
          ],
        },
      };
      studio.authorizeRevision.mockResolvedValue({
        ...authorized('owner', [
          { key: `library-asset:${assetA}`, kind: 'library-asset', id: assetA, sourceAccess: 'owner', path: '/a' },
          { key: `library-asset:${assetB}`, kind: 'library-asset', id: assetB, sourceAccess: 'owner', path: '/b' },
        ]),
        envelope: twoSequences,
      });

      await sut.createExport(owner, newUuidV7(), { includeMedia: true, sequenceIds: ['seq-2'] });
      const created = operations.create.mock.calls[0][0];
      expect(created.snapshot.sequenceIds).toEqual(['seq-2']);
      expect(created.snapshot.embed).toEqual([{ key: `library-asset:${assetB}`, kind: 'library-asset', id: assetB }]);

      // Every sequence is the whole project, which is exported as one.
      await sut.createExport(owner, newUuidV7(), { sequenceIds: ['seq-1', 'seq-2'] });
      expect(operations.create.mock.calls[1][0].snapshot.sequenceIds).toBeNull();

      // A sequence the revision does not define is refused before anything is queued.
      await expect(sut.createExport(owner, newUuidV7(), { sequenceIds: ['seq-9'] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(operations.create).toHaveBeenCalledTimes(2);
    });

    it('refuses a reviewer before resolving any source for them (FL-280)', async () => {
      studio.requireOwnedProject.mockRejectedValue(
        new ForbiddenException('Only the owner can export a Studio project'),
      );
      await expect(sut.createExport(owner, newUuidV7(), {})).rejects.toBeInstanceOf(ForbiddenException);
      expect(studio.authorizeRevision).not.toHaveBeenCalled();
    });

    it('refuses a reviewer and answers a repeated submit with the first job', async () => {
      studio.authorizeRevision.mockResolvedValue(authorized('reviewer', []));
      await expect(sut.createExport(owner, newUuidV7(), {})).rejects.toBeInstanceOf(ForbiddenException);

      const projectId = newUuidV7();
      const first = operationOf({
        kind: MediaOperationKind.StudioBundleExport,
        snapshot: { kind: 'studio-bundle-export', projectId, includeMedia: true, sequenceIds: ['seq-1'] },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      operations.getByRequestKey.mockResolvedValue(first);
      await expect(
        sut.createExport(owner, projectId, { includeMedia: true, sequenceIds: ['seq-1'], requestKey: 'k' }),
      ).resolves.toMatchObject({ id: first.id });
      await expect(
        sut.createExport(owner, projectId, { includeMedia: true, sequenceIds: ['seq-1', 'seq-1'], requestKey: 'k' }),
      ).resolves.toMatchObject({ id: first.id });

      // The same key for another project is a client bug, never a replay of somebody else's job.
      await expect(sut.createExport(owner, newUuidV7(), { requestKey: 'k' })).rejects.toBeInstanceOf(ConflictException);
      await expect(sut.createExport(owner, projectId, { requestKey: 'k' })).rejects.toBeInstanceOf(ConflictException);
      await expect(
        sut.createExport(owner, projectId, { includeMedia: true, sequenceIds: ['seq-2'], requestKey: 'k' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('replays all-sequence and reordered subset requests by their original selection', async () => {
      const projectId = newUuidV7();
      const fullEnvelope = {
        ...envelope,
        graph: { sequences: ['seq-1', 'seq-2', 'seq-3'].map((id) => ({ id, tracks: [] })) },
      };
      const access = authorized('owner', []);
      studio.authorizeRevision.mockResolvedValue({
        ...access,
        project: { id: projectId, name: 'Lake trip' },
        revision: { ...access.revision, digest: studioEnvelopeDigest(fullEnvelope) },
        envelope: fullEnvelope,
      });

      const whole = await sut.createExport(owner, projectId, {
        sequenceIds: ['seq-3', 'seq-1', 'seq-2'],
        requestKey: 'whole',
      });
      const wholeRow = await operations.create.mock.results[0].value;
      expect(wholeRow.snapshot.sequenceIds).toBeNull();
      expect(wholeRow.snapshot.requestedSequenceIds).toEqual(['seq-1', 'seq-2', 'seq-3']);
      operations.getByRequestKey.mockResolvedValue(wholeRow);
      await expect(
        sut.createExport(owner, projectId, { sequenceIds: ['seq-2', 'seq-3', 'seq-1'], requestKey: 'whole' }),
      ).resolves.toMatchObject({ id: whole.id });

      // Jobs written before this fix lack requestedSequenceIds; their stored revision disambiguates a whole-project choice.
      const legacySnapshot = { ...wholeRow.snapshot };
      delete legacySnapshot.requestedSequenceIds;
      projects.getRevision.mockResolvedValue({ digest: wholeRow.snapshot.digest, envelope: fullEnvelope });
      operations.getByRequestKey.mockResolvedValue({ ...wholeRow, snapshot: legacySnapshot });
      await expect(
        sut.createExport(owner, projectId, { sequenceIds: ['seq-1', 'seq-2', 'seq-3'], requestKey: 'whole' }),
      ).resolves.toMatchObject({ id: whole.id });
      await expect(
        sut.createExport(owner, projectId, { sequenceIds: ['seq-1'], requestKey: 'whole' }),
      ).rejects.toBeInstanceOf(ConflictException);

      projects.getRevision.mockResolvedValue(undefined);
      await expect(
        sut.createExport(owner, projectId, { sequenceIds: ['seq-1', 'seq-2', 'seq-3'], requestKey: 'whole' }),
      ).rejects.toBeInstanceOf(ConflictException);
      operations.getByRequestKey.mockResolvedValue({ ...wholeRow, snapshot: { ...legacySnapshot, digest: undefined } });
      await expect(
        sut.createExport(owner, projectId, { sequenceIds: ['seq-1', 'seq-2', 'seq-3'], requestKey: 'whole' }),
      ).rejects.toBeInstanceOf(ConflictException);

      operations.getByRequestKey.mockResolvedValue(undefined);
      const subset = await sut.createExport(owner, projectId, {
        sequenceIds: ['seq-2', 'seq-1'],
        requestKey: 'subset',
      });
      const subsetRow = await operations.create.mock.results[1].value;
      expect(subsetRow.snapshot.sequenceIds).toEqual(['seq-2', 'seq-1']);
      operations.getByRequestKey.mockResolvedValue(subsetRow);
      await expect(
        sut.createExport(owner, projectId, { sequenceIds: ['seq-1', 'seq-2'], requestKey: 'subset' }),
      ).resolves.toMatchObject({ id: subset.id });
      expect(operations.create).toHaveBeenCalledTimes(2);
    });
  });

  describe('upload admission', () => {
    it('reserves bytes before receiving a body and refuses invalid sizes', async () => {
      const reservation = { id: newUuidV7(), path: '/private/reserved.zip' };
      projects.createUpload.mockResolvedValue(reservation);
      await expect(sut.reserveUpload(owner, 123)).resolves.toEqual(reservation);
      expect(projects.createUpload).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: owner.user.id, sizeBytes: 123, digest: '' }),
      );
      await expect(sut.reserveUpload(owner, -1)).rejects.toThrow('Invalid');
      expect(projects.createUpload).toHaveBeenCalledTimes(1);
    });

    it('retains the charged upload row when file cleanup fails', async () => {
      projects.getUpload.mockResolvedValue({ id: 'upload', path: '/private/failed.zip' });
      fs.storage.unlink.mockRejectedValueOnce(new Error('disk unavailable'));
      await expect(sut.abortUpload(owner, 'upload')).rejects.toThrow('disk unavailable');
      expect(projects.deleteUpload).not.toHaveBeenCalled();
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

  describe('revealed items (FL-195 follow-up)', () => {
    const lockedExport = () => {
      const project = { id: newUuidV7(), ownerId: owner.user.id, name: 'Lake trip', deletedAt: null } as StudioProject;
      const digest = studioEnvelopeDigest(envelope);
      projects.getById.mockResolvedValue(project);
      projects.getRevision.mockResolvedValue({ id: newUuidV7(), revision: 4, digest, envelope });
      fs.files.set('/library/b.jpg', Buffer.from('locked photo bytes'));
      allowed = new Map([[assetB, { path: '/library/b.jpg', ownerId: owner.user.id }]]);
      assets.getByIds.mockResolvedValue([
        {
          id: assetB,
          ownerId: owner.user.id,
          visibility: AssetVisibility.Locked,
          originalFileName: 'secret.jpg',
          checksum: sha256('locked photo bytes'),
        },
      ]);
      return operationOf({
        kind: MediaOperationKind.StudioBundleExport,
        snapshot: {
          kind: 'studio-bundle-export',
          projectId: project.id,
          revision: 4,
          digest,
          includeMedia: true,
          // what the owner's unlocked session authorized at submit
          embed: [{ key: `library-asset:${assetB}`, kind: 'library-asset', id: assetB }],
          sequenceIds: null,
          requestKey: null,
        },
      } as never);
    };

    it("embeds the owner's revealed item when their unlocked session asked for it", async () => {
      await sut.run({ operation: lockedExport(), claimToken: 'token' });

      expect(operations.fail).not.toHaveBeenCalled();
      // the other two sources of the stored graph are not named by this snapshot, so they stay references
      expect(lastResult()).toMatchObject({ embedded: 1, referenced: 2 });
    });

    it('hides that bundle from a session that may not see the item, and shows it to one that may', async () => {
      const job = lockedExport();
      operations.getForOwner.mockResolvedValue({ ...job, status: MediaOperationStatus.Completed, result: null });

      studio.hiddenOwnedItems.mockResolvedValue(new Set([assetB]));
      await expect(sut.getOperation(owner, job.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.downloadExport(owner, job.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(studio.hiddenOwnedItems).toHaveBeenCalledWith(owner, [assetB]);

      studio.hiddenOwnedItems.mockResolvedValue(new Set());
      await expect(sut.getOperation(owner, job.id)).resolves.toMatchObject({ operationId: job.id });
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
          // A locked session's snapshot never names the Locked item (FL-195), and a shared item is never
          // copied even when named.
          embed: [assetA, assetC].map((id) => ({ key: `library-asset:${id}`, kind: 'library-asset', id })),
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

      // Access can change after submission. A retry may recover, but it must not quietly create
      // a project with the explicitly chosen source missing.
      allowed.delete(standIn);
      projects.createWithRevision.mockClear();
      const revokedJob = operationOf({ ...importJob, id: newUuidV7() });
      await sut.run({ operation: revokedJob, claimToken: 'token-revoked' });
      expect(operations.fail).toHaveBeenCalledWith(
        revokedJob.id,
        'token-revoked',
        expect.objectContaining({ errorCode: 'bundle_relink_unavailable' }),
      );
      expect(projects.createWithRevision).not.toHaveBeenCalled();

      // The first attempt can commit the project and then fail before completing the operation.
      // A retry must recover that project even if its selected relink target was since revoked.
      allowed.set(standIn, { path: '/library/stand-in.jpg', ownerId: owner.user.id });
      const recoveredProject = {
        id: newUuidV7(),
        ownerId: owner.user.id,
        importedFromDigest: upload.digest,
      } as StudioProject;
      projects.createWithRevision.mockResolvedValueOnce({ project: recoveredProject, created: true });
      projects.markUploadConsumed.mockRejectedValueOnce(new Error('write interrupted'));
      operations.setBulkResult.mockClear();
      const interruptedJob = operationOf({ ...importJob, id: newUuidV7() });
      await sut.run({ operation: interruptedJob, claimToken: 'token-interrupted' });
      const prepared = operations.setBulkResult.mock.calls.find(
        (call) => call[2].result?.projectId === null && call[2].result?.relinked === 1,
      )?.[2].result;
      expect(prepared).toBeDefined();

      allowed.delete(standIn);
      projects.getByImportOperation.mockResolvedValueOnce(recoveredProject);
      projects.createWithRevision.mockClear();
      resources.resolveProjectResources.mockClear();
      operations.fail.mockClear();
      operations.setBulkResult.mockClear();
      await sut.run({ operation: { ...interruptedJob, result: prepared }, claimToken: 'token-retry' });
      expect(operations.fail).not.toHaveBeenCalled();
      expect(projects.createWithRevision).not.toHaveBeenCalled();
      expect(resources.resolveProjectResources).not.toHaveBeenCalled();
      expect(operations.complete).toHaveBeenCalledWith(interruptedJob.id, 'token-retry', { resultAssetId: null });
      expect(lastResult()).toMatchObject({ projectId: recoveredProject.id, relinked: 1, kept: 1 });
    });
  });

  describe('a partial bundle round trip', () => {
    /** A Freecut project: Main, two standalone sequences, and a compound clip nested in one of them. */
    const freecutEnvelope = {
      ...envelope,
      graph: {
        id: 'fc-1',
        name: 'Lake trip',
        timeline: {
          tracks: [{ id: 't1' }],
          items: [{ id: 'm1', type: 'video', mediaId: assetA }],
          topLevelSequenceIds: ['seq-b', 'seq-c'],
          compositions: [
            {
              id: 'seq-b',
              tracks: [],
              items: [
                { id: 'b1', type: 'video', mediaId: assetB },
                { id: 'b2', type: 'composition', compositionId: 'comp-n' },
              ],
            },
            { id: 'comp-n', tracks: [], items: [{ id: 'n1', type: 'image', mediaId: assetC, future: { keep: 1 } }] },
            { id: 'seq-c', tracks: [], items: [{ id: 'c1', type: 'video', mediaId: assetA }] },
          ],
        },
      },
    };

    const readManifest = async (bundle: Buffer) => {
      const source = {
        size: bundle.length,
        read: (position: number, length: number) => Promise.resolve(bundle.subarray(position, position + length)),
      };
      const directory = await readZipDirectory(source);
      const read = async (name: string) =>
        JSON.parse((await readZipEntry(source, directory.byName.get(name)!)).toString('utf8'));
      return {
        manifest: (await read(STUDIO_BUNDLE_MANIFEST_ENTRY)) as StudioBundleManifest,
        project: (await read('project.json')) as typeof freecutEnvelope,
      };
    };

    const importBundle = async (bundle: Buffer, manifest: StudioBundleManifest) => {
      fs.files.set('/uploads/partial.zip', bundle);
      const upload = {
        id: newUuidV7(),
        ownerId: owner.user.id,
        path: '/uploads/partial.zip',
        digest: sha256(bundle).toString('hex'),
        expiresAt: new Date(Date.now() + 60_000),
        manifest,
      } as unknown as StudioBundleUpload;
      projects.getUpload.mockResolvedValue(upload);
      const job = operationOf({
        kind: MediaOperationKind.StudioBundleImport,
        snapshot: {
          kind: 'studio-bundle-import',
          uploadId: upload.id,
          digest: upload.digest,
          name: null,
          mapping: {},
          requestKey: null,
        },
      } as never);
      await sut.run({ operation: job, claimToken: 'import-token' });
      return job;
    };

    it('exports only the chosen sequence with what it nests, and imports it with every reference intact', async () => {
      const project = { id: newUuidV7(), ownerId: owner.user.id, name: 'Lake trip', deletedAt: null } as StudioProject;
      const digest = studioEnvelopeDigest(freecutEnvelope);
      projects.getById.mockResolvedValue(project);
      projects.getRevision.mockResolvedValue({ id: newUuidV7(), revision: 4, digest, envelope: freecutEnvelope });
      fs.files.set('/library/b.mov', Buffer.from('b bytes'));
      allowed = new Map([
        [assetA, { path: '/library/a.mov', ownerId: owner.user.id }],
        [assetB, { path: '/library/b.mov', ownerId: owner.user.id }],
        [assetC, { path: '/library/c.jpg', ownerId: newUuid() }],
      ]);
      assets.getByIds.mockResolvedValue(
        [assetA, assetB, assetC].map((id) => ({
          id,
          ownerId: allowed.get(id)!.ownerId,
          visibility: AssetVisibility.Timeline,
          originalFileName: `${id}.mov`,
          checksum: sha256(id),
        })),
      );

      const exportJob = operationOf({
        kind: MediaOperationKind.StudioBundleExport,
        snapshot: {
          kind: 'studio-bundle-export',
          projectId: project.id,
          revision: 4,
          digest,
          includeMedia: true,
          embed: [{ key: `library-asset:${assetB}`, kind: 'library-asset', id: assetB }],
          sequenceIds: ['seq-b'],
          requestKey: null,
        },
      } as never);
      await sut.run({ operation: exportJob, claimToken: 'token' });

      expect(operations.fail).not.toHaveBeenCalled();
      const exported = lastResult();
      expect(exported).toMatchObject({ embedded: 1, referenced: 1 });
      const bundle = fs.files.get(exported.path as string)!;
      const { manifest, project: document } = await readManifest(bundle);

      // The document carries seq-b and the compound clip it nests, nothing of Main or seq-c.
      const timeline = document.graph.timeline;
      expect(timeline.compositions.map((composition) => composition.id)).toEqual(['seq-b', 'comp-n']);
      expect(timeline.items).toEqual([]);
      expect(timeline.topLevelSequenceIds).toEqual(['seq-b']);
      expect(timeline.compositions[1].items[0]).toMatchObject({ future: { keep: 1 } });
      expect(manifest.project.sequenceIds).toEqual(['seq-b', 'comp-n']);
      // It is not the stored revision, so it is named by its own digest.
      expect(manifest.project.digest).toBe(studioEnvelopeDigest(document));
      expect(manifest.project.digest).not.toBe(digest);
      // Only what the kept sequences use is listed: B copied, C (shared) referenced, A not at all.
      expect(manifest.sources.map((item) => [item.id, item.mode])).toEqual(
        expect.arrayContaining([
          [assetB, 'embedded'],
          [assetC, 'reference'],
        ]),
      );
      expect(manifest.sources).toHaveLength(2);

      // On the importing server only the shared item resolves; the copied one has nothing to relink to.
      allowed = new Map([[assetC, { path: '/library/c.jpg', ownerId: newUuid() }]]);
      operations.setBulkResult.mockClear();
      await importBundle(bundle, manifest);

      expect(operations.fail).not.toHaveBeenCalled();
      const seed = projects.createWithRevision.mock.calls[0][0];
      expect(seed.revision.envelope.graph).toEqual(document.graph);
      expect(seed.revision.digest).toBe(manifest.project.digest);
      expect(lastResult()).toMatchObject({ kept: 1, embeddedVerified: 1, missing: [{ id: assetB, embedded: true }] });
    });

    it('refuses a partial bundle that points at a sequence it does not carry', async () => {
      const cut = {
        ...freecutEnvelope,
        graph: {
          ...freecutEnvelope.graph,
          timeline: {
            ...freecutEnvelope.graph.timeline,
            items: [],
            compositions: [freecutEnvelope.graph.timeline.compositions[0]],
            topLevelSequenceIds: ['seq-b'],
          },
        },
      };
      const project = serializeStudioBundleProject(cut);
      const manifest = buildStudioBundleManifest({
        createdAt: new Date('2026-09-22T10:00:00.000Z'),
        producerVersion: '3.0.0',
        name: 'Lake trip',
        revision: 4,
        digest: studioEnvelopeDigest(cut),
        sourceProjectId: 'p',
        sequenceIds: ['seq-b'],
        engine: STUDIO_ENGINE,
        engineRevision: 'rev-1',
        project,
        sources: [
          {
            key: `library-asset:${assetB}`,
            kind: StudioResourceKind.LibraryAsset,
            id: assetB,
            mode: 'reference',
            path: null,
            sha256: null,
            bytes: null,
            fileName: null,
            contentType: null,
          },
        ],
        media: {},
      });
      const bundle = buildZip([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        { name: 'project.json', data: project },
      ]);

      const job = await importBundle(bundle, manifest);
      expect(operations.fail).toHaveBeenCalledWith(
        job.id,
        'import-token',
        expect.objectContaining({ errorCode: 'bundle_project_invalid', error: expect.stringContaining('comp-n') }),
      );
      expect(projects.createWithRevision).not.toHaveBeenCalled();
    });
  });

  describe('files kept with the project (FL-105)', () => {
    const voice = newUuid();
    const subs = newUuid();
    const lut = newUuid();
    const logo = newUuid();
    const unplaced = newUuid();

    const wav = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVEfmt '), Buffer.alloc(64, 7)]);
    const srt = Buffer.from('1\n00:00:01,000 --> 00:00:02,500\nHello\n');
    const cube = Buffer.from(`TITLE "Warm"\nLUT_3D_SIZE 2\n${'0.5 0.25 1.0\n'.repeat(8)}`);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>');
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

    const kept = [
      { id: voice, bytes: wav, contentType: 'audio/wav', extension: '.wav', fileName: 'Voiceover 1.webm' },
      { id: subs, bytes: srt, contentType: 'application/x-subrip', extension: '.srt', fileName: 'subs.srt' },
      { id: lut, bytes: cube, contentType: 'text/x-cube-lut', extension: '.cube', fileName: 'Warm.cube' },
      { id: logo, bytes: svg, contentType: 'image/svg+xml', extension: '.svg', fileName: 'logo.svg' },
      { id: unplaced, bytes: png, contentType: 'image/png', extension: '.png', fileName: 'spare.png' },
    ];

    /** A clip places a kept file by its media id; captions and a LUT name theirs by their own keys. */
    const importsEnvelope = {
      ...envelope,
      graph: {
        sequences: [
          {
            id: 'seq-1',
            tracks: [
              {
                clips: [
                  { id: 'c1', assetId: assetA },
                  { id: 'c2', mediaId: voice },
                  {
                    id: 'c3',
                    importId: logo,
                    captionsImportId: subs,
                    // Edits to the graphic are part of the clip, in whatever shape the editor writes them.
                    graphicEdits: { colors: { '#ff0000': '#00ff88' }, theme: 'dark', text: { title: 'Lake' } },
                  },
                ],
              },
            ],
          },
          {
            id: 'seq-2',
            tracks: [{ clips: [{ id: 'c4', mediaId: voice, grade: { lutId: lut, lutSource: 'import' } }] }],
          },
        ],
      },
    };

    let sourceProject: StudioProject;
    let registered: Array<Record<string, unknown>>;

    const rowsOf = (projectId: string) =>
      kept.map((item) => ({
        projectId,
        id: item.id,
        ownerId: owner.user.id,
        contentType: item.contentType,
        checksum: sha256(item.bytes).toString('hex'),
        sizeBytes: item.bytes.length,
        path: join(studioImportProjectFolder(owner.user.id, projectId), `${item.id}${item.extension}`),
        fileName: item.fileName,
        externalReferences: item.contentType === 'image/svg+xml' ? 0 : null,
        createdAt: new Date(0),
      }));

    const readBundleManifest = async (bundle: Buffer) => {
      const source = {
        size: bundle.length,
        read: (position: number, length: number) => Promise.resolve(bundle.subarray(position, position + length)),
      };
      const directory = await readZipDirectory(source);
      return JSON.parse(
        (await readZipEntry(source, directory.byName.get(STUDIO_BUNDLE_MANIFEST_ENTRY)!)).toString('utf8'),
      ) as StudioBundleManifest;
    };

    const exportJobOf = (includeMedia: boolean, imports: string[]) =>
      operationOf({
        kind: MediaOperationKind.StudioBundleExport,
        snapshot: {
          kind: 'studio-bundle-export',
          projectId: sourceProject.id,
          revision: 4,
          digest: studioEnvelopeDigest(importsEnvelope),
          includeMedia,
          embed: [],
          imports,
          sequenceIds: null,
          requestKey: null,
        },
      } as never);

    const uploadOf = (bundle: Buffer, manifest: StudioBundleManifest) => {
      fs.files.set('/uploads/kept.zip', bundle);
      const upload = {
        id: newUuidV7(),
        ownerId: owner.user.id,
        path: '/uploads/kept.zip',
        digest: sha256(bundle).toString('hex'),
        expiresAt: new Date(Date.now() + 60_000),
        manifest,
      } as unknown as StudioBundleUpload;
      projects.getUpload.mockResolvedValue(upload);
      return upload;
    };

    const importJobOf = (upload: StudioBundleUpload) =>
      operationOf({
        kind: MediaOperationKind.StudioBundleImport,
        snapshot: {
          kind: 'studio-bundle-import',
          uploadId: upload.id,
          digest: upload.digest,
          name: null,
          mapping: {},
          requestKey: null,
        },
      } as never);

    /** A bundle written by hand, as a file from somewhere else would be. */
    const handMade = (
      items: Array<{
        id: string;
        bytes?: Buffer;
        fileName: string | null;
        contentType: string | null;
        sha256?: string;
      }>,
    ) => {
      const document = { ...envelope, graph: { sequences: [{ id: 'seq-1', tracks: [] }] } };
      const project = serializeStudioBundleProject(document);
      const media: Record<string, { sha256: string; bytes: number }> = {};
      const entries: Array<{ name: string; data: Buffer }> = [];
      const sources = items.map((item, index) => {
        const path = item.bytes ? `media/project-import-${index}` : null;
        if (item.bytes && path) {
          media[path] = { sha256: item.sha256 ?? sha256(item.bytes).toString('hex'), bytes: item.bytes.length };
          entries.push({ name: path, data: item.bytes });
        }
        return {
          key: `project-import:${item.id}`,
          kind: StudioResourceKind.ProjectImport,
          id: item.id,
          mode: item.bytes ? ('embedded' as const) : ('reference' as const),
          path,
          sha256: null,
          bytes: item.bytes?.length ?? null,
          fileName: item.fileName,
          contentType: item.contentType,
        };
      });
      const manifest = buildStudioBundleManifest({
        createdAt: new Date('2026-10-01T10:00:00.000Z'),
        producerVersion: '3.0.0',
        name: 'From elsewhere',
        revision: 1,
        digest: studioEnvelopeDigest(document),
        sourceProjectId: 'p',
        engine: STUDIO_ENGINE,
        engineRevision: 'rev-1',
        project,
        sources,
        media,
      });
      const bundle = buildZip([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        { name: 'project.json', data: project },
        ...entries,
      ]);
      return { bundle, manifest };
    };

    beforeEach(() => {
      sourceProject = { id: newUuidV7(), ownerId: owner.user.id, name: 'Lake trip', deletedAt: null } as StudioProject;
      registered = [];
      projects.getById.mockResolvedValue(sourceProject);
      projects.getRevision.mockResolvedValue({
        id: newUuidV7(),
        revision: 4,
        digest: studioEnvelopeDigest(importsEnvelope),
        envelope: importsEnvelope,
      });
      const rows = rowsOf(sourceProject.id);
      for (const [index, row] of rows.entries()) {
        fs.files.set(row.path, kept[index].bytes);
      }
      projects.listImports = vi.fn().mockResolvedValue(rows);
      projects.listImportDeclarations.mockResolvedValue(rows.map(({ id, sizeBytes }) => ({ id, sizeBytes })));
      projects.getImport = vi.fn().mockResolvedValue(undefined);
      projects.getImportBytes = vi.fn().mockResolvedValue(0);
      projects.registerImport = vi.fn().mockImplementation((item: Record<string, unknown>) => {
        registered.push(item);
        return Promise.resolve({ ...item, createdAt: new Date(0) });
      });
      // The real upload path: the owner check answers with the project the import created.
      const ownedStudio = {
        ...studio,
        forgetResolutions: vi.fn(),
        requireOwnedProject: vi.fn((auth: AuthDto, id: string) =>
          Promise.resolve({ id, ownerId: auth.user.id, deletedAt: null, archivedAt: null }),
        ),
      };
      const logger = getMocks().logger as never;
      sut = new StudioBundleService(
        logger,
        operations as unknown as MediaOperationRepository,
        projects as unknown as StudioProjectRepository,
        fs.storage as never,
        fs.crypto as never,
        assets as never,
        users as never,
        resources as unknown as StudioResourceService,
        ownedStudio as unknown as StudioProjectService,
        new StudioProjectImportService(
          logger,
          projects as never,
          fs.storage as never,
          fs.crypto as never,
          users as never,
          ownedStudio as never,
        ),
      );
    });

    it('names every kept file for a whole project and only the placed ones for a subset', async () => {
      studio.authorizeRevision.mockResolvedValue({
        access: 'owner',
        project: { id: sourceProject.id, name: 'Lake trip' },
        revision: { id: newUuidV7(), revision: 4, digest: studioEnvelopeDigest(importsEnvelope) },
        envelope: importsEnvelope,
        manifest: { entries: [] },
      });

      await sut.createExport(owner, sourceProject.id, { includeMedia: true });
      expect(operations.create.mock.calls[0][0].snapshot.imports).toEqual(kept.map((item) => item.id));

      await sut.createExport(owner, sourceProject.id, { includeMedia: true, sequenceIds: ['seq-2'] });
      expect(operations.create.mock.calls[1][0].snapshot.imports).toEqual([voice, lut]);
    });

    it('round trips saved Lottie override maps through archive bytes and the real kept-file importer', async () => {
      const bytes = Buffer.from(
        JSON.stringify({
          v: '5.9.0',
          w: 320,
          h: 180,
          fr: 30,
          ip: 0,
          op: 90,
          layers: [],
          assets: [],
        }),
      );
      const saved = {
        ...envelope,
        graph: {
          id: 'lottie-project',
          name: 'Lottie',
          description: '',
          createdAt: 0,
          updatedAt: 0,
          duration: 0,
          schemaVersion: 15,
          metadata: { width: 320, height: 180, fps: 30 },
          timeline: {
            tracks: [
              {
                id: 'v1',
                name: 'Video',
                kind: 'video',
                height: 80,
                locked: false,
                visible: true,
                muted: false,
                solo: false,
                order: 0,
              },
            ],
            items: [
              {
                id: 'template',
                type: 'lottie',
                trackId: 'v1',
                mediaId: logo,
                importId: logo,
                from: 30,
                durationInFrames: 90,
                label: 'Template',
                src: '',
                width: 320,
                height: 180,
                lottieFps: 30,
                lottieDuration: 3,
                animationId: 'existing-animation',
                themeId: 'existing-theme',
                colorOverrides: { c0: '#FF8000' },
                textOverrides: { '0': 'Hello', 's:title': '' },
                slotOverrides: { opacity: 25, position: [10, -20] },
              },
            ],
            currentFrame: 0,
            zoomLevel: 1,
            scrollPosition: 0,
          },
        },
      };
      const rows = rowsOf(sourceProject.id).map((row) =>
        row.id === logo
          ? {
              ...row,
              contentType: 'application/json',
              checksum: sha256(bytes).toString('hex'),
              sizeBytes: bytes.length,
              path: join(studioImportProjectFolder(owner.user.id, sourceProject.id), `${logo}.json`),
              fileName: 'animation.json',
              externalReferences: 0,
            }
          : row,
      );
      fs.files.set(rows.find((row) => row.id === logo)!.path, bytes);
      projects.listImports.mockResolvedValue(rows);
      projects.getRevision.mockResolvedValue({
        id: newUuidV7(),
        revision: 5,
        digest: studioEnvelopeDigest(saved),
        envelope: saved,
      });
      const exportJob = exportJobOf(
        true,
        kept.map((item) => item.id),
      );
      Object.assign(exportJob.snapshot as object, { revision: 5, digest: studioEnvelopeDigest(saved) });
      await sut.run({ operation: exportJob, claimToken: 'lottie-export' });
      expect(operations.fail).not.toHaveBeenCalled();
      const exported = lastResult();
      const bundle = fs.files.get(exported.path as string)!;
      const source = {
        size: bundle.length,
        read: (position: number, length: number) => Promise.resolve(bundle.subarray(position, position + length)),
      };
      const directory = await readZipDirectory(source);
      const manifest = await readBundleManifest(bundle);
      const projectBytes = await readZipEntry(source, directory.byName.get('project.json')!);
      const archived = JSON.parse(projectBytes.toString('utf8'));
      expect(manifest.project.revision).toBe(5);
      expect(manifest.files['project.json']).toEqual({
        bytes: projectBytes.length,
        sha256: sha256(projectBytes).toString('hex'),
      });
      // Literal output oracle: do not derive expected maps by copying the input or running editor helpers.
      expect(archived.graph.timeline.items[0]).toMatchObject({
        id: 'template',
        type: 'lottie',
        mediaId: logo,
        importId: logo,
        animationId: 'existing-animation',
        themeId: 'existing-theme',
        from: 30,
        durationInFrames: 90,
        colorOverrides: { c0: '#FF8000' },
        textOverrides: { '0': 'Hello', 's:title': '' },
        slotOverrides: { opacity: 25, position: [10, -20] },
      });
      const carried = manifest.sources.find((item) => item.key === `project-import:${logo}`)!;
      expect(carried).toMatchObject({
        mode: 'embedded',
        contentType: 'application/json',
        sha256: sha256(bytes).toString('hex'),
        bytes: bytes.length,
      });
      expect(await readZipEntry(source, directory.byName.get(carried.path!)!)).toEqual(bytes);
      // Remove original kept files: the import must recover them from the archive, not donor state.
      for (const path of fs.files.keys()) if (path !== exported.path) fs.files.delete(path);
      const upload = uploadOf(bundle, manifest);
      await sut.run({ operation: importJobOf(upload), claimToken: 'lottie-import' });
      expect(operations.fail).not.toHaveBeenCalled();
      expect(projects.createWithRevision).toHaveBeenCalledOnce();
      const created = projects.createWithRevision.mock.calls[0][0];
      expect(created.revision.envelope.graph).toEqual(archived.graph);
      expect((created.revision.envelope.graph as typeof saved.graph).timeline.items[0]).toMatchObject({
        animationId: 'existing-animation',
        themeId: 'existing-theme',
        colorOverrides: { c0: '#FF8000' },
        textOverrides: { '0': 'Hello', 's:title': '' },
        slotOverrides: { opacity: 25, position: [10, -20] },
      });
      const imported = registered.find((item) => item.id === logo)!;
      expect(imported).toMatchObject({
        contentType: 'application/json',
        externalReferences: 0,
        checksum: sha256(bytes).toString('hex'),
        sizeBytes: bytes.length,
      });
      expect(fs.files.get(imported.path as string)).toEqual(bytes);
      expect(lastResult()).toMatchObject({ embeddedVerified: 5, missing: [] });
    });

    it('refuses extraction before opening an output when temporary storage cannot be reserved', async () => {
      const { bundle, manifest } = handMade([kept[0]]);
      const upload = uploadOf(bundle, manifest);
      projects.createUpload.mockRejectedValueOnce(new PayloadTooLargeException('storage quota'));
      await sut.run({ operation: importJobOf(upload), claimToken: 'token' });
      expect(operations.fail).toHaveBeenCalledWith(
        expect.any(String),
        'token',
        expect.objectContaining({ error: 'storage quota' }),
      );
      expect(fs.storage.createWriteStream).not.toHaveBeenCalled();
    });

    it('stops ZIP output at its admitted byte bound and removes the partial file', async () => {
      const job = exportJobOf(false, []);
      job.settings = { storageReservationBytes: STUDIO_BUNDLE_DOCUMENT_RESERVATION + 1 };
      await sut.run({ operation: job, claimToken: 'token' });
      expect(operations.fail).toHaveBeenCalledWith(
        job.id,
        'token',
        expect.objectContaining({ error: expect.stringContaining('exceeds its storage reservation') }),
      );
      expect(fs.files.keys().some((path) => path.includes(job.id))).toBe(false);
    });

    it('carries the bytes out and keeps them with the imported project under the same ids', async () => {
      // --- The exporting server -------------------------------------------------------------
      const exportJob = exportJobOf(
        true,
        kept.map((item) => item.id),
      );
      await sut.run({ operation: exportJob, claimToken: 'token' });

      expect(operations.fail).not.toHaveBeenCalled();
      const exported = lastResult();
      expect(exported).toMatchObject({ embedded: 5, referenced: 2 });
      const bundle = fs.files.get(exported.path as string)!;
      const manifest = await readBundleManifest(bundle);
      const byKey = new Map(manifest.sources.map((item) => [item.key, item]));
      for (const item of kept) {
        // Named by the import id and the type the upload read, never by the uploaded name.
        expect(byKey.get(`project-import:${item.id}`)).toEqual({
          key: `project-import:${item.id}`,
          kind: 'project-import',
          id: item.id,
          mode: 'embedded',
          path: `media/project-import-${item.id}${item.extension}`,
          sha256: sha256(item.bytes).toString('hex'),
          bytes: item.bytes.length,
          fileName: item.fileName,
          contentType: item.contentType,
        });
      }
      // The id a clip places the take by is still listed the way older readers expect.
      expect(byKey.get(`library-asset:${voice}`)).toMatchObject({ mode: 'reference', fileName: null, sha256: null });

      // --- The importing server -------------------------------------------------------------
      for (const path of fs.files.keys()) {
        if (path !== exported.path) {
          fs.files.delete(path);
        }
      }
      const upload = uploadOf(bundle, manifest);

      // The review lists each kept file once, as coming with the bundle.
      const review = await sut.getUpload(owner, upload.id);
      expect(review.sources.map((source) => [source.key, source.resolution])).toEqual([
        [`library-asset:${assetA}`, 'missing'],
        ...kept.map((item) => [`project-import:${item.id}`, 'kept']),
      ]);
      expect(assets.getByChecksums).not.toHaveBeenCalled();

      operations.setBulkResult.mockClear();
      const importJob = importJobOf(upload);
      await sut.run({ operation: importJob, claimToken: 'token-2' });

      expect(operations.fail).not.toHaveBeenCalled();
      const created = (await projects.createWithRevision.mock.results[0].value).project.id as string;
      // The graph comes back as it left, so a graphic's edits arrive with the graphic they apply to.
      expect(projects.createWithRevision.mock.calls[0][0].revision.envelope.graph).toEqual(importsEnvelope.graph);
      expect(registered).toEqual(
        kept.map((item) => ({
          projectId: created,
          id: item.id,
          ownerId: owner.user.id,
          contentType: item.contentType,
          checksum: sha256(item.bytes).toString('hex'),
          sizeBytes: item.bytes.length,
          path: join(studioImportProjectFolder(owner.user.id, created), `${item.id}${item.extension}`),
          fileName: item.fileName,
          externalReferences: item.contentType === 'image/svg+xml' ? 0 : null,
          reservationId: expect.any(String),
        })),
      );
      for (const item of kept) {
        expect(
          fs.files.get(join(studioImportProjectFolder(owner.user.id, created), `${item.id}${item.extension}`)),
        ).toEqual(item.bytes);
      }
      // Nothing is left behind in the incoming folder.
      expect(
        fs.files
          .keys()
          .filter((path) => path.includes('/incoming/'))
          .toArray(),
      ).toEqual([]);
      expect(lastResult()).toMatchObject({
        projectId: created,
        relinked: 0,
        kept: 0,
        embeddedVerified: 5,
        missing: [{ key: `library-asset:${assetA}`, embedded: false }],
      });
    });

    it('lists kept files by digest without their bytes when media was not asked for', async () => {
      const exportJob = exportJobOf(false, [voice, subs]);
      await sut.run({ operation: exportJob, claimToken: 'token' });

      expect(lastResult()).toMatchObject({ embedded: 0, referenced: 4 });
      const bundle = fs.files.get(lastResult().path as string)!;
      const manifest = await readBundleManifest(bundle);
      expect(Object.keys(manifest.files)).toEqual(['project.json']);
      expect(manifest.sources.find((item) => item.id === voice && item.kind === 'project-import')).toMatchObject({
        mode: 'reference',
        path: null,
        sha256: sha256(wav).toString('hex'),
        fileName: 'Voiceover 1.webm',
      });

      const upload = uploadOf(bundle, manifest);
      operations.setBulkResult.mockClear();
      await sut.run({ operation: importJobOf(upload), claimToken: 'token-2' });
      expect(registered).toEqual([]);
      expect(lastResult().missing).toEqual(
        expect.arrayContaining([
          {
            key: `project-import:${voice}`,
            kind: 'project-import',
            id: voice,
            fileName: 'Voiceover 1.webm',
            embedded: false,
          },
          { key: `project-import:${subs}`, kind: 'project-import', id: subs, fileName: 'subs.srt', embedded: false },
        ]),
      );
      // The take is reported once, by its own source, not again under its media id.
      expect((lastResult().missing as Array<{ key: string }>).map((item) => item.key)).not.toContain(
        `library-asset:${voice}`,
      );
    });

    it('refuses to export a kept file that no longer matches its record', async () => {
      fs.files.set(rowsOf(sourceProject.id)[0].path, Buffer.concat([wav, Buffer.from('tampered')]));
      const exportJob = exportJobOf(true, [voice]);
      await sut.run({ operation: exportJob, claimToken: 'token' });
      expect(operations.fail).toHaveBeenCalledWith(
        exportJob.id,
        'token',
        expect.objectContaining({ errorCode: 'bundle_import_changed' }),
      );
    });

    it('checks every carried file as an upload and leaves out what fails, whatever the bundle says', async () => {
      const good = newUuid();
      const scripted = newUuid();
      const notCaptions = newUuid();
      const named = newUuid();
      const { bundle, manifest } = handMade([
        { id: good, bytes: wav, fileName: '../../../etc/cron.d/take.wav', contentType: 'image/svg+xml' },
        {
          id: scripted,
          bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
          fileName: 'logo.wav',
          contentType: 'audio/wav',
        },
        { id: notCaptions, bytes: Buffer.from('These are my notes.\n'), fileName: 'subs.vtt', contentType: 'text/vtt' },
        { id: 'not-a-uuid', bytes: png, fileName: 'still.png', contentType: 'image/png' },
        { id: named, fileName: 'left-behind.wav', contentType: 'audio/wav' },
      ]);
      // Another server: nothing of the exporting project is here.
      fs.files.clear();
      const upload = uploadOf(bundle, manifest);

      await expect(
        sut.createImport(owner, { uploadId: upload.id, mapping: { [`project-import:${good}`]: newUuid() } }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await sut.run({ operation: importJobOf(upload), claimToken: 'token' });

      expect(operations.fail).not.toHaveBeenCalled();
      const created = (await projects.createWithRevision.mock.results[0].value).project.id as string;
      // Only the sound file is kept: under its id and the type its bytes are, with a bare name as a label.
      expect(registered).toEqual([
        expect.objectContaining({
          id: good,
          contentType: 'audio/wav',
          path: join(studioImportProjectFolder(owner.user.id, created), `${good}.wav`),
          fileName: 'take.wav',
        }),
      ]);
      expect(lastResult().missing).toEqual([
        expect.objectContaining({ id: named, embedded: false }),
        expect.objectContaining({ id: scripted, embedded: true }),
        expect.objectContaining({ id: notCaptions, embedded: true }),
        expect.objectContaining({ id: 'not-a-uuid', embedded: true }),
      ]);
      // Nothing was written anywhere but the bundle itself and the one kept file.
      expect(fs.files.keys().toArray().sort()).toEqual(
        ['/uploads/kept.zip', join(studioImportProjectFolder(owner.user.id, created), `${good}.wav`)].sort(),
      );
    });

    it('fails the import, and creates nothing, when a carried file does not match its digest', async () => {
      const { bundle, manifest } = handMade([
        { id: newUuid(), bytes: wav, fileName: 'take.wav', contentType: 'audio/wav', sha256: 'a'.repeat(64) },
      ]);
      const upload = uploadOf(bundle, manifest);
      const job = importJobOf(upload);
      await sut.run({ operation: job, claimToken: 'token' });

      expect(operations.fail).toHaveBeenCalledWith(
        job.id,
        'token',
        expect.objectContaining({ errorCode: 'bundle_digest_mismatch' }),
      );
      expect(projects.createWithRevision).not.toHaveBeenCalled();
      expect(registered).toEqual([]);
    });

    it('keeps the files on the retry when the first attempt stopped after creating the project', async () => {
      const first = newUuid();
      const second = newUuid();
      const { bundle, manifest } = handMade([
        { id: first, bytes: wav, fileName: 'one.wav', contentType: 'audio/wav' },
        { id: second, bytes: png, fileName: 'two.png', contentType: 'image/png' },
      ]);
      const upload = uploadOf(bundle, manifest);
      const job = importJobOf(upload);
      const project = { id: newUuidV7(), ownerId: owner.user.id, importedFromDigest: upload.digest } as StudioProject;
      projects.createWithRevision.mockResolvedValueOnce({ project, created: true });
      // The second file cannot be moved into place: storage fails, which is not a refusal.
      fs.storage.rename.mockImplementationOnce(fs.storage.rename.getMockImplementation()!);
      fs.storage.rename.mockImplementationOnce(() => Promise.reject(new Error('EIO')));

      await sut.run({ operation: job, claimToken: 'token' });
      expect(operations.fail).toHaveBeenCalledWith(job.id, 'token', expect.objectContaining({ error: 'EIO' }));
      expect(registered.map((item) => item.id)).toEqual([first, second]);
      const prepared = operations.setBulkResult.mock.calls.find((call) => call[2].result?.projectId === null)?.[2]
        .result;

      operations.fail.mockClear();
      projects.getByImportOperation.mockResolvedValueOnce(project);
      projects.createWithRevision.mockClear();
      await sut.run({ operation: { ...job, result: prepared } as MediaOperation, claimToken: 'token-retry' });

      expect(operations.fail).not.toHaveBeenCalled();
      expect(projects.createWithRevision).not.toHaveBeenCalled();
      expect(operations.complete).toHaveBeenCalledWith(job.id, 'token-retry', { resultAssetId: null });
      for (const [id, extension, bytes] of [
        [first, '.wav', wav],
        [second, '.png', png],
      ] as const) {
        expect(fs.files.get(join(studioImportProjectFolder(owner.user.id, project.id), `${id}${extension}`))).toEqual(
          bytes,
        );
      }
      expect(lastResult()).toMatchObject({ projectId: project.id, missing: [] });
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

    it('only replays a request key for the same relink choices and project name', async () => {
      const item = upload();
      const standIn = newUuid();
      const first = operationOf({
        kind: MediaOperationKind.StudioBundleImport,
        snapshot: {
          kind: 'studio-bundle-import',
          uploadId: item.id,
          name: 'Trip copy',
          mapping: { [`library-asset:${assetA}`]: standIn },
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      } as never);
      operations.getByRequestKey.mockResolvedValue(first);
      const request = {
        uploadId: item.id,
        name: 'Trip copy',
        mapping: { [`library-asset:${assetA}`]: standIn },
        requestKey: 'import-1',
      };

      await expect(sut.createImport(owner, request)).resolves.toMatchObject({ id: first.id });
      await expect(sut.createImport(owner, { ...request, name: 'Other trip' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      await expect(sut.createImport(owner, { ...request, mapping: {} })).rejects.toBeInstanceOf(ConflictException);
      await expect(sut.createImport(owner, { ...request, uploadId: newUuidV7() })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(operations.create).not.toHaveBeenCalled();
    });

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
      projects.listExpiredUploads.mockResolvedValue([{ id: newUuidV7(), path: '/uploads/old.zip' }]);
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
