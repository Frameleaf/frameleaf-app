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

/**
 * FL-721 (spec §6.2): on your own copy of a partner's Locked item whose files the partner encrypted:
 * whether it opens for you, and why not.
 */
export const PartnerLockedEncryptionSchema = z
  .object({
    openable: z.boolean().describe('Whether the item opens for you (with your own PIN, or a passphrase you typed)'),
    reason: z
      .enum(['not-ready', 'owner-passphrase'])
      .optional()
      .describe(
        "Why it doesn't open: `not-ready` until the partner next opens Locked; `owner-passphrase` until you type the partner's passphrase",
      )
      .meta({ id: 'PartnerLockedEncryptionReason' }),
    ownerName: z.string().describe("The partner's name"),
  })
  .meta({ id: 'PartnerLockedEncryptionDto' });

export type PartnerLockedEncryptionDto = z.infer<typeof PartnerLockedEncryptionSchema>;
