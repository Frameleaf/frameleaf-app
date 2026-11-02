import { createZodDto } from 'nestjs-zod';
import z from 'zod';

// Reason kinds, date sources and precisions are documented strings, not enums, so a new kind never
// breaks a native client's strict decoder (new response enum values do).
const AlbumSuggestionReasonSchema = z
  .object({
    kind: z
      .string()
      .describe(
        'Why it was suggested: during-trip, place, same-camera, looks-like, same-scene, near-identical or people. Unknown kinds may be added; show nothing for them.',
      ),
    date: z.string().optional().describe('Local date (YYYY-MM-DD) for during-trip, same-scene and near-identical'),
    place: z.string().optional().describe('Place name for place'),
    assetId: z.uuidv4().optional().describe('The album photo it matches, for same-scene and near-identical'),
    fileName: z.string().optional().describe('File name of that album photo'),
    names: z.array(z.string()).optional().describe('Names of the people in it who are also in the album, for people'),
  })
  .meta({ id: 'AlbumSuggestionReasonDto' });

const AlbumTripSuggestionSchema = z
  .object({
    assetId: z.uuidv4().describe('Suggested photo'),
    fileName: z.string().describe('Its file name'),
    likely: z.boolean().describe('Very likely (taken during the trip at its places) rather than possibly'),
    reasons: z.array(AlbumSuggestionReasonSchema),
  })
  .meta({ id: 'AlbumTripSuggestionDto' });

const AlbumDateSuggestionSchema = z
  .object({
    assetId: z.uuidv4().describe('Suggested photo'),
    fileName: z.string().describe('Its file name'),
    source: z
      .string()
      .describe(
        "Why its date can't be trusted: facebook (saved from Facebook), whatsapp, messenger (received), or none (no capture date in the file)",
      ),
    fileDate: z.string().describe('The local date it has now (YYYY-MM-DD)'),
    savedAt: z.string().nullable().describe('When its name says it was saved or received, if it says'),
    precision: z.string().describe('How precise the suggested date is: moment, day or trip'),
    dateTimeOriginal: z
      .string()
      .describe(
        'The suggested date, ready for an asset update (local time with offset, e.g. 2026-08-14T20:41:00-06:00)',
      ),
    reasons: z.array(AlbumSuggestionReasonSchema),
  })
  .meta({ id: 'AlbumDateSuggestionDto' });

const AlbumSuggestionsResponseSchema = z
  .object({
    autoAdd: z.boolean().describe('Whether new photos from this trip are added for you automatically'),
    tripStart: z
      .string()
      .nullable()
      .describe('First local day of the trip (YYYY-MM-DD); null when the album is not a trip'),
    tripEnd: z.string().nullable().describe('Last local day of the trip (YYYY-MM-DD)'),
    places: z.array(z.string()).describe('The places the album was photographed, most photographed first'),
    fromTrip: z.array(AlbumTripSuggestionSchema).describe('Photos taken during the trip that are not in the album'),
    needDate: z
      .array(AlbumDateSuggestionSchema)
      .describe('Photos with no trustworthy date that look like they are from the trip'),
  })
  .meta({ id: 'AlbumSuggestionsResponseDto' });

const AlbumSuggestionAutoAddSchema = z
  .object({ enabled: z.boolean().describe('Add new very likely photos from this trip automatically') })
  .meta({ id: 'AlbumSuggestionAutoAddDto' });

export class AlbumSuggestionsResponseDto extends createZodDto(AlbumSuggestionsResponseSchema) {}
export class AlbumSuggestionAutoAddDto extends createZodDto(AlbumSuggestionAutoAddSchema) {}
export type AlbumSuggestionReason = z.infer<typeof AlbumSuggestionReasonSchema>;
export type AlbumTripSuggestion = z.infer<typeof AlbumTripSuggestionSchema>;
export type AlbumDateSuggestion = z.infer<typeof AlbumDateSuggestionSchema>;
