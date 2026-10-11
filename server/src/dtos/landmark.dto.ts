import { createZodDto } from 'nestjs-zod';
import z from 'zod';

/** How to draw a landmark's own brand icon, when the icon pack has one for it. */
const LandmarkIconSchema = z
  .object({
    background: z
      .string()
      .describe("The icon's own background colour (#rrggbb): fill the circle around the icon with it"),
    tile: z
      .boolean()
      .describe('Whether the icon fills its frame and is drawn edge to edge; otherwise it is a mark drawn inset'),
  })
  .meta({ id: 'LandmarkIconDto' });

/** A landmark as it is named on an asset or in a list: enough to label it and pick its icon. */
export const LandmarkSummarySchema = z
  .object({
    id: z.string().describe('Landmark ID (its Wikidata ID, for example Q243)'),
    name: z.string().describe('Landmark name'),
    kind: z.string().describe('Kind of place, for example theme_park, museum or national_park'),
    icon: LandmarkIconSchema.optional().describe(
      'Present when the landmark has its own brand icon, served by GET /search/landmarks/{id}/icon; without it, show the icon for its kind',
    ),
  })
  .meta({ id: 'LandmarkSummaryDto' });

const LandmarkIconParamSchema = z.object({ id: z.string().regex(/^Q\d{1,18}$/) });
export class LandmarkIconParamDto extends createZodDto(LandmarkIconParamSchema) {}
