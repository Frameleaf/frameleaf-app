import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** FL-964: filling a person's photos that have no location from their own location history. */

/** The most proposals one request names; leave `assetIds` out to apply them all. */
export const LOCATION_FILL_MAX_SELECTED = 5000;

const instant = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Not a date')
  .meta({ format: 'date-time' });

export class LocationFillCreateDto extends createZodDto(
  z
    .object({
      maxGapMinutes: z
        .union([z.literal(5), z.literal(15), z.literal(60)])
        .describe('How close in time a place in your history must be to a photo: 5, 15 or 60 minutes'),
      from: instant.optional().describe('Only photos taken from this local date and time on'),
      to: instant.optional().describe('Only photos taken up to this local date and time'),
    })
    .refine((dto) => !dto.from || !dto.to || Date.parse(dto.from) <= Date.parse(dto.to), {
      message: 'from must not be after to',
    })
    .meta({ id: 'LocationFillCreateDto' }),
) {}

export class LocationFillApplyDto extends createZodDto(
  z
    .object({
      assetIds: z
        .array(z.uuidv4())
        .min(1)
        .max(LOCATION_FILL_MAX_SELECTED)
        .refine((ids) => new Set(ids).size === ids.length, 'Name each photo once')
        .optional()
        .describe('The photos to give their proposed location; leave out for every proposal of the run'),
    })
    .meta({ id: 'LocationFillApplyDto' }),
) {}

export class LocationFillProposalsQueryDto extends createZodDto(
  z.object({
    page: z.coerce.number().int().min(1).max(100_000).default(1).describe('Page number'),
    size: z.coerce.number().int().min(1).max(500).default(100).describe('Proposals a page'),
  }),
) {}

const LocationFillRunResponseSchema = z
  .object({
    id: z.uuidv7().describe('Run ID'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the run was started'),
    status: z
      .string()
      .describe(
        'proposing (looking through your photos), ready (proposals to review), applying, applied, undoing, undone or failed; later versions may add more',
      ),
    maxGapMinutes: z.int().describe('How close in time a history place had to be'),
    from: z.string().nullable().describe('Only photos taken from here on, when asked'),
    to: z.string().nullable().describe('Only photos taken up to here, when asked'),
    candidateCount: z.int().min(0).describe('Photos without a location that were looked at so far'),
    proposalCount: z.int().min(0).describe('Photos a location was found for so far'),
    appliedCount: z.int().min(0).describe('Photos that hold a location from this run now'),
    appliedAt: z.string().nullable().describe('When proposals were last applied'),
    undoneAt: z.string().nullable().describe('When the run was undone'),
    error: z.string().nullable().describe('Why the run stopped, when it did'),
  })
  .meta({ id: 'LocationFillRunResponseDto' });

const LocationFillProposalSchema = z
  .object({
    assetId: z.uuidv4().describe('Asset ID'),
    latitude: z.number().meta({ format: 'double' }).describe('Proposed latitude'),
    longitude: z.number().meta({ format: 'double' }).describe('Proposed longitude'),
    method: z
      .string()
      .describe('nearest (the history place closest in time) or interpolated (between the places before and after)'),
    gapSeconds: z.int().min(0).describe('Seconds between the photo and the nearest history place used'),
    localDateTime: z.string().describe('The photo’s local date and time'),
    applied: z.boolean().describe('The photo holds this location now'),
  })
  .meta({ id: 'LocationFillProposalDto' });

const LocationFillProposalsResponseSchema = z
  .object({
    total: z.int().min(0).describe('Proposals in the run'),
    hasNextPage: z.boolean(),
    days: z.array(
      z
        .object({
          day: z.string().describe('The local day, YYYY-MM-DD'),
          proposals: z.array(LocationFillProposalSchema),
        })
        .meta({ id: 'LocationFillDayDto' }),
    ),
  })
  .meta({ id: 'LocationFillProposalsResponseDto' });

export class LocationFillRunResponseDto extends createZodDto(LocationFillRunResponseSchema) {}
export class LocationFillProposalsResponseDto extends createZodDto(LocationFillProposalsResponseSchema) {}
