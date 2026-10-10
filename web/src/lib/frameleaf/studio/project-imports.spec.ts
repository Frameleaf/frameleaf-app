import { StudioProjectImportKind } from '@frameleaf/sdk';
import { isStudioBinImport, toStudioProjectImport } from '$lib/frameleaf/studio/project-imports';

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
