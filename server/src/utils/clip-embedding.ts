import z from 'zod';

export type ClipEmbedding = string | { embedding: string; modelKey: string };

/** Snapshot a verified producer result for storage; a legacy vector carries no provenance. */
export const clipEmbeddingForStorage = (
  value: ClipEmbedding,
): { embedding: string; producerModelKey: string | null } => {
  if (typeof value === 'string') return { embedding: value, producerModelKey: null };
  const { embedding, modelKey } = z
    .strictObject({
      embedding: z
        .string()
        .min(1)
        .max(4 * 1024 * 1024),
      modelKey: z.string().regex(/^clip:[a-f0-9]{64}$/),
    })
    .parse(value);
  return { embedding, producerModelKey: modelKey };
};
