import type { SystemConfig } from 'src/config.js';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { SystemMetadataKey } from 'src/enum.js';
import { readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { verifiedCustomHost } from 'src/utils/frameleaf-remote-access.js';
import { httpsOrigin } from 'src/utils/frameleaf-sign-in.js';

/**
 * The https origins this server already trusts for Sign in with Frameleaf: the addresses Frameleaf Cloud
 * published for the link, the relay name enrolled for it, and a verified custom hostname. Passkeys are
 * allowed on exactly these (and on the server's own external domain), and a Frameleaf sign-in may
 * return to exactly these.
 */
export const frameleafTrustedOrigins = async (
  deps: { configRepository: ConfigRepository; systemMetadataRepository: SystemMetadataRepository },
  settings: Pick<SystemConfig, 'frameleafCloud'>,
): Promise<string[]> => {
  const { cloudUrl, link } = await readCloudLink(deps);
  const origins = [httpsOrigin(link?.services?.publicUrl), httpsOrigin(link?.services?.relayOrigin)];
  const state = await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafRemoteAccess);
  const enrollment = state?.names;
  if (
    enrollment &&
    enrollment.instanceId === link?.instanceId &&
    enrollment.cloudUrl === cloudUrl &&
    enrollment.linkedAt === link?.linkedAt
  ) {
    origins.push(httpsOrigin(`https://${enrollment.names.relay}`));
    const custom = verifiedCustomHost(settings.frameleafCloud.remoteAccess);
    if (custom) {
      origins.push(httpsOrigin(`https://${custom}`));
    }
  }
  return origins.filter((origin): origin is string => !!origin);
};
