import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MediaHealthCategorySchema } from 'src/enum.js';

/**
 * Damaged and missing files (FL-1337, design §7-8): the list Library care shows, each problem's history,
 * and what a person can do about it. States and steps are plain strings, so a later value never breaks
 * an app that does not know it yet.
 */

const FIX_STATES =
  'How the fixes left it. Fixed for you: repaired, part-saved, found-again, restored. Needs you: missing, waiting-phone, cant-repair, couldnt-check, or null when no fix has looked at it yet. Left as they are: left-as-is.';
const STEPS =
  'What happened: added, imported, moved, not-on-drive, wont-open, checked, looked-where-moving, searched-copy, checked-backups, restored, asked-phones, checked-on-phone, repaired, kept-damaged, put-back, unsupported, undone, kept-as-is or removed';
const OUTCOMES = 'How it went: ok, not-found, failed, waiting or info';

const FactsSchema = z
  .record(z.string(), z.unknown())
  .describe('What the sentence needs: places searched, the part saved, a phone’s name, who did it…');

const FileProblemTabSchema = z
  .enum(['needs', 'fixed', 'kept'])
  .describe('Needs you, Fixed for you (the last 30 days) or Left as they are')
  .meta({ id: 'FileProblemTab' });

const FileProblemListQuerySchema = z
  .object({
    tab: FileProblemTabSchema,
    take: z.coerce.number().int().min(1).max(200).default(50).describe('How many to list (1 to 200)'),
    skip: z.coerce.number().int().min(0).default(0).describe('How many to skip'),
  })
  .meta({ id: 'FileProblemListQueryDto' });

const FileProblemLineSchema = z
  .object({
    step: z.string().describe(STEPS),
    outcome: z.string().describe(OUTCOMES),
    facts: FactsSchema,
  })
  .meta({ id: 'FileProblemLineDto' });

// A problem is made here (`uuid_generate_v4()`). A photo or an account can come from an import, which keeps the
// ids it is given, so those are any UUID, as on the processing failures list (FL-845).
const FileProblemRowSchema = z
  .object({
    id: z.uuidv4().describe('The problem'),
    assetId: z.uuid().describe('The photo or video'),
    ownerId: z.uuid().describe('Whose library it is in'),
    ownerName: z.string().describe('The name of the account whose library it is in'),
    originalFileName: z.string().describe('The name of its file'),
    category: MediaHealthCategorySchema,
    fixState: z.string().nullable().describe(FIX_STATES),
    partSaved: z.boolean().describe('A repair saved only part of the picture'),
    line: FileProblemLineSchema.nullable().describe(
      'The step its one-line story is told from: the newest, apart from the damaged file kept beside a repair. Null while its history is empty.',
    ),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('When it last changed'),
    pictureAllowed: z.boolean().describe('The caller may see its picture: false on another account’s file'),
    canAct: z
      .boolean()
      .describe('The caller may undo it, keep it, look in a folder for it or remove it: its owner only'),
  })
  .meta({ id: 'FileProblemRowDto' });

const FileStepSchema = z
  .object({
    at: z.string().meta({ format: 'date-time' }).describe('When it happened'),
    step: z.string().describe(STEPS),
    outcome: z.string().describe(OUTCOMES),
    facts: FactsSchema,
  })
  .meta({ id: 'FileStepDto' });

const FileProblemSchema = FileProblemRowSchema.extend({
  steps: z.array(FileStepSchema).describe('Its history, oldest first'),
}).meta({ id: 'FileProblemDto' });

const FileProblemPageSchema = z
  .object({
    items: z.array(FileProblemRowSchema).describe('One page of the tab, in its order'),
    total: z.int().min(0).describe('How many the tab holds'),
  })
  .meta({ id: 'FileProblemPageDto' });

const FileProblemFolderSchema = z
  .object({
    id: z.string().describe('The folder, as Look in a folder names it'),
    name: z.string().describe('Its name'),
  })
  .meta({ id: 'FileProblemFolderDto' });

const FileProblemLookInSchema = z
  .object({
    folderId: z.string().min(1).max(200).describe('One of the folders the caller may search'),
  })
  .meta({ id: 'FileProblemLookInDto' });

export class FileProblemListQueryDto extends createZodDto(FileProblemListQuerySchema) {}
export class FileProblemRowDto extends createZodDto(FileProblemRowSchema) {}
export class FileStepDto extends createZodDto(FileStepSchema) {}
export class FileProblemDto extends createZodDto(FileProblemSchema) {}
export class FileProblemPageDto extends createZodDto(FileProblemPageSchema) {}
export class FileProblemFolderDto extends createZodDto(FileProblemFolderSchema) {}
export class FileProblemLookInDto extends createZodDto(FileProblemLookInSchema) {}

export type FileProblemTab = z.infer<typeof FileProblemTabSchema>;
