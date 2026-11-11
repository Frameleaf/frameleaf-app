import { isIP } from 'node:net';

export function selfSignedCertificateArguments(origin: string | undefined, key: string, cert: string): string[] {
  const host = origin ? new URL(origin).hostname.replace(/^\[|\]$/g, '') : 'localhost';
  if (!/^[A-Za-z0-9.:-]+$/.test(host)) throw new Error('Invalid HTTPS hostname');
  return [
    'req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-days', '365',
    '-keyout', key, '-out', cert, '-subj', `/CN=${host}`,
    '-addext', `subjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}`,
  ];
}
