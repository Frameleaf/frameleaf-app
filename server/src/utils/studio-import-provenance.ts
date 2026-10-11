import z from 'zod';

const dimension = z.number().int().min(1).max(32_768);
const fields = {
  version: z.literal(1),
  family: z.literal('anime4k'),
  evidence: z.literal('client-reported'),
  // Literal union keeps the canonical SDK structurally assignable to the pure host contract.
  variant: z.union([z.literal('animation'), z.literal('liveAction'), z.literal('threeD')]),
  source: z.strictObject({
    namespace: z.literal('freecut-media'),
    id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
    projectId: z.uuid(),
  }),
  input: z.strictObject({ width: dimension, height: dimension }),
  output: z.strictObject({
    width: dimension,
    height: dimension,
    fps: z.number().finite().positive().max(1000),
    frameCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    codec: z.string().regex(/^[\u{20}-\u{7E}]{1,128}$/u),
  }),
  modelBinding: z
    .strictObject({
      resourceId: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .optional(),
};

const doubled = (value: { input: { width: number; height: number }; output: { width: number; height: number } }) =>
  value.output.width === value.input.width * 2 && value.output.height === value.input.height * 2;

export const ProcessingProvenanceSchema = z.strictObject(fields).refine(doubled, 'invalid_anime4k_dimensions');
export const RetainedProcessingProvenanceSchema = z
  .strictObject({ ...fields, outputSha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .refine(doubled, 'invalid_anime4k_dimensions');

export type ProcessingProvenanceInput = z.infer<typeof ProcessingProvenanceSchema>;
export type RetainedProcessingProvenance = z.infer<typeof RetainedProcessingProvenanceSchema>;

export function parseProcessingProvenance(value: unknown): ProcessingProvenanceInput {
  const normalized = ProcessingProvenanceSchema.parse(value);
  if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > 4096) {
    throw new Error('provenance_too_large');
  }
  return normalized;
}

export function bindProcessingProvenance(value: unknown, checksum: string): RetainedProcessingProvenance {
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error('invalid_output_checksum');
  }
  return { ...parseProcessingProvenance(value), outputSha256: checksum };
}

export function sameProvenance(
  a: RetainedProcessingProvenance | null,
  b: RetainedProcessingProvenance | null,
): boolean {
  const normalize = (value: RetainedProcessingProvenance | null) =>
    value === null ? null : RetainedProcessingProvenanceSchema.parse(value);
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}

export function assertReadyRetry(
  stored: RetainedProcessingProvenance | null,
  supplied: RetainedProcessingProvenance | undefined,
): void {
  if (supplied !== undefined && !sameProvenance(stored, supplied)) {
    throw new Error('provenance_conflict');
  }
}
