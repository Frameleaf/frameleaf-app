import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const DesktopQualificationRequestSchema = z.strictObject({
  requestId: z.uuidv4().refine((value) => value === value.toLowerCase()),
  modelKey: z.string().regex(/^(clip|ocr|face):[a-f0-9]{64}$/),
  provider: z.enum([
    'CPUExecutionProvider',
    'CUDAExecutionProvider',
    'CoreMLExecutionProvider',
    'OpenVINOExecutionProvider',
    'MIGraphXExecutionProvider',
  ]),
  runtimeSourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  runtime: z.strictObject({
    manifestGzipBase64: z.string().min(1).max(2_796_204),
    signatureBase64: z.string().length(88),
  }),
});
export class DesktopQualificationIdParamDto extends createZodDto(
  z.strictObject({
    id: z.uuidv4().refine((value) => value === value.toLowerCase()),
  }),
) {}
export const DesktopQualificationReportSchema = z.strictObject({ report: z.record(z.string(), z.json()) });
export class DesktopQualificationChallengeDto extends createZodDto(
  z.strictObject({
    id: z.uuidv4(),
    modelKey: z.string().regex(/^(clip|ocr|face):[a-f0-9]{64}$/),
    specJson: z
      .string()
      .min(1)
      .max(1024 * 1024),
    bindingSha256: digest,
    fixtureBase64: z.string().min(1).max(2_796_204),
    manifestSha256: digest,
    expiresAt: z.iso.datetime(),
    reportSha256: digest.nullable(),
  }),
) {}

export class DesktopAcceptedQualificationDto extends createZodDto(
  z.strictObject({
    id: z.uuidv4(),
    deviceId: z.uuidv4(),
    sessionId: z.uuidv4(),
    authorizationEpoch: z.number().int().positive(),
    modelKey: z.string().regex(/^(clip|ocr|face):[a-f0-9]{64}$/),
    configSha256: digest,
    inputKind: z.enum(['text', 'image']).meta({ id: 'DesktopInputKind' }),
    bindingSha256: digest,
    manifestSha256: digest,
    runtimeFingerprint: digest,
    reportSha256: digest,
    qualifiedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  }),
) {}
