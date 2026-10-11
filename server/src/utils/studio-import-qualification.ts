import z from 'zod';

const configurationText = z
  .string()
  .min(1)
  .max(1024)
  .regex(/^[^\p{C}]+$/u)
  .refine((value) => value.trim().length > 0);
const evidenceReference = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[\u{21}-\u{7E}]+$/u)
  .refine((reference) => {
    if (/^sha256:[a-f0-9]{64}$/.test(reference)) return true;
    if (!/^https:\/\/[^/?#\\@]+(?:\/[^?#\\]*)?$/.test(reference) || /%(?![\da-f]{2})/i.test(reference)) return false;
    try {
      const url = new URL(reference);
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
    } catch {
      return false;
    }
  });
const evidenceReferences = z.array(evidenceReference).max(64);
const qualificationProfileSchema = z.strictObject({
  serverVersion: configurationText,
  adapterVersion: configurationText,
  runtime: configurationText,
  architecture: configurationText,
  filesystem: configurationText,
  mountIdentity: configurationText,
  rootIdentity: configurationText,
  linkDomain: configurationText,
  bridge: configurationText,
  backingStorage: configurationText,
  storageOptions: configurationText,
  database: z.strictObject({
    fsync: z.boolean(),
    synchronousCommit: z.boolean(),
    fullPageWrites: z.boolean(),
    walStorage: configurationText,
  }),
  failureBoundary: configurationText,
  evidenceReferences,
});
const approvedProfileSchema = qualificationProfileSchema.extend({ evidenceReferences: evidenceReferences.min(1) });

export type QualificationProfile = z.infer<typeof qualificationProfileSchema>;

/** Structural gate only: the authenticated deployment owner must verify evidence, review and expiry first. */
export function requirePublicationQualification(
  profile: QualificationProfile | null,
  observed: QualificationProfile,
): void {
  const approved = approvedProfileSchema.safeParse(profile);
  const current = qualificationProfileSchema.safeParse(observed);
  if (!approved.success || !current.success) throw new Error('storage_unqualified');
  for (const { database } of [approved.data, current.data]) {
    if (!database.fsync || !database.synchronousCommit || !database.fullPageWrites) {
      throw new Error('database_durability_unqualified');
    }
  }
  const configuration = (value: QualificationProfile) => JSON.stringify({ ...value, evidenceReferences: undefined });
  if (configuration(approved.data) !== configuration(current.data)) {
    throw new Error('storage_qualification_changed');
  }
}
