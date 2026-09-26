import type { SystemConfig } from 'src/dtos/config.dto.js';
import type { FrameleafRemoteAccess, FrameleafRemoteConnection } from 'src/types.js';
import { SystemMetadataKey } from 'src/enum.js';
import { type CloudGatewayDeps, readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';
import { edgeStateCurrent, remotePublicUrl, verifiedCustomHost } from 'src/utils/frameleaf-remote-access.js';
import { frameleafPublicUrl, httpsOrigin } from 'src/utils/frameleaf-sign-in.js';

type PublicUrlDeps = Pick<CloudGatewayDeps, 'configRepository' | 'systemMetadataRepository'>;
type RemoteSettings = SystemConfig['frameleafCloud']['remoteAccess'];

/**
 * FL-190: the address this server can be reached at, for links in emails and login URLs: the
 * configured external domain, else, for a linked server, the custom hostname when "Use my domain" is
 * chosen and Frameleaf Cloud verified it (FL-165), else the `publicUrl` Frameleaf Cloud published
 * (https only). Never the relay origin: remote access through the relay refuses password sign-in by
 * default, and maintenance mode is not served there. `undefined` when the server knows neither;
 * callers then leave the link out rather than pointing at another project's host.
 */
export const resolvePublicUrl = async (
  server: Pick<SystemConfig['server'], 'externalDomain'>,
  deps: PublicUrlDeps,
  remote?: Pick<RemoteSettings, 'publicUrl' | 'customHostname'>,
): Promise<string | undefined> => {
  if (server.externalDomain) {
    return server.externalDomain;
  }
  if (!deps.configRepository.getEnv().frameleafCloud.url) {
    return undefined;
  }
  const { link, linked } = await readCloudLink(deps);
  if (!linked) {
    return undefined;
  }
  const custom = remote?.publicUrl === 'custom' ? verifiedCustomHost(remote) : null;
  return (custom && `https://${custom}`) || httpsOrigin(link?.services?.publicUrl) || undefined;
};

export type RemoteAccessPublication = {
  instanceId: string | null;
  /** The address published for remote access, or null. */
  publicUrl: string | null;
  connections: FrameleafRemoteConnection[];
};

/**
 * FL-165: what this server publishes for remote access (`/server/config`, `/.well-known/immich` and
 * `GET server/connections`): while it is linked and remote access is on, `https://r.<label>.<domain>`
 * or the verified custom hostname when "Use my domain" is chosen, and the connection candidates the
 * edge worker reported; otherwise the address Frameleaf Cloud published for the link, if any.
 */
export const remoteAccessPublication = async (
  remote: RemoteSettings,
  deps: PublicUrlDeps,
  now = Date.now(),
): Promise<RemoteAccessPublication> => {
  const { link, linked } = await readCloudLink(deps);
  if (!linked || !link?.instanceId) {
    return { instanceId: null, publicUrl: null, connections: [] };
  }
  const state: FrameleafRemoteAccess | null = remote.enabled
    ? await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafRemoteAccess)
    : null;
  const names = state?.names && state.names.instanceId === link.instanceId ? state.names : null;
  if (!names) {
    return { instanceId: link.instanceId, publicUrl: frameleafPublicUrl(link), connections: [] };
  }
  return {
    instanceId: link.instanceId,
    publicUrl: remotePublicUrl(names, remote),
    // candidates are only as good as the edge worker's last report
    connections: edgeStateCurrent(state, now) ? (state?.candidates ?? []) : [],
  };
};
