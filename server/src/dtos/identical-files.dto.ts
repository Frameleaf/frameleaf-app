import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { StorageWalkCursor } from 'src/repositories/storage.repository.js';

/**
 * FL-413: identical files are stored once. Files with the same SHA-256 and size, read from disk, are
 * merged automatically for the whole server; there is no account to choose. These are the admin status
 * and "Check again" shapes, and the per-photo "Restore own file" undo.
 */

export const IDENTICAL_FILES_STAGES = ['scan', 'link', 'merge', 'orphans', 'done'] as const;
export type IdenticalFilesStage = (typeof IDENTICAL_FILES_STAGES)[number];

export const IDENTICAL_FILES_TRIGGERS = ['manual', 'immich-import'] as const;
export type IdenticalFilesTrigger = (typeof IDENTICAL_FILES_TRIGGERS)[number];

export const IDENTICAL_FILES_PROBLEM_KINDS = [
  /** The file is not where the photo says. */
  'missing',
  /** The file could not be read. */
  'unreadable',
  /** The file on disk is not what the photo recorded, or it changed while the run worked on it. */
  'changed',
  /** A link of this photo was undone: it is never linked again automatically. */
  'undone',
  /** Two identical photos in one library that a merge could not carry over; Duplicate review lists them. */
  'check-before-merging',
  /** An extra copy something still uses (often a backup); the next run tries again. */
  'kept-for-now',
  /** An orphaned file that is damaged; it waits in Unused files and was not imported. */
  'damaged',
  /** An orphaned file its owner has no quota left for. */
  'over-quota',
  /** Something the run could not decide, such as an orphan with no owner. */
  'needs-a-look',
  /** A step failed; the run stopped and carries on from its cursor when it runs again. */
  'failed',
] as const;
export type IdenticalFilesProblemKind = (typeof IDENTICAL_FILES_PROBLEM_KINDS)[number];

const IdenticalFilesCountsSchema = z
  .object({
    scanned: z.int().nonnegative().describe('Originals read from disk'),
    upgraded: z.int().nonnegative().describe('SHA-1 records upgraded to SHA-256'),
    registered: z.int().nonnegative().describe('Originals given a storage record'),
    linked: z.int().nonnegative().describe('Photos pointed at another person’s identical file'),
    photosMerged: z.int().nonnegative().describe('Identical photos in one library sent to the Trash by a merge'),
    filesMovedToUnused: z.int().nonnegative().describe('Extra copies moved to Unused files'),
    bytesMovedToUnused: z.int().nonnegative().describe('Bytes moved to Unused files'),
    orphansFound: z.int().nonnegative().describe('Media files nothing pointed at'),
    orphanDuplicates: z.int().nonnegative().describe('Orphans whose content the owner already had'),
    photosRecovered: z.int().nonnegative().describe('Orphans brought back as photos'),
    damaged: z.int().nonnegative().describe('Damaged orphans moved to Unused files'),
    problems: z.int().nonnegative().describe('Problems found, including those past the listed ones'),
  })
  .meta({ id: 'IdenticalFilesCountsDto' });
export type IdenticalFilesCounts = z.infer<typeof IdenticalFilesCountsSchema>;

export const emptyIdenticalFilesCounts = (): IdenticalFilesCounts => ({
  scanned: 0,
  upgraded: 0,
  registered: 0,
  linked: 0,
  photosMerged: 0,
  filesMovedToUnused: 0,
  bytesMovedToUnused: 0,
  orphansFound: 0,
  orphanDuplicates: 0,
  photosRecovered: 0,
  damaged: 0,
  problems: 0,
});

const IdenticalFilesProblemSchema = z
  .object({
    kind: z.enum(IDENTICAL_FILES_PROBLEM_KINDS).describe('What went wrong').meta({ id: 'IdenticalFilesProblemKind' }),
    assetId: z.string().nullable().describe('The photo concerned, when there is one'),
    path: z.string().nullable().describe('An orphaned file, relative to the media location'),
    detail: z.string().nullable().describe('More about it, such as the reason a merge was held back'),
  })
  .meta({ id: 'IdenticalFilesProblemDto' });
export type IdenticalFilesProblem = z.infer<typeof IdenticalFilesProblemSchema>;

const IdenticalFilesStatusSchema = z
  .object({
    status: z
      .enum(['never-run', 'running', 'completed'])
      .describe('Where the latest run stands')
      .meta({ id: 'IdenticalFilesRunStatus' }),
    stage: z
      .enum(IDENTICAL_FILES_STAGES)
      .describe('The stage the latest run is in or ended in')
      .meta({ id: 'IdenticalFilesStage' })
      .nullable(),
    trigger: z
      .enum(IDENTICAL_FILES_TRIGGERS)
      .describe('What started the latest run')
      .meta({ id: 'IdenticalFilesTrigger' })
      .nullable(),
    startedAt: z.string().meta({ format: 'date-time' }).nullable(),
    finishedAt: z.string().meta({ format: 'date-time' }).nullable(),
    totalOriginals: z.int().nonnegative().describe('Managed originals when the run started (scan progress total)'),
    counts: IdenticalFilesCountsSchema,
    recovered: z
      .array(
        z.object({
          ownerId: z.string(),
          photos: z.int().nonnegative(),
          albumId: z.string().nullable().describe('The owner’s Recovered Media album'),
        }),
      )
      .describe('Photos recovered per owner'),
    problems: z.array(IdenticalFilesProblemSchema).describe('The first problems found (at most 200)'),
  })
  .meta({ id: 'IdenticalFilesStatusDto' });

const IdenticalFilesChangeSchema = z
  .object({
    id: z.string().describe('Change id'),
    kind: z
      .enum(['link'])
      .describe('`link`: the photo was pointed at another person’s identical file')
      .meta({ id: 'IdenticalFilesChangeKind' }),
    keptAssetId: z.string().nullable().describe('The photo whose file was kept'),
    createdAt: z.string().meta({ format: 'date-time' }),
    undoneAt: z.string().meta({ format: 'date-time' }).nullable(),
    restorable: z.boolean().describe('The photo’s own file waits in Unused files and can be restored'),
  })
  .meta({ id: 'IdenticalFilesChangeDto' });

/** FL-520: a quick count of extra copies on the drive, without reading any file. */
const IdenticalFilesExtraCopiesSchema = z
  .object({
    files: z.int().nonnegative().describe('Extra files on the drive that hold the same content as another'),
    contents: z.int().nonnegative().describe('Photos and videos those extra files are copies of'),
    bytes: z.int().nonnegative().describe('Space the extra files take'),
  })
  .meta({ id: 'IdenticalFilesExtraCopiesDto' });

export class IdenticalFilesExtraCopiesDto extends createZodDto(IdenticalFilesExtraCopiesSchema) {}
export class IdenticalFilesStatusDto extends createZodDto(IdenticalFilesStatusSchema) {}
export class IdenticalFilesChangeDto extends createZodDto(IdenticalFilesChangeSchema) {}

/** The run's durable state (`system_metadata`), saved after every batch. */
export type IdenticalFilesState = {
  runId: string;
  trigger: IdenticalFilesTrigger;
  /** The administrator who asked for the run; orphans in a deleted user's folder become theirs. */
  requestedBy: string | null;
  /** FL-414: the Immich import's derived run this run was started for. */
  importRunId?: string | null;
  status: 'running' | 'completed';
  stage: IdenticalFilesStage;
  /** Where the current stage stopped: an asset id, a content key, or null at its start. */
  cursor: string | null;
  /** The orphan stage's resumable walk. */
  walk: StorageWalkCursor | null;
  startedAt: string;
  finishedAt: string | null;
  totalOriginals: number;
  counts: IdenticalFilesCounts;
  /** Photos recovered this run, per owner. */
  recovered: Record<string, number>;
  /** Every owner's Recovered Media album, kept across runs so a renamed album is still used. */
  recoveredAlbums: Record<string, string>;
  problems: IdenticalFilesProblem[];
};
