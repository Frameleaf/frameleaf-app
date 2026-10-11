import { describe, expect, it } from 'vitest';
import { KEY, LINEAGE } from 'test/fixtures/studio-import-retention.js';
import { buddyStudioImportSchema } from './buddy-backup-studio.js';

// Schema-only path; canonical managed destinations are exercised by the DB restore fixture.
const legacyImport = {
  id: KEY.importId,
  projectId: KEY.projectId,
  ownerId: KEY.ownerId,
  createdAt: new Date(0).toISOString(),
  contentType: 'video/mp4',
  checksum: 'ab'.repeat(32),
  sizeBytes: 4,
  path: '/data/exports/o/buddy-projects/p/s/bytes.mp4',
  fileName: 'upscaled.mp4',
  externalReferences: null,
};
const retained = { ...LINEAGE, outputSha256: legacyImport.checksum };

describe('Buddy retained import schema', () => {
  it('preserves new lineage while accepting an old snapshot row', () => {
    const parsed = buddyStudioImportSchema.parse({ ...legacyImport, processingProvenance: retained });
    expect(parsed.processingProvenance).toEqual(retained);
    expect(buddyStudioImportSchema.parse(legacyImport).processingProvenance).toBeNull();
    expect(
      buddyStudioImportSchema.parse({ ...legacyImport, processingProvenance: null }).processingProvenance,
    ).toBeNull();
  });

  it.each([
    { ...retained, outputSha256: 'cd'.repeat(32) },
    { ...retained, version: 2 },
    { ...retained, path: '/private/stage' },
    { ...retained, source: { ...retained.source, url: 'https://private.invalid' } },
    { ...retained, output: { ...retained.output, width: 1 } },
  ])('refuses changed hashes or unsupported lineage instead of stripping fields', (processingProvenance) => {
    expect(buddyStudioImportSchema.safeParse({ ...legacyImport, processingProvenance }).success).toBe(false);
  });
});
