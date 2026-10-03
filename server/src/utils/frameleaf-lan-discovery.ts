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
  /** `FRAMELEAF_LOCAL_URL`: the operator's own address for this server on the home network. */
  localUrl?: string | null;
}): FrameleafRemoteConnection[] =>
  options.addresses.map((address) => {
    const { protocol, port } = localAddressFor(address, options);
    return {
      kind: 'local',
      uri: `${protocol}://${address}:${port}`,
      protocol,
      address,
      port,
      local: true,
      relay: false,
      ipv6: false,
      custom: false,
      dnsRebindingProtection: false,
      httpsRequired: protocol === 'https',
      verified: false,
    };
  });

/**
 * The scheme and port an app reaches `address` on. When `FRAMELEAF_LOCAL_URL` names that address, its
 * scheme and port win over the process's bind port: in a container with a port mapping (host 2290 to
 * container 2283) only the operator's URL names a port that answers on the network.
 */
export const localAddressFor = (
  address: string,
  options: { port: number; localUrl?: string | null },
): { protocol: 'http' | 'https'; port: number } => {
  if (options.localUrl) {
    const url = new URL(options.localUrl);
    if (url.hostname === address) {
      const protocol = url.protocol === 'https:' ? 'https' : 'http';
      return { protocol, port: url.port ? Number(url.port) : protocol === 'https' ? 443 : 80 };
    }
  }
  return { protocol: 'http', port: options.port };
};
