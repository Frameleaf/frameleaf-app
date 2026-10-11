import {
  importStudioProjectFile,
  StudioProjectImportKind,
  getStudioProjectImports,
  registerStudioImportPublication,
  getStudioImportPublications,
  cancelStudioImportPublication,
} from '@frameleaf/sdk';
import {
  isStudioBinImport,
  createStudioRetentionApi,
  toStudioPublicationReceipt,
  loadStudioProjectImports,
  toStudioProjectImport,
  uploadStudioProjectImport,
} from '$lib/frameleaf/studio/project-imports';

vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  importStudioProjectFile: vi.fn(),
  getStudioProjectImports: vi.fn(),
  registerStudioImportPublication: vi.fn(),
  getStudioImportPublications: vi.fn(),
  cancelStudioImportPublication: vi.fn(),
}));

describe('Studio project imports (FL-103 / FL-105)', () => {
  const dto = {
    id: '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01',
    kind: StudioProjectImportKind.Audio,
    contentType: 'audio/webm',
    fileName: 'Voiceover 1.webm',
    sizeBytes: 1024,
    checksum: 'a'.repeat(64),
    externalReferences: null,
    createdAt: '2026-09-29T00:00:00.000Z',
  };

  it('offers a kept file to the editor under its media id, read through the owner-only file route', () => {
    const ref = toStudioProjectImport('0198a1c2-0000-7000-8000-0000000000aa', dto);
    expect(ref).toEqual({
      id: dto.id,
      kind: 'audio',
      name: 'Voiceover 1.webm',
      mimeType: 'audio/webm',
      sizeBytes: 1024,
      checksum: dto.checksum,
      url: `/api/studio/projects/0198a1c2-0000-7000-8000-0000000000aa/imports/${dto.id}/file`,
    });
  });

  it('gives a Lottie animation the type the editor reads it by', () => {
    const lottie = { ...dto, kind: StudioProjectImportKind.Vector, contentType: 'application/json' };
    expect(toStudioProjectImport('p', lottie).mimeType).toBe('application/lottie+json');
    const svg = { ...dto, kind: StudioProjectImportKind.Vector, contentType: 'image/svg+xml' };
    expect(toStudioProjectImport('p', svg).mimeType).toBe('image/svg+xml');
  });

  it('does not offer a kept caption file or LUT to the media bin (FL-105)', () => {
    expect(isStudioBinImport(dto)).toBe(true);
    expect(isStudioBinImport({ ...dto, kind: StudioProjectImportKind.Vector })).toBe(true);
    expect(isStudioBinImport({ ...dto, kind: StudioProjectImportKind.Captions, contentType: 'text/vtt' })).toBe(false);
    expect(isStudioBinImport({ ...dto, kind: StudioProjectImportKind.Lut, contentType: 'text/x-cube-lut' })).toBe(
      false,
    );
  });
});

it('preserves canonical retained provenance and omits it on legacy imports', () => {
  const processingProvenance = {
    version: 1 as const,
    family: 'anime4k' as const,
    evidence: 'client-reported' as const,
    variant: 'animation' as const,
    source: { namespace: 'freecut-media' as const, id: 'take', projectId: '0198a1c2-0000-7000-8000-0000000000aa' },
    input: { width: 640, height: 360 },
    output: { width: 1280, height: 720, fps: 30, frameCount: 30, codec: 'avc1' },
    outputSha256: 'ab'.repeat(32),
  };
  const dto = {
    id: 'take',
    kind: StudioProjectImportKind.Video,
    contentType: 'video/mp4',
    fileName: 'out.mp4',
    sizeBytes: 4,
    checksum: processingProvenance.outputSha256,
    externalReferences: null,
    createdAt: '2026-10-11T00:00:00Z',
  };
  expect(toStudioProjectImport('p', { ...dto, processingProvenance }).processingProvenance).toEqual(
    processingProvenance,
  );
  expect(Object.hasOwn(toStudioProjectImport('p', dto), 'processingProvenance')).toBe(false);
});

it('encodes host upload provenance exactly once and keeps legacy fields absent', async () => {
  const provenance = {
    version: 1 as const,
    family: 'anime4k' as const,
    evidence: 'client-reported' as const,
    variant: 'animation' as const,
    source: { namespace: 'freecut-media' as const, id: 'take', projectId: 'project' },
    input: { width: 640, height: 360 },
    output: { width: 1280, height: 720, fps: 30, frameCount: 30, codec: 'avc1' },
  };
  vi.mocked(importStudioProjectFile).mockResolvedValue({
    id: 'take',
    kind: StudioProjectImportKind.Video,
    contentType: 'video/mp4',
    fileName: 'out.mp4',
    sizeBytes: 4,
    checksum: 'ab'.repeat(32),
    externalReferences: null,
    createdAt: '2026-10-11T00:00:00Z',
  });
  const upload = { id: 'take', fileName: 'out.mp4', file: new Blob(['test'], { type: 'video/mp4' }) };
  await uploadStudioProjectImport('project', {
    ...upload,
    publicationId: 'publication',
    processingProvenance: provenance,
  });
  expect(importStudioProjectFile).toHaveBeenLastCalledWith(
    {
      id: 'project',
      studioProjectImportCreateDto: {
        id: 'take',
        file: expect.any(File),
        publicationId: 'publication',
        processingProvenance: JSON.stringify(provenance),
      },
    },
    undefined,
  );
  await uploadStudioProjectImport('project', upload);
  expect(importStudioProjectFile).toHaveBeenLastCalledWith(
    {
      id: 'project',
      studioProjectImportCreateDto: { id: 'take', file: expect.any(File) },
    },
    undefined,
  );
});

const retentionProject = '0198a1c2-0000-7000-8000-0000000000aa';
const retentionDto = {
  id: '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01',
  kind: StudioProjectImportKind.Video,
  contentType: 'video/mp4',
  fileName: 'out.mp4',
  sizeBytes: 4,
  checksum: 'ab'.repeat(32),
  externalReferences: null,
  createdAt: new Date(0).toISOString(),
};
const receiptDto = {
  importId: retentionDto.id,
  publicationId: '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e02',
  state: 'published' as const,
  createdAt: new Date(0).toISOString(),
  expiresAt: new Date(21600000).toISOString(),
  cleanupPending: true,
  imported: retentionDto,
};

it('maps only public receipt fields and canonical original-project URLs', () => {
  const dto = {
    ...receiptDto,
    stagedPath: '/private/stage',
    declaration: { path: '/private/file' },
    imported: { ...retentionDto, targetPath: '/private/file' },
  };
  const mapped = toStudioPublicationReceipt(retentionProject, dto);
  expect(mapped).toEqual({ ...receiptDto, imported: toStudioProjectImport(retentionProject, retentionDto) });
  expect(JSON.stringify(mapped)).not.toContain('/private/');
  expect(() =>
    toStudioPublicationReceipt(retentionProject, { ...receiptDto, imported: { ...retentionDto, id: 'foreign' } }),
  ).toThrow('receipt_binding_changed');
  expect(() => toStudioPublicationReceipt(retentionProject, { ...receiptDto, state: 'preparing' })).toThrow(
    'receipt_binding_changed',
  );
});

it('binds SDK register/discover/cancel to one host project and cancellable request without local discovery IDs', async () => {
  vi.mocked(registerStudioImportPublication).mockResolvedValueOnce(receiptDto);
  vi.mocked(getStudioImportPublications).mockResolvedValueOnce({ items: [receiptDto], nextCursor: 'server_cursor' });
  vi.mocked(getStudioImportPublications).mockResolvedValueOnce({ items: [], nextCursor: null });
  vi.mocked(cancelStudioImportPublication).mockResolvedValueOnce({ status: 'already-published', receipt: receiptDto });
  const controller = new AbortController();
  const api = createStudioRetentionApi(controller.signal);
  expect(await api.register(retentionProject, retentionDto.id, receiptDto.publicationId)).toEqual(
    toStudioPublicationReceipt(retentionProject, receiptDto),
  );
  expect(registerStudioImportPublication).toHaveBeenLastCalledWith(
    {
      id: retentionProject,
      studioImportPublicationRegisterDto: { importId: retentionDto.id, publicationId: receiptDto.publicationId },
    },
    { signal: controller.signal },
  );
  const first = await api.discover(retentionProject);
  expect(getStudioImportPublications).toHaveBeenLastCalledWith({ id: retentionProject }, { signal: controller.signal });
  await api.discover(retentionProject, first.nextCursor!);
  expect(getStudioImportPublications).toHaveBeenLastCalledWith(
    { id: retentionProject, cursor: 'server_cursor' },
    { signal: controller.signal },
  );
  expect((await api.cancel(retentionProject, retentionDto.id, receiptDto.publicationId)).status).toBe(
    'already-published',
  );
  expect(cancelStudioImportPublication).toHaveBeenLastCalledWith(
    { id: retentionProject, importId: retentionDto.id, publicationId: receiptDto.publicationId },
    { signal: controller.signal },
  );
});

it('reloads every canonical import independently of an unavailable receipt page', async () => {
  const files = Array.from({ length: 101 }, (_, i) => ({
    ...retentionDto,
    id: `4b0f4b2e-5d3a-4c55-9e0e-${String(i).padStart(12, '0')}`,
  }));
  vi.mocked(getStudioProjectImports).mockResolvedValueOnce(files);
  vi.mocked(getStudioImportPublications).mockRejectedValueOnce(new Error('unavailable'));
  const controller = new AbortController();
  const api = createStudioRetentionApi(controller.signal);
  await expect(api.discover(retentionProject)).rejects.toThrow('unavailable');
  const loaded = await loadStudioProjectImports(retentionProject, controller.signal);
  expect(loaded).toHaveLength(101);
  expect(new Set(loaded.map((item) => item.id)).size).toBe(101);
});
