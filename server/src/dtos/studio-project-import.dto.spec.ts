import { KEY, LINEAGE } from 'test/fixtures/studio-import-retention.js';
import {
  StudioImportPublicationRegisterDto,
  StudioImportPublicationQueryDto,
  StudioImportPublicationParamDto,
  StudioImportPublicationPageDto,
  StudioProjectImportDto,
} from './studio-project-import.dto.js';
import { ProcessingProvenanceSchema } from 'src/utils/studio-import-provenance.js';

describe('canonical import/publication schemas', () => {
  it('keeps strict UUIDv7 project / UUID publication binding and registration body', () => {
    expect(
      StudioImportPublicationParamDto.schema.safeParse({ id: KEY.projectId, publicationId: KEY.publicationId }).success,
    ).toBe(true);
    expect(
      StudioImportPublicationParamDto.schema.safeParse({ id: KEY.importId, publicationId: KEY.publicationId }).success,
    ).toBe(false);
    expect(
      StudioImportPublicationRegisterDto.schema.safeParse({
        importId: KEY.importId,
        publicationId: KEY.publicationId,
        path: '/private',
      }).success,
    ).toBe(false);
  });
  it('rejects client outputSha256 and accepts normalized retained output only on the public read DTO', () => {
    expect(ProcessingProvenanceSchema.safeParse({ ...LINEAGE, outputSha256: 'ab'.repeat(32) }).success).toBe(false);
    const legacy = {
      id: KEY.importId,
      kind: 'video',
      contentType: 'video/mp4',
      fileName: 'out.mp4',
      sizeBytes: 4,
      checksum: 'ab'.repeat(32),
      externalReferences: null,
      createdAt: '2026-10-11T00:00:00Z',
    };
    expect(Object.hasOwn(StudioProjectImportDto.schema.parse(legacy), 'processingProvenance')).toBe(false);
    expect(
      StudioProjectImportDto.schema.parse({
        ...legacy,
        processingProvenance: { ...LINEAGE, outputSha256: legacy.checksum },
      }).processingProvenance?.outputSha256,
    ).toBe(legacy.checksum);
  });
  it('has only an optional state/cursor query and at most100 receipts per page', () => {
    for (const query of [{ limit: 100 }, { cursor: '' }, { state: 'future' }])
      expect(StudioImportPublicationQueryDto.schema.safeParse(query).success).toBe(false);
    const receipt = {
      publicationId: KEY.publicationId,
      importId: KEY.importId,
      state: 'registered',
      createdAt: '2026-10-11T00:00:00Z',
      expiresAt: '2026-10-11T06:00:00Z',
      cleanupPending: false,
    };
    expect(
      StudioImportPublicationPageDto.schema.safeParse({ items: Array(101).fill(receipt), nextCursor: null }).success,
    ).toBe(false);
  });
});
