import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { SearchResponseSchema } from 'src/dtos/search.dto.js';
import { ASSISTANT_ACTION_MAX_ITEMS, ASSISTANT_ACTION_TOOLS } from 'src/utils/assistant-action.js';

/**
 * FL-885: the arguments of the Library Assistant's one tool, `search_library`. A planner model fills them
 * from the question and the names the person may see; the rule planner produces the same shape. People,
 * pets, albums and tags are names here and resolved to ids by the server, never by the model.
 */
export const assistantPlanFiltersShape = {
  people: z.array(z.string().min(1).max(200)).min(1).max(10).optional().describe('People in the photo, by name'),
  pets: z.array(z.string().min(1).max(200)).min(1).max(10).optional().describe('Pets in the photo, by name'),
  albums: z.array(z.string().min(1).max(200)).min(1).max(5).optional().describe('Albums holding the item, by name'),
  tags: z.array(z.string().min(1).max(200)).min(1).max(5).optional().describe('Tags on the item, by name'),
  city: z.string().min(1).max(200).optional().describe('City the item was taken in'),
  takenAfter: z.iso.datetime().optional().describe('Taken at or after this time'),
  takenBefore: z.iso.datetime().optional().describe('Taken at or before this time'),
  type: z.enum(['IMAGE', 'VIDEO']).meta({ id: 'AssistantMediaType' }).optional().describe('Photos or videos only'),
  favorite: z.boolean().optional().describe('Favorites only'),
  ocr: z.string().min(1).max(200).optional().describe('Text visible in the photo'),
  spoken: z.string().min(1).max(200).optional().describe('Words spoken in the video'),
  description: z.string().min(1).max(200).optional().describe('A phrase in the description'),
  visual: z.string().min(1).max(200).optional().describe('What the photo looks like, for visual search'),
};
export const AssistantPlanFiltersSchema = z
  .strictObject(assistantPlanFiltersShape)
  .meta({ id: 'AssistantPlanFiltersDto' });
export type AssistantPlanFilters = z.infer<typeof AssistantPlanFiltersSchema>;

const AssistantAskSchema = z
  .object({
    query: z.string().trim().min(1).max(1000).describe('The question, as the person typed it'),
    size: z.int().min(1).max(500).optional().describe('Most results to return'),
    language: z.string().max(16).optional().describe('Language of the question'),
  })
  .meta({ id: 'AssistantAskDto' });

const AssistantReasonItemSchema = z
  .object({
    kind: z
      .string()
      .describe(
        'What the reason rests on: person, pet, place, date, favorite, type, album, tag, text, speech, description or visual. Plain string; new kinds may appear',
      ),
    text: z.string().describe('The reason as a short sentence, from the stored data of this item'),
    value: z.string().optional().describe('The stored value the reason names (a name, place, date or quoted text)'),
  })
  .meta({ id: 'AssistantReasonItemDto' });

const AssistantReasonSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    items: z.array(AssistantReasonItemSchema).describe('Why this item matched, most specific first'),
  })
  .meta({ id: 'AssistantReasonDto' });

const AssistantAskResponseSchema = z
  .object({
    query: z.string().describe('The question as asked'),
    summary: z.string().describe('One line describing what was searched'),
    answeredBy: z
      .string()
      .describe('What planned the search: `planner` (a planner model) or `rules`. Plain string; new values may appear'),
    plan: AssistantPlanFiltersSchema.describe('The search that was run'),
    results: SearchResponseSchema,
    reasons: z.array(AssistantReasonSchema).describe('Why each result matched, one entry per result'),
    warnings: z.array(z.string()).describe('Parts of the question that could not be used'),
    switchBackToken: z
      .uuidv4()
      .optional()
      .describe('Opaque token for reporting a switch to Classic search from this answer'),
  })
  .meta({ id: 'AssistantAskResponseDto' });

const AssistantSwitchBackSchema = z
  .strictObject({ token: z.uuidv4().describe('The switch-back token from the Assistant answer') })
  .meta({ id: 'AssistantSwitchBackDto' });

export class AssistantSwitchBackDto extends createZodDto(AssistantSwitchBackSchema) {}
export class AssistantAskDto extends createZodDto(AssistantAskSchema) {}
export class AssistantAskResponseDto extends createZodDto(AssistantAskResponseSchema) {}
export type AssistantReasonItem = z.infer<typeof AssistantReasonItemSchema>;

/**
 * FL-938: one change Frameleaf Assistant proposes to the library. Nothing here changes anything until the
 * same person confirms the proposal; `kind`, `status` and every `reason` are plain strings, never enums,
 * so a client built before a new one keeps decoding.
 */
const AssistantActionToolSchema = z
  .enum(ASSISTANT_ACTION_TOOLS)
  .describe('The change to propose: make an album, add to an album, tag, favourite, or cull bursts')
  .meta({ id: 'AssistantActionTool' });

const AssistantActionArgumentsSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(200).optional().describe('`create_album`: the name of the new album'),
    description: z.string().trim().max(1000).optional().describe('`create_album`: its description'),
    album: z.string().trim().min(1).max(200).optional().describe('`add_to_album`: the album, by name'),
    albumId: z.uuidv4().optional().describe('`add_to_album`: the album, by id, in place of its name'),
    tags: z
      .array(z.string().trim().min(1).max(200))
      .min(1)
      .max(5)
      .optional()
      .describe('`tag`: the tags, by name. A name no tag has yet becomes a new tag when the change is confirmed'),
  })
  .meta({ id: 'AssistantActionArgumentsDto' });

const AssistantActionProposeSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(1000).optional().describe('The question the change came from, as typed'),
    tool: AssistantActionToolSchema,
    arguments: AssistantActionArgumentsSchema.optional(),
    assetIds: z
      .array(z.uuidv4())
      .min(1)
      .max(ASSISTANT_ACTION_MAX_ITEMS)
      .describe('The items the person is looking at. The set is frozen here and never re-resolved'),
  })
  .meta({ id: 'AssistantActionProposeDto' });

const AssistantActionApplySchema = z
  .strictObject({ confirm: z.literal(true).describe('The person confirmed the proposal. Must be true') })
  .meta({ id: 'AssistantActionApplyDto' });

const AssistantActionSearchSchema = z
  .object({
    before: z.uuidv7().optional().describe('The id of the last action of the previous page'),
    take: z.coerce.number().int().min(1).max(100).optional().describe('At most this many actions'),
  })
  .meta({ id: 'AssistantActionSearchDto' });

const AssistantActionSkippedSchema = z
  .object({
    reason: z
      .string()
      .describe(
        'Why items were left out: `not_found` (not yours, in the trash or gone), `locked` (Locked or hidden by a Locked rule), `already_done`, `kept` (the best of a burst), `not_in_burst`, `not_scored`, `not_applied` (the change never reached it), `changed_since` (changed after the change was applied) or `album_gone`. Plain string; new reasons may appear',
      ),
    count: z.int().min(0).describe('How many items'),
    sampleAssetIds: z.array(z.uuidv4()).describe('A few of them'),
  })
  .meta({ id: 'AssistantActionSkippedDto' });

const AssistantActionUndoSchema = z
  .object({
    restored: z.int().min(0).describe('How many items are being put back exactly as they were'),
    skipped: z.array(AssistantActionSkippedSchema).describe('What undo left alone, and why'),
    albumRemoved: z.boolean().describe('The album the change made was removed, because nothing else had changed in it'),
    tagsRemoved: z.array(z.string()).describe('Tags the change made that were removed again'),
    mediaOperationIds: z.array(z.uuidv7()).describe('The background jobs putting the items back'),
  })
  .meta({ id: 'AssistantActionUndoDto' });

const AssistantActionResponseSchema = z
  .object({
    id: z.uuidv7().describe('Action ID'),
    kind: z
      .string()
      .describe('`create_album`, `add_to_album`, `tag`, `favourite` or `cull`. Plain string; new kinds may appear'),
    status: z.string().describe('`proposed`, `applied`, `undone` or `expired`. Plain string; new values may appear'),
    question: z.string().nullable().describe('The question the change came from'),
    total: z.int().min(0).describe('How many items the change covers'),
    sampleAssetIds: z.array(z.uuidv4()).describe('A few of the items the change covers'),
    skipped: z.array(AssistantActionSkippedSchema).describe('Items that were asked for and left out, and why'),
    albumId: z.uuidv4().nullable().describe('The album written to; null until a new album is made'),
    albumName: z.string().nullable().describe('The name of the album written to'),
    tags: z.array(z.string()).describe('The tags written'),
    bursts: z.int().min(0).nullable().describe('`cull`: how many bursts are thinned out'),
    keptAssetIds: z.array(z.uuidv4()).describe('`cull`: a few of the frames that are kept'),
    mediaOperationId: z.uuidv7().nullable().describe('The background job applying the change'),
    createdAt: z.iso.datetime().describe('When it was proposed'),
    appliedAt: z.iso.datetime().nullable().describe('When it was confirmed'),
    undoneAt: z.iso.datetime().nullable().describe('When it was undone'),
    undoExpiresAt: z.iso.datetime().nullable().describe('Until when it can be undone'),
    canUndo: z.boolean().describe('Whether it can be undone now'),
    undo: AssistantActionUndoSchema.nullable().describe('What undo did, once it was undone'),
  })
  .meta({ id: 'AssistantActionResponseDto' });

const AssistantActionListResponseSchema = z
  .object({
    actions: z.array(AssistantActionResponseSchema).describe('Newest first'),
    hasMore: z.boolean().describe('Whether an older page exists'),
  })
  .meta({ id: 'AssistantActionListResponseDto' });

export class AssistantActionProposeDto extends createZodDto(AssistantActionProposeSchema) {}
export class AssistantActionApplyDto extends createZodDto(AssistantActionApplySchema) {}
export class AssistantActionSearchDto extends createZodDto(AssistantActionSearchSchema) {}
export class AssistantActionResponseDto extends createZodDto(AssistantActionResponseSchema) {}
export class AssistantActionListResponseDto extends createZodDto(AssistantActionListResponseSchema) {}
export type AssistantActionSkipped = z.infer<typeof AssistantActionSkippedSchema>;
export type AssistantActionUndo = z.infer<typeof AssistantActionUndoSchema>;
