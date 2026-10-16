import z from 'zod';
import type { DesktopModelProfile } from 'src/utils/desktop-model-catalogue.js';

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

/** Decode before scheduling publication; both NAS HTTP and desktop results use this contract. */
export const parseBoundClipResult = (value: unknown, profile: DesktopModelProfile) => {
  if (profile.workload !== 'clip' || profile.embeddingDimensions === undefined)
    throw new Error('producer_result_invalid');
  const result = z
    .strictObject({
      clip: z.string().max(4 * 1024 * 1024),
      imageWidth: z.number().int().positive().optional(),
      imageHeight: z.number().int().positive().optional(),
    })
    .parse(value);
  if (
    profile.spec.fixtureKind === 'image'
      ? result.imageWidth === undefined || result.imageHeight === undefined
      : result.imageWidth !== undefined || result.imageHeight !== undefined
  )
    throw new Error('producer_result_invalid');
  z.array(z.number().finite()).length(profile.embeddingDimensions).parse(JSON.parse(result.clip));
  return { embedding: result.clip, modelKey: profile.modelKey };
};
