vi.mock('@frameleaf/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@frameleaf/sdk')>()),
  importStudioProjectFile: vi.fn(),
}));
import { importStudioProjectFile, StudioProjectImportKind } from '@frameleaf/sdk';
import {
  isStudioBinImport,
  toStudioProjectImport,
  uploadStudioProjectImport,
} from '$lib/frameleaf/studio/project-imports';

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
  expect(importStudioProjectFile).toHaveBeenLastCalledWith({
    id: 'project',
    studioProjectImportCreateDto: {
      id: 'take',
      file: expect.any(File),
      publicationId: 'publication',
      processingProvenance: JSON.stringify(provenance),
    },
  });
  await uploadStudioProjectImport('project', upload);
  expect(importStudioProjectFile).toHaveBeenLastCalledWith({
    id: 'project',
    studioProjectImportCreateDto: { id: 'take', file: expect.any(File) },
  });
});
