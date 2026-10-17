import type { FrameleafUserLicenseRepository } from 'src/repositories/frameleaf-user-license.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { SystemMetadataKey } from 'src/enum.js';
import { entitlementFlags } from 'src/utils/frameleaf-license.js';

type SupporterRepositories = {
  systemMetadataRepository: Pick<SystemMetadataRepository, 'get'>;
  frameleafUserLicenseRepository: Pick<FrameleafUserLicenseRepository, 'getUserIds'>;
};

/**
 * Supporter option (b): who wears the "Supporter" tag beside their name. Everyone, while this server's
 * Server licence is active or in grace (the rule of ServerFeatures `supporter`); otherwise each person
 * who holds their own Individual licence on this server (the Users list's `license`).
 */
export const getSupporters = async (
  { systemMetadataRepository, frameleafUserLicenseRepository }: SupporterRepositories,
  userIds: string[],
): Promise<(userId: string) => boolean> => {
  const licenses = await systemMetadataRepository.get(SystemMetadataKey.FrameleafLicense);
  if (entitlementFlags([licenses?.key, licenses?.plan]).supporter) {
    return () => true;
  }
  const supporters = new Set(await frameleafUserLicenseRepository.getUserIds([...new Set(userIds)]));
  return (userId) => supporters.has(userId);
};
