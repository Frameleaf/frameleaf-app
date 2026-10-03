import { createZodDto } from 'nestjs-zod';
import z from 'zod';

const StageProgressSchema = z
  .object({
    done: z.int().min(0).describe('Items finished in this stage'),
    total: z.int().min(0).describe('Items this stage covers'),
  })
  .meta({ id: 'StorageMigrationStageProgressDto' });

const StorageMigrationStatusResponseSchema = z
  .object({
    stage: z
      .enum(['pending', 'checking', 'relinking', 'linking', 'trashing', 'done'])
      .describe('Current stage; pending until the server has started the migration')
      .meta({ id: 'StorageMigrationStage' }),
    required: z.boolean().describe('False when the library had nothing to combine (a fresh install)'),
    background: z.boolean().describe('An administrator chose to let it finish in the background'),
    showInGettingReady: z.boolean().describe('Whether the Getting Ready screen waits for it'),
    stages: z
      .object({
        checking: StageProgressSchema,
        relinking: StageProgressSchema,
        linking: StageProgressSchema,
        trashing: StageProgressSchema,
      })
      .describe('Progress of each stage'),
    relinked: z.int().min(0).describe('Missing originals relinked automatically'),
    toReview: z.int().min(0).describe('Missing originals left for review in Library Care'),
    skipped: z.int().min(0).describe('Files that could not be read or verified, skipped'),
    bytesFreed: z.int().min(0).describe('Bytes of extra copies moved to the file trash'),
    estimatedSecondsLeft: z.int().min(0).nullable().describe('Estimated time left, from the measured rate'),
    startedAt: z.string().nullable().describe('When the migration started'),
    finishedAt: z.string().nullable().describe('When the migration finished'),
  })
  .meta({ id: 'StorageMigrationStatusResponseDto' });

export class StorageMigrationStatusResponseDto extends createZodDto(StorageMigrationStatusResponseSchema) {}
