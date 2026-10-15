import { createZodDto } from 'nestjs-zod';
import { createHash } from 'node:crypto';
import z from 'zod';

const signature = z
  .string()
  .length(88)
  .refine((value) => {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === 64 && bytes.toString('base64') === value;
  });
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const DesktopSessionRequestSchema = z.strictObject({
  deviceId: z.uuid(),
  requestId: z.uuidv4(),
  timestamp,
  signature,
});
export class DesktopSessionRequestDto extends createZodDto(DesktopSessionRequestSchema) {}
export class DesktopSessionDto extends createZodDto(
  z.object({
    sessionId: z.uuid(),
    workerToken: z.string().regex(/^[a-f0-9]{64}$/),
    authorizationEpoch: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
    scopes: z.array(z.enum(['library-inference']).meta({ id: 'DesktopWorkerScope' })),
    modelKeys: z.array(z.string()),
  }),
) {}
export const DesktopWorkerProofSchema = z.strictObject({
  sessionId: z.uuid(),
  sequence: z.number().int().min(1).max(2_147_483_647),
  timestamp,
  signature,
});
export type DesktopWorkerProof = z.infer<typeof DesktopWorkerProofSchema>;
export class DesktopWorkerPayloadDto extends createZodDto(
  z.strictObject({ payload: z.string().max(4 * 1024 * 1024) }),
) {}
export const desktopSessionMessage = (serverId: string, accountId: string, request: DesktopSessionRequestDto): string =>
  [
    'frameleaf-desktop/session/v1',
    serverId,
    accountId,
    request.deviceId,
    request.requestId,
    String(request.timestamp),
  ].join('\n');
export const desktopWorkerMessage = (
  serverId: string,
  epoch: number,
  token: string,
  proof: DesktopWorkerProof,
  operation: string,
  payload: string,
): string =>
  [
    'frameleaf-desktop/request/v1',
    serverId,
    proof.sessionId,
    String(epoch),
    String(proof.sequence),
    String(proof.timestamp),
    operation,
    createHash('sha256').update(payload).digest('hex'),
    createHash('sha256').update(token).digest('hex'),
  ].join('\n');
