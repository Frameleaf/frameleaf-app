import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSTANCE_KEY_FILE, InstanceIdentityRepository } from 'src/repositories/instance-identity.repository.js';
import { ed25519Thumbprint } from 'src/utils/frameleaf-cloud.js';

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

describe(InstanceIdentityRepository.name, () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'frameleaf-identity-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('computes the RFC 7638 thumbprint of an Ed25519 key (RFC 8037 appendix A.3 vector)', () => {
    expect(ed25519Thumbprint({ kty: 'OKP', crv: 'Ed25519', x: '11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo' })).toBe(
      'kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k',
    );
  });

  it('creates a UUIDv7 instance id and a 0600 Ed25519 key once', async () => {
    const identity = await new InstanceIdentityRepository().loadOrCreate(join(dir, 'identity'), null);

    expect(identity.instanceId).toMatch(/^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
    expect(identity.keyFile).toBe(join(dir, 'identity', INSTANCE_KEY_FILE));
    expect(identity.kid).toBe(ed25519Thumbprint(identity.publicJwk));
    expect((await stat(identity.keyFile)).mode & 0o777).toBe(0o600);

    const again = await new InstanceIdentityRepository().loadOrCreate(join(dir, 'identity'), identity);
    expect(again).toEqual(identity);
  });

  it('lets a second worker racing the first find the existing key instead of overwriting it', async () => {
    const [first, second] = await Promise.all([
      new InstanceIdentityRepository().loadOrCreate(dir, null),
      new InstanceIdentityRepository().loadOrCreate(dir, null),
    ]);
    expect(first.kid).toBe(second.kid);
    const pem = await readFile(join(dir, INSTANCE_KEY_FILE), 'utf8');
    expect(pem).toContain('BEGIN PRIVATE KEY');
  });

  it('refuses a key file that is not Ed25519', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await writeFile(join(dir, INSTANCE_KEY_FILE), privateKey.export({ format: 'pem', type: 'pkcs8' }));
    await expect(new InstanceIdentityRepository().loadOrCreate(dir, null)).rejects.toThrow('not an Ed25519 key');
  });

  it('signs a private_key_jwt client assertion that verifies with the public JWK', async () => {
    const repository = new InstanceIdentityRepository();
    const identity = await repository.loadOrCreate(dir, null);
    const now = Date.UTC(2026, 8, 25, 12);
    const assertion = repository.signAssertion(identity.kid, identity.instanceId, 'https://id.cloud.test/token', {
      now,
      ttlSeconds: 3600,
    });
    const [header, payload, signature] = assertion.split('.', 3);

    expect(decode(header)).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: identity.kid });
    const claims = decode(payload);
    expect(claims).toMatchObject({
      iss: identity.instanceId,
      sub: identity.instanceId,
      aud: 'https://id.cloud.test/token',
      iat: now / 1000,
    });
    expect(claims.exp - claims.iat).toBe(300);
    expect(claims.jti).toEqual(expect.any(String));
    expect(
      verify(
        null,
        Buffer.from(`${header}.${payload}`),
        createPublicKey({ key: identity.publicJwk, format: 'jwk' }),
        Buffer.from(signature, 'base64url'),
      ),
    ).toBe(true);
  });

  it('refuses to sign before the key is loaded', () => {
    expect(() => new InstanceIdentityRepository().signAssertion('kid', 'id', 'aud')).toThrow('not loaded');
  });
});
