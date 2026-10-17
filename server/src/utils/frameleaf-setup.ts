import type { FrameleafVia } from 'src/utils/frameleaf-sign-in.js';
import { isHomeAddress, isRemoteVia } from 'src/utils/frameleaf-sign-in.js';

/**
 * Whether a request reached the server from the home network: the edge worker vouched `lan`, or no
 * edge worker was involved and the client address is a home address (private ranges, loopback, and
 * `FRAMELEAF_TRUSTED_LAN_CIDRS`). Remote access (`wan`, `relay`) never is.
 */
export const isLanRequest = (
  via: FrameleafVia | null | undefined,
  clientIp: string | undefined,
  trustedLanCidrs: string[],
): boolean => {
  if (isRemoteVia(via)) {
    return false;
  }
  return via === 'lan' || isHomeAddress(clientIp, trustedLanCidrs);
};
