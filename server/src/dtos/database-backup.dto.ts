import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const DatabaseBackupSchema = z
  .object({
    filename: z.string().describe('Backup filename'),
    filesize: z.int().describe('Backup file size'),
    timezone: z.string().describe('Backup timezone'),
  })
  .meta({ id: 'DatabaseBackupDto' });

const DatabaseBackupListResponseSchema = z
  .object({
    backups: z.array(DatabaseBackupSchema).describe('List of backups'),
  })
  .meta({ id: 'DatabaseBackupListResponseDto' });

const DatabaseBackupUploadSchema = z
  .object({
    file: z.file().optional().describe('Database backup file'),
  })
  .meta({ id: 'DatabaseBackupUploadDto' });

const DatabaseBackupDeleteSchema = z
  .object({
    backups: z.array(z.string()).describe('Backup filenames to delete'),
  })
  .meta({ id: 'DatabaseBackupDeleteDto' });

/**
 * FL-362: the one backup schedule as the Backup settings show it. Backups run one after another in the
 * order of `places`; a place that is off is left out of a run.
 */
/** `local` is the copy of the library data on this server. */
const BackupSequencePlaceSchema = z.enum(['local', 'buddy', 'cloud']).meta({ id: 'BackupSequencePlace' });

const BackupScheduleResponseSchema = z
  .object({
    cronExpression: z.string().describe('The schedule in force, in the server time zone'),
    chosen: z
      .boolean()
      .describe('Whether the schedule was chosen in Backup settings; false while it is the one stored before'),
    timezone: z.string().describe('The server time zone the schedule runs in'),
    nextRunAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the next run starts'),
    places: z
      .array(
        z.object({
          id: BackupSequencePlaceSchema,
          on: z.boolean().describe('Whether a run backs up to this place'),
        }),
      )
      .describe('The places a run visits, in order'),
    run: z
      .object({
        startedAt: z.string().meta({ format: 'date-time' }),
        place: BackupSequencePlaceSchema,
      })
      .nullable()
      .describe('The run in progress'),
    lastFinishedAt: z.string().meta({ format: 'date-time' }).nullable().describe('When the last run ended'),
  })
  .meta({ id: 'BackupScheduleResponseDto' });

/**
 * FL-71 (CC-9, CommandCenter.jsx:1752-1800, 2362-2375): "Prove your backup can restore". A restore
 * test is due when either part has never been recorded, or the older record is more than
 * RESTORE_VERIFICATION_INTERVAL_DAYS old.
 */
const BackupRestoreVerificationResponseSchema = z
  .object({
    metadataVerifiedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When restoring the database was last proved'),
    originalsVerifiedAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When restoring the original files was last proved'),
    verifiedBy: z
      .object({ id: z.uuidv4(), name: z.string() })
      .nullable()
      .describe('The administrator who recorded the last test; null once that account is gone'),
    overdue: z.boolean().describe('Whether a restore test is due'),
    dueAt: z
      .string()
      .meta({ format: 'date-time' })
      .nullable()
      .describe('When the next test is due; null when a part has never been proved'),
    intervalDays: z.int().describe('How often a restore test is due'),
  })
  .meta({ id: 'BackupRestoreVerificationResponseDto' });

const BackupRestoreVerificationRecordSchema = z
  .object({
    metadata: z.boolean().describe('The database restored and was checked'),
    originals: z.boolean().describe('Original files restored and their checksums were verified'),
  })
  .refine(({ metadata, originals }) => metadata || originals, { message: 'Record at least one restored part' })
  .meta({ id: 'BackupRestoreVerificationRecordDto' });

export class BackupScheduleResponseDto extends createZodDto(BackupScheduleResponseSchema) {}
export class BackupRestoreVerificationResponseDto extends createZodDto(BackupRestoreVerificationResponseSchema) {}
export class BackupRestoreVerificationRecordDto extends createZodDto(BackupRestoreVerificationRecordSchema) {}
export class DatabaseBackupListResponseDto extends createZodDto(DatabaseBackupListResponseSchema) {}
export class DatabaseBackupUploadDto extends createZodDto(DatabaseBackupUploadSchema) {}
export class DatabaseBackupDeleteDto extends createZodDto(DatabaseBackupDeleteSchema) {}
