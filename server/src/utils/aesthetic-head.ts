import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import z from 'zod';

/**
 * FL-978: learned aesthetic heads, one per visual search model, shipped with the release in
 * `resources/aesthetic-heads/<modelName>.json` (provenance in `machine-learning/README.md`). A head is
 * dense layers with ReLU between them and one final logit; the score is sigmoid(logit). A model with no
 * head keeps the version 1 image-quality score.
 */
export const AESTHETIC_HEAD_SCORE_VERSION = 2;

const finite = z.number().finite();
const headSchema = z
  .object({
    modelName: z.string().min(1),
    producerModelKey: z.string().regex(/^clip:[a-f0-9]{64}$/),
    scoreVersion: z.literal(AESTHETIC_HEAD_SCORE_VERSION),
    layers: z.array(z.object({ weights: z.array(z.array(finite).min(1)).min(1), bias: z.array(finite).min(1) })).min(1),
  })
  .superRefine(({ layers }, context) => {
    let inputs = layers[0].weights.length;
    for (const { weights, bias } of layers) {
      if (weights.length !== inputs || weights.some((row) => row.length !== bias.length)) {
        context.addIssue({ code: 'custom', message: 'aesthetic_head_shape' });
        return;
      }
      inputs = bias.length;
    }
    if (inputs !== 1) context.addIssue({ code: 'custom', message: 'aesthetic_head_output' });
  });

export type AestheticHead = z.infer<typeof headSchema>;

const HEADS_DIR = join(import.meta.dirname, '../../resources/aesthetic-heads');
const heads = new Map<string, AestheticHead | null>();

export const parseAestheticHead = (value: unknown) => headSchema.parse(value);

/** The release's head for a visual search model, or null when the model has none. */
export const getAestheticHead = (modelName: string): AestheticHead | null => {
  if (!heads.has(modelName)) {
    const file = join(HEADS_DIR, `${modelName}.json`);
    // Model names come from settings; only a plain file name inside the heads folder is read.
    const safe = /^[\w.-]+$/.test(modelName) && existsSync(file);
    heads.set(modelName, safe ? parseAestheticHead(JSON.parse(readFileSync(file, 'utf8'))) : null);
  }
  return heads.get(modelName)!;
};

/** sigmoid(head(embedding)), or null when the embedding does not fit the head. */
export const scoreAesthetic = (head: AestheticHead, embedding: readonly number[]): number | null => {
  let values: readonly number[] = embedding;
  if (values.length !== head.layers[0].weights.length) return null;
  for (const [index, { weights, bias }] of head.layers.entries()) {
    const next = [...bias];
    for (const [i, value] of values.entries()) {
      const row = weights[i];
      for (let j = 0; j < next.length; j++) next[j] += value * row[j];
    }
    values = index < head.layers.length - 1 ? next.map((value) => Math.max(0, value)) : next;
  }
  const score = 1 / (1 + Math.exp(-values[0]));
  return Number.isFinite(score) ? score : null;
};
