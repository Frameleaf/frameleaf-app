import { createZodDto } from 'nestjs-zod';
import z from 'zod';

// FL-1537: the review of the photos found on the drive (FL-1531 mock). New enums of their own: nothing
// here adds a value to an enum another response already uses.

const FoundFileOutcomeSchema = z
  .enum(['back', 'added', 'spare', 'needs', 'left'])
  .describe(
    'What became of the file: put back under a photo that was missing, added as a new photo, a spare copy of a photo that is there, waiting for a person, or left alone at a person’s word',
  )
  .meta({ id: 'FoundFileOutcome' });

const FoundFileReasonSchema = z
  .enum(['no-owner', 'wont-open', 'over-limit', 'asked'])
  .describe(
    'Why a file waits for a person: its folder belongs to no account, it does not open, its account has no room for it, or putting photos back by themselves is switched off',
  )
  .meta({ id: 'FoundFileReason' });

const count = z.int().nonnegative();
const dateTime = z.string().meta({ format: 'date-time' });

const FoundFileGroupSchema = z
  .object({
    reason: FoundFileReasonSchema,
    ownerId: z.uuidv4().nullable().describe('The account the files belong to; null for a folder no account uses'),
    folder: z.string().nullable().describe('The folder no account uses; null when the files have an account'),
    count,
    sizeInBytes: count,
  })
  .meta({ id: 'FoundFileGroupDto' });

const FoundFilesSummaryResponseSchema = z
  .object({
    back: count.describe('Files put back under a photo that was missing'),
    added: count.describe('Files added to a library as new photos'),
    spare: count.describe('Second copies of photos that are in a library'),
    spareSizeInBytes: count,
    needs: count.describe('Files waiting for a person'),
    left: count.describe('Files a person chose to leave alone'),
    tidied: z
      .object({
        previews: count.describe('Previews cleared because their photo is gone'),
        previewSizeInBytes: count,
        sidecars: count.describe('XMP files joined to the photo of the same name'),
      })
      .meta({ id: 'FoundFilesTidiedDto' }),
    groups: z.array(FoundFileGroupSchema).describe('The files waiting for a person, one group per decision'),
  })
  .meta({ id: 'FoundFilesSummaryResponseDto' });

const FoundFileListSchema = z
  .object({
    outcome: FoundFileOutcomeSchema,
    reason: FoundFileReasonSchema.optional(),
    folder: z.string().min(1).optional().describe('Only the files in this folder no account uses'),
    ownerId: z.uuidv4().optional().describe('Only the files in this account’s folders'),
    cursor: z.uuidv7().optional().describe('The id of the last file of the page before'),
    size: z.coerce.number().int().positive().max(500).default(100).optional().describe('Files per page'),
  })
  .meta({ id: 'FoundFileListDto' });

const item = {
  id: z.uuidv7(),
  fileName: z.string(),
  path: z.string(),
  sizeInBytes: count,
  outcome: FoundFileOutcomeSchema,
  reason: FoundFileReasonSchema.nullable(),
  ownerId: z
    .uuidv4()
    .nullable()
    .describe('The account the file belongs to: its folder’s, else its photo’s; null when neither is known'),
  assetId: z.uuidv4().nullable().describe('The photo it went back under, became, or copies'),
  viewable: z
    .boolean()
    .describe('Whether the person asking may see the picture: it is their own, or it belongs to no account'),
  sortedAt: dateTime,
};

const FoundFileResponseSchema = z.object(item).meta({ id: 'FoundFileResponseDto' });

const FoundFileListResponseSchema = z
  .object({
    items: z.array(FoundFileResponseSchema),
    nextCursor: z.uuidv7().nullable().describe('Pass as `cursor` for the next page; null on the last page'),
  })
  .meta({ id: 'FoundFileListResponseDto' });

const FoundFileStepSchema = z
  .object({
    step: z.string().describe('What was done: found, read, back, added, spare, undone, again, …'),
    at: dateTime,
    outcome: z.string().optional(),
    facts: z.record(z.string(), z.unknown()).optional(),
  })
  .meta({ id: 'FoundFileStepDto' });

const FoundFileDetailResponseSchema = z
  .object({
    ...item,
    previousPath: z.string().nullable().describe('Where the photo it went back under pointed before'),
    steps: z.array(FoundFileStepSchema).describe('What was done with the file, oldest first'),
  })
  .meta({ id: 'FoundFileDetailResponseDto' });

const FoundFilesResolveSchema = z
  .object({
    reason: z.enum(['no-owner', 'over-limit', 'asked']).meta({ id: 'FoundFileDecision' }),
    folder: z.string().min(1).optional().describe('With no-owner: the folder the files are in'),
    ownerId: z
      .uuidv4()
      .optional()
      .describe('With no-owner: the account whose library the files go to. With over-limit: the account'),
    cursor: z.uuidv7().optional().describe('`nextCursor` of the call before'),
  })
  .meta({ id: 'FoundFilesResolveDto' });

const FoundFilesResolveResponseSchema = z
  .object({
    back: count,
    added: count,
    spare: count,
    waiting: count.describe('Files that still wait for a person'),
    skipped: count.describe('Files that changed or went since they were read; the next check sorts them'),
    nextCursor: z.uuidv7().nullable().describe('Call again with this as `cursor`; null when the group is done'),
  })
  .meta({ id: 'FoundFilesResolveResponseDto' });

const FoundFilesDeleteSpareSchema = z
  .object({
    ids: z.array(z.uuidv7()).min(1).max(100).optional().describe('Only these spare copies; left out, all of them'),
    cursor: z.uuidv7().optional().describe('`nextCursor` of the call before'),
  })
  .meta({ id: 'FoundFilesDeleteSpareDto' });

const FoundFilesDeleteSpareResponseSchema = z
  .object({
    deleted: count,
    freedBytes: count,
    kept: count.describe('Copies kept: the photo they copy could not be shown to be there and open'),
    nextCursor: z.uuidv7().nullable().describe('Call again with this as `cursor`; null when all were looked at'),
  })
  .meta({ id: 'FoundFilesDeleteSpareResponseDto' });

const FoundFilesArchiveSchema = z
  .object({
    folder: z.string().min(1).optional().describe('Only the files in this folder no account uses'),
    ownerId: z.uuidv4().optional().describe('Only the files in this account’s folders'),
  })
  .meta({ id: 'FoundFilesArchiveDto' });

export class FoundFilesSummaryResponseDto extends createZodDto(FoundFilesSummaryResponseSchema) {}
export class FoundFileListDto extends createZodDto(FoundFileListSchema) {}
export class FoundFileResponseDto extends createZodDto(FoundFileResponseSchema) {}
export class FoundFileListResponseDto extends createZodDto(FoundFileListResponseSchema) {}
export class FoundFileDetailResponseDto extends createZodDto(FoundFileDetailResponseSchema) {}
export class FoundFilesResolveDto extends createZodDto(FoundFilesResolveSchema) {}
export class FoundFilesResolveResponseDto extends createZodDto(FoundFilesResolveResponseSchema) {}
export class FoundFilesDeleteSpareDto extends createZodDto(FoundFilesDeleteSpareSchema) {}
export class FoundFilesDeleteSpareResponseDto extends createZodDto(FoundFilesDeleteSpareResponseSchema) {}
export class FoundFilesArchiveDto extends createZodDto(FoundFilesArchiveSchema) {}
