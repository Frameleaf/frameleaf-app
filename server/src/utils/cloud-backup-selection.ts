import { createHash } from 'node:crypto';

/**
 * The opaque per-server account reference Frameleaf Cloud knows an account by (`fingerprint.user`, the
 * binding a personal licence is activated with): SHA-256 of the instance id followed by the account id.
 */
export const backupUserFingerprint = (instanceId: string, userId: string) =>
  createHash('sha256').update(`${instanceId}${userId}`).digest('hex');

/** The licence coverage a run's grant gave, as the run records it. */
export type BackupLicenceScope =
  { scope: 'all' } | { scope: 'none' } | { scope: 'users'; userFingerprints: string[] } | { scope: 'own-bucket' };

export const isLicenceEligible = (scope: BackupLicenceScope, fingerprint: string) =>
  scope.scope === 'all' ||
  scope.scope === 'own-bucket' ||
  (scope.scope === 'users' && scope.userFingerprints.includes(fingerprint));
