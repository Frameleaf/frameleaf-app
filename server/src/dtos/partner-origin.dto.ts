import z from 'zod';

/**
 * FL-326 (spec §5.2): where a partner copy came from, for the "From {owner}'s library" label on album cards
 * and in the info panel. Present only on the viewer's own copies; it stays after edits.
 */
export const PartnerOriginSchema = z
  .object({
    rootOwnerId: z.uuidv4().describe('The account that originally uploaded or created it'),
    rootOwnerName: z.string().describe("That account's name"),
  })
  .meta({ id: 'PartnerOriginDto' });

export type PartnerOriginDto = z.infer<typeof PartnerOriginSchema>;
