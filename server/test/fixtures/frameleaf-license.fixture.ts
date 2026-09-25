import { KeyObject, generateKeyPairSync, sign } from 'node:crypto';
import type { FrameleafLicenseClaims } from 'src/types.js';
import type { LicenseSigningKey } from 'src/utils/frameleaf-license.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

/** A licence-signing key for specs (FL-156): the private half signs, `key` is what a server pins. */
export const makeLicenseSigner = (status: LicenseSigningKey['status'] = 'active') => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { crv: string; kty: string; x: string };
  return { privateKey, key: { kid: ed25519Thumbprint(jwk), x: jwk.x, status } as LicenseSigningKey };
};

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** A `license+jwt` certificate as the Frameleaf licence service issues it, for `nowSeconds`. */
export const signLicenseCertificate = (
  signer: { privateKey: KeyObject; key: LicenseSigningKey },
  nowSeconds: number,
  claims: Partial<FrameleafLicenseClaims> & Record<string, unknown> = {},
  header: Record<string, unknown> = {},
) => {
  const head = b64({ alg: 'EdDSA', typ: 'license+jwt', kid: signer.key.kid, ...header });
  const body = b64({
    iss: 'https://id.cloud.test',
    aud: 'frameleaf-server',
    sub: 'account-1',
    iid: 'instance-1',
    ent: ['CLOUD', 'REMOTE_ACCESS', 'CLOUD_BACKUP', 'CLOUD_ML'],
    lic_exp: nowSeconds + 30 * 86_400,
    upd: { after: 86_400 },
    grace_days: 7,
    iat: nowSeconds,
    nbf: nowSeconds,
    exp: nowSeconds + 7 * 86_400,
    jti: 'jti-1',
    ...claims,
  });
  const signature = sign(null, Buffer.from(`${head}.${body}`), signer.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
};
