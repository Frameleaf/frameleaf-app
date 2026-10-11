import z from 'zod';
import {
  StudioImportPublicationPageDto,
  StudioImportPublicationParamDto,
  StudioImportPublicationQueryDto,
  StudioImportPublicationRegisterDto,
  StudioProjectImportDto,
} from 'src/dtos/studio-project-import.dto.js';
import { ProcessingProvenanceSchema, RetainedProcessingProvenanceSchema } from 'src/utils/studio-import-provenance.js';
import { KEY, LINEAGE } from 'test/fixtures/studio-import-retention.js';

describe('canonical import/publication schemas', () => {
  it('exports canonical provenance numeric types without widening the version literal', () => {
    const visit = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const node = value as Record<string, unknown>;
      if (node.type === 'number') expect(node.format).toBe('double');
      for (const child of Object.values(node)) visit(child);
    };
    for (const schema of [ProcessingProvenanceSchema, RetainedProcessingProvenanceSchema]) {
      const exported = z.toJSONSchema(schema, { target: 'openapi-3.0', io: 'output' });
      visit(exported);
      expect(exported.properties?.version).toEqual({ $ref: '#/definitions/ProcessingProvenanceVersion' });
      expect(exported.definitions).toMatchObject({
        ProcessingProvenanceVersion: {
          type: 'integer',
          format: 'int32',
          enum: [1],
        },
      });
      expect(exported.properties?.output).toMatchObject({
        properties: {
          width: { type: 'integer', maximum: 32_768 },
          height: { type: 'integer', maximum: 32_768 },
          fps: { type: 'number', format: 'double', maximum: 1000 },
          frameCount: { type: 'integer', maximum: Number.MAX_SAFE_INTEGER },
        },
      });
      const value = schema === ProcessingProvenanceSchema ? LINEAGE : { ...LINEAGE, outputSha256: 'ab'.repeat(32) };
      expect(schema.safeParse(value).success).toBe(true);
      for (const version of [0, 1.5, 2, '1', null]) expect(schema.safeParse({ ...value, version }).success).toBe(false);
    }
    visit(z.toJSONSchema(StudioProjectImportDto.schema, { target: 'openapi-3.0', io: 'output' }));
  });
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
      StudioImportPublicationPageDto.schema.safeParse({
        items: Array.from({ length: 101 }, () => ({ ...receipt })),
        nextCursor: null,
      }).success,
    ).toBe(false);
  });
});
