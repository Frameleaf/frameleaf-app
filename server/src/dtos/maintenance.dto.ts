import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MaintenanceAction, MaintenanceActionSchema, StorageFolderSchema } from 'src/enum.js';

/**
 * FL-81: the reason is shown to everyone on the maintenance screen, signed in or not, so it is plain
 * public text: control and invisible formatting characters (line breaks, bidi overrides) become
 * spaces, runs of spaces collapse and the result is trimmed. Leaving the reason out keeps the current
 * one; `null` or a blank string clears it (both parse to `null`).
 */
const maintenanceReason = z
  .string()
  .max(200)
  .transform(
    (value) =>
      value
        .replaceAll(/[\p{Cc}\p{Cf}\u{2028}\u{2029}]+/gu, ' ')
        .replaceAll(/ {2,}/g, ' ')
        .trim() || null,
  )
  .nullable()
  .optional()
  .describe(
    'Why the server is in maintenance, shown to everyone on the maintenance screen (max 200 characters). Omit to keep the current reason; null or an empty string clears it',
  );

const SetMaintenanceModeSchema = z
  .object({
    action: MaintenanceActionSchema,
    reason: maintenanceReason,
    restoreBackupFilename: z.string().optional().describe('Restore backup filename'),
    keepSafetyBackup: z
      .boolean()
      .optional()
      .describe(
        'Keep the safety backup of the current database that a restore makes first (default true); it is always kept when the restore fails',
      ),
  })
  .refine(
    (data) => data.action !== MaintenanceAction.RestoreDatabase || (data.restoreBackupFilename?.length ?? 0) > 0,
    { error: 'Backup filename is required when action is restore_database', path: ['restoreBackupFilename'] },
  )
  .meta({ id: 'SetMaintenanceModeDto' });

const MaintenanceLoginSchema = z
  .object({
    token: z.string().optional().describe('Maintenance token'),
  })
  .meta({ id: 'MaintenanceLoginDto' });

const MaintenanceAuthSchema = z
  .object({
    username: z.string().describe('Maintenance username'),
  })
  .meta({ id: 'MaintenanceAuthDto' });

const MaintenanceStatusResponseSchema = z
  .object({
    active: z.boolean(),
    action: MaintenanceActionSchema,
    progress: z.int().optional(),
    task: z.string().optional(),
    error: z.string().optional(),
    reason: z.string().optional().describe('Why the server is in maintenance, as set by the administrator (public)'),
  })
  .meta({ id: 'MaintenanceStatusResponseDto' });

const MaintenanceDetectInstallStorageFolderSchema = z
  .object({
    folder: StorageFolderSchema,
    readable: z.boolean().describe('Whether the folder is readable'),
    writable: z.boolean().describe('Whether the folder is writable'),
    files: z.int().describe('Number of files in the folder'),
  })
  .meta({ id: 'MaintenanceDetectInstallStorageFolderDto' });

const MaintenanceDetectInstallResponseSchema = z
  .object({
    storage: z.array(MaintenanceDetectInstallStorageFolderSchema),
  })
  .meta({ id: 'MaintenanceDetectInstallResponseDto' });

export class SetMaintenanceModeDto extends createZodDto(SetMaintenanceModeSchema) {}
export class MaintenanceLoginDto extends createZodDto(MaintenanceLoginSchema) {}
export class MaintenanceAuthDto extends createZodDto(MaintenanceAuthSchema) {}
export class MaintenanceStatusResponseDto extends createZodDto(MaintenanceStatusResponseSchema) {}
export class MaintenanceDetectInstallResponseDto extends createZodDto(MaintenanceDetectInstallResponseSchema) {}
