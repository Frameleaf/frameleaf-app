import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/u);
const counter = z.number().int().min(1).max(2_147_483_647);
export const SourceReadResourcesSchema = z
  .array(z.strictObject({ resourceKey: fingerprint, version: fingerprint }))
  .min(1)
  .max(256);
export const SourceReadPollSchema = z.strictObject({
  maxBytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  resources: SourceReadResourcesSchema.optional(),
});
export const SourceReadHeartbeatSchema = z.strictObject({
  requestId: z.uuid(),
  claimFence: counter,
  claimToken: fingerprint,
});
export const SourceReadDeliverySchema = SourceReadHeartbeatSchema.extend({
  resourceKey: fingerprint,
  version: fingerprint,
  sha256: fingerprint,
  bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export class SourceResourcePayloadDto extends createZodDto(
  z.strictObject({
    payload: z
      .string()
      .max(65_536)
      .refine((value) => Buffer.byteLength(value) <= 65_536),
  }),
) {}
export class SourceReadRequestDto extends createZodDto(
  z.strictObject({
    id: z.uuid(),
    sourceId: z.uuid(),
    scopeFingerprint: fingerprint,
    authorizationEpoch: counter,
    resourceKey: fingerprint,
    version: fingerprint,
    sha256: fingerprint,
    bytes: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    claimFence: counter,
    claimToken: fingerprint,
    leaseUntil: z.iso.datetime(),
    deadline: z.iso.datetime(),
  }),
) {}
export class SourceReadPollDto extends createZodDto(
  z.strictObject({ request: SourceReadRequestDto.schema.nullable() }),
) {}
export class SourceReadHeartbeatDto extends createZodDto(
  z.strictObject({ leaseUntil: z.iso.datetime(), deadline: z.iso.datetime() }),
) {}

export class SourceReadDeliveryResultDto extends createZodDto(z.strictObject({ accepted: z.boolean() })) {}
