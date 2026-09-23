import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { Library } from 'src/database.js';
import { LibraryImportPathReasonSchema, MediaOperationStatusSchema } from 'src/enum.js';
import { isoDatetimeToDate, stringToBool } from 'src/validation.js';

/** FL-78: the library form's limits. A folder or pattern longer than this is not a real one. */
export const LIBRARY_NAME_MAX_LENGTH = 160;
export const LIBRARY_PATH_MAX_LENGTH = 1024;

const stringArrayMax128 = z
  .array(z.string().max(LIBRARY_PATH_MAX_LENGTH))
  .max(128)
  .refine((arr) => arr.every((s) => s.trim() !== ''), 'Array items must not be empty')
  .refine((arr) => new Set(arr).size === arr.length, 'Array must have unique items');

const CreateLibrarySchema = z
  .object({
    ownerId: z.uuidv4().describe('Owner user ID. Fixed once the library exists.'),
    name: z.string().min(1).max(LIBRARY_NAME_MAX_LENGTH).optional().describe('Library name'),
    importPaths: stringArrayMax128.optional().describe('Import paths (max 128)'),
    exclusionPatterns: stringArrayMax128.optional().describe('Exclusion patterns (max 128)'),
  })
  .meta({ id: 'CreateLibraryDto' });

const UpdateLibrarySchema = z
  .object({
    name: z.string().min(1).max(LIBRARY_NAME_MAX_LENGTH).optional().describe('Library name'),
    importPaths: stringArrayMax128.optional().describe('Import paths (max 128)'),
    exclusionPatterns: stringArrayMax128.optional().describe('Exclusion patterns (max 128)'),
  })
  .meta({ id: 'UpdateLibraryDto' });

export interface CrawlOptionsDto {
  pathsToCrawl: string[];
  includeHidden?: boolean;
  exclusionPatterns?: string[];
}

export interface WalkOptionsDto extends CrawlOptionsDto {
  take: number;
}

const ValidateLibrarySchema = z
  .object({
    importPaths: stringArrayMax128.optional().describe('Import paths to validate (max 128)'),
    exclusionPatterns: stringArrayMax128.optional().describe('Exclusion patterns (max 128)'),
  })
  .meta({ id: 'ValidateLibraryDto' });

const ValidateLibraryImportPathResponseSchema = z
  .object({
    importPath: z.string().describe('Import path'),
    isValid: z.boolean().describe('Is valid'),
    reason: LibraryImportPathReasonSchema,
    message: z.string().optional().describe('Validation message'),
  })
  .meta({ id: 'ValidateLibraryImportPathResponseDto' });

const ValidateLibraryResponseSchema = z
  .object({
    importPaths: z
      .array(ValidateLibraryImportPathResponseSchema)
      .optional()
      .describe('Validation results for import paths'),
  })
  .meta({ id: 'ValidateLibraryResponseDto' });

const LibrarySearchSchema = z
  .object({
    withDeleted: stringToBool.optional().describe('Include libraries whose removal is still in progress'),
  })
  .meta({ id: 'LibrarySearchDto' });

const LibraryScanPhaseSchema = z
  .enum(['crawl', 'check', 'done'])
  .describe('Scan phase')
  .meta({ id: 'LibraryScanPhase' });

const LibraryScanStopReasonSchema = z
  .enum(['paths_changed', 'library_removed', 'owner_deleted'])
  .describe('Why the server stopped a scan on its own')
  .meta({ id: 'LibraryScanStopReason' });

/**
 * The library's latest scan (FL-78): the durable job's own state, never a guess. Counts are
 * items, never names or paths of items.
 */
const LibraryScanResponseSchema = z
  .object({
    operationId: z.uuidv4().describe('The scan job, a media operation of kind library_scan'),
    status: MediaOperationStatusSchema,
    phase: LibraryScanPhaseSchema,
    progress: z.number().min(0).max(100).meta({ format: 'double' }).describe('Progress, 0 to 100'),
    processedUnits: z.int().min(0).describe('Files and items handled so far'),
    totalUnits: z.int().min(0).describe('Files and items known so far; grows while the folders are read'),
    added: z.int().min(0).describe('New items indexed'),
    checked: z.int().min(0).describe('Indexed items checked against their folder'),
    updated: z.int().min(0).describe('Items whose file changed and are read again'),
    offlined: z.int().min(0).describe('Items whose file is missing, marked offline'),
    onlined: z.int().min(0).describe('Offline items whose file is back'),
    pauseRequested: z.boolean().describe('A pause was asked for and the scan has not reached it yet'),
    retrying: z.boolean().describe('The scan failed once and waits for its automatic retry'),
    stopReason: LibraryScanStopReasonSchema.nullable(),
    errorCode: z.string().nullable().describe('Stable failure code'),
    error: z.string().nullable().describe('Failure detail for the administrator'),
    createdAt: isoDatetimeToDate.describe('When the scan was asked for'),
    startedAt: isoDatetimeToDate.nullable().describe('When the scan first started'),
    finishedAt: isoDatetimeToDate.nullable().describe('When the scan ended'),
  })
  .meta({ id: 'LibraryScanResponseDto' });

const LibraryResponseSchema = z
  .object({
    id: z.uuidv4().describe('Library ID'),
    ownerId: z.uuidv4().describe('Owner user ID'),
    name: z.string().describe('Library name'),
    assetCount: z.int().describe('Number of assets'),
    importPaths: z.array(z.string()).describe('Import paths'),
    exclusionPatterns: z.array(z.string()).describe('Exclusion patterns'),
    createdAt: isoDatetimeToDate.describe('Creation date'),
    updatedAt: isoDatetimeToDate.describe('Last update date'),
    refreshedAt: isoDatetimeToDate.nullable().describe('Last refresh date'),
    deletedAt: isoDatetimeToDate.nullable().describe('When removal was confirmed; set while removal is in progress'),
    scan: LibraryScanResponseSchema.nullable().describe('The latest scan, or null if the library was never scanned'),
  })
  .meta({ id: 'LibraryResponseDto' });

const LibraryStatsResponseSchema = z
  .object({
    photos: z.int().describe('Number of photos'),
    videos: z.int().describe('Number of videos'),
    total: z.int().describe('Total number of assets'),
    usage: z.int().describe('Storage usage in bytes'),
    usagePhysical: z.int().describe('Storage usage in bytes, counting each distinct original file once'),
  })
  .meta({ id: 'LibraryStatsResponseDto' });

const ManagedUploadsStatsResponseSchema = z
  .object({
    ownerId: z.uuidv4().describe('Account whose uploads these are'),
    photos: z.int().describe('Number of photos'),
    videos: z.int().describe('Number of videos'),
    total: z.int().describe('Total number of assets'),
    usage: z.int().describe('Storage usage in bytes'),
    usagePhysical: z.int().describe('Storage usage in bytes, counting each distinct original file once'),
  })
  .meta({ id: 'ManagedUploadsStatsResponseDto' });

/**
 * The first stage of removing a library (FL-78): what goes and what stays, and a token that the
 * second stage must present so a removal is only ever confirmed against what was reviewed.
 */
const LibraryRemovalReviewSchema = z
  .object({
    libraryId: z.uuidv4().describe('Library ID'),
    name: z.string().describe('Library name, to be typed to confirm'),
    ownerId: z.uuidv4().describe('Owner user ID'),
    photos: z.int().describe('Indexed photos that will be removed'),
    videos: z.int().describe('Indexed videos that will be removed'),
    total: z.int().describe('Indexed items that will be removed'),
    usage: z.int().describe('Original bytes those items reference'),
    offline: z.int().describe('Items already offline'),
    albums: z.int().describe('Albums that lose items'),
    sharedLinks: z.int().describe('Shared links that lose items'),
    faces: z.int().describe('Detected faces that will be removed with their items'),
    scanActive: z.boolean().describe('A scan is running and will be stopped'),
    originalsKept: z.boolean().describe('Source files in the import folders are never deleted'),
    reviewToken: z.string().describe('Present this to confirm the removal'),
  })
  .meta({ id: 'LibraryRemovalReviewDto' });

const LibraryRemovalSchema = z
  .object({
    reviewToken: z.string().min(1).max(128).describe('The token from the removal review'),
    confirmName: z.string().min(1).max(LIBRARY_NAME_MAX_LENGTH).describe('The library name, typed to confirm'),
  })
  .meta({ id: 'LibraryRemovalDto' });

export class CreateLibraryDto extends createZodDto(CreateLibrarySchema) {}
export class UpdateLibraryDto extends createZodDto(UpdateLibrarySchema) {}
export class ValidateLibraryDto extends createZodDto(ValidateLibrarySchema) {}
export class ValidateLibraryResponseDto extends createZodDto(ValidateLibraryResponseSchema) {}
export class ValidateLibraryImportPathResponseDto extends createZodDto(ValidateLibraryImportPathResponseSchema) {}
export class LibraryResponseDto extends createZodDto(LibraryResponseSchema) {}
export class LibraryStatsResponseDto extends createZodDto(LibraryStatsResponseSchema) {}
export class LibrarySearchDto extends createZodDto(LibrarySearchSchema) {}
export class LibraryScanResponseDto extends createZodDto(LibraryScanResponseSchema) {}
export class ManagedUploadsStatsResponseDto extends createZodDto(ManagedUploadsStatsResponseSchema) {}
export class LibraryRemovalReviewDto extends createZodDto(LibraryRemovalReviewSchema) {}
export class LibraryRemovalDto extends createZodDto(LibraryRemovalSchema) {}

export function mapLibrary(entity: Library, scan: LibraryScanResponseDto | null = null): LibraryResponseDto {
  const assetCount = entity.assets ? entity.assets.length : 0;
  return {
    id: entity.id,
    ownerId: entity.ownerId,
    name: entity.name,
    createdAt: entity.createdAt,
    updatedAt: entity.updatedAt,
    refreshedAt: entity.refreshedAt,
    assetCount,
    importPaths: entity.importPaths,
    exclusionPatterns: entity.exclusionPatterns,
    deletedAt: entity.deletedAt ?? null,
    scan,
  };
}
