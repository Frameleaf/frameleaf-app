import z from 'zod';

export const desktopAssistancePolicySchema = z.strictObject({
  version: z.literal(1),
  accounts: z
    .record(z.uuid(), z.strictObject({ revisionId: z.uuid(), memberApproved: z.boolean().optional() }))
    .refine((accounts) => Object.keys(accounts).length <= 256),
  /**
   * FL-1484: the computers an administrator lets work on everyone's photos at home, not only the photos of the
   * account signed in on them. `revisionId` changes whenever the list does, so work authorized under an old list
   * is refused.
   */
  household: z.strictObject({ revisionId: z.uuid(), devices: z.array(z.uuid()).max(64) }).optional(),
});
export type DesktopAssistancePolicyRegistry = z.infer<typeof desktopAssistancePolicySchema>;

/** FL-1484: the computers that work on everyone's photos. */
export const householdDevices = (policy: DesktopAssistancePolicyRegistry): Set<string> =>
  new Set(policy.household?.devices);

/**
 * FL-1484: the authority a photo's work on the person's computers runs under: the owner's own desktop
 * assistance, else the household's while a computer works on everyone's photos.
 */
export const desktopAuthorityFor = (
  policy: DesktopAssistancePolicyRegistry,
  ownerId: string,
): { revisionId: string } | undefined =>
  policy.accounts[ownerId] ??
  (policy.household && policy.household.devices.length > 0 ? { revisionId: policy.household.revisionId } : undefined);

/** Whether work authorized under `revisionId` for `ownerId`'s photo may still run. */
export const desktopRevisionCurrent = (
  policy: DesktopAssistancePolicyRegistry,
  ownerId: string,
  revisionId: string,
): boolean =>
  policy.accounts[ownerId]?.revisionId === revisionId ||
  (!!policy.household && policy.household.devices.length > 0 && policy.household.revisionId === revisionId);

export const desktopAccountPermitted = (policy: DesktopAssistancePolicyRegistry, ownerId: string, isAdmin: boolean) => {
  const account = policy.accounts[ownerId];
  return !!account && (isAdmin || account.memberApproved === true);
};
