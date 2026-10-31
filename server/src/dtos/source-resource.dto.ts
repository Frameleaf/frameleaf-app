import { createZodDto } from 'nestjs-zod';
import { createHash } from 'node:crypto';
import z from 'zod';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const signature = z
  .string()
  .length(88)
  .refine((value) => {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === 64 && bytes.toString('base64') === value;
  });
const timestamp = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const SourceGrantTokenSchema = z
  .string()
  .length(71)
  .regex(/^flsrc1_[a-f0-9]{64}$/u);
export class SourceGrantRequestDto extends createZodDto(
  z.strictObject({
    sourceId: z.uuid(),
    deviceId: z.uuid(),
    scopeFingerprint: fingerprint,
    requestId: z.uuidv4(),
    timestamp,
    signature,
  }),
) {}
export const SourceResourceProofSchema = z.strictObject({
  grantId: z.uuid(),
  sequence: z.number().int().min(1).max(2_147_483_647),
  timestamp,
  signature,
});
export type SourceResourceProof = z.infer<typeof SourceResourceProofSchema>;
export class SourceGrantDto extends createZodDto(
  z.object({
    grantId: z.uuid(),
    sourceId: z.uuid(),
    deviceId: z.uuid(),
    ownerId: z.uuid(),
    serverId: z.string().min(1).max(128),
    sourceToken: SourceGrantTokenSchema,
    scopeFingerprint: fingerprint,
    authorizationEpoch: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
    scopes: z.array(z.enum(['source-original-read']).meta({ id: 'SourceResourceScope' })).length(1),
  }),
) {}
export type SourceResourceBinding = {
  serverId: string;
  ownerId: string;
  sourceId: string;
  scopeFingerprint: string;
  authorizationEpoch: number;
};
export const sourceGrantMessage = (serverId: string, ownerId: string, request: SourceGrantRequestDto): string =>
  [
    'frameleaf-source/grant/v1',
    serverId,
    ownerId,
    request.sourceId,
    request.deviceId,
    request.scopeFingerprint,
    request.requestId,
    String(request.timestamp),
  ].join('\n');
export const sourceResourceMessage = (
  binding: SourceResourceBinding,
  token: string,
  proof: SourceResourceProof,
  operation: string,
  payload: string,
): string =>
  [
    'frameleaf-source/request/v1',
    binding.serverId,
    binding.ownerId,
    binding.sourceId,
    binding.scopeFingerprint,
    proof.grantId,
    String(binding.authorizationEpoch),
    String(proof.sequence),
    String(proof.timestamp),
    operation,
    createHash('sha256').update(payload).digest('hex'),
    createHash('sha256').update(token).digest('hex'),
  ].join('\n');
