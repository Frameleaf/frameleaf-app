import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AdminConfigSchema, type SystemConfig, mapAdminConfig } from 'src/dtos/config.dto.js';
import { MachineLearningHardwareAccelerationSchema } from 'src/enum.js';

// Upstream moved the system config schema/defaults into src/dtos/config.dto.ts
// (new config module, see the /admin/config endpoints). This file keeps the
// fork's legacy import path alive and hosts the fork-only DTOs used by the
// /system-config fork endpoints (image-description re-queue, smart albums,
// ML hardware detection).

export {
  ConfigFFmpegDto as SystemConfigFFmpegDto,
  ConfigTemplateStorageOptionDto as SystemConfigTemplateStorageOptionDto,
  SystemConfigDto,
  SystemConfigSmtpDto,
} from 'src/dtos/config.dto.js';
export { ReleaseChannel } from 'src/enum.js';

/** Full admin config schema — used by the fork's config repositories for validation. */
export const SystemConfigSchema = AdminConfigSchema;

/** @deprecated use {@link mapAdminConfig}; kept for fork call sites and specs. */
export const mapConfig = mapAdminConfig;

const MachineLearningHardwareResponseSchema = z
  .object({
    providers: z.array(z.string()).describe('Available ONNX Runtime providers'),
    openvinoDeviceIds: z.array(z.string()).describe('Available OpenVINO device IDs'),
    torchCudaAvailable: z.boolean().describe('Whether PyTorch CUDA is available'),
    cudaDeviceCount: z.int().min(0).describe('Available PyTorch CUDA device count'),
    preferredAcceleration: MachineLearningHardwareAccelerationSchema.describe(
      'Detected preferred hardware acceleration',
    ),
  })
  .meta({ id: 'MachineLearningHardwareResponseDto' });

export class MachineLearningHardwareResponseDto extends createZodDto(MachineLearningHardwareResponseSchema) {}

const MachineLearningHardwareQuerySchema = z
  .object({
    destinationId: z
      .uuidv4()
      .optional()
      .describe(
        'Destination to probe. When omitted, the first enabled local destination is probed; a cloud destination is never chosen implicitly.',
      ),
  })
  .meta({ id: 'MachineLearningHardwareQueryDto' });

export class MachineLearningHardwareQueryDto extends createZodDto(MachineLearningHardwareQuerySchema) {}

const ImageDescriptionRequeueEstimateSchema = z
  .object({
    totalAssets: z.int().min(0).describe('Total eligible image assets'),
    withDescription: z
      .int()
      .min(0)
      .describe('Number of eligible assets that currently have a description (will be re-run on force-requeue).'),
    withoutDescription: z.int().min(0).describe('Number of eligible assets that currently have no description.'),
    rollingAvgSeconds: z
      .number()
      .meta({ format: 'double' })
      .min(0)
      .describe(
        'Average seconds per asset, computed as a rolling mean of the most recent 100 completed image-description jobs. Falls back to a 1.5s default when no jobs have completed since the server started.',
      ),
    estimatedTotalSeconds: z
      .number()
      .meta({ format: 'double' })
      .min(0)
      .describe(
        'Estimated wall-clock time to re-describe every eligible asset (force mode: every asset is re-processed, not just those without descriptions).',
      ),
    activeBackend: z.string().describe('Configured hardware acceleration backend (e.g. "auto", "cuda")'),
    activeModel: z.string().describe('Configured image description model name'),
  })
  .meta({ id: 'ImageDescriptionRequeueEstimateDto' });

export class ImageDescriptionRequeueEstimateDto extends createZodDto(ImageDescriptionRequeueEstimateSchema) {}

const ImageDescriptionRequeueResponseSchema = z
  .object({
    queued: z.boolean().describe('Whether the queue-all job was newly enqueued (false = already in-flight)'),
  })
  .meta({ id: 'ImageDescriptionRequeueResponseDto' });

export class ImageDescriptionRequeueResponseDto extends createZodDto(ImageDescriptionRequeueResponseSchema) {}

const SmartAlbumReevaluateEstimateSchema = z
  .object({
    totalAssets: z
      .int()
      .min(0)
      .describe('Total image assets that will be evaluated (currently equals withDescription)'),
    withDescription: z.int().min(0).describe('Image assets with a successfully completed description'),
  })
  .meta({ id: 'SmartAlbumReevaluateEstimateDto' });

export class SmartAlbumReevaluateEstimateDto extends createZodDto(SmartAlbumReevaluateEstimateSchema) {}

const SmartAlbumReevaluateResponseSchema = z
  .object({
    queued: z.boolean().describe('Whether the re-evaluate job was newly enqueued (false = already in-flight)'),
  })
  .meta({ id: 'SmartAlbumReevaluateResponseDto' });

export class SmartAlbumReevaluateResponseDto extends createZodDto(SmartAlbumReevaluateResponseSchema) {}

/** Known built-in smart-album kinds. Keep aligned with SystemConfig['smartAlbums']['builtIn']. */
export const SMART_ALBUM_BUILT_IN_KINDS = [
  'travel',
  'documents',
  'screenshots',
  'food',
  'pets',
  'nature',
] as const satisfies readonly (keyof SystemConfig['smartAlbums']['builtIn'])[];
export type SmartAlbumBuiltInKind = (typeof SMART_ALBUM_BUILT_IN_KINDS)[number];

const SmartAlbumReevaluateRequestSchema = z
  .object({
    kind: z
      .enum(SMART_ALBUM_BUILT_IN_KINDS)
      .meta({ id: 'SmartAlbumBuiltInKind' })
      .optional()
      .describe('Optional built-in kind to scope the re-evaluation to. Omit to re-evaluate every enabled kind.'),
  })
  .meta({ id: 'SmartAlbumReevaluateRequestDto' });

export class SmartAlbumReevaluateRequestDto extends createZodDto(SmartAlbumReevaluateRequestSchema) {}

// FL-66: the settings editor's baseline. The revision is a digest of the saved settings; a save
// that sends it back as `expectedRevision` is refused (409) when the settings changed since.
const AdminConfigRevisionResponseSchema = z
  .object({
    config: AdminConfigSchema,
    revision: z
      .string()
      .describe(
        'Changes whenever a saved setting changes; send it back as expectedRevision so a save made against older settings is refused',
      ),
  })
  .meta({ id: 'AdminConfigRevisionResponseDto' });

export class AdminConfigRevisionResponseDto extends createZodDto(AdminConfigRevisionResponseSchema) {}

const AdminConfigRevisionUpdateSchema = z
  .object({
    config: AdminConfigSchema,
    expectedRevision: z
      .string()
      .min(1)
      .describe(
        'The revision the changes were made against. When the saved settings no longer match it the update is refused with 409 and nothing is changed',
      ),
  })
  .meta({ id: 'AdminConfigRevisionUpdateDto' });

export class AdminConfigRevisionUpdateDto extends createZodDto(AdminConfigRevisionUpdateSchema) {}

// FL-66: the settings change history, newest first. Values are what an administrator can read,
// JSON encoded and shortened; credentials only say whether they were replaced or cleared.
const SystemConfigHistoryChangeSchema = z
  .object({
    path: z.string().describe('The changed setting, as a dotted path such as trash.days'),
    before: z.string().nullable().describe('The value before the change, JSON encoded; null for a credential'),
    after: z.string().nullable().describe('The value after the change, JSON encoded; null for a credential'),
    credential: z
      .enum(['replaced', 'cleared'])
      .optional()
      .describe('Set for a write-only credential: whether it was replaced or cleared. Its value is never recorded')
      .meta({ id: 'SystemConfigHistoryCredentialChange' }),
  })
  .meta({ id: 'SystemConfigHistoryChangeDto' });

const SystemConfigHistoryEntrySchema = z
  .object({
    id: z.string().describe('Entry ID'),
    createdAt: z.string().describe('When the change was saved (ISO 8601)'),
    actorId: z.string().nullable().describe('The administrator who saved the change'),
    actorName: z.string().nullable().describe("The administrator's name when the change was saved"),
    title: z
      .string()
      .nullable()
      .optional()
      .describe('The entry title, such as "Updated email server password"; absent for a settings save'),
    kind: z
      .enum(['settings', 'credential', 'review'])
      .optional()
      .describe('What the entry records; absent for entries saved before it was recorded')
      .meta({ id: 'SystemConfigHistoryKind' }),
    changes: z.array(SystemConfigHistoryChangeSchema).describe('Every changed setting'),
    omittedChanges: z.int().min(0).describe('Changed settings left out because the entry reached its limit'),
  })
  .meta({ id: 'SystemConfigHistoryEntryDto' });

const SystemConfigHistoryResponseSchema = z
  .object({
    entries: z.array(SystemConfigHistoryEntrySchema).describe('The newest settings changes first'),
  })
  .meta({ id: 'SystemConfigHistoryResponseDto' });

export class SystemConfigHistoryResponseDto extends createZodDto(SystemConfigHistoryResponseSchema) {}
