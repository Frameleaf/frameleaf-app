import type { SystemConfig } from 'src/dtos/config.dto.js';
import { type CloudGatewayDeps, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { httpsOrigin } from 'src/utils/frameleaf-sign-in.js';

type PublicUrlDeps = Pick<CloudGatewayDeps, 'configRepository' | 'systemMetadataRepository'>;

/**
 * FL-190: the address this server can be reached at, for links in emails and login URLs: the
 * configured external domain, else the public URL (a verified custom hostname) Frameleaf Cloud
 * published for a linked server. Never the relay origin: remote access through the relay refuses
 * password sign-in by default, and maintenance mode is not served there. `undefined` when the server
 * knows neither; callers then leave the link out rather than pointing at another project's host.
 */
export const resolvePublicUrl = async (
  server: Pick<SystemConfig['server'], 'externalDomain'>,
  deps: PublicUrlDeps,
): Promise<string | undefined> => {
  if (server.externalDomain) {
    return server.externalDomain;
  }
  if (!deps.configRepository.getEnv().frameleafCloud.url) {
    return undefined;
  }
  const { link, linked } = await readCloudLink(deps);
  return (linked && httpsOrigin(link?.services?.publicUrl)) || undefined;
};
