import { rateLimitAddress } from 'src/middleware/rate-limit.guard.js';

export const SIGN_IN_SECURITY_URL = '/user-settings?area=privacy&section=authorized-devices';

export const signInNetwork = (address: string): string | null => {
  const normalized = rateLimitAddress(address);
  if (normalized === 'unknown') return null;
  if (normalized.endsWith('/64')) return `${normalized.split(':', 3).join(':')}::/48`;
  return `${normalized.split('.').slice(0, 3).join('.')}.0/24`;
};
