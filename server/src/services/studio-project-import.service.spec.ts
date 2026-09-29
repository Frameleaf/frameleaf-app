import { BadRequestException, ConflictException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { StudioProjectImport } from 'src/repositories/studio-project.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { CacheControl } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
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
    registerImport: ReturnType<typeof vi.fn>;
    listImports: ReturnType<typeof vi.fn>;
    getImport: ReturnType<typeof vi.fn>;
    getImportBytes: ReturnType<typeof vi.fn>;
    deleteOrphanImports: ReturnType<typeof vi.fn>;
  };
  let studio: { forgetResolutions: ReturnType<typeof vi.fn> };
  let users: { get: ReturnType<typeof vi.fn> };
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
      registerImport: vi.fn().mockImplementation((item) => Promise.resolve({ ...item, createdAt: new Date(0) })),
      listImports: vi.fn().mockResolvedValue([]),
      getImport: vi.fn(),
      getImportBytes: vi.fn().mockResolvedValue(0),
      deleteOrphanImports: vi.fn().mockResolvedValue([]),
    };
    studio = { forgetResolutions: vi.fn() };
    users = { get: vi.fn().mockResolvedValue({ quotaSizeInBytes: null, quotaUsageInBytes: 0 }) };
    const storage = new StorageRepository({ setContext: vi.fn() } as never);
    // The kept copy goes into the temp directory instead of the media location.
    vi.spyOn(storage, 'mkdirSync').mockImplementation(() => {});
    vi.spyOn(storage, 'rename').mockImplementation(async (source) => {
      await writeFile(join(directory, 'kept'), await readFile(source));
      await rm(source);
    });
    vi.spyOn(storage, 'checkFileExists').mockResolvedValue(false);
    sut = new StudioProjectImportService(
      { setContext: vi.fn(), log: vi.fn() } as never,
      projects as never,
      storage,
      new CryptoRepository(),
      users as never,
      studio as never,
    );
    return () => rm(directory, { recursive: true, force: true });
  });

  it('keeps a recording with its checksum and the type read from its bytes (FL-103)', async () => {
    const bytes = wav();
    const file = await upload(bytes, 'audio/webm', 'Voiceover 1.webm');
    const result = await sut.upload(auth(), PROJECT, IMPORT, file);

    expect(projects.registerImport).toHaveBeenCalledWith({
      projectId: PROJECT,
      id: IMPORT,
      ownerId: OWNER,
      contentType: 'audio/wav',
      checksum: createHash('sha256').update(bytes).digest('hex'),
      sizeBytes: bytes.length,
      path: join(studioImportProjectFolder(OWNER, PROJECT), `${IMPORT}.wav`),
      fileName: 'Voiceover 1.webm',
      externalReferences: null,
    });
    expect(result).toMatchObject({ id: IMPORT, kind: 'audio', contentType: 'audio/wav', sizeBytes: bytes.length });
    expect(await readFile(join(directory, 'kept'))).toEqual(bytes);
    await expect(readFile(file.path)).rejects.toThrow();
    expect(studio.forgetResolutions).toHaveBeenCalledWith([PROJECT]);
  });

  it('records the external subresources of a graphic and refuses scripts (FL-105)', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><image href="https://x.example/a.png"/></svg>');
    await sut.upload(auth(), PROJECT, IMPORT, await upload(svg, 'image/svg+xml', 'logo.svg'));
    expect(projects.registerImport).toHaveBeenLastCalledWith(
      expect.objectContaining({ contentType: 'image/svg+xml', externalReferences: 1 }),
    );

    const scripted = await upload(Buffer.from('<svg><script>alert(1)</script></svg>'), 'image/svg+xml', 'x.svg');
    await expect(sut.upload(auth(), PROJECT, IMPORT, scripted)).rejects.toBeInstanceOf(BadRequestException);
    await expect(readFile(scripted.path)).rejects.toThrow();
  });

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
    expect(projects.registerImport).not.toHaveBeenCalled();
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
    expect(projects.registerImport).not.toHaveBeenCalled();
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
    projects.registerImport.mockResolvedValue(stored);
    const file = await upload(wav());
    await expect(sut.upload(auth(), PROJECT, IMPORT, file)).resolves.toMatchObject({ id: IMPORT });
    await expect(readFile(file.path)).rejects.toThrow();
    await expect(readFile(join(directory, 'kept'))).rejects.toThrow();
  });

  it('lowercases the id, keeps a new import within the quota and answers a retry without counting it', async () => {
    const upper = IMPORT.toUpperCase();
    await sut.upload(auth(), PROJECT, upper, await upload(wav()));
    expect(projects.registerImport).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: IMPORT, path: expect.stringContaining(`${IMPORT}.wav`) }),
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

  it('removes the files of projects deleted for good and stale incoming uploads', async () => {
    const storage = (sut as unknown as { storage: StorageRepository }).storage;
    const unlink = vi.spyOn(storage, 'unlink').mockResolvedValue();
    const unlinkDir = vi.spyOn(storage, 'unlinkDir').mockResolvedValue();
    vi.spyOn(storage, 'readdir').mockImplementation((folder: string) =>
      Promise.resolve(folder.endsWith('exports') ? [OWNER, 'not-an-owner'] : ['old.upload', 'new.upload']),
    );
    vi.spyOn(storage, 'stat').mockImplementation((path: string) =>
      Promise.resolve({ mtime: new Date(path.endsWith('old.upload') ? 0 : Date.now()) } as never),
    );
    projects.deleteOrphanImports.mockResolvedValue([
      { projectId: PROJECT, ownerId: OWNER, path: '/data/exports/o/studio-imports/p/a.wav' },
    ]);
    await sut.sweep(new Date());
    expect(unlink).toHaveBeenCalledWith('/data/exports/o/studio-imports/p/a.wav');
    expect(unlinkDir).toHaveBeenCalledWith(studioImportProjectFolder(OWNER, PROJECT), { recursive: true, force: true });
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/incoming\/old\.upload$/));
    expect(unlink).not.toHaveBeenCalledWith(expect.stringMatching(/new\.upload$/));
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
});
