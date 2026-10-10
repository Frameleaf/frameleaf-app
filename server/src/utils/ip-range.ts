import validator from 'validator';
import z from 'zod';

export type IsIPRangeOptions = { requireCIDR?: boolean };

function isIPOrRange(value: string, options?: IsIPRangeOptions): boolean {
  const { requireCIDR = true } = options ?? {};
  // eslint-disable-next-line import-x/no-named-as-default-member
  if (validator.isIPRange(value)) {
    return true;
  }
  // eslint-disable-next-line import-x/no-named-as-default-member
  return !requireCIDR && validator.isIP(value);
}

/**
 * Zod schema that validates an array of strings as IP addresses or IP/CIDR ranges.
 * When requireCIDR is true (default), plain IPs are rejected; only CIDR ranges are allowed.
 *
 * @example
 * z.string().optional().transform(...).pipe(IsIPRange())
 * @example
 * z.string().optional().transform(...).pipe(IsIPRange({ requireCIDR: false }))
 */
export function IsIPRange(options?: IsIPRangeOptions) {
  return z
    .array(z.string())
    .refine((arr) => arr.every((item) => isIPOrRange(item, options)), 'Must be an ip address or ip address range');
}
