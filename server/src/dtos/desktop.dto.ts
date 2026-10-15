import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const DesktopModeSchema = z.enum(['local-server', 'client-worker']).meta({ id: 'DesktopMode' });
const DesktopPlatformSchema = z.enum(['macos', 'windows', 'linux']).meta({ id: 'DesktopPlatform' });
const DesktopArchitectureSchema = z.enum(['arm64', 'x86_64']).meta({ id: 'DesktopArchitecture' });
export const DesktopDeviceStateSchema = z
  .enum(['awaiting-approval', 'preparing', 'paused', 'revoked'])
  .meta({ id: 'DesktopDeviceState' });
const base64Bytes = (bytes: number) =>
  z.string().refine((value) => {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length === bytes && decoded.toString('base64') === value;
  }, 'Invalid canonical base64');

export const DesktopEnrollmentSchema = z.strictObject({
  protocolVersion: z.number().int().min(1).max(1),
  installationId: z.uuidv4(),
  requestId: z.uuidv4(),
  publicKey: base64Bytes(32),
  name: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .regex(/^[^\p{Cc}\p{Cf}]+$/u),
  platform: DesktopPlatformSchema,
  architecture: DesktopArchitectureSchema,
  mode: DesktopModeSchema,
  timestamp: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  signature: base64Bytes(64),
});
export class DesktopEnrollmentDto extends createZodDto(DesktopEnrollmentSchema) {}
export class DesktopDeviceDto extends createZodDto(
  z.object({
    id: z.uuid(),
    installationId: z.uuidv4(),
    name: z.string(),
    platform: DesktopPlatformSchema,
    architecture: DesktopArchitectureSchema,
    mode: DesktopModeSchema,
    state: DesktopDeviceStateSchema,
    createdAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
    routeEffects: z.object({
      changed: z.array(z.string()),
      preserved: z.literal('all').meta({ id: 'DesktopRoutePreservation' }),
    }),
  }),
) {}
export class DesktopCapabilitiesDto extends createZodDto(
  z.object({
    protocolVersion: z.number().int().min(1).max(1),
    serverId: z.string(),
    features: z.object({
      enrollment: z.literal(true),
      worker: z.literal(false),
      sources: z.literal(false),
      nativeHost: z.literal(false),
    }),
    enrollmentPolicy: z.literal('administrators').meta({ id: 'DesktopEnrollmentPolicy' }),
  }),
) {}

/** A fixed, language-independent proof binds enrollment to this server and authenticated account. */
export const enrollmentMessage = (serverId: string, accountId: string, dto: DesktopEnrollmentDto): string =>
  [
    'frameleaf-desktop/enroll/v1',
    serverId,
    accountId,
    dto.installationId,
    dto.requestId,
    String(dto.timestamp),
    dto.publicKey,
    dto.name,
    dto.platform,
    dto.architecture,
    dto.mode,
  ].join('\n');
