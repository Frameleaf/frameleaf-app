import { vectorCompatible } from './adapters.js';
import { inspectEmbeddingAdmission } from './embeddings.js';
import { ImportDatabase } from './types.js';

it('inspects actual typmods and stored configuration but never treats selected model names as producer evidence', async () => {
  const db: ImportDatabase = {
    query: vi.fn(async (statement) =>
      statement.includes('atttypmod')
        ? [
            { table_name: 'smart_search', dimensions: 768 },
            { table_name: 'face_search', dimensions: 512 },
          ]
        : [{ clip: 'ViT-B-16-SigLIP-384__webli', face: 'buffalo_l' }],
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
