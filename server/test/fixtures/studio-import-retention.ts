export const KEY = {
  ownerId: '0198a1c2-0000-7000-8000-00000000000a',
  projectId: '0198a1c2-0000-7000-8000-0000000000aa',
  importId: '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01',
  publicationId: '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e02',
};

export const LINEAGE = {
  version: 1 as const,
  family: 'anime4k' as const,
  evidence: 'client-reported' as const,
  variant: 'animation' as const,
  source: { namespace: 'freecut-media' as const, id: KEY.importId, projectId: KEY.projectId },
  input: { width: 640, height: 360 },
  output: { width: 1280, height: 720, fps: 29.97, frameCount: 30, codec: 'avc1.64001f' },
};

export const DECLARATION = {
  contentType: 'video/mp4',
  extension: '.mp4',
  sizeBytes: 4,
  checksum: 'ab'.repeat(32),
  fileName: 'upscaled.mp4',
  externalReferences: null,
  processingProvenance: { ...LINEAGE, outputSha256: 'ab'.repeat(32) },
};

export const PREPARED = {
  stagedPath: '/data/exports/owner/studio-imports/incoming/attempt.upload',
  targetPath: '/data/exports/owner/studio-imports/project/import.mp4',
  identity: { dev: '1', ino: '2', size: 4 },
  declaration: DECLARATION,
};
