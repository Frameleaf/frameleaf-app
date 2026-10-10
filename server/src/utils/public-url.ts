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
  // FL-165: the custom hostname reaches this server through the relay only, so it goes into links
  // only while the edge worker reports the relay connected
  let custom = remote?.publicUrl === 'custom' ? verifiedCustomHost(remote) : null;
  if (custom) {
    const state = await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafRemoteAccess);
    custom = edgeStateCurrent(state) && state?.relay.connected ? custom : null;
  }
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
 * `GET server/connections`), while it is linked and remote access is on:
 *
 * - the connection candidates the edge worker reported, but the relay name and the custom hostname
 *   (both reach this server through the relay) only while the relay is connected;
 * - the public address, `https://r.<label>.<domain>` or the verified custom hostname when "Use my
 *   domain" is chosen, likewise only while the relay is connected, so no address is published that
 *   does not answer yet.
 *
 * Otherwise the address Frameleaf Cloud published for the link, if any.
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
  // candidates are only as good as the edge worker's last report
  const current = !!names && edgeStateCurrent(state, now);
  const relayConnected = current && !!state?.relay.connected;
  if (!names || !relayConnected) {
    return {
      instanceId: link.instanceId,
      publicUrl: frameleafPublicUrl(link),
      connections: current ? (state?.candidates ?? []).filter((candidate) => !candidate.relay) : [],
    };
  }
  return {
    instanceId: link.instanceId,
    publicUrl: remotePublicUrl(names, remote),
    connections: state?.candidates ?? [],
  };
};

/**
 * FL-167: the home-network origins this server published (its LAN names, `https://<ip>.<label>.<domain>:<port>`),
 * the only places a Sign in with Frameleaf handoff may return to, so it can never be an open redirect.
 */
export const publishedLocalOrigins = async (remote: RemoteSettings, deps: PublicUrlDeps): Promise<string[]> => {
  const { connections } = await remoteAccessPublication(remote, deps);
  return connections
    .filter((connection) => connection.kind === 'local')
    .map((connection) => new URL(connection.uri).origin);
};

/**
 * FL-83 (AL-30b, owner decision 2026-09-27): the address a share hands out, such as the link in a
 * "shared with you" notification.
 *
 * 1. The Public server URL the administrator set (`server.externalDomain`), always.
 * 2. Otherwise, the address the request arrived on, but only when it is one this server knows:
 *    the verified custom hostname (FL-165, the CNAME a person pointed at this server) or one of the
 *    remote-access addresses it currently publishes. The Host header is never trusted on its own.
 * 3. Otherwise the verified custom hostname when "Use my domain" is chosen, then the
 *    direct-connection address (the WAN name Frameleaf Cloud's probe reached, else a published WAN
 *    or IPv6 name), then the address Frameleaf Cloud published for the link if it is still in the current
 *    connection list.
 *
 * `undefined` when the server knows none of these; the share then carries no link, never one
 * pointing at another project's host or at an unverified name.
 */
export const resolveShareBaseUrl = async (
  server: Pick<SystemConfig['server'], 'externalDomain'>,
  deps: PublicUrlDeps,
  remote: RemoteSettings,
  requestOrigin?: string | null,
): Promise<string | undefined> => {
  if (server.externalDomain) {
    return server.externalDomain.replace(/\/+$/, '');
  }
  if (!deps.configRepository.getEnv().frameleafCloud.url) {
    return undefined;
  }
  const { connections, publicUrl } = await remoteAccessPublication(remote, deps);
  const custom = verifiedCustomHost(remote);
  const customOrigin = custom ? `https://${custom}` : null;
  const remoteOrigins = connections
    .filter((connection) => !connection.local && (!connection.custom || connection.address === custom))
    .map(({ uri }) => httpsOrigin(uri));
  const known = new Set(remoteOrigins);

  const arrival = httpsOrigin(requestOrigin);
  if (arrival && known.has(arrival)) {
    return arrival;
  }
  if (remote.publicUrl === 'custom' && customOrigin && remoteOrigins.includes(customOrigin)) {
    return customOrigin;
  }
  const direct = connections.filter(
    (connection) => (connection.kind === 'wan' || connection.kind === 'ipv6') && !connection.custom,
  );
  const directUri = (direct.find((connection) => connection.verified) ?? direct[0])?.uri;
  const published = httpsOrigin(publicUrl);
  return httpsOrigin(directUri) ?? (published && known.has(published) ? published : undefined);
};
