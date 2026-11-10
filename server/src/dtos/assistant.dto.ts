import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { SearchResponseSchema } from 'src/dtos/search.dto.js';

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
    language: z.string().min(1).max(16).optional().describe('Language of the question'),
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
  })
  .meta({ id: 'AssistantAskResponseDto' });

export class AssistantAskDto extends createZodDto(AssistantAskSchema) {}
export class AssistantAskResponseDto extends createZodDto(AssistantAskResponseSchema) {}
export type AssistantReasonItem = z.infer<typeof AssistantReasonItemSchema>;
