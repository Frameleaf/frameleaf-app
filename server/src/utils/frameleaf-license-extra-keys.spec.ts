import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FRAMELEAF_LICENSE_KEYS } from 'src/constants.js';
import { FRAMELEAF_BUILD_CHANNEL } from 'src/utils/frameleaf-build-channel.js';
import {
  LICENSE_EXTRA_JWKS_MAX_BYTES,
  extraLicenseKeysLog,
  loadExtraLicenseKeys,
  parseExtraLicenseJwks,
} from 'src/utils/frameleaf-license-extra-keys.js';
import { verifyLicenseCertificate } from 'src/utils/frameleaf-license.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';
import { makeLicenseSigner, signLicenseCertificate } from 'test/fixtures/frameleaf-license.fixture.js';

const dev = makeLicenseSigner('active');
const pinned = [makeLicenseSigner('active').key, makeLicenseSigner('spare').key];
const jwk = (key = dev.key, extra: Record<string, unknown> = {}) => ({
  kty: 'OKP',
  crv: 'Ed25519',
  x: key.x,
  kid: key.kid,
  alg: 'EdDSA',
  use: 'sig',
  ...extra,
});
const jwks = (...keys: unknown[]) => JSON.stringify({ keys });

describe('frameleaf-license-extra-keys (integration builds only)', () => {
  it('the source build channel is release; only the integration image build rewrites it', () => {
    expect(FRAMELEAF_BUILD_CHANNEL).toBe('release');
  });

  describe(parseExtraLicenseJwks.name, () => {
    it('accepts the cloud keys document format (packages/contracts licence/keys.json)', () => {
      const document = cloudContractFixture<{ keys: Array<{ kid: string; x: string }> }>('licence/keys.json');
      const keys = parseExtraLicenseJwks(JSON.stringify(document), pinned);
      expect(keys).toEqual(document.keys.map(({ kid, x }) => ({ kid, x, status: 'spare' })));
    });

    it('accepts a minimal public JWK', () => {
      expect(
        parseExtraLicenseJwks(jwks({ kty: 'OKP', crv: 'Ed25519', x: dev.key.x, kid: dev.key.kid }), pinned),
      ).toEqual([{ kid: dev.key.kid, x: dev.key.x, status: 'spare' }]);
    });

    const { privateKey } = generateKeyPairSync('ed25519');
    const privateJwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
    const privateKid = makeLicenseSigner().key;
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ format: 'jwk' });

    it.each([
      ['not JSON', '{keys:', /not JSON/],
      ['an array', '[]', /not a JWKS object/],
      ['null', 'null', /not a JWKS object/],
      ['no keys', '{}', /only "keys"/],
      ['extra top-level members', JSON.stringify({ keys: [jwk()], issuer: 'x' }), /only "keys"/],
      ['empty keys', jwks(), /non-empty/],
      ['keys not an array', JSON.stringify({ keys: {} }), /non-empty/],
      ['too many keys', jwks(...Array.from({ length: 9 }, () => jwk(makeLicenseSigner().key))), /at most 8/],
      ['a non-object key', jwks('x'), /not an object/],
      ['private key material (d)', jwks({ ...privateJwk, kid: privateKid.kid }), /private key material/],
      ['an RSA key', jwks({ ...rsa, kid: 'r' }), /not allowed|not an Ed25519/],
      ['an unknown member', jwks(jwk(dev.key, { x5u: 'https://evil.test/cert' })), /not allowed: x5u/],
      ['a symmetric member (k)', jwks(jwk(dev.key, { k: 'AAAA' })), /not allowed: k/],
      ['kty EC', jwks(jwk(dev.key, { kty: 'EC' })), /not an Ed25519/],
      ['crv X25519', jwks(jwk(dev.key, { crv: 'X25519' })), /not an Ed25519/],
      ['alg RS256', jwks(jwk(dev.key, { alg: 'RS256' })), /other than EdDSA/],
      ['alg none', jwks(jwk(dev.key, { alg: 'none' })), /other than EdDSA/],
      ['use enc', jwks(jwk(dev.key, { use: 'enc' })), /not a signing key/],
      ['key_ops sign', jwks(jwk(dev.key, { key_ops: ['sign'] })), /only be used to verify/],
      ['key_ops verify+sign', jwks(jwk(dev.key, { key_ops: ['verify', 'sign'] })), /only be used to verify/],
      ['a short x', jwks(jwk(dev.key, { x: 'AAAA' })), /no valid Ed25519/],
      ['a non-base64url x', jwks(jwk(dev.key, { x: `${dev.key.x.slice(0, -1)}=` })), /no valid Ed25519/],
      ['a kid that is not the thumbprint', jwks(jwk(dev.key, { kid: 'dev-key' })), /thumbprint/],
      ['a missing kid', jwks({ kty: 'OKP', crv: 'Ed25519', x: dev.key.x }), /thumbprint/],
      ['a repeated kid', jwks(jwk(), jwk()), /repeats a kid/],
      ['the kid of a pinned production key', jwks(jwk(pinned[0])), /pinned production key/],
    ])('rejects %s', (_name, text, problem) => {
      expect(() => parseExtraLicenseJwks(text, pinned)).toThrow(problem);
    });
  });

  describe(loadExtraLicenseKeys.name, () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'frameleaf-extra-jwks-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('is unset without a path, on either channel', () => {
      expect(loadExtraLicenseKeys({ channel: 'integration', path: null, pinned })).toEqual({ state: 'unset' });
      expect(loadExtraLicenseKeys({ channel: 'release', path: '  ', pinned })).toEqual({ state: 'unset' });
      expect(extraLicenseKeysLog({ state: 'unset' })).toBeNull();
    });

    it('a release build ignores the setting and never opens the file', async () => {
      const path = join(dir, 'keys.json');
      await writeFile(path, jwks(jwk()));
      const read = () => {
        throw new Error('a release build must not read the file');
      };
      const result = loadExtraLicenseKeys({ channel: 'release', path, pinned, read, size: read });
      expect(result).toEqual({ state: 'ignored', path });
      expect(extraLicenseKeysLog(result)).toEqual({
        level: 'warn',
        message: expect.stringMatching(
          /FRAMELEAF_LICENSE_EXTRA_JWKS_FILE is set .* but ignored: this is a release build/,
        ),
      });
    });

    it('an integration build loads a valid file and says so loudly', async () => {
      const path = join(dir, 'keys.json');
      await writeFile(path, jwks(jwk()));
      const result = loadExtraLicenseKeys({ channel: 'integration', path, pinned });
      expect(result).toEqual({ state: 'active', path, keys: [{ kid: dev.key.kid, x: dev.key.x, status: 'spare' }] });
      expect(extraLicenseKeysLog(result)).toEqual({
        level: 'warn',
        message: expect.stringContaining(`Pre-release build trusting extra licence keys from ${path}`),
      });
    });

    it.each([
      ['a relative path', () => 'keys.json', /absolute/],
      ['a missing file', (d: string) => join(d, 'missing.json'), /cannot be read/],
      ['a directory', (d: string) => d, /not a regular file/],
      ['a URL', () => 'https://cloud.test/.well-known/frameleaf-keys.json', /absolute/],
    ])('rejects %s and trusts nothing extra', (_name, makePath, problem) => {
      const path = makePath(dir);
      const result = loadExtraLicenseKeys({ channel: 'integration', path, pinned });
      expect(result).toMatchObject({ state: 'rejected', path, problem: expect.stringMatching(problem) });
      expect(extraLicenseKeysLog(result)?.level).toBe('error');
    });

    it('rejects a file that is too large', async () => {
      const path = join(dir, 'keys.json');
      await writeFile(path, ' '.repeat(LICENSE_EXTRA_JWKS_MAX_BYTES + 1));
      expect(loadExtraLicenseKeys({ channel: 'integration', path, pinned })).toMatchObject({
        state: 'rejected',
        problem: expect.stringMatching(/larger than/),
      });
    });

    it('rejects a malformed file', async () => {
      const path = join(dir, 'keys.json');
      await writeFile(path, jwks(jwk(dev.key, { d: 'secret' })));
      expect(loadExtraLicenseKeys({ channel: 'integration', path, pinned })).toMatchObject({
        state: 'rejected',
        problem: expect.stringMatching(/private key material/),
      });
    });
  });

  describe('scope', () => {
    const NOW = Date.UTC(2026, 8, 25, 12);
    const context = { instanceId: 'instance-1', accountId: 'account-1', now: NOW };
    const extra = parseExtraLicenseJwks(jwks(jwk()), FRAMELEAF_LICENSE_KEYS);

    it('verifies a licence certificate the extra key signed, with every other check unchanged', () => {
      const keys = [...FRAMELEAF_LICENSE_KEYS, ...extra];
      const sign = (claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) =>
        signLicenseCertificate(dev, NOW / 1000, claims, header);
      expect(verifyLicenseCertificate(sign(), { ...context, keys })).toMatchObject({ ok: true, kid: dev.key.kid });
      expect(verifyLicenseCertificate(sign({ aud: 'other' }), { ...context, keys })).toEqual({
        ok: false,
        reason: 'audience',
      });
      expect(verifyLicenseCertificate(sign({ iid: 'instance-2' }), { ...context, keys })).toEqual({
        ok: false,
        reason: 'instance',
      });
      expect(verifyLicenseCertificate(sign({ exp: NOW / 1000 - 1 }), { ...context, keys })).toEqual({
        ok: false,
        reason: 'expired',
      });
      expect(verifyLicenseCertificate(sign({}, { alg: 'ES256' }), { ...context, keys })).toEqual({
        ok: false,
        reason: 'algorithm',
      });
      // a JWS of any other type (a token, an activation, a release manifest) is not a licence
      expect(verifyLicenseCertificate(sign({}, { typ: 'JWT' }), { ...context, keys })).toEqual({
        ok: false,
        reason: 'type',
      });
      expect(verifyLicenseCertificate(sign({}, { typ: 'dpop+jwt' }), { ...context, keys })).toEqual({
        ok: false,
        reason: 'type',
      });
    });

    it('reaches no verifier but the licence service: nothing else imports the loader or the channel', () => {
      const src = join(import.meta.dirname, '..');
      const importers = (readdirSync(src, { recursive: true }) as string[])
        .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
        .filter((file) =>
          /from 'src\/utils\/frameleaf-(license-extra-keys|build-channel)\.js'/.test(
            readFileSync(join(src, file), 'utf8'),
          ),
        )
        .map((file) => relative(src, join(src, file)))
        .sort();
      expect(importers).toEqual(['services/frameleaf-license.service.ts', 'utils/frameleaf-license-extra-keys.ts']);
    });

    it('is refused with the pinned production keys alone', () => {
      expect(
        verifyLicenseCertificate(signLicenseCertificate(dev, NOW / 1000), { ...context, keys: FRAMELEAF_LICENSE_KEYS }),
      ).toEqual({ ok: false, reason: 'unknown-kid' });
    });
  });
});
