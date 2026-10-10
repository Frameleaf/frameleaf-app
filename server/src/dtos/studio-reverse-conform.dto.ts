import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const Identifier = z.string().regex(/^[\w.:-]{1,128}$/);
const PositiveInteger = z.int().min(1).max(Number.MAX_SAFE_INTEGER);

export class StudioReverseConformEnqueueDto extends createZodDto(
  z.object({
    clientId: Identifier,
    command: z.object({
      id: z.literal('job.enqueueReverseConform'),
      payload: z.object({ clipId: Identifier, destinationId: z.literal('local') }),
      revision: PositiveInteger,
      idempotencyKey: Identifier,
      issuedAt: z.int().min(0).max(Number.MAX_SAFE_INTEGER),
    }),
  }),
) {}

export class StudioReverseConformApplyDto extends createZodDto(
  z.object({
    clientId: Identifier,
    operationId: z.uuidv7(),
  }),
) {}

export class StudioReverseConformQueuedDto extends createZodDto(z.object({ operationId: z.uuidv7() })) {}

export const StudioReverseConformResultSchema = z.object({
  operationId: z.uuidv7(),
  projectId: z.uuidv7(),
  clipId: Identifier.nullable(),
  sourceRevision: PositiveInteger,
  generatedId: Identifier,
  frames: PositiveInteger,
  frameRate: z.object({ num: PositiveInteger, den: PositiveInteger }),
  width: PositiveInteger,
  height: PositiveInteger,
  browserPreview: z.object({
    generatedId: Identifier,
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    contentType: z.literal('video/mp4'),
    profile: z.literal('h264-main-3.2-aac-lc-v1'),
    delivery: z.literal('authenticated'),
  }),
});

export class StudioReverseConformResultDto extends createZodDto(StudioReverseConformResultSchema) {}
