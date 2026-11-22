import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const DesktopTranscodeLeaseSchema = z.strictObject({ claimToken: z.uuid() });
export const DesktopTranscodeFailureSchema = z.strictObject({
  claimToken: z.uuid(),
  code: z
    .enum(['encode-failed', 'input-invalid', 'insufficient-disk', 'cancelled'])
    .meta({ id: 'DesktopTranscodeFailureCode' }),
});

export class DesktopTranscodeUploadQueryDto extends createZodDto(
  z.strictObject({
    claimToken: z.uuid(),
    checksum: digest,
    sizeInBytes: z.string().regex(/^[1-9]\d{0,15}$/),
  }),
) {}

export class DesktopTranscodeInputQueryDto extends createZodDto(z.strictObject({ claimToken: z.uuid() })) {}

export class DesktopTranscodeTaskDto extends createZodDto(
  z.object({
    id: z.uuid(),
    claimToken: z.uuid(),
    inputOptions: z.array(z.string()),
    outputOptions: z.array(z.string()),
    twoPass: z.boolean(),
    frameCount: z.number().int().min(0),
    sourceBytes: z.number().int().positive(),
    maxOutputBytes: z.number().int().positive(),
    expiresAt: z.iso.datetime(),
  }),
) {}
export class DesktopTranscodeClaimDto extends createZodDto(
  z.object({ task: DesktopTranscodeTaskDto.schema.nullable() }),
) {}
