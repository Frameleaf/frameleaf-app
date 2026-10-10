import z from 'zod';

/** A landmark as it is named on an asset or in a list: enough to label it and pick its icon. */
export const LandmarkSummarySchema = z
  .object({
    id: z.string().describe('Landmark ID (its Wikidata ID, for example Q243)'),
    name: z.string().describe('Landmark name'),
    kind: z.string().describe('Kind of place, for example theme_park, museum or national_park'),
  })
  .meta({ id: 'LandmarkSummaryDto' });
