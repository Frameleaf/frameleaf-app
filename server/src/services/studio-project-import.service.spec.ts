import type { RetentionUpload } from 'src/utils/studio-import-publication.js';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { StudioProjectImport, StudioProjectRepository } from 'src/repositories/studio-project.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { CacheControl } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { KEY, LINEAGE } from 'test/fixtures/studio-import-retention.js';
import { StudioProjectImportService, studioImportProjectFolder } from 'src/services/studio-project-import.service.js';

const OWNER = '0198a1c2-0000-7000-8000-00000000000a';
const STRANGER = '0198a1c2-0000-7000-8000-00000000000b';
const PROJECT = '0198a1c2-0000-7000-8000-0000000000aa';
const IMPORT = '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01';

const auth = (userId = OWNER, extra: Partial<AuthDto> = {}) =>
  ({ user: { id: userId }, ...extra }) as unknown as AuthDto;

const wav = () => {
  const header = Buffer.alloc(64);
  header.write('RIFF', 0, 'latin1');
  header.write('WAVE', 8, 'latin1');
  return Buffer.concat([header, Buffer.alloc(1000, 1)]);
};

describe(StudioProjectImportService.name, () => {
  let directory: string;
  let projects: {
    getById: ReturnType<typeof vi.fn>;
    deleteUpload: ReturnType<typeof vi.fn>;
    listImports: ReturnType<typeof vi.fn>;
    getImport: ReturnType<typeof vi.fn>;
    getImportBytes: ReturnType<typeof vi.fn>;
    listOrphanImportProjects: ReturnType<typeof vi.fn>;
    deleteImports: ReturnType<typeof vi.fn<StudioProjectRepository['deleteImports']>>;
    getRevision?: ReturnType<typeof vi.fn>;
  };
  let studio: { forgetResolutions: ReturnType<typeof vi.fn>; requireOwnedProject: ReturnType<typeof vi.fn> };
  let users: { get: ReturnType<typeof vi.fn> };
  let publications: {
    register: ReturnType<typeof vi.fn>;
    getPublication: ReturnType<typeof vi.fn>;
    retain: ReturnType<typeof vi.fn>;
    recover: ReturnType<typeof vi.fn>;
    cleanupIncoming: ReturnType<typeof vi.fn>;
  };
  let sut: StudioProjectImportService;

  const upload = async (bytes: Buffer, mimetype = 'audio/wav', originalname = 'take.wav') => {
    const path = join(directory, `incoming-${Math.random()}`);
    await writeFile(path, bytes);
    return { path, size: bytes.length, mimetype, originalname } as Express.Multer.File;
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'studio-import-'));
    StorageCore.setMediaLocation('/data');
    projects = {
      getById: vi.fn().mockResolvedValue({ id: PROJECT, ownerId: OWNER, deletedAt: null, archivedAt: null }),
      deleteUpload: vi.fn().mockResolvedValue(undefined),
      listImports: vi.fn().mockResolvedValue([]),
      getImport: vi.fn(),
      getImportBytes: vi.fn().mockResolvedValue(0),
      listOrphanImportProjects: vi.fn().mockResolvedValue([]),
      deleteImports: vi.fn<StudioProjectRepository['deleteImports']>().mockResolvedValue(undefined),
    };
    studio = {
      forgetResolutions: vi.fn(),
      // the owner rule of StudioProjectService.requireOwnedProject, for a stranger: 404 as if missing
      requireOwnedProject: vi.fn(async (actor: AuthDto, id: string) => {
        const project = (await (projects.getById as (id: string) => Promise<{ ownerId: string } | undefined>)(id)) as
          { ownerId: string } | undefined;
        if (!project || project.ownerId !== actor.user.id) {
          throw new NotFoundException('Studio project not found');
        }
        return project;
      }),
    };
    users = { get: vi.fn().mockResolvedValue({ quotaSizeInBytes: null, quotaUsageInBytes: 0 }) };
    const storage = new StorageRepository({ setContext: vi.fn() } as never);
    publications = {
      recover: vi.fn().mockResolvedValue({ attempted: 0, deferred: 0 }),
      cleanupIncoming: vi.fn().mockResolvedValue(false),
      register: vi.fn().mockResolvedValue({ state: 'registered' }),
      getPublication: vi.fn().mockResolvedValue({ state: 'registered' }),
      retain: vi.fn(async (_auth: AuthDto, upload: RetentionUpload) => {
        const item = {
          ...upload.declaration,
          id: upload.key.importId,
          projectId: upload.key.projectId,
          ownerId: upload.key.ownerId,
          path: join(
            studioImportProjectFolder(OWNER, PROJECT),
            `${upload.key.importId}${upload.declaration.extension}`,
          ),
          createdAt: new Date(0),
        };
        await writeFile(join(directory, 'kept'), await readFile(upload.incoming));
        await rm(upload.incoming);
        return item;
      }),
    };
    sut = new StudioProjectImportService(
      { setContext: vi.fn(), log: vi.fn(), warn: vi.fn() } as never,
      projects as never,
      storage,
      new CryptoRepository(),
      users as never,
      studio as never,
      publications as never,
    );
    return () => rm(directory, { recursive: true, force: true });
  });

  it('keeps a recording with its checksum and the type read from its bytes (FL-103)', async () => {
    const bytes = wav();
    const file = await upload(bytes, 'audio/webm', 'Voiceover 1.webm');
    const result = await sut.upload(auth(), PROJECT, IMPORT, file);

    expect(publications.register).toHaveBeenCalledWith(auth(), PROJECT, expect.objectContaining({ importId: IMPORT }));
    expect(publications.retain).toHaveBeenCalledWith(auth(), {
      key: expect.objectContaining({ ownerId: OWNER, projectId: PROJECT, importId: IMPORT }),
      incoming: file.path,
      reservationId: undefined,
      declaration: {
        contentType: 'audio/wav',
        extension: '.wav',
        checksum: createHash('sha256').update(bytes).digest('hex'),
        sizeBytes: bytes.length,
        fileName: 'Voiceover 1.webm',
        externalReferences: null,
        processingProvenance: null,
      },
    });
    expect(result).toMatchObject({ id: IMPORT, kind: 'audio', contentType: 'audio/wav', sizeBytes: bytes.length });
    expect(Object.hasOwn(result, 'processingProvenance')).toBe(false);
    expect(await readFile(join(directory, 'kept'))).toEqual(bytes);
    await expect(readFile(file.path)).rejects.toThrow();
    expect(studio.forgetResolutions).toHaveBeenCalledWith([PROJECT]);
  });

  it('records the external subresources of a graphic and refuses scripts (FL-105)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x.example/a.png"/></svg>');
    await sut.upload(auth(), PROJECT, IMPORT, await upload(svg, 'image/svg+xml', 'logo.svg'));
    expect(publications.retain).toHaveBeenLastCalledWith(
      auth(),
      expect.objectContaining({
        declaration: expect.objectContaining({ contentType: 'image/svg+xml', externalReferences: 1 }),
      }),
    );

    const scripted = await upload(Buffer.from('<svg><script>alert(1)</script></svg>'), 'image/svg+xml', 'x.svg');
    await expect(sut.upload(auth(), PROJECT, IMPORT, scripted)).rejects.toBeInstanceOf(BadRequestException);
    await expect(readFile(scripted.path)).rejects.toThrow();
  });

  it('refuses a nested SVG Lottie image before registering immutable bytes (FL-105)', async () => {
    const bytes = Buffer.from(
      JSON.stringify({
        v: '5.9.0',
        layers: [],
        assets: [{ id: 'nested', p: 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Lz48L3N2Zz4=', e: 1 }],
      }),
    );
    const file = await upload(bytes, 'application/json', 'animation.json');
    await expect(sut.upload(auth(), PROJECT, IMPORT, file)).rejects.toBeInstanceOf(BadRequestException);
    expect(publications.retain).not.toHaveBeenCalled();
    await expect(readFile(file.path)).rejects.toThrow();
    await expect(readFile(join(directory, 'kept'))).rejects.toThrow();
  });

  it.each([
    [
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
      0,
    ],
    ['outside.png', 1],
  ])(
    'keeps supported inline and declared external Lottie image sources unchanged (FL-105)',
    async (p, externalReferences) => {
      const bytes = Buffer.from(JSON.stringify({ v: '5.9.0', layers: [], assets: [{ p }] }));
      const result = await sut.upload(
        auth(),
        PROJECT,
        IMPORT,
        await upload(bytes, 'application/json', 'animation.json'),
      );
      expect(result).toMatchObject({
        contentType: 'application/json',
        externalReferences,
        checksum: createHash('sha256').update(bytes).digest('hex'),
      });
      expect(await readFile(join(directory, 'kept'))).toEqual(bytes);
    },
  );

  it('removes the upload and refuses files it cannot place', async () => {
    const pdf = await upload(Buffer.from('%PDF-1.7'.padEnd(64, ' ')), 'audio/wav', 'song.wav');
    await expect(sut.upload(auth(), PROJECT, IMPORT, pdf)).rejects.toBeInstanceOf(BadRequestException);
    await expect(readFile(pdf.path)).rejects.toThrow();

    const noId = await upload(wav());
    await expect(sut.upload(auth(), PROJECT, 'not-a-uuid', noId)).rejects.toBeInstanceOf(BadRequestException);
    await expect(readFile(noId.path)).rejects.toThrow();

    const big = await upload(wav());
    await expect(
      sut.upload(auth(), PROJECT, IMPORT, { ...big, size: 3 * 1024 * 1024 * 1024 } as Express.Multer.File),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(publications.retain).not.toHaveBeenCalled();
  });

  it('answers 404 to anyone but the owner, and keeps nothing', async () => {
    for (const caller of [auth(STRANGER), auth(OWNER, { sharedLink: { id: 'link' } as never })]) {
      const file = await upload(wav());
      await expect(sut.upload(caller, PROJECT, IMPORT, file)).rejects.toBeInstanceOf(NotFoundException);
      await expect(readFile(file.path)).rejects.toThrow();
      await expect(sut.list(caller, PROJECT)).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.getFile(caller, PROJECT, IMPORT)).rejects.toBeInstanceOf(NotFoundException);
    }
    projects.getById.mockResolvedValue(undefined);
    await expect(sut.list(auth(), PROJECT)).rejects.toBeInstanceOf(NotFoundException);
    expect(publications.retain).not.toHaveBeenCalled();
  });

  it('answers a reviewer 403 from the shared owner check, and keeps nothing (FL-112)', async () => {
    studio.requireOwnedProject.mockRejectedValue(
      new ForbiddenException('Only the owner can import into a Studio project'),
    );
    const file = await upload(wav());
    await expect(sut.upload(auth(STRANGER), PROJECT, IMPORT, file)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(readFile(file.path)).rejects.toThrow();
    await expect(sut.list(auth(STRANGER), PROJECT)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(sut.getFile(auth(STRANGER), PROJECT, IMPORT)).rejects.toBeInstanceOf(ForbiddenException);
    expect(studio.requireOwnedProject).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT,
      'Only the owner can import into a Studio project',
    );
    expect(publications.retain).not.toHaveBeenCalled();
  });

  it('refuses imports into a trashed or archived project', async () => {
    projects.getById.mockResolvedValue({ id: PROJECT, ownerId: OWNER, deletedAt: new Date(), archivedAt: null });
    await expect(sut.upload(auth(), PROJECT, IMPORT, await upload(wav()))).rejects.toBeInstanceOf(ConflictException);
    projects.getById.mockResolvedValue({ id: PROJECT, ownerId: OWNER, deletedAt: null, archivedAt: new Date() });
    await expect(sut.upload(auth(), PROJECT, IMPORT, await upload(wav()))).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers a retried upload from the stored import without keeping a second copy', async () => {
    const stored: StudioProjectImport = {
      projectId: PROJECT,
      id: IMPORT,
      ownerId: OWNER,
      contentType: 'audio/wav',
      checksum: 'a'.repeat(64),
      sizeBytes: 1064,
      path: '/elsewhere/kept.wav',
      fileName: 'take.wav',
      externalReferences: null,
      createdAt: new Date(0),
    };
    publications.retain.mockImplementationOnce(async (_auth, upload) => {
      await rm(upload.incoming);
      return stored;
    });
    const file = await upload(wav());
    await expect(sut.upload(auth(), PROJECT, IMPORT, file)).resolves.toMatchObject({ id: IMPORT });
    await expect(readFile(file.path)).rejects.toThrow();
    await expect(readFile(join(directory, 'kept'))).rejects.toThrow();
  });

  it('lowercases the id, keeps a new import within the quota and answers a retry without counting it', async () => {
    const upper = IMPORT.toUpperCase();
    await sut.upload(auth(), PROJECT, upper, await upload(wav()));
    expect(publications.retain).toHaveBeenLastCalledWith(
      auth(),
      expect.objectContaining({
        key: expect.objectContaining({ importId: IMPORT }),
        declaration: expect.objectContaining({ extension: '.wav' }),
      }),
    );

    users.get.mockResolvedValue({ quotaSizeInBytes: 2000, quotaUsageInBytes: 500 });
    projects.getImportBytes.mockResolvedValue(600);
    const over = await upload(wav());
    await expect(sut.upload(auth(), PROJECT, IMPORT, over)).rejects.toBeInstanceOf(PayloadTooLargeException);
    await expect(readFile(over.path)).rejects.toThrow();

    // The same import again is the stored one, not new usage.
    projects.getImport.mockResolvedValue({ id: IMPORT });
    await expect(sut.upload(auth(), PROJECT, IMPORT, await upload(wav()))).resolves.toMatchObject({ id: IMPORT });
  });

  it('answers 400 for a vector graphic that is not UTF-8', async () => {
    const latin = Buffer.concat([
      Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>'),
      Buffer.from([0xe9, 0xff]),
      Buffer.from('</text></svg>'),
    ]);
    const file = await upload(latin, 'image/svg+xml', 'x.svg');
    await expect(sut.upload(auth(), PROJECT, IMPORT, file)).rejects.toBeInstanceOf(BadRequestException);
    await expect(readFile(file.path)).rejects.toThrow();
  });

  describe('caption files and LUTs (FL-105)', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,500\nHello\n';
    const vtt = 'WEBVTT\n\n00:01.000 --> 00:02.500\nHello\n';
    const cube = `TITLE "Warm"\nLUT_3D_SIZE 2\n${'0.5 0.25 1.0\n'.repeat(8)}`;

    it.each([
      ['a SubRip file', srt, 'application/x-subrip', 'captions', '.srt'],
      ['a WebVTT file', vtt, 'text/vtt', 'captions', '.vtt'],
      ['a .cube LUT', cube, 'text/x-cube-lut', 'lut', '.cube'],
    ])('keeps %s under the type read from its bytes, not its name', async (_name, body, contentType, kind, ext) => {
      const bytes = Buffer.from(body);
      const file = await upload(bytes, 'video/mp4', '../../etc/clip.mp4');
      const result = await sut.upload(auth(), PROJECT, IMPORT, file);

      expect(publications.retain).toHaveBeenCalledWith(
        auth(),
        expect.objectContaining({
          declaration: expect.objectContaining({
            contentType,
            extension: ext,
            checksum: createHash('sha256').update(bytes).digest('hex'),
            fileName: 'clip.mp4',
            externalReferences: null,
          }),
        }),
      );
      expect(result).toMatchObject({ kind, contentType });
      expect(await readFile(join(directory, 'kept'))).toEqual(bytes);
    });

    it.each([
      ['a SubRip file that turns into something else', `${srt}\n<html><script>alert(1)</script></html>\n`, 'x.srt'],
      ['a WebVTT file with no captions', 'WEBVTT\n\nNOTE empty\n', 'x.vtt'],
      [
        'a WebVTT file whose styles load a file',
        `WEBVTT\n\nSTYLE\n::cue{background:url(//t.example/p)}\n\n${vtt.slice(8)}`,
        'x.vtt',
      ],
      ['a LUT with the wrong number of rows', `LUT_3D_SIZE 2\n${'0 0 0\n'.repeat(5)}`, 'x.cube'],
      ['a 1D LUT', 'LUT_1D_SIZE 2\n0 0 0\n1 1 1\n', 'x.cube'],
      ['plain text called a caption file', 'These are my notes.\n', 'x.srt'],
      ['plain text called a LUT', 'These are my notes.\n', 'x.cube'],
    ])('refuses %s and removes the upload', async (_name, body, name) => {
      const file = await upload(Buffer.from(body), 'text/plain', name);
      await expect(sut.upload(auth(), PROJECT, IMPORT, file)).rejects.toBeInstanceOf(BadRequestException);
      await expect(readFile(file.path)).rejects.toThrow();
      expect(publications.retain).not.toHaveBeenCalled();
    });

    it('refuses a caption file or LUT that is not UTF-8', async () => {
      for (const body of [srt, cube]) {
        const file = await upload(Buffer.concat([Buffer.from(body), Buffer.from([0xe9, 0xff, 0x0a])]));
        await expect(sut.upload(auth(), PROJECT, IMPORT, file)).rejects.toThrow(/must be UTF-8 text/);
        await expect(readFile(file.path)).rejects.toThrow();
      }
      expect(publications.retain).not.toHaveBeenCalled();
    });

    it('refuses an oversized caption file or LUT before reading it', async () => {
      const storage = (sut as unknown as { storage: StorageRepository }).storage;
      const read = vi.spyOn(storage, 'readFile');
      for (const [body, size] of [
        [srt, 4 * 1024 * 1024 + 1],
        [vtt, 4 * 1024 * 1024 + 1],
        [cube, 16 * 1024 * 1024 + 1],
      ] as const) {
        const file = await upload(Buffer.from(body));
        read.mockClear();
        await expect(
          sut.upload(auth(), PROJECT, IMPORT, { ...file, size } as Express.Multer.File),
        ).rejects.toBeInstanceOf(PayloadTooLargeException);
        // Only the head was read to tell what the file is; the body never was.
        expect(read).toHaveBeenCalledTimes(1);
        await expect(readFile(file.path)).rejects.toThrow();
      }
      expect(publications.retain).not.toHaveBeenCalled();
    });

    it('keeps a caption file at exactly the limit', async () => {
      const filler = '\n2\n00:00:03,000 --> 00:00:04,000\nline\n\n';
      const body = Buffer.alloc(4 * 1024 * 1024, ' ');
      body.write(`${srt}\n`);
      body.write(filler, body.length - filler.length);
      await expect(sut.upload(auth(), PROJECT, IMPORT, await upload(body))).resolves.toMatchObject({
        kind: 'captions',
        sizeBytes: 4 * 1024 * 1024,
      });
    });
  });

  it('removes registered orphan files individually and retries failures while sweeping stale incoming uploads', async () => {
    StorageCore.setMediaLocation(await realpath(directory));
    await mkdir(join(directory, 'exports'));
    const storage = (sut as unknown as { storage: StorageRepository }).storage;
    const unlink = vi.spyOn(storage, 'unlink').mockResolvedValue();
    const unlinkDir = vi.spyOn(storage, 'unlinkDir').mockResolvedValue();
    vi.spyOn(storage, 'readdir').mockImplementation((folder: string) =>
      Promise.resolve(folder.endsWith('exports') ? [OWNER, 'not-an-owner'] : [`${IMPORT}.upload`, `${PROJECT}.upload`]),
    );
    vi.spyOn(storage, 'stat').mockImplementation((path: string) =>
      Promise.resolve({ mtime: new Date(path.endsWith(`${IMPORT}.upload`) ? 0 : Date.now()) } as never),
    );
    const GONE = '0198a1c2-0000-7000-8000-0000000000bb';
    projects.listOrphanImportProjects.mockResolvedValue([
      { projectId: PROJECT, ownerId: OWNER },
      { projectId: GONE, ownerId: OWNER },
    ]);
    const keptPath = join(studioImportProjectFolder(OWNER, PROJECT), `${IMPORT}.wav`);
    const failedPath = join(studioImportProjectFolder(OWNER, GONE), `${IMPORT}.wav`);
    projects.deleteImports.mockImplementation(async (projectId, ownerId, remove) => {
      await remove({
        projectId,
        ownerId,
        id: IMPORT,
        path: projectId === PROJECT ? keptPath : failedPath,
      } as StudioProjectImport);
    });
    unlink.mockImplementation((path) => (path === failedPath ? Promise.reject(new Error('EIO')) : Promise.resolve()));
    publications.cleanupIncoming.mockImplementation(async (_owner, path, _cutoff, _remove) => {
      if (path.endsWith(`${IMPORT}.upload`)) await unlink(path);
      return true;
    });
    await sut.sweep(new Date());
    expect(publications.recover).toHaveBeenCalled();
    expect(publications.cleanupIncoming).toHaveBeenCalled();
    expect(unlinkDir).not.toHaveBeenCalled();
    expect(projects.deleteImports).toHaveBeenCalledWith(PROJECT, OWNER, expect.any(Function));
    expect(projects.deleteImports).toHaveBeenCalledWith(GONE, OWNER, expect.any(Function));
    expect(unlink).toHaveBeenCalledWith(keptPath);
    expect(unlink).toHaveBeenCalledWith(failedPath);
    expect(unlink).toHaveBeenCalledWith(
      expect.stringMatching(/incoming\/4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01\.upload$/),
    );
    expect(unlink).not.toHaveBeenCalledWith(expect.stringMatching(/0198a1c2-0000-7000-8000-0000000000aa\.upload$/));
  });

  it('leaves journal-owned incoming paths to locked recovery rather than TTL unlink', async () => {
    const path = join(studioImportProjectFolder(OWNER, PROJECT), 'unused');
    const storage = (sut as unknown as { storage: StorageRepository }).storage;
    const unlink = vi.spyOn(storage, 'unlink').mockResolvedValue();
    publications.cleanupIncoming.mockResolvedValue(false);
    await expect(sut.releaseIncoming(OWNER, path, new Date())).resolves.toBe(false);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('serves the owner the stored bytes with their recorded type', async () => {
    projects.getImport.mockResolvedValue({
      path: '/media/exports/owner/studio-imports/p/i.wav',
      contentType: 'audio/wav',
      fileName: 'take.wav',
    });
    await expect(sut.getFile(auth(), PROJECT, IMPORT)).resolves.toMatchObject({
      path: '/media/exports/owner/studio-imports/p/i.wav',
      contentType: 'audio/wav',
      cacheControl: CacheControl.PrivateWithCache,
    });
    projects.getImport.mockResolvedValue(undefined);
    await expect(sut.getFile(auth(), PROJECT, IMPORT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('binds actual staged checksum to already registered provenance and passes its reservation internally', async () => {
    const bytes = wav();
    const file = await upload(bytes);
    const retained = await sut.upload(auth(), PROJECT, IMPORT, file, KEY.publicationId, {
      publicationId: KEY.publicationId,
      processingProvenance: JSON.stringify(LINEAGE),
    });
    expect(retained.processingProvenance).toEqual({
      ...LINEAGE,
      outputSha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(publications.register).not.toHaveBeenCalled();
    expect(publications.getPublication).toHaveBeenCalledWith(auth(), KEY);
    expect(publications.retain).toHaveBeenCalledWith(
      auth(),
      expect.objectContaining({
        key: KEY,
        reservationId: KEY.publicationId,
        declaration: expect.objectContaining({
          processingProvenance: { ...LINEAGE, outputSha256: createHash('sha256').update(bytes).digest('hex') },
        }),
      }),
    );
  });

  it.each([
    { processingProvenance: JSON.stringify(LINEAGE) },
    { publicationId: 'invalid' },
    { publicationId: KEY.publicationId, processingProvenance: LINEAGE },
    { publicationId: KEY.publicationId, processingProvenance: '{bad' },
    { publicationId: KEY.publicationId, processingProvenance: ' '.repeat(4097) },
    { publicationId: KEY.publicationId, processingProvenance: null },
    {
      publicationId: KEY.publicationId,
      processingProvenance: JSON.stringify({ ...LINEAGE, outputSha256: 'ab'.repeat(32) }),
    },
  ])('refuses malformed lineage before prepare and removes only request scratch', async (options) => {
    const file = await upload(wav());
    await expect(sut.upload(auth(), PROJECT, IMPORT, file, KEY.publicationId, options)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(publications.retain).not.toHaveBeenCalled();
    expect(projects.deleteUpload).toHaveBeenCalledWith(KEY.publicationId, OWNER);
    await expect(readFile(file.path)).rejects.toThrow();
  });

  it('requires a matching registered receipt for a supplied publication id', async () => {
    publications.getPublication.mockResolvedValue(null);
    const file = await upload(wav());
    await expect(
      sut.upload(auth(), PROJECT, IMPORT, file, undefined, {
        publicationId: KEY.publicationId,
        processingProvenance: JSON.stringify(LINEAGE),
      }),
    ).rejects.toThrow('publication_registration_required');
    expect(publications.retain).not.toHaveBeenCalled();
    await expect(readFile(file.path)).rejects.toThrow();
  });

  it('refuses a cancelled receipt before prepare and cleans only the new request scratch', async () => {
    publications.getPublication.mockResolvedValue({ state: 'aborted' });
    const file = await upload(wav());
    await expect(
      sut.upload(auth(), PROJECT, IMPORT, file, KEY.importId, { publicationId: KEY.publicationId }),
    ).rejects.toThrow('publication_aborted');
    expect(publications.retain).not.toHaveBeenCalled();
    await expect(readFile(file.path)).rejects.toThrow();
    expect(projects.deleteUpload).toHaveBeenCalledWith(KEY.importId, OWNER);
  });

  it('preserves request bytes and reservation on an unknown prepare outcome', async () => {
    publications.retain.mockRejectedValue(new Error('commit_unknown'));
    const bytes = wav();
    const file = await upload(bytes);
    await expect(sut.upload(auth(), PROJECT, IMPORT, file, KEY.publicationId)).rejects.toThrow('commit_unknown');
    expect(await readFile(file.path)).toEqual(bytes);
    expect(projects.deleteUpload).not.toHaveBeenCalled();
  });

  it('releases a request reservation only after definite pre-retention validation failure cleanup', async () => {
    const file = await upload(Buffer.from('%PDF-1.7'.padEnd(64, ' ')));
    await expect(sut.upload(auth(), PROJECT, IMPORT, file, KEY.publicationId)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(readFile(file.path)).rejects.toThrow();
    expect(projects.deleteUpload).toHaveBeenCalledWith(KEY.publicationId, OWNER);
  });

  describe('inventory (FL-348)', () => {
    it('lists the kept files and the fonts and models the head graph names, with their rights', async () => {
      projects.getById.mockResolvedValue({ id: PROJECT, ownerId: OWNER, currentRevision: 3, deletedAt: null });
      projects.getRevision = vi.fn().mockResolvedValue({
        envelope: {
          graph: {
            id: 'g',
            timeline: {
              tracks: [{ id: 'v1', items: [] }],
              items: [
                { id: 't1', type: 'text', trackId: 'v1', fontFamily: 'Abel' },
                { id: 't2', type: 'text', trackId: 'v1', fontFamily: 'Not A Bundled Font' },
              ],
            },
          },
        },
      });
      (sut as unknown as { projects: typeof projects }).projects = projects;

      const inventory = await sut.inventory(auth(), PROJECT);
      expect(projects.getRevision).toHaveBeenCalledWith(PROJECT, 3);
      expect(inventory).toMatchObject({ projectId: PROJECT, revision: 3, keptFiles: [], luts: [], models: [] });
      expect(inventory.fonts).toEqual([
        expect.objectContaining({ name: 'Abel', rightsId: 'font:Abel', allowed: true, detail: null }),
        expect.objectContaining({ name: 'Not A Bundled Font', allowed: false }),
      ]);
    });

    it('answers a stranger as if the project did not exist', async () => {
      await expect(sut.inventory(auth(STRANGER), PROJECT)).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
