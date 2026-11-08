import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** FL-1298: merging one album into another, and the run record that lets a person undo it. */

export const AlbumChangeRunKindSchema = z.enum(['merge', 'cleanup', 'heal']).describe('What the run did').meta({
  id: 'AlbumChangeRunKind',
});

export const AlbumChangeRunStatusSchema = z
  .enum(['running', 'done', 'failed', 'undone'])
  .describe('Where the run has got to')
  .meta({ id: 'AlbumChangeRunStatus' });

const AlbumMergeSchema = z
  .object({ otherId: z.uuidv4().describe('The album to merge with this one') })
  .meta({ id: 'AlbumMergeDto' });

const AlbumMergePreviewParamSchema = z.object({
  id: z.uuidv4().describe('Album ID'),
  otherId: z.uuidv4().describe('The album to merge with this one'),
});

const AlbumMergePreviewResponseSchema = z
  .object({
    winnerId: z.uuidv4().describe('The album that keeps its name and icon. The other is merged in and removed.'),
    total: z.int().min(0).describe('Photos the merged album will hold that this session may see, each counted once'),
    inBoth: z.int().min(0).describe('Of those, how many are in both albums'),
    winnerShared: z
      .boolean()
      .describe('The album that stays is shared, by people, a public link or a shared space, who will see both'),
    loserShared: z
      .boolean()
      .describe('The album merged away is shared. Its people and public links lose access; they are not moved'),
  })
  .meta({ id: 'AlbumMergePreviewResponseDto' });

const AlbumMergeResponseSchema = z
  .object({
    runId: z.uuidv7().describe('The merge, for undoing it'),
    winnerId: z.uuidv4().describe('The album that stayed'),
  })
  .meta({ id: 'AlbumMergeResponseDto' });

const AlbumChangeRunResponseSchema = z
  .object({
    id: z.uuidv7().describe('Run ID'),
    kind: AlbumChangeRunKindSchema,
    status: AlbumChangeRunStatusSchema,
    createdAt: z.string().describe('When the run started'),
    canUndo: z.boolean().describe('Undo is available now; false while the run is still in progress'),
    summary: z.record(z.string(), z.unknown()).describe('What the run did: names and counts'),
  })
  .meta({ id: 'AlbumChangeRunResponseDto' });

const AlbumChangeRunLatestResponseSchema = z
  .object({
    run: AlbumChangeRunResponseSchema.nullable().describe('The newest run that can still be undone, if any'),
  })
  .meta({ id: 'AlbumChangeRunLatestResponseDto' });

const AlbumChangeUndoResponseSchema = z
  .object({
    reversed: z.int().min(0).describe('Changes taken back'),
    skipped: z
      .array(z.string())
      .describe('Names of what was left alone because it was changed after the run; a later edit wins'),
  })
  .meta({ id: 'AlbumChangeUndoResponseDto' });

export class AlbumMergeDto extends createZodDto(AlbumMergeSchema) {}
export class AlbumMergePreviewParamDto extends createZodDto(AlbumMergePreviewParamSchema) {}
export class AlbumMergePreviewResponseDto extends createZodDto(AlbumMergePreviewResponseSchema) {}
export class AlbumMergeResponseDto extends createZodDto(AlbumMergeResponseSchema) {}
export class AlbumChangeRunLatestResponseDto extends createZodDto(AlbumChangeRunLatestResponseSchema) {}
export class AlbumChangeUndoResponseDto extends createZodDto(AlbumChangeUndoResponseSchema) {}
export type AlbumChangeRunResponseDto = z.infer<typeof AlbumChangeRunResponseSchema>;
