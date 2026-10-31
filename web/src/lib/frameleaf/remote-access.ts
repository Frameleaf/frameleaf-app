/**
 * Remote access (FL-165): the custom hostname check the Remote access page runs as the administrator
 * types (the prototype's `validateCustomHostname`, design/frameleaf/template/src/frameleaf-cloud-data.mjs).
 * The server checks the same rules again, and refuses the direct domain it actually uses too.
 */
import type { Translations } from 'svelte-i18n';

/** Frameleaf's own domains; a custom hostname under any of them is refused. */
export const RESERVED_REMOTE_DOMAINS: readonly string[] = [
  'frameleaf.net',
  'frameleaf-direct.net',
  'frameleaf.direct',
  'frameleaf.cloud',
];

export type HostnameCheck =
  { valid: true; host: string } | { valid: false; host: string; reason: 'empty' | 'scheme' | 'subdomain' | 'reserved' };

const LABEL = /^[\da-z](?:[\da-z-]{0,61}[\da-z])?$/;

export const checkCustomHostname = (
  value: string,
  reserved: readonly string[] = RESERVED_REMOTE_DOMAINS,
): HostnameCheck => {
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (!host) {
    return { valid: false, host, reason: 'empty' };
  }
  if (/^[a-z]+:\/\//.test(host) || host.includes('/')) {
    return { valid: false, host, reason: 'scheme' };
  }
  const labels = host.split('.');
  if (
    host.length > 253 ||
    labels.length < 3 ||
    labels.some((label) => !LABEL.test(label)) ||
    !/^[a-z]{2,63}$/.test(labels.at(-1) ?? '')
  ) {
    return { valid: false, host, reason: 'subdomain' };
  }
  if (reserved.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return { valid: false, host, reason: 'reserved' };
  }
  return { valid: true, host };
};

/** The i18n key of a refusal's message. */
export const hostnameMessageKey = (reason: Extract<HostnameCheck, { valid: false }>['reason']): Translations =>
  `frameleaf_remote_hostname_invalid_${reason}` as const;
