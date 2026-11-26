import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const DesktopClaimRequestSchema = z.strictObject({
  modelKeys: z.array(z.string().min(1).max(256)).max(64),
  waitMs: z.number().int().min(0).max(20_000).default(20_000),
  /**
   * Asks to be told when a requested model was withdrawn from this computer: the claim then answers
   * 409 `desktop_qualification_hold` at once. Without it a claim answers as it always has.
   */
  reportWithdrawn: z.boolean().optional(),
  /**
   * How many more tasks this desktop can take now. With it a desktop may hold several leases: each claim
   * returns one new lease (never one it already holds), while it holds fewer tasks of that kind of work than
   * the queue's Jobs setting. Without it a desktop holds one lease, as it always has.
   */
  slots: z.number().int().min(1).max(64).optional(),
});
export const DesktopHeartbeatSchema = z.strictObject({ id: z.uuid() });
export const DesktopResultSchema = z.strictObject({ result: z.record(z.string(), z.json()) });
export const DesktopFailureSchema = z.strictObject({
  code: z
    .enum(['inference-failed', 'input-invalid', 'model-unavailable', 'cancelled'])
    .meta({ id: 'DesktopWorkerFailureCode' }),
});
export const DesktopEmptySchema = z.strictObject({});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export class DesktopWorkerTaskDto extends createZodDto(
  z.object({
    id: z.uuid(),
    taskId: z.uuid(),
    deviceId: z.uuid(),
    sessionId: z.uuid(),
    authorizationEpoch: z.number().int().positive(),
    generation: z.number().int().positive(),
    qualificationId: z.uuidv4(),
    qualificationExpiresAt: z.iso.datetime(),
    modelKey: z.string().min(1).max(256),
    configJson: z.string().max(64 * 1024),
    configSha256: digest,
    inputSha256: digest,
    inputKind: z.enum(['text', 'image']).meta({ id: 'DesktopInputKind' }),
    maxInputBytes: z
      .number()
      .int()
      .positive()
      .max(16 * 1024 * 1024),
    expiresAt: z.iso.datetime(),
    executionDeadline: z.iso.datetime(),
  }),
) {}
export class DesktopWorkerClaimDto extends createZodDto(z.object({ task: DesktopWorkerTaskDto.schema.nullable() })) {}
export class DesktopWorkerAckDto extends createZodDto(z.object({ accepted: z.boolean() })) {}

export class DesktopWorkerHeartbeatDto extends createZodDto(
  z.object({ accepted: z.boolean(), expiresAt: z.iso.datetime().nullable() }),
) {}
