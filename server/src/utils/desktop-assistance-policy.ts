import z from 'zod';

export const desktopAssistancePolicySchema = z.strictObject({
  version: z.literal(1),
  accounts: z
    .record(z.uuid(), z.strictObject({ revisionId: z.uuid(), memberApproved: z.boolean().optional() }))
    .refine((accounts) => Object.keys(accounts).length <= 256),
});
export type DesktopAssistancePolicyRegistry = z.infer<typeof desktopAssistancePolicySchema>;

export const desktopAccountPermitted = (policy: DesktopAssistancePolicyRegistry, ownerId: string, isAdmin: boolean) => {
  const account = policy.accounts[ownerId];
  return !!account && (isAdmin || account.memberApproved === true);
};
