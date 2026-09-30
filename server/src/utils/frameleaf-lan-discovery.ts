import type { FrameleafRemoteConnection } from 'src/types.js';

/**
 * FL-229 (NAPI-005): a plain-HTTP `local` candidate per LAN address, on this server's own bind port -
 * the fallback an app can still try when nothing better (a cloud-issued wildcard certificate, an edge
 * worker's own report) is available. Not verified, no TLS: this server makes no promise about what,
 * if anything, terminates TLS in front of it when it is not enrolled with Frameleaf Cloud.
 *
 * Addresses come from `detectHostAddresses` (frameleaf-remote-access.ts) - the same LAN-address
 * detection the edge worker uses for its own (HTTPS, verified) candidates - so container/virtual-
 * interface filtering and the `FRAMELEAF_LOCAL_URL` override only need to be right in one place.
 */
export const localConnectionCandidates = (options: {
  port: number;
  addresses: string[];
}): FrameleafRemoteConnection[] =>
  options.addresses.map((address) => ({
    kind: 'local',
    uri: `http://${address}:${options.port}`,
    protocol: 'http',
    address,
    port: options.port,
    local: true,
    relay: false,
    ipv6: false,
    custom: false,
    dnsRebindingProtection: false,
    httpsRequired: false,
    verified: false,
  }));
