import { frozenSource, vectorCompatible } from 'src/immich-import/adapters.js';
import { inspectEmbeddingAdmission } from 'src/immich-import/embeddings.js';
import frozen from 'src/immich-import/fixtures/frozen-sources.json' with { type: 'json' };
import { ImportDatabase } from 'src/immich-import/types.js';

it.each(Object.keys(frozen.versions))(
  'keeps the %s transfer decision tied to the frozen absence of producer identity',
  (version) => {
    const source = frozenSource(version);
    expect(Object.keys(source.structure.tables.smart_search).sort()).toEqual(['assetId', 'embedding']);
    expect(Object.keys(source.structure.tables.face_search).sort()).toEqual(['embedding', 'faceId']);
    expect(source.tables.smart_search.columns).toEqual(['assetId', 'embedding']);
    expect(source.tables.face_search.columns).toEqual(['faceId', 'embedding']);
  },
);

it('inspects actual typmods and stored configuration but never treats selected model names as producer evidence', async () => {
  const db: ImportDatabase = {
    query: vi.fn((statement) =>
      Promise.resolve(
        statement.includes('atttypmod')
          ? [
              { table_name: 'smart_search', dimensions: 768 },
              { table_name: 'face_search', dimensions: 512 },
            ]
          : [{ clip: 'ViT-B-16-SigLIP-384__webli', face: 'buffalo_l' }],
      ),
    ),
    transaction: async (body) => body(db),
  };
  const admission = await inspectEmbeddingAdmission(db, db);
  expect(admission.smart_search).toMatchObject({
    sourceDimensions: 768,
    destinationDimensions: 768,
    producingModel: null,
  });
  expect(admission.face_search.destinationDimensions).toBe(512);
  expect(vectorCompatible(JSON.stringify(Array.from({ length: 768 }, () => 0.1)), admission.smart_search)).toBe(false);
});
